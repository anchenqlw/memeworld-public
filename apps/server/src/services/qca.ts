import { config } from '../config.js';
import { qcaAsciiSlug } from '../lib/qcaNaming.js';
import {
  createQcaCreditsError,
  detectQcaCreditsUnavailable,
  shouldSurfaceQcaCreditsFailure,
  toQcaUserAlert,
  type QcaUserAlert,
} from '../lib/qcaErrors.js';
import { db } from '../db/index.js';
import { isWithinAdventureReportGrace, shanghaiDateFromIso } from '../lib/date.js';
import { v4 as uuid } from 'uuid';
import { alwaysAllowToolConfig } from '../lib/qcaPermissions.js';

export type QcaResources = {
  envId: string;
  agentId: string;
  memstoreId: string;
  deploymentId: string;
};

export type QcaSite = 'global' | 'cn';
export type QcaCredential = { pat: string; site: QcaSite; userId?: string };

const QCA_BASES: Record<QcaSite, string> = {
  global: 'https://api.qoder.com/api/v1/cloud',
  cn: 'https://api.qoder.com.cn/api/v1/cloud',
};

export class QcaApiError extends Error {
  constructor(
    message: string,
    public readonly code: 'QCA_PAT_INVALID' | 'QCA_PERMISSION_DENIED' | 'QCA_TEMPORARY_ERROR' | 'QCA_API_ERROR',
    public readonly status?: number
  ) {
    super(message);
    this.name = 'QcaApiError';
  }
}

type QcaModel = {
  id?: unknown;
  display_name?: unknown;
  is_enabled?: unknown;
  price_factor?: unknown;
  efforts?: unknown;
  default_effort?: unknown;
};

export type QcaModelOption = {
  id: string;
  display_name: string;
  price_factor: number | null;
  efforts: string[];
  default_effort: string | null;
};

function formatQcaApiFailure(method: string, path: string, data: unknown, rawText: string) {
  const detail = extractQcaErrorDetail(data) || (rawText.trim().slice(0, 200) || undefined);
  return detail
    ? `QCA ${method} ${path} 请求失败：${detail}`
    : `QCA ${method} ${path} 请求失败`;
}

function extractQcaErrorDetail(data: unknown) {
  if (!data || typeof data !== 'object') return undefined;
  const record = data as Record<string, unknown>;
  const nested = record.error;
  if (nested && typeof nested === 'object') {
    const message = (nested as Record<string, unknown>).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  if (typeof record.message === 'string' && record.message.trim()) return record.message.trim();
  return undefined;
}

export async function qcaFetch(
  credential: QcaCredential,
  method: string,
  path: string,
  body?: unknown,
  idempotencyKey?: string,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}
) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credential.pat}`,
    'Content-Type': 'application/json',
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res: Response;
    try {
      res = await (options.fetchImpl || fetch)(`${QCA_BASES[credential.site]}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
    } catch {
      lastError = new QcaApiError('QCA 服务暂时不可用，请稍后重试', 'QCA_TEMPORARY_ERROR');
      if (attempt < 2) continue;
      throw lastError;
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const source = path.includes('/sessions') ? 'chat' : 'travel';
      if (detectQcaCreditsUnavailable(data || text, { status: res.status, source })) {
        throw createQcaCreditsError({ status: res.status, source }, text);
      }
      if (res.status === 401) {
        if (credential.userId) {
          await db.updateTable('pat_credentials').set({
            status: 'invalid',
            updated_at: new Date().toISOString(),
          }).where('user_id', '=', credential.userId).execute();
        }
        throw new QcaApiError('PAT 已失效，请重新绑定', 'QCA_PAT_INVALID', 401);
      }
      if (res.status === 403) throw new QcaApiError('PAT 权限不足', 'QCA_PERMISSION_DENIED', 403);
      if (res.status === 429 || res.status >= 500) {
        lastError = new QcaApiError('QCA 服务暂时不可用，请稍后重试', 'QCA_TEMPORARY_ERROR', res.status);
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      lastError = new QcaApiError(formatQcaApiFailure(method, path, data, text), 'QCA_API_ERROR', res.status);
      throw lastError;
    }
    return data as Record<string, unknown>;
  }
  throw lastError || new Error('QCA request failed after retries');
}

export async function probeQcaCredential(
  pat: string,
  options: { fetchImpl?: typeof fetch; skipMock?: boolean } = {}
): Promise<QcaCredential> {
  if (config.qcaMock && !options.skipMock) return { pat, site: 'global' };
  const outcomes: Array<{ site: QcaSite; error?: QcaApiError }> = [];
  for (const site of ['global', 'cn'] as const) {
    try {
      await qcaFetch({ pat, site }, 'GET', '/agents?limit=1', undefined, undefined, {
        timeoutMs: 3_000,
        fetchImpl: options.fetchImpl,
      });
      return { pat, site };
    } catch (error) {
      outcomes.push({ site, error: error instanceof QcaApiError ? error : undefined });
      if (error instanceof QcaApiError && error.code === 'QCA_PERMISSION_DENIED') throw error;
    }
  }
  if (outcomes.every((outcome) => outcome.error?.code === 'QCA_PAT_INVALID')) {
    throw new QcaApiError('PAT 无效或已过期', 'QCA_PAT_INVALID', 401);
  }
  throw new QcaApiError('QCA 服务暂时不可用，无法验证 PAT', 'QCA_TEMPORARY_ERROR');
}

export async function listEnabledQcaModels(credential: QcaCredential): Promise<QcaModelOption[]> {
  if (config.qcaMock) {
    // 第一项即 resolveQcaAgentModel 的缺省选择；第二项对齐官方契约（Credits 耗尽后只保留 Lite），
    // 也让「换 model」这条路径在 QCA_MOCK 下可被真实驱动（#084）。
    return [
      { id: 'ultimate', display_name: 'Ultimate', price_factor: 1.6, efforts: ['low', 'medium', 'high'], default_effort: 'high' },
      { id: 'lite', display_name: 'Lite', price_factor: 0.4, efforts: ['low', 'medium'], default_effort: 'low' },
    ];
  }
  const response = await qcaFetch(credential, 'GET', '/models');
  const models = Array.isArray(response.data) ? response.data as QcaModel[] : [];
  return models
    .filter((model) => model.is_enabled !== false && typeof model.id === 'string')
    .map((model) => ({
      id: model.id as string,
      display_name: typeof model.display_name === 'string' ? model.display_name : model.id as string,
      price_factor: typeof model.price_factor === 'number' ? model.price_factor : null,
      efforts: Array.isArray(model.efforts) ? model.efforts.filter((effort): effort is string => typeof effort === 'string') : [],
      default_effort: typeof model.default_effort === 'string' ? model.default_effort : null,
    }));
}

export async function resolveQcaAgentModel(credential: QcaCredential, requestedModel?: string): Promise<string> {
  const models = await listEnabledQcaModels(credential);
  const enabledIds = models.map((model) => model.id);
  if (requestedModel) {
    if (enabledIds.includes(requestedModel)) return requestedModel;
    throw Object.assign(new Error('所选模型当前不可用，请重新选择'), { code: 'INVALID_QCA_MODEL' });
  }
  if (config.qcaAgentModel) {
    if (enabledIds.includes(config.qcaAgentModel)) return config.qcaAgentModel;
    throw new Error(`Configured QCA_AGENT_MODEL is not enabled for this account: ${config.qcaAgentModel}`);
  }
  if (enabledIds.length === 0) throw new Error('No enabled QCA model is available for this account');
  return enabledIds[0];
}

export async function verifyPat(pat: string): Promise<QcaCredential> {
  if (config.qcaMock && !(pat.startsWith('pt-') || pat.length >= 8)) {
    throw new QcaApiError('PAT 无效或已过期', 'QCA_PAT_INVALID', 401);
  }
  return probeQcaCredential(pat);
}

export const TRAVEL_AGENT_TOOLS = ['Read', 'Write', 'Edit', 'Bash'] as const;

type TravelAgentToolset = [{
  type: 'agent_toolset_20260401';
  enabled_tools: typeof TRAVEL_AGENT_TOOLS[number][];
  configs: Array<{ name: typeof TRAVEL_AGENT_TOOLS[number]; enabled: true; permission_policy: { readonly type: 'always_allow' } }>;
}];

export function travelAgentToolset(): TravelAgentToolset {
  return [{
    type: 'agent_toolset_20260401',
    enabled_tools: [...TRAVEL_AGENT_TOOLS],
    configs: TRAVEL_AGENT_TOOLS.map(alwaysAllowToolConfig),
  }];
}

type AgentPatch = {
  system?: string;
  tools?: TravelAgentToolset;
};

async function patchAgent(credential: QcaCredential, agentId: string, patch: AgentPatch, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const current = await qcaFetch(credential, 'GET', `/agents/${agentId}`) as { version?: number };
    if (typeof current.version !== 'number') {
      throw new QcaApiError(`QCA GET /agents/${agentId} 未返回 version`, 'QCA_API_ERROR');
    }
    try {
      await qcaFetch(credential, 'POST', `/agents/${agentId}`, { version: current.version, ...patch });
      return;
    } catch (error) {
      if (attempt < retries && error instanceof QcaApiError && error.status === 409) continue;
      throw error;
    }
  }
}

export async function updateTravelAgentTools(credential: QcaCredential, agentId: string): Promise<void> {
  if (config.qcaMock) return;
  await patchAgent(credential, agentId, { tools: travelAgentToolset() });
}

export async function createCatResources(
  credential: QcaCredential,
  params: {
    catName: string;
    /** 建猫时传入 catId 前缀，保证 QCA 资源名与 Idempotency-Key 为 ASCII */
    catSlug?: string;
    systemPrompt: string;
    taskInstruction: string;
    serverUrl: string;
    catToken: string;
    model: string;
  }
): Promise<QcaResources> {
  if (config.qcaMock) {
    const suffix = uuid().slice(0, 8);
    return {
      envId: `env_mock_${suffix}`,
      agentId: `agent_mock_${suffix}`,
      memstoreId: `memstore_mock_${suffix}`,
      deploymentId: `dep_mock_${suffix}`,
    };
  }

  const slug = params.catSlug || qcaAsciiSlug(params.catName);
  const host = new URL(params.serverUrl).hostname;
  const created: QcaResources = { envId: '', agentId: '', memstoreId: '', deploymentId: '' };
  try {
    const env = await qcaFetch(credential, 'POST', '/environments', {
      name: `meme-cat-env-${slug}`,
      config: {
        type: 'cloud',
        networking: { type: 'allowed_hosts', allowed_hosts: [host] },
      },
      metadata: { app: 'meme' },
    });
    created.envId = env.id as string;

    const agent = await qcaFetch(
      credential,
      'POST',
      '/agents',
      {
        name: `meme-cat-${slug}`,
        model: params.model,
        system: params.systemPrompt,
        tools: travelAgentToolset(),
        metadata: { app: 'meme', cat_name: params.catName },
      },
      `meme-agent-${slug}-${Date.now()}`
    );
    created.agentId = agent.id as string;

    const memstore = await qcaFetch(credential, 'POST', '/memory_stores', {
      name: `meme-cat-memory-${slug}`,
      description: `Me&Me 小猫「${params.catName}」的长期记忆`,
      metadata: { app: 'meme', cat_name: params.catName },
    });
    created.memstoreId = memstore.id as string;

    const hour = Math.floor(Math.random() * 6);
    const minute = Math.floor(Math.random() * 60);
    const cron = `${minute} ${hour} * * *`;

    const deployment = await qcaFetch(credential, 'POST', '/deployments', {
      name: `meme-daily-travel-${slug}`,
      agent: created.agentId,
      environment_id: created.envId,
      schedule: { type: 'cron', expression: cron, timezone: 'Asia/Shanghai' },
      initial_events: [{ type: 'user.message', content: [{ type: 'text', text: params.taskInstruction }] }],
      resources: [
        {
          type: 'memory_store',
          memory_store_id: created.memstoreId,
          access: 'read_write',
          instructions: '你的长期记忆，按任务要求读写',
        },
      ],
      environment_variables: `SERVER_URL=${params.serverUrl};CAT_TOKEN=${params.catToken}`,
      metadata: { app: 'meme' },
    });
    created.deploymentId = deployment.id as string;
    return created;
  } catch (error) {
    await archiveResources(credential, created);
    throw error;
  }
}

export async function runDeployment(credential: QcaCredential, deploymentId: string): Promise<void> {
  if (config.qcaMock) return;
  await qcaFetch(credential, 'POST', `/deployments/${deploymentId}/run`, {});
}

export type AdventurePresencePhase = 'idle' | 'running' | 'failed';

export type AdventurePresence = {
  phase: AdventurePresencePhase;
  checked_at: string;
  session_id?: string;
  session_status?: string;
  run_id?: string;
  destination?: {
    location_id: string;
    name: string;
    selected_at: string;
  };
};

/** 根据最新 Deployment run + Session 状态判断猫是否正在云端探险 */
export async function fetchAdventurePresence(
  credential: QcaCredential,
  deploymentId: string,
  options: { hasTravelToday: boolean; travelSessionId?: string | null },
): Promise<AdventurePresence> {
  const checked_at = new Date().toISOString();
  if (config.qcaMock) return { phase: 'idle', checked_at };

  if (options.travelSessionId) {
    try {
      const session = await qcaFetch(credential, 'GET', `/sessions/${options.travelSessionId}`) as {
        status?: string;
        archived_at?: string | null;
        updated_at?: string;
        stats?: { duration_seconds?: number };
      };
      const sessionStatus = session.status ?? 'unknown';
      if (session.archived_at || sessionStatus === 'archived') {
        return { phase: 'failed', checked_at, session_id: options.travelSessionId, session_status: sessionStatus };
      }
      if (sessionStatus !== 'idle') {
        return { phase: 'running', checked_at, session_id: options.travelSessionId, session_status: sessionStatus };
      }
      const updatedToday = session.updated_at
        ? shanghaiDateFromIso(session.updated_at) === shanghaiDateFromIso(checked_at)
        : false;
      if (!options.hasTravelToday && updatedToday && (session.stats?.duration_seconds ?? 0) > 0) {
        if (isWithinAdventureReportGrace(session.updated_at)) {
          return { phase: 'running', checked_at, session_id: options.travelSessionId, session_status: sessionStatus };
        }
        return { phase: 'failed', checked_at, session_id: options.travelSessionId, session_status: sessionStatus };
      }
      return { phase: 'idle', checked_at, session_id: options.travelSessionId, session_status: sessionStatus };
    } catch {
      return { phase: 'idle', checked_at, session_id: options.travelSessionId };
    }
  }

  const runs = await qcaFetch(credential, 'GET', `/deployments/${deploymentId}/runs?limit=1`) as {
    data?: Array<{ id?: string; session_id?: string; error?: unknown; created_at?: string }>;
  };
  const latest = runs.data?.[0];
  if (!latest) return { phase: 'idle', checked_at };

  const base = { checked_at, run_id: latest.id, session_id: latest.session_id };

  if (latest.error) {
    return { ...base, phase: 'failed' };
  }

  if (!latest.session_id) {
    return { ...base, phase: 'idle' };
  }

  const session = await qcaFetch(credential, 'GET', `/sessions/${latest.session_id}`) as {
    status?: string;
  };
  const sessionStatus = session.status ?? 'unknown';

  if (sessionStatus !== 'idle') {
    return { ...base, phase: 'running', session_status: sessionStatus };
  }

  const runToday = latest.created_at
    ? shanghaiDateFromIso(latest.created_at) === shanghaiDateFromIso(checked_at)
    : false;
  if (runToday && !options.hasTravelToday) {
    if (isWithinAdventureReportGrace(latest.created_at)) {
      return { ...base, phase: 'running', session_status: sessionStatus };
    }
    return { ...base, phase: 'failed', session_status: sessionStatus };
  }

  return { ...base, phase: 'idle', session_status: sessionStatus };
}

export async function pauseDeployment(credential: QcaCredential, deploymentId: string): Promise<void> {
  if (config.qcaMock) return;
  await qcaFetch(credential, 'POST', `/deployments/${deploymentId}/pause`, {});
}

export async function unpauseDeployment(credential: QcaCredential, deploymentId: string): Promise<void> {
  if (config.qcaMock) return;
  await qcaFetch(credential, 'POST', `/deployments/${deploymentId}/unpause`, {});
}

export async function updateAgent(
  credential: QcaCredential,
  agentId: string,
  patch: string | AgentPatch,
): Promise<void> {
  if (config.qcaMock) return;
  const body = typeof patch === 'string' ? { system: patch } : patch;
  await patchAgent(credential, agentId, body);
}

export async function updateDeploymentTask(
  credential: QcaCredential,
  deploymentId: string,
  taskInstruction: string,
  catToken: string
): Promise<void> {
  if (config.qcaMock) return;
  await qcaFetch(credential, 'POST', `/deployments/${deploymentId}`, {
    initial_events: [{ type: 'user.message', content: [{ type: 'text', text: taskInstruction }] }],
    environment_variables: `SERVER_URL=${config.catApiPublicUrl};CAT_TOKEN=${catToken}`,
  });
}

/**
 * M3 task reconciliation only replaces the repository-owned instruction.
 * Keeping environment_variables out of this patch is intentional: legacy Build
 * cats do not persist the raw CAT_TOKEN, so reconciliation must never rotate or
 * reconstruct credentials as a side effect of a task-version refresh.
 */
export async function updateDeploymentTaskInstruction(
  credential: QcaCredential,
  deploymentId: string,
  taskInstruction: string,
  fetcher: typeof qcaFetch = qcaFetch,
): Promise<void> {
  if (config.qcaMock && fetcher === qcaFetch) return;
  await fetcher(credential, 'POST', `/deployments/${deploymentId}`, buildDeploymentTaskInstructionPatch(taskInstruction));
}

export function buildDeploymentTaskInstructionPatch(taskInstruction: string) {
  return {
    initial_events: [{ type: 'user.message', content: [{ type: 'text', text: taskInstruction }] }],
  };
}

export async function readDeploymentTaskInstruction(
  credential: QcaCredential,
  deploymentId: string,
): Promise<string | null> {
  if (config.qcaMock) return null;
  const deployment = await qcaFetch(credential, 'GET', `/deployments/${deploymentId}`) as {
    initial_events?: Array<{ content?: string | Array<{ type?: string; text?: string }> }>;
  };
  const content = deployment.initial_events?.[0]?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const text = content.find((part) => part?.type === 'text' && typeof part.text === 'string')?.text;
  return typeof text === 'string' ? text : null;
}

export async function checkResourceHealth(
  credential: QcaCredential,
  ids: { envId?: string | null; agentId?: string | null; memstoreId?: string | null; deploymentId?: string | null },
  options: { creditsRecoveredAt?: string } = {},
): Promise<{ status: string; details: Record<string, string>; alert?: QcaUserAlert }> {
  if (config.qcaMock) {
    return { status: 'healthy', details: { mode: 'mock' } };
  }
  const details: Record<string, string> = {};
  let ok = true;
  const checks: Array<[string, string | null | undefined, string]> = [
    ['environment', ids.envId, '/environments'],
    ['agent', ids.agentId, '/agents'],
    ['memory_store', ids.memstoreId, '/memory_stores'],
    ['deployment', ids.deploymentId, '/deployments'],
  ];
  for (const [key, id, base] of checks) {
    if (!id) {
      details[key] = 'missing';
      ok = false;
      continue;
    }
    try {
      await qcaFetch(credential, 'GET', `${base}/${id}`);
      details[key] = 'ok';
    } catch (error) {
      if (error instanceof QcaApiError && error.code === 'QCA_PAT_INVALID') throw error;
      details[key] = 'error';
      ok = false;
    }
  }
  let alert: QcaUserAlert | undefined;
  if (ids.deploymentId) {
    try {
      const runs = await qcaFetch(credential, 'GET', `/deployments/${ids.deploymentId}/runs?limit=1`) as {
        data?: Array<{ error?: unknown; session_id?: string; created_at?: string }>;
      };
      const latest = runs.data?.[0];
      let diagnostic: unknown = latest?.error;
      if (!diagnostic && latest?.session_id) {
        const [session, events] = await Promise.all([
          qcaFetch(credential, 'GET', `/sessions/${latest.session_id}`),
          qcaFetch(credential, 'GET', `/sessions/${latest.session_id}/events?limit=50`),
        ]);
        diagnostic = { session, events };
      }
      if (
        shouldSurfaceQcaCreditsFailure(latest?.created_at, options.creditsRecoveredAt)
        && diagnostic
        && detectQcaCreditsUnavailable(diagnostic, { source: 'travel' })
      ) {
        alert = toQcaUserAlert('travel');
      }
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'QCA_CREDITS_UNAVAILABLE') {
        alert = toQcaUserAlert('travel');
      }
    }
  }
  return { status: ok ? 'healthy' : 'broken', details, ...(alert ? { alert } : {}) };
}

export async function canAccessQcaResources(
  credential: QcaCredential,
  ids: { envId?: string | null; agentId?: string | null; memstoreId?: string | null; deploymentId?: string | null;
    imageEnvId?: string | null; imageAgentId?: string | null }
): Promise<boolean> {
  if (config.qcaMock) return true;
  const checks: Array<[string | null | undefined, string]> = [
    [ids.envId, '/environments'], [ids.agentId, '/agents'], [ids.memstoreId, '/memory_stores'],
    [ids.deploymentId, '/deployments'], [ids.imageEnvId, '/environments'], [ids.imageAgentId, '/agents'],
  ];
  try {
    await Promise.all(checks.filter(([id]) => Boolean(id)).map(([id, base]) => qcaFetch(credential, 'GET', `${base}/${id}`)));
    return true;
  } catch (error) {
    if (error instanceof QcaApiError && error.code === 'QCA_PAT_INVALID') throw error;
    return false;
  }
}

export async function createChatSession(
  credential: QcaCredential,
  params: { agentId: string; envId: string; memstoreId: string }
): Promise<string> {
  if (config.qcaMock) return `session_mock_${uuid().slice(0, 8)}`;
  const session = await qcaFetch(credential, 'POST', '/sessions', {
    agent: params.agentId,
    environment_id: params.envId,
    resources: [
      { type: 'memory_store', memory_store_id: params.memstoreId, access: 'read_write' },
    ],
  });
  return session.id as string;
}

export async function sendChatMessage(credential: QcaCredential, sessionId: string, message: string): Promise<string> {
  if (config.qcaMock) {
    return `喵~ 我听到了：「${message.slice(0, 50)}」。今天云端的风景很好呢，主人。`;
  }
  await qcaFetch(credential, 'POST', `/sessions/${sessionId}/events`, {
    events: [{ type: 'user.message', content: [{ type: 'text', text: message }] }],
  });
  // Poll for assistant response (simplified; production would SSE from QCA)
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const page = (await qcaFetch(credential, 'GET', `/sessions/${sessionId}/events`)) as {
      data?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
    };
    const msgs = (page.data || []).filter((e) => e.type === 'agent.message' || e.type === 'assistant.message');
    const last = msgs[msgs.length - 1];
    const text = last?.content?.find((c) => c.type === 'text')?.text;
    if (text) return text;
  }
  return '喵…我刚才走神了，主人再说一次？';
}

export async function archiveResources(credential: QcaCredential, ids: QcaResources): Promise<void> {
  if (config.qcaMock) return;
  const order = [
    ['deployment', ids.deploymentId, '/deployments'],
    ['memstore', ids.memstoreId, '/memory_stores'],
    ['agent', ids.agentId, '/agents'],
    ['env', ids.envId, '/environments'],
  ] as const;
  for (const [, id, base] of order) {
    if (!id) continue;
    try {
      await qcaFetch(credential, 'POST', `${base}/${id}/archive`, {});
    } catch {
      /* best effort rollback */
    }
  }
}

export async function archiveChatSession(credential: QcaCredential, sessionId: string) {
  if (config.qcaMock) return;
  await qcaFetch(credential, 'POST', `/sessions/${sessionId}/archive`, {});
}

/** 迁移到 Forward 后归档 Build 旅行 Agent/Deployment，保留 Environment 与 Memory Store */
export async function archiveLegacyBuildTravelOnly(
  credential: QcaCredential,
  ids: { agentId?: string | null; deploymentId?: string | null },
): Promise<void> {
  if (config.qcaMock) return;
  if (ids.deploymentId) {
    await pauseDeployment(credential, ids.deploymentId).catch(() => undefined);
    try {
      await qcaFetch(credential, 'POST', `/deployments/${ids.deploymentId}/archive`, {});
    } catch {
      /* best effort */
    }
  }
  if (ids.agentId) {
    try {
      await qcaFetch(credential, 'POST', `/agents/${ids.agentId}/archive`, {});
    } catch {
      /* best effort */
    }
  }
}

export async function readBuildTravelCron(credential: QcaCredential, deploymentId: string) {
  if (config.qcaMock) return undefined;
  try {
    const deployment = await qcaFetch(credential, 'GET', `/deployments/${deploymentId}`) as {
      schedule?: { expression?: string; timezone?: string };
    };
    if (deployment.schedule?.expression) {
      return {
        expression: deployment.schedule.expression,
        timezone: deployment.schedule.timezone || 'Asia/Shanghai',
      };
    }
  } catch {
    /* ignore */
  }
  return undefined;
}
