import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuid } from 'uuid';
import { config } from '../config.js';
import { qcaAsciiSlug } from '../lib/qcaNaming.js';
import { isWithinAdventureReportGrace, shanghaiDateFromIso } from '../lib/date.js';
import { getRepoRoot, renderCatAgentPrompt } from '../lib/templates.js';
import { detectQcaCreditsUnavailable, shouldSurfaceQcaCreditsFailure, toQcaUserAlert } from '../lib/qcaErrors.js';
import { alwaysAllowIdentityToolConfig } from '../lib/qcaPermissions.js';
import { qcaFetch, QcaApiError, type QcaCredential } from './qca.js';
import {
  forwardFetch,
  forwardFetchWithTransientNotFoundRetry,
  forwardTravelToolConfigs,
  waitForForwardIdentityReady,
} from './qcaForward.js';
import {
  bootstrapForwardTravelMemory,
  ensureIdentityMemoryStore,
} from './qcaForwardRegistry.js';
import type { AdventurePresence } from './qca.js';

export const TRAVEL_TEMPLATE_LOGICAL_NAME = 'meandme-daily-travel';
export const TRAVEL_TEMPLATE_DISPLAY_NAME = 'meme-meandme-daily-travel';

export type ForwardTravelResources = {
  envId: string;
  memstoreId: string;
  travelTemplateId: string;
  identityId: string;
  scheduleId: string;
};

type ForwardScheduleEvent = {
  type: 'user.message';
  content: string;
};

function renderTravelTemplateSystemPrompt() {
  const templatePath = path.join(getRepoRoot(), 'templates/qca-forward/meandme-daily-travel.md');
  const raw = fs.readFileSync(templatePath, 'utf8');
  const bodyStart = raw.indexOf('---\n\n');
  return bodyStart >= 0 ? raw.slice(bodyStart + 5).trim() : raw.trim();
}

function buildForwardTravelEvent(taskInstruction: string): ForwardScheduleEvent {
  return { type: 'user.message', content: taskInstruction };
}

function randomShanghaiCron() {
  const hour = Math.floor(Math.random() * 6);
  const minute = Math.floor(Math.random() * 60);
  return `${minute} ${hour} * * *`;
}

export function catUsesForwardTravel(cat: { qca_forward_schedule_id?: string | null }) {
  return Boolean(cat.qca_forward_schedule_id);
}

async function createTravelEnvironment(credential: QcaCredential, slug: string, serverUrl: string) {
  const host = new URL(serverUrl).hostname;
  const env = await qcaFetch(credential, 'POST', '/environments', {
    name: `meme-cat-env-${slug}`,
    config: {
      type: 'cloud',
      networking: { type: 'allowed_hosts', allowed_hosts: [host] },
    },
    metadata: { app: 'meme', mode: 'forward' },
  });
  return env.id as string;
}

async function findTravelTemplateId(credential: QcaCredential) {
  const page = await forwardFetch(credential, 'GET', '/templates?status=active&limit=100') as {
    data?: Array<{ id?: string; name?: string; metadata?: Record<string, unknown> }>;
  };
  const match = (page.data ?? []).find((item) =>
    item.name === TRAVEL_TEMPLATE_DISPLAY_NAME
    || item.metadata?.logical_name === TRAVEL_TEMPLATE_LOGICAL_NAME,
  );
  return match?.id ?? null;
}

async function ensureTravelTemplate(
  credential: QcaCredential,
  params: { envId: string; model: string; serverUrl: string; catToken: string },
) {
  const existing = await findTravelTemplateId(credential);
  const body = {
    name: TRAVEL_TEMPLATE_DISPLAY_NAME,
    description: 'Me&Me 小猫每日自主旅行',
    model: params.model,
    environment_id: params.envId,
    system: renderTravelTemplateSystemPrompt(),
    tools: [{ type: 'agent_toolset_20260401', configs: forwardTravelToolConfigs() }],
    environment_variables: {
      SERVER_URL: params.serverUrl,
      CAT_TOKEN: params.catToken,
    },
    metadata: { app: 'meme', logical_name: TRAVEL_TEMPLATE_LOGICAL_NAME },
  };
  if (existing) {
    await forwardFetch(credential, 'POST', `/templates/${existing}`, body);
    return existing;
  }
  const created = await forwardFetch(
    credential,
    'POST',
    '/templates',
    body,
    `meme-forward-template-${TRAVEL_TEMPLATE_LOGICAL_NAME}`,
  );
  return created.id as string;
}

async function findIdentityByExternalId(credential: QcaCredential, externalId: string) {
  const page = await forwardFetch(
    credential,
    'GET',
    `/identities?external_id=${encodeURIComponent(externalId)}&limit=1`,
  ) as { data?: Array<{ id?: string }> };
  return page.data?.[0]?.id ?? null;
}

async function ensureCatIdentity(credential: QcaCredential, params: { catId: string; catName: string }) {
  const existing = await findIdentityByExternalId(credential, params.catId);
  if (existing) return existing;
  const created = await forwardFetch(
    credential,
    'POST',
    '/identities',
    {
      external_id: params.catId,
      name: `meme-cat-${qcaAsciiSlug(params.catName)}`,
      metadata: { app: 'meme', cat_id: params.catId },
    },
    `meme-forward-identity-${params.catId}`,
  );
  return created.id as string;
}

export async function upsertForwardIdentityConfig(
  credential: QcaCredential,
  params: {
    identityId: string;
    templateId: string;
    systemPrompt: string;
    model: string;
    toolNames?: readonly string[];
  },
) {
  if (config.qcaMock) return;
  const tools = params.toolNames ?? forwardTravelToolConfigs().map((tool) => tool.name);
  await waitForForwardIdentityReady(credential, params.identityId, { source: 'travel' });
  await forwardFetchWithTransientNotFoundRetry(
    credential,
    'POST',
    `/identities/${params.identityId}/templates/${params.templateId}/config`,
    {
      name: 'travel-profile',
      identity_config: {
        system: { mode: 'replace', content: params.systemPrompt },
        model: params.model,
        tools: Object.fromEntries(tools.map((name) => [name, alwaysAllowIdentityToolConfig()])),
      },
      metadata: { app: 'meme' },
    },
    undefined,
    { source: 'travel' },
  );
}

async function createTravelSchedule(
  credential: QcaCredential,
  params: {
    catId: string;
    identityId: string;
    templateId: string;
    envId: string;
    catName: string;
    taskInstruction: string;
    cronExpression?: string;
    cronTimezone?: string;
  },
) {
  const slug = qcaAsciiSlug(params.catName);
  const catSlug = qcaAsciiSlug(params.catId).slice(0, 12);
  const created = await forwardFetch(
    credential,
    'POST',
    '/schedules',
    {
      identity_id: params.identityId,
      template_id: params.templateId,
      name: `meme-daily-travel-${slug}-${catSlug}`,
      description: `Me&Me 小猫「${params.catName}」每日旅行`,
      initial_events: [buildForwardTravelEvent(params.taskInstruction)],
      trigger_policy: {
        type: 'cron',
        expression: params.cronExpression ?? randomShanghaiCron(),
        timezone: params.cronTimezone ?? 'Asia/Shanghai',
      },
      execution: {
        session_mode: 'reuse_session',
        max_concurrent_runs: 1,
        max_attempts: 1,
        timeout_ms: 300_000,
      },
      environment_id: params.envId,
      metadata: { app: 'meme' },
    },
    buildForwardScheduleIdempotencyKey(params.catId),
  );
  return created.id as string;
}

export function buildForwardScheduleIdempotencyKey(catId: string) {
  return `meme-forward-schedule-${catId}`;
}

export async function updateForwardTravelTemplateEnv(
  credential: QcaCredential,
  templateId: string,
  params: { serverUrl: string; catToken: string },
) {
  if (config.qcaMock) return;
  await forwardFetch(credential, 'POST', `/templates/${templateId}`, {
    environment_variables: {
      SERVER_URL: params.serverUrl,
      CAT_TOKEN: params.catToken,
    },
  });
}

export async function updateForwardTravelScheduleTask(
  credential: QcaCredential,
  scheduleId: string,
  taskInstruction: string,
) {
  if (config.qcaMock) return;
  await forwardFetch(credential, 'POST', `/schedules/${scheduleId}`, {
    initial_events: [buildForwardTravelEvent(taskInstruction)],
  });
}

export async function readForwardTravelScheduleTask(
  credential: QcaCredential,
  scheduleId: string,
): Promise<string | null> {
  if (config.qcaMock) return null;
  const schedule = await forwardFetch(credential, 'GET', `/schedules/${scheduleId}`) as {
    initial_events?: Array<{ content?: string }>;
  };
  const content = schedule.initial_events?.[0]?.content;
  return typeof content === 'string' ? content : null;
}

export async function runForwardSchedule(credential: QcaCredential, scheduleId: string) {
  if (config.qcaMock) return { id: `srun_mock_${uuid().slice(0, 8)}` };
  return forwardFetch(credential, 'POST', `/schedules/${scheduleId}/run`, {});
}

export async function pauseForwardSchedule(credential: QcaCredential, scheduleId: string) {
  if (config.qcaMock) return;
  await forwardFetch(credential, 'POST', `/schedules/${scheduleId}/pause`, {});
}

export async function unpauseForwardSchedule(credential: QcaCredential, scheduleId: string) {
  if (config.qcaMock) return;
  await forwardFetch(credential, 'POST', `/schedules/${scheduleId}/unpause`, {});
}

export type EnsureForwardTravelParams = {
  catId: string;
  catName: string;
  systemPrompt: string;
  taskInstruction: string;
  serverUrl: string;
  catToken: string;
  model: string;
  ownerNickname: string;
  personality: string;
  attrs: { courage: number; curiosity: number; affinity: number; insight: number };
  existingEnvId?: string | null;
  existingMemstoreId?: string | null;
  existingTemplateId?: string | null;
  existingIdentityId?: string | null;
  existingScheduleId?: string | null;
  cronExpression?: string;
  cronTimezone?: string;
};

export async function ensureForwardTravelResourcesForCat(
  credential: QcaCredential,
  params: EnsureForwardTravelParams,
): Promise<ForwardTravelResources> {
  if (config.qcaMock) {
    const suffix = uuid().slice(0, 8);
    return {
      envId: params.existingEnvId || `env_mock_${suffix}`,
      memstoreId: params.existingMemstoreId || `memstore_mock_${suffix}`,
      travelTemplateId: params.existingTemplateId || `tmpl_mock_${suffix}`,
      identityId: params.existingIdentityId || `idn_mock_${suffix}`,
      scheduleId: params.existingScheduleId || `sched_mock_${suffix}`,
    };
  }

  if (
    params.existingScheduleId
    && params.existingIdentityId
    && params.existingTemplateId
    && params.existingEnvId
    && params.existingMemstoreId
  ) {
    await upsertForwardIdentityConfig(credential, {
      identityId: params.existingIdentityId,
      templateId: params.existingTemplateId,
      systemPrompt: params.systemPrompt,
      model: params.model,
    });
    await updateForwardTravelTemplateEnv(credential, params.existingTemplateId, {
      serverUrl: params.serverUrl,
      catToken: params.catToken,
    });
    await updateForwardTravelScheduleTask(credential, params.existingScheduleId, params.taskInstruction);
    const memstoreId = await ensureIdentityMemoryStore(credential, {
      catId: params.catId,
      catName: params.catName,
      identityId: params.existingIdentityId,
      existingMemstoreId: params.existingMemstoreId,
      travelTemplateId: params.existingTemplateId,
    });
    await bootstrapForwardTravelMemory(credential, {
      memstoreId,
      identityId: params.existingIdentityId,
      serverUrl: params.serverUrl,
      catToken: params.catToken,
      catName: params.catName,
      personality: params.personality,
      ownerNickname: params.ownerNickname,
      attrs: params.attrs,
    });
    return {
      envId: params.existingEnvId,
      memstoreId,
      travelTemplateId: params.existingTemplateId,
      identityId: params.existingIdentityId,
      scheduleId: params.existingScheduleId,
    };
  }

  const slug = params.catId.slice(0, 8);
  const created: ForwardTravelResources = {
    envId: params.existingEnvId || '',
    memstoreId: params.existingMemstoreId || '',
    travelTemplateId: params.existingTemplateId || '',
    identityId: params.existingIdentityId || '',
    scheduleId: params.existingScheduleId || '',
  };
  try {
    if (!created.envId) {
      created.envId = await createTravelEnvironment(credential, slug, params.serverUrl);
    }
    created.travelTemplateId = await ensureTravelTemplate(credential, {
      envId: created.envId,
      model: params.model,
      serverUrl: params.serverUrl,
      catToken: params.catToken,
    });
    created.identityId = await ensureCatIdentity(credential, {
      catId: params.catId,
      catName: params.catName,
    });
    await upsertForwardIdentityConfig(credential, {
      identityId: created.identityId,
      templateId: created.travelTemplateId,
      systemPrompt: params.systemPrompt,
      model: params.model,
    });
    created.memstoreId = await ensureIdentityMemoryStore(credential, {
      catId: params.catId,
      catName: params.catName,
      identityId: created.identityId,
      existingMemstoreId: created.memstoreId || null,
      travelTemplateId: created.travelTemplateId,
    });
    await bootstrapForwardTravelMemory(credential, {
      memstoreId: created.memstoreId,
      identityId: created.identityId,
      serverUrl: params.serverUrl,
      catToken: params.catToken,
      catName: params.catName,
      personality: params.personality,
      ownerNickname: params.ownerNickname,
      attrs: params.attrs,
    });
    if (!created.scheduleId) {
      created.scheduleId = await createTravelSchedule(credential, {
        catId: params.catId,
        identityId: created.identityId,
        templateId: created.travelTemplateId,
        envId: created.envId,
        catName: params.catName,
        taskInstruction: params.taskInstruction,
        cronExpression: params.cronExpression,
        cronTimezone: params.cronTimezone,
      });
    }
    return created;
  } catch (error) {
    await archiveForwardTravelResources(credential, created);
    throw error;
  }
}

export async function createForwardTravelResources(
  credential: QcaCredential,
  params: {
    catId: string;
    catName: string;
    systemPrompt: string;
    taskInstruction: string;
    serverUrl: string;
    catToken: string;
    model: string;
    ownerNickname: string;
    personality: string;
    attrs: { courage: number; curiosity: number; affinity: number; insight: number };
  },
): Promise<ForwardTravelResources> {
  return ensureForwardTravelResourcesForCat(credential, params);
}

export async function archiveForwardTravelResources(
  credential: QcaCredential,
  ids: Partial<ForwardTravelResources>,
) {
  if (config.qcaMock) return;
  const order = [
    ['schedule', ids.scheduleId, '/schedules'],
    ['identity', ids.identityId, '/identities'],
  ] as const;
  for (const [, id, base] of order) {
    if (!id) continue;
    try {
      if (base === '/schedules') {
        await forwardFetch(credential, 'POST', `${base}/${id}/archive`, {});
      } else {
        await forwardFetch(credential, 'DELETE', `${base}/${id}`, {});
      }
    } catch {
      /* best effort */
    }
  }
  const buildOrder = [
    ['memstore', ids.memstoreId, '/memory_stores'],
    ['env', ids.envId, '/environments'],
  ] as const;
  for (const [, id, base] of buildOrder) {
    if (!id) continue;
    try {
      await qcaFetch(credential, 'POST', `${base}/${id}/archive`, {});
    } catch {
      /* best effort */
    }
  }
}

export async function canAccessForwardTravelResources(
  credential: QcaCredential,
  ids: {
    identityId?: string | null;
    scheduleId?: string | null;
    travelTemplateId?: string | null;
    envId?: string | null;
    memstoreId?: string | null;
    catId?: string | null;
  },
) {
  if (config.qcaMock) return true;
  try {
    if (ids.catId) {
      const identityId = await findIdentityByExternalId(credential, ids.catId);
      if (!identityId) return false;
      if (ids.identityId && identityId !== ids.identityId) return false;
    }
    const tasks: Promise<unknown>[] = [];
    if (ids.identityId) tasks.push(forwardFetch(credential, 'GET', `/identities/${ids.identityId}`));
    if (ids.scheduleId) tasks.push(forwardFetch(credential, 'GET', `/schedules/${ids.scheduleId}`));
    if (ids.travelTemplateId) tasks.push(forwardFetch(credential, 'GET', `/templates/${ids.travelTemplateId}`));
    if (ids.envId) tasks.push(qcaFetch(credential, 'GET', `/environments/${ids.envId}`));
    if (ids.memstoreId) tasks.push(qcaFetch(credential, 'GET', `/memory_stores/${ids.memstoreId}`));
    if (tasks.length === 0) return true;
    await Promise.all(tasks);
    return true;
  } catch (error) {
    if (error instanceof QcaApiError && error.code === 'QCA_PAT_INVALID') throw error;
    return false;
  }
}

export async function checkForwardTravelHealth(
  credential: QcaCredential,
  ids: {
    identityId?: string | null;
    scheduleId?: string | null;
    travelTemplateId?: string | null;
    envId?: string | null;
    memstoreId?: string | null;
  },
) {
  if (config.qcaMock) return { status: 'healthy', details: { mode: 'forward_mock' } };
  const details: Record<string, string> = {};
  let ok = true;
  const forwardChecks: Array<[string, string | null | undefined, string]> = [
    ['identity', ids.identityId, '/identities'],
    ['schedule', ids.scheduleId, '/schedules'],
    ['template', ids.travelTemplateId, '/templates'],
  ];
  for (const [key, id, base] of forwardChecks) {
    if (!id) {
      details[key] = 'missing';
      ok = false;
      continue;
    }
    try {
      await forwardFetch(credential, 'GET', `${base}/${id}`);
      details[key] = 'ok';
    } catch {
      details[key] = 'error';
      ok = false;
    }
  }
  const buildChecks: Array<[string, string | null | undefined, string]> = [
    ['environment', ids.envId, '/environments'],
    ['memory_store', ids.memstoreId, '/memory_stores'],
  ];
  for (const [key, id, base] of buildChecks) {
    if (!id) {
      details[key] = 'missing';
      ok = false;
      continue;
    }
    try {
      await qcaFetch(credential, 'GET', `${base}/${id}`);
      details[key] = 'ok';
    } catch {
      details[key] = 'error';
      ok = false;
    }
  }
  return { status: ok ? 'healthy' : 'broken', details, mode: 'forward' as const };
}

export async function fetchForwardAdventurePresence(
  credential: QcaCredential,
  options: { identityId: string; scheduleId?: string | null; hasTravelToday: boolean },
): Promise<AdventurePresence> {
  const checked_at = new Date().toISOString();
  if (config.qcaMock) return { phase: 'idle', checked_at };
  try {
    const qs = new URLSearchParams({ identity_id: options.identityId, limit: '5' });
    if (options.scheduleId) qs.set('schedule_id', options.scheduleId);
    const runs = await forwardFetch(credential, 'GET', `/schedule_runs?${qs.toString()}`) as {
      data?: Array<{
        id?: string;
        session_id?: string | null;
        schedule_id?: string;
        status?: string;
        error?: unknown;
        created_at?: string;
      }>;
    };
    const latest = runs.data?.[0];
    if (!latest) return { phase: 'idle', checked_at };

    const base = {
      checked_at,
      run_id: latest.id,
      session_id: latest.session_id ?? undefined,
    };
    if (latest.error) return { ...base, phase: 'failed' };
    if (latest.status === 'pending' || latest.status === 'running') {
      return { ...base, phase: 'running', session_status: latest.status };
    }

    let sessionCreatedAt = latest.created_at;
    if (latest.session_id) {
      const session = await forwardFetch(credential, 'GET', `/sessions/${latest.session_id}`) as {
        status?: string;
        created_at?: string;
      };
      sessionCreatedAt = session.created_at ?? sessionCreatedAt;
      if (session.status && session.status !== 'idle' && session.status !== 'terminated') {
        return { ...base, phase: 'running', session_status: session.status };
      }
    }

    const runToday = sessionCreatedAt
      ? shanghaiDateFromIso(sessionCreatedAt) === shanghaiDateFromIso(checked_at)
      : false;
    if (runToday && !options.hasTravelToday && latest.status === 'completed') {
      if (isWithinAdventureReportGrace(sessionCreatedAt)) {
        return { ...base, phase: 'running', session_status: latest.status };
      }
      return { ...base, phase: 'failed', session_status: latest.status };
    }
    return { ...base, phase: 'idle', session_status: latest.status };
  } catch {
    return { phase: 'idle', checked_at };
  }
}

export async function resolveForwardTravelAccessAlert(
  credential: QcaCredential,
  identityId: string | null | undefined,
  scheduleId?: string | null,
  creditsRecoveredAt?: string,
) {
  if (!identityId || config.qcaMock) return undefined;
  try {
    const qs = new URLSearchParams({ identity_id: identityId, limit: '1' });
    if (scheduleId) qs.set('schedule_id', scheduleId);
    const runs = await forwardFetch(credential, 'GET', `/schedule_runs?${qs.toString()}`) as {
      data?: Array<{ error?: unknown; created_at?: string }>;
    };
    const latest = runs.data?.[0];
    if (
      shouldSurfaceQcaCreditsFailure(latest?.created_at, creditsRecoveredAt)
      && latest?.error
      && detectQcaCreditsUnavailable(latest.error, { source: 'travel' })
    ) {
      return toQcaUserAlert('travel');
    }
  } catch {
    /* ignore */
  }
  return undefined;
}
