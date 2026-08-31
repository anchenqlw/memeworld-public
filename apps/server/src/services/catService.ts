import { db, type CatRow } from '../db/index.js';
import { v4 as uuid } from 'uuid';
import { generateAppearance, isValidAppearance, type Appearance } from '../lib/appearance.js';
import { encryptPat, decryptPat, generateCatToken, hashToken } from '../lib/crypto.js';
import { renderCatAgentPrompt, renderDailyTravelTask } from '../lib/templates.js';
import { config } from '../config.js';
import {
  createCatResources,
  pauseDeployment,
  updateAgent,
  updateDeploymentTask,
  travelAgentToolset,
  checkResourceHealth,
  archiveResources,
  resolveQcaAgentModel,
  fetchAdventurePresence,
  unpauseDeployment,
  archiveLegacyBuildTravelOnly,
  readBuildTravelCron,
  type AdventurePresence,
  type QcaCredential,
} from './qca.js';
import {
  ensureTravelSession,
  getTravelSessionStatus,
  sendTravelTaskEvent,
} from './qcaTravelSession.js';
import { shanghaiDate } from '../lib/date.js';
import { createImageArtistResources, archiveImageArtistResources } from './qcaImage.js';
import {
  bootstrapForwardTravelMemory,
  syncIdentityMemoryStoreAfterRun,
} from './qcaForwardRegistry.js';
import { bootstrapTravelMemory } from './qcaMemory.js';
import {
  archiveForwardTravelResources,
  canAccessForwardTravelResources,
  catUsesForwardTravel,
  checkForwardTravelHealth,
  ensureForwardTravelResourcesForCat,
  fetchForwardAdventurePresence,
  pauseForwardSchedule,
  resolveForwardTravelAccessAlert,
  runForwardSchedule,
  unpauseForwardSchedule,
  updateForwardTravelScheduleTask,
  updateForwardTravelTemplateEnv,
  upsertForwardIdentityConfig,
  type ForwardTravelResources,
} from './qcaForwardService.js';
import { ensureForwardChatSetup, ensureImChannel } from './qcaForwardChatService.js';
import { listCatItems } from './itemService.js';
import { listBadgesForCat } from './badgeService.js';
import { getCurrentImageUrl, listAppearanceHistory, listBirthCandidates, findPendingRepaintCandidate, isRepaintAppearanceId, REPAINT_APPEARANCE_ID_PREFIX } from './catImageService.js';
import { enqueueBirthCandidate, enqueueRepaintCandidate } from './imageJobService.js';
import { buildCatIdentityAnchor } from '../lib/meandmeImageStyle.js';
import { QCA_CREDITS_UNAVAILABLE, toQcaUserAlert } from '../lib/qcaErrors.js';
import {
  normalizeCustomAppearanceDescription,
  requiresCustomAppearanceReentry,
} from './customAppearanceService.js';
import {
  getVerifiedGrowthCardContext,
  syncGrowthCardIndex,
  syncGrowthCardIndexForIdentity,
} from './growthCardMemoryService.js';

const ATTR_MAX = 10;

// ---------- backlog #072：「需要照看」的用户可读诊断（脱敏） ----------

export type QcaDiagnosisAction = {
  id: 'check_pat' | 'check_credits' | 'repair';
  label: string;
  href?: string;
};

export type QcaDiagnosis = {
  summary: string;
  causes: string[];
  actions: QcaDiagnosisAction[];
  checked_at: string | null;
};

/** 诊断组件白名单：健康检查 details 的 key → 用户可读名称。名单之外的 key 一律丢弃。 */
const DIAGNOSIS_COMPONENT_LABELS: Record<string, string> = {
  environment: '探险环境',
  agent: '旅行代理',
  memory_store: '记忆小屋',
  deployment: '定时探险任务',
  identity: '云端身份',
  schedule: '探险日程',
  template: '探险模板',
};

/**
 * 由健康检查快照构造「需要照看」诊断。
 * 脱敏硬约束：输出只由本文件内的固定文案拼装——details 的 value 仅用于判断
 * 'missing' | 'error' 两种状态，任何原始字符串（PAT/错误栈/QCA 响应体）都不会透传。
 */
export function buildBrokenDiagnosis(input: {
  details?: unknown;
  patInvalid?: boolean;
  creditsAlert?: boolean;
  checkedAt?: string | null;
}): QcaDiagnosis {
  const causes: string[] = [];
  if (input.patInvalid) causes.push('Qoder 契约（PAT）已失效或未绑定，云端能力暂时用不了');
  if (input.creditsAlert) causes.push('云端能量（Credits）不足');
  if (input.details && typeof input.details === 'object' && !Array.isArray(input.details)) {
    for (const [key, label] of Object.entries(DIAGNOSIS_COMPONENT_LABELS)) {
      const state = (input.details as Record<string, unknown>)[key];
      if (state === 'missing') causes.push(`${label}缺失`);
      else if (state === 'error') causes.push(`${label}检查没通过`);
    }
  }
  if (causes.length === 0) causes.push('云端资源检查没通过，具体原因还在确认');
  return {
    summary: '小猫的云端资源检查没通过，需要你照看一下。多数情况可以自助修复：检查 PAT 是否有效、Credits 是否充足，或试试一键修复。',
    causes,
    actions: [
      { id: 'check_pat', label: '检查 / 更换 PAT' },
      { id: 'check_credits', label: '查看 Credits 余额', href: 'https://qoder.com/pricing' },
      { id: 'repair', label: '一键修复' },
    ],
    checked_at: input.checkedAt ?? null,
  };
}

/**
 * 档案接口只下发 qca_health 的白名单字段（status + 重建的 credits alert）。
 * 防御性脱敏：即使健康缓存里被写入原始错误/响应体，也不会透传给前端；
 * status 也走枚举白名单，未知值一律归一为 'unknown'。
 */
const CLIENT_QCA_HEALTH_STATUSES = new Set(['healthy', 'broken', 'unknown', 'not_started']);

function sanitizeQcaHealthForClient(health: { status?: unknown; alert?: { code?: unknown; source?: unknown } }) {
  const status = typeof health.status === 'string' && CLIENT_QCA_HEALTH_STATUSES.has(health.status)
    ? health.status
    : 'unknown';
  const alertSource = health.alert?.code === QCA_CREDITS_UNAVAILABLE ? health.alert.source : undefined;
  const alert = alertSource === 'image' || alertSource === 'travel' || alertSource === 'chat'
    ? toQcaUserAlert(alertSource)
    : health.alert?.code === QCA_CREDITS_UNAVAILABLE ? toQcaUserAlert('travel') : undefined;
  return { status, ...(alert ? { alert } : {}) };
}

function travelMemoryBootstrapParams(cat: CatRow, ownerNickname: string, serverUrl: string, catToken: string) {
  return {
    serverUrl,
    catToken,
    catName: cat.name,
    personality: cat.personality,
    ownerNickname,
    attrs: {
      courage: cat.attr_courage,
      curiosity: cat.attr_curiosity,
      affinity: cat.attr_affinity,
      insight: cat.attr_insight,
    },
  };
}

async function primeTravelRun(
  pat: QcaCredential,
  cat: CatRow,
  resources: { memstoreId: string; deploymentId: string },
  ownerNickname: string,
) {
  const serverUrl = config.catApiPublicUrl;
  const catToken = generateCatToken();
  await updateDeploymentTask(pat, resources.deploymentId, renderDailyTravelTask(cat.name, serverUrl), catToken);
  await bootstrapTravelMemory(pat, resources.memstoreId, travelMemoryBootstrapParams(cat, ownerNickname, serverUrl, catToken));
  await db.updateTable('cats').set({
    cat_token_hash: hashToken(catToken),
    updated_at: new Date().toISOString(),
  }).where('id', '=', cat.id).execute();
}

/** 无有效天性时按名字+性格哈希派生（天性不再由用户手动分配） */
function deriveAttrsFromSeed(name: string, personality: string) {
  let h = 0;
  const s = `${name}:${personality}`;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  const pick = (shift: number) => 3 + (Math.abs(h >> shift) % 5); // 3~7
  return { courage: pick(0), curiosity: pick(5), affinity: pick(10), insight: pick(15) };
}

function isValidAttrs(a: unknown): a is { courage: number; curiosity: number; affinity: number; insight: number } {
  if (!a || typeof a !== 'object') return false;
  const o = a as Record<string, unknown>;
  return ['courage', 'curiosity', 'affinity', 'insight'].every(
    (k) => typeof o[k] === 'number' && Number.isInteger(o[k]) && (o[k] as number) >= 0 && (o[k] as number) <= ATTR_MAX
  );
}

export async function getPatForUser(userId: string): Promise<QcaCredential | null> {
  const row = await db.selectFrom('pat_credentials').select(['encrypted_pat', 'qca_site', 'status']).where('user_id', '=', userId).executeTakeFirst();
  if (!row || row.status !== 'valid') return null;
  return { pat: decryptPat(row.encrypted_pat), site: row.qca_site as QcaCredential['site'], userId };
}

export async function savePat(userId: string, credential: QcaCredential, hint: string) {
  const now = new Date().toISOString();
  await db.insertInto('pat_credentials').values({
    id: uuid(), user_id: userId, encrypted_pat: encryptPat(credential.pat), pat_hint: hint,
    qca_site: credential.site, status: 'valid', last_verified_at: now,
  }).onConflict((oc) => oc.column('user_id').doUpdateSet({
    encrypted_pat: encryptPat(credential.pat), pat_hint: hint, qca_site: credential.site,
    status: 'valid', last_verified_at: now, updated_at: now,
  })).execute();
}

export function getPatStatus(userId: string) {
  return db.selectFrom('pat_credentials').select(['status', 'pat_hint', 'qca_site', 'last_verified_at']).where('user_id', '=', userId).executeTakeFirst();
}

export function deletePat(userId: string) {
  return db.deleteFrom('pat_credentials').where('user_id', '=', userId).execute();
}

export async function getCatByUserId(userId: string): Promise<CatRow | undefined> {
  return await db.selectFrom('cats').selectAll().where('user_id', '=', userId).executeTakeFirst() as CatRow | undefined;
}

export async function getCatByTokenHash(hash: string): Promise<CatRow | undefined> {
  return await db.selectFrom('cats').selectAll().where('cat_token_hash', '=', hash).where('status', '=', 'active').executeTakeFirst() as CatRow | undefined;
}

function catHasTravelResources(cat: CatRow) {
  if (catUsesForwardTravel(cat)) {
    return Boolean(cat.qca_forward_identity_id && cat.qca_forward_schedule_id);
  }
  return Boolean(cat.qca_agent_id && cat.qca_deployment_id);
}

async function formatCat(row: CatRow, extras?: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    personality: row.personality,
    attrs: {
      courage: row.attr_courage,
      curiosity: row.attr_curiosity,
      affinity: row.attr_affinity,
      insight: row.attr_insight,
    },
    appearance: JSON.parse(row.appearance),
    current_image_url: await getCurrentImageUrl(row.id),
    appearance_status: (row as CatRow & { appearance_status?: string }).appearance_status || 'pending',
    lifecycle_stage: row.lifecycle_stage,
    selected_birth_appearance_id: row.selected_birth_appearance_id,
    appearance_confirmed_at: row.appearance_confirmed_at,
    adventure_started_at: row.adventure_started_at,
    travel_schedule_enabled: Boolean(row.travel_schedule_enabled),
    can_start_adventure: row.lifecycle_stage === 'world' && !row.travel_schedule_enabled,
    wandering_mode: Boolean(row.wandering_mode),
    travel_wish_location_id: row.travel_wish_location_id || null,
    outfit: JSON.parse(row.outfit),
    status: row.status,
    qca: {
      model: row.qca_model,
      env_id: row.qca_env_id,
      agent_id: row.qca_agent_id,
      memstore_id: row.qca_memstore_id,
      deployment_id: row.qca_deployment_id,
      image_env_id: row.qca_image_env_id,
      image_agent_id: row.qca_image_agent_id,
      forward_mode: catUsesForwardTravel(row),
      forward_travel_template_id: row.qca_forward_travel_template_id,
      forward_chat_template_id: row.qca_forward_chat_template_id,
      forward_im_channel_id: row.qca_forward_im_channel_id,
      forward_identity_id: row.qca_forward_identity_id,
      forward_schedule_id: row.qca_forward_schedule_id,
    },
    created_at: row.created_at,
    ...extras,
  };
}

export async function getCatProfile(userId: string) {
  const cat = await getCatByUserId(userId);
  if (!cat) return null;

  let qcaHealth = cat.qca_health_cache ? JSON.parse(cat.qca_health_cache) : { status: 'unknown' };
  const adventurePresence = (qcaHealth.adventure_presence ?? { phase: 'idle' }) as AdventurePresence;
  const checkedAt = cat.qca_health_checked_at;
  const ttlMs = 2 * 60 * 1000;
  const presenceTtlMs = 30 * 1000;
  const stale = !checkedAt || Date.now() - new Date(checkedAt).getTime() > ttlMs;
  const presenceStale = !adventurePresence.checked_at
    || Date.now() - new Date(adventurePresence.checked_at).getTime() > presenceTtlMs;

  if (!catHasTravelResources(cat)) {
    qcaHealth = { status: 'not_started' };
  } else if (stale || (cat.travel_schedule_enabled && presenceStale)) {
    refreshQcaSnapshotAsync(userId, cat.id);
  }

  const today = shanghaiDate();
  const [hasTravelToday, items, appearance_history, appearance_candidates, latestImageJob, patRow, appearance_repaint] = await Promise.all([
    db.selectFrom('travels').select('id').where('cat_id', '=', cat.id).where('travel_date', '=', today).executeTakeFirst(),
    listCatItems(cat.id), listAppearanceHistory(cat.id), listBirthCandidates(cat.id),
    db.selectFrom('image_jobs').select(['kind', 'status', 'last_error']).where('cat_id', '=', cat.id)
      .orderBy('created_at', 'desc').orderBy('updated_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst(),
    db.selectFrom('pat_credentials').select('status').where('user_id', '=', userId).executeTakeFirst(),
    getAppearanceRepaintState(cat),
  ]);
  let effectivePresence = adventurePresence;
  if (hasTravelToday && effectivePresence.phase === 'failed') {
    effectivePresence = { ...effectivePresence, phase: 'idle', checked_at: new Date().toISOString() };
  }
  // #099：QCA 只负责“是否正在运行”；目的地来自服务端校验后的独立业务列。
  // 只在同一上海日期、尚无最终 travel、且 presence=running 时投影，跨日/失败/完成都不冒充事实。
  if (!hasTravelToday
    && effectivePresence.phase === 'running'
    && cat.current_destination_location_id
    && cat.current_destination_selected_on === today
    && cat.current_destination_selected_at) {
    const destination = await db.selectFrom('world_locations').select(['id', 'name'])
      .where('id', '=', cat.current_destination_location_id).where('status', '=', 'active').executeTakeFirst();
    if (destination) {
      effectivePresence = {
        ...effectivePresence,
        destination: {
          location_id: destination.id,
          name: destination.name,
          selected_at: cat.current_destination_selected_at,
        },
      };
    }
  }
  const customAppearanceReentryRequired = latestImageJob?.status === 'failed'
    && requiresCustomAppearanceReentry(latestImageJob.last_error);
  const imageGenerationAlert = latestImageJob?.status === 'failed'
    && !customAppearanceReentryRequired
    && latestImageJob.last_error?.startsWith(QCA_CREDITS_UNAVAILABLE)
    ? toQcaUserAlert('image')
    : undefined;
  const imageGenerationError = latestImageJob?.status === 'failed' && !imageGenerationAlert
    ? customAppearanceReentryRequired ? {
        code: 'CUSTOM_APPEARANCE_REENTRY_REQUIRED',
        message: '这次没有画成功，自定义外貌描述已安全清除，请重新填写后再画一张。',
      } : {
        code: latestImageJob.last_error?.startsWith('IMAGE_SESSION_TIMEOUT') ? 'IMAGE_SESSION_TIMEOUT' : 'IMAGE_GENERATION_FAILED',
        message: latestImageJob.last_error?.startsWith('IMAGE_SESSION_TIMEOUT')
          ? '云端画师等待超时了，请再画一张。'
          : '这次没有画成功，请再画一张。',
      }
    : latestImageJob?.status === 'canceled'
      ? { code: 'IMAGE_JOB_CANCELED', message: '绘制已取消，你可以修改外观或再画一张。' }
      : undefined;
  // #072：qca_health 只下发白名单字段；broken 时同时下发脱敏诊断（红点必有可读出口）
  const clientQcaHealth = sanitizeQcaHealthForClient(qcaHealth as { status?: unknown; alert?: { code?: unknown; source?: unknown } });
  const isBroken = cat.status === 'broken' || clientQcaHealth.status === 'broken';
  const qcaDiagnosis = isBroken
    ? buildBrokenDiagnosis({
        details: (qcaHealth as { details?: unknown }).details,
        patInvalid: !patRow || patRow.status !== 'valid',
        creditsAlert: Boolean(clientQcaHealth.alert) || Boolean(imageGenerationAlert),
        checkedAt,
      })
    : undefined;
  return formatCat(cat, {
    qca_health: clientQcaHealth,
    qca_health_checked_at: checkedAt,
    ...(qcaDiagnosis ? { qca_diagnosis: qcaDiagnosis } : {}),
    adventure_presence: effectivePresence,
    items,
    appearance_history,
    appearance_candidates,
    // #077：形象确认后的重画申诉状态（入口可见性 / 剩余次数 / 待确认的新形象 / 消耗告知）
    appearance_repaint,
    image_generation_alert: imageGenerationAlert,
    image_generation_error: imageGenerationError,
  });
}

export type QcaHealthStatus = 'healthy' | 'broken' | 'unknown' | 'not_started';

export type RepairTravelAudit = {
  mode: 'build' | 'forward';
  health_before: QcaHealthStatus;
  health_after: QcaHealthStatus;
};

function cachedQcaHealth(raw: string | null): { status: QcaHealthStatus; credits_recovered_at?: string } {
  if (!raw) return { status: 'unknown' };
  try {
    const parsed = JSON.parse(raw) as { status?: unknown; credits_recovered_at?: unknown };
    const status = typeof parsed.status === 'string' && CLIENT_QCA_HEALTH_STATUSES.has(parsed.status)
      ? parsed.status as QcaHealthStatus
      : 'unknown';
    return {
      status,
      ...(typeof parsed.credits_recovered_at === 'string'
        ? { credits_recovered_at: parsed.credits_recovered_at }
        : {}),
    };
  } catch {
    return { status: 'unknown' };
  }
}

/**
 * QCA 健康检查到 cats.status 的唯一状态转移。
 * 只有 active/broken 属于健康检查管理域；recalled 与任何其它终态都原样保留。
 */
export function catStatusAfterQcaHealth(currentStatus: string, healthStatus: QcaHealthStatus) {
  if (currentStatus !== 'active' && currentStatus !== 'broken') return currentStatus;
  if (healthStatus === 'broken') return 'broken';
  if (healthStatus === 'healthy') return 'active';
  return currentStatus;
}

async function persistQcaSnapshot(
  catId: string,
  snapshot: Record<string, unknown>,
  healthStatus: QcaHealthStatus,
) {
  return db.transaction().execute(async (trx) => {
    let statusQuery = trx.selectFrom('cats').select('status').where('id', '=', catId);
    if (config.dbDialect === 'postgres') statusQuery = statusQuery.forUpdate();
    const current = await statusQuery.executeTakeFirstOrThrow();
    await trx.updateTable('cats').set({
      qca_health_cache: JSON.stringify(snapshot),
      qca_health_checked_at: new Date().toISOString(),
      status: catStatusAfterQcaHealth(current.status, healthStatus),
    }).where('id', '=', catId).execute();
  });
}

async function refreshQcaSnapshot(userId: string, catId: string) {
  const pat = await getPatForUser(userId);
  const cat = await db.selectFrom('cats').selectAll().where('id', '=', catId).executeTakeFirst() as CatRow | undefined;
  if (!pat || !cat) return null;

  try {
    const cachedHealth = cachedQcaHealth(cat.qca_health_cache);
    const creditsRecoveredAt = cachedHealth.credits_recovered_at;
    const today = shanghaiDate();
    const hasTravelToday = await db.selectFrom('travels').select('id')
      .where('cat_id', '=', catId).where('travel_date', '=', today).executeTakeFirst();

    const health = catUsesForwardTravel(cat)
      ? await checkForwardTravelHealth(pat, {
          identityId: cat.qca_forward_identity_id,
          scheduleId: cat.qca_forward_schedule_id,
          travelTemplateId: cat.qca_forward_travel_template_id,
          envId: cat.qca_env_id,
          memstoreId: cat.qca_memstore_id,
        })
      : await checkResourceHealth(pat, {
          envId: cat.qca_env_id,
          agentId: cat.qca_agent_id,
          memstoreId: cat.qca_memstore_id,
          deploymentId: cat.qca_deployment_id,
        }, { creditsRecoveredAt });

    let adventure_presence: AdventurePresence = { phase: 'idle', checked_at: new Date().toISOString() };
    if (catUsesForwardTravel(cat) && cat.qca_forward_schedule_id && cat.qca_forward_identity_id) {
      try {
        adventure_presence = await fetchForwardAdventurePresence(pat, {
          identityId: cat.qca_forward_identity_id,
          scheduleId: cat.qca_forward_schedule_id,
          hasTravelToday: Boolean(hasTravelToday),
        });
      } catch {
        adventure_presence = { phase: 'idle', checked_at: new Date().toISOString() };
      }
    } else if (cat.qca_deployment_id) {
      try {
        adventure_presence = await fetchAdventurePresence(pat, cat.qca_deployment_id, {
          hasTravelToday: Boolean(hasTravelToday),
          travelSessionId: cat.qca_travel_session_id,
        });
      } catch {
        adventure_presence = { phase: 'idle', checked_at: new Date().toISOString() };
      }
    }

    if (Boolean(hasTravelToday) && adventure_presence.phase === 'failed') {
      adventure_presence = { ...adventure_presence, phase: 'idle' };
    }

    const forwardAlert = catUsesForwardTravel(cat)
      ? await resolveForwardTravelAccessAlert(pat, cat.qca_forward_identity_id, cat.qca_forward_schedule_id, creditsRecoveredAt)
      : undefined;
    const buildAlert = 'alert' in health ? health.alert : undefined;
    const snapshot = {
      ...health,
      ...(forwardAlert ? { alert: forwardAlert } : buildAlert ? { alert: buildAlert } : {}),
      adventure_presence,
      ...(creditsRecoveredAt ? { credits_recovered_at: creditsRecoveredAt } : {}),
    };
    const healthStatus = CLIENT_QCA_HEALTH_STATUSES.has(health.status) ? health.status as QcaHealthStatus : 'unknown';
    await persistQcaSnapshot(catId, snapshot, healthStatus);
    return snapshot;
  } catch {
    const cachedHealth = cachedQcaHealth(cat.qca_health_cache);
    await persistQcaSnapshot(catId, {
      status: 'unknown',
      adventure_presence: { phase: 'idle', checked_at: new Date().toISOString() },
      ...(cachedHealth.credits_recovered_at ? { credits_recovered_at: cachedHealth.credits_recovered_at } : {}),
    }, 'unknown');
    return null;
  }
}

function refreshQcaSnapshotAsync(userId: string, catId: string) {
  setImmediate(() => {
    void refreshQcaSnapshot(userId, catId);
  });
}

export async function createCat(
  userId: string,
  input: {
    name: string;
    personality: string;
    model: string;
    /** 可选：由前端根据性格标签推导；缺省/非法时服务端按种子派生 */
    attrs?: { courage: number; curiosity: number; affinity: number; insight: number };
    appearance?: Appearance;
    custom_description?: string;
  }
) {
  if (await getCatByUserId(userId)) throw Object.assign(new Error('已有猫'), { code: 'CAT_EXISTS' });
  // 在任何 QCA 查询/资源创建前校验，恶意/越界输入不能先产生外部副作用再失败。
  const customDescription = normalizeCustomAppearanceDescription(input.custom_description);
  const pat = await getPatForUser(userId);
  if (!pat) throw Object.assign(new Error('请先填入 PAT'), { code: 'NO_PAT' });
  if (!input.model) throw Object.assign(new Error('请选择小猫模型'), { code: 'QCA_MODEL_REQUIRED' });
  const model = await resolveQcaAgentModel(pat, input.model);

  const attrs = isValidAttrs(input.attrs) ? input.attrs : deriveAttrsFromSeed(input.name, input.personality);

  const catToken = generateCatToken();
  const appearance = isValidAppearance(input.appearance)
    ? input.appearance
    : generateAppearance(input.name, input.personality);
  const catId = uuid();

  let imageResources: Awaited<ReturnType<typeof createImageArtistResources>> | undefined;
  try {
    imageResources = await createImageArtistResources(pat, input.name, catId.slice(0, 8), model);
    await db.insertInto('cats').values({
      id: catId, user_id: userId, name: input.name, personality: input.personality,
      attr_courage: attrs.courage, attr_curiosity: attrs.curiosity, attr_affinity: attrs.affinity, attr_insight: attrs.insight,
      qca_image_env_id: imageResources.envId, qca_image_agent_id: imageResources.agentId,
      qca_model: model,
      image_identity_anchor: null, cat_token_hash: hashToken(catToken), appearance: JSON.stringify(appearance),
      outfit: JSON.stringify({ head: null, neck: null, back: null }), status: 'active',
      appearance_status: 'pending', lifecycle_stage: 'appearance', travel_schedule_enabled: 0,
    }).execute();
  } catch (e) {
    if (imageResources) await archiveImageArtistResources(pat, imageResources);
    throw e;
  }

  await enqueueBirthCandidate(catId, customDescription);

  return { cat: await formatCat((await getCatByUserId(userId))!), catToken };
}

/**
 * 换 model 的资源影响面只有画师（#084 边界核实）：
 * - 画师 `qca_image_env_id`/`qca_image_agent_id` 是持久化资源、创建时就绑定 model，必须重建 + 归档旧的；
 * - 主 agent / 聊天 / 旅行都是读时把 `cat.qca_model` 当参数传给 Forward 模板（chatService.ts、下方 setupForwardChatAndIm
 *   等处），不持有 model 状态，因此一律不重建、不触碰。
 * requestedModel 与当前一致时原样早退（不去校验可用性）——Credits 耗尽只剩 Lite 时，
 * 「按当前模型再画一张」不应该因为校验而变成报错。
 */
async function switchImageArtistModel(cat: CatRow, pat: QcaCredential, requestedModel: string) {
  if (requestedModel === cat.qca_model) return { model: cat.qca_model, rebuilt: false as const };
  const model = await resolveQcaAgentModel(pat, requestedModel);
  const replacement = await createImageArtistResources(pat, cat.name, `${cat.id.slice(0, 8)}-${Date.now()}`, model);
  const previous = cat.qca_image_env_id && cat.qca_image_agent_id
    ? { envId: cat.qca_image_env_id, agentId: cat.qca_image_agent_id }
    : null;
  // 乐观并发（首轮独立验收发现画师泄漏、二轮发现 ABA）：createImageArtistResources 是真实 QCA
  // 网络调用、耗时可观，两个并发换 model 请求会各建一个画师，而后写的 UPDATE 覆盖先写的——
  // 先写那个画师就**永久孤立在用户 QCA 账号里**（既不在库、也不会被归档）。
  //
  // 令牌用 `qca_image_env_id` 而非 `qca_model`（二轮验收实测的 ABA）：qca_model 是**可回退的值**，
  // A 在途期间 B(ultimate→lite)、C(lite→ultimate) 先后完成后它回到 A 读到的旧值，条件重新成立，
  // A 就覆盖掉 C 的画师、C 的画师从未被归档。而画师 id 每次创建必不同，不存在回退，可作真令牌。
  // null 分支（历史猫 qca_image_env_id 为 NULL）单独走 `is null`。
  const updated = await db.updateTable('cats').set({
    qca_model: model,
    qca_image_env_id: replacement.envId,
    qca_image_agent_id: replacement.agentId,
    updated_at: new Date().toISOString(),
  })
    .where('id', '=', cat.id)
    .where((eb) => cat.qca_image_env_id === null
      ? eb('qca_image_env_id', 'is', null)
      : eb('qca_image_env_id', '=', cat.qca_image_env_id))
    .executeTakeFirst();
  if (!Number(updated?.numUpdatedRows ?? 0)) {
    // 并发败者：先自清刚建的画师，避免泄漏。
    await archiveImageArtistResources(pat, { envId: replacement.envId, agentId: replacement.agentId });
    const fresh = await db.selectFrom('cats').select('qca_model').where('id', '=', cat.id).executeTakeFirst();
    // 二轮验收指出的静默丢弃：若并发赢家换到的是**别的** model，败者原先一律回
    // `model_changed:false` + 实况，于是用户选了 Ultimate 却收到「Lite 就是当前的模型，没有变化」
    // ——请求被静默丢弃还被「没有变化」掩盖。故此时明确报冲突让前端可重试；
    // 只有实况恰好等于用户所请求的 model 时，才按幂等回报「已是该模型」。
    if (fresh?.qca_model !== model) {
      throw Object.assign(
        new Error('刚刚有另一次模型更换先完成了，请刷新看看当前模型再决定是否重新更换'),
        { code: 'MODEL_CHANGE_CONFLICT' },
      );
    }
    return { model: fresh.qca_model, rebuilt: false as const };
  }
  if (previous) await archiveImageArtistResources(pat, previous);
  return { model, rebuilt: true as const };
}

/**
 * #084：形象确认后更换模型——建猫向导之外唯一的更换入口。
 * model 影响生图与对话质量、也影响 Credits 消耗，属于用户会反复调整的设置项，
 * 而此前只有建猫向导的一次性选择（`createCat` / `regenerateBirthAppearance`）。
 */
export async function changeCatModel(userId: string, requestedModel: string) {
  const cat = await getCatByUserId(userId);
  if (!cat) throw Object.assign(new Error('没有小猫'), { code: 'NO_CAT' });
  const requested = requestedModel?.trim();
  if (!requested) throw Object.assign(new Error('请选择小猫模型'), { code: 'QCA_MODEL_REQUIRED' });
  const pat = await getPatForUser(userId);
  if (!pat) throw Object.assign(new Error('请先填入 PAT'), { code: 'NO_PAT' });

  // 旧画师会被归档，正在生成的图片（出生图或旅行照片）都会被半途换掉画师——
  // 与「换 PAT 前先等图画完」同一守则，任何在跑的 image job 都先拒绝。
  const activeJob = await db.selectFrom('image_jobs').select('id').where('cat_id', '=', cat.id)
    .where('status', 'in', ['pending', 'running']).executeTakeFirst();
  if (activeJob) throw Object.assign(new Error('还有图片正在生成，等它画完再换模型'), { code: 'IMAGE_JOB_ACTIVE' });

  const { rebuilt } = await switchImageArtistModel(cat, pat, requested);
  // 不触发健康复检：qca_health 只体检旅行资源（env/agent/memstore/deployment），
  // 画师不在其中，换 model 也不动旅行资源，多跑一次只是白费一轮 QCA 调用。
  return formatCat((await getCatByUserId(userId))!, { model_changed: rebuilt });
}

export async function regenerateBirthAppearance(userId: string, requestedModel?: string, customDescriptionInput?: string) {
  const cat = await getCatByUserId(userId);
  if (!cat) throw Object.assign(new Error('没有小猫'), { code: 'NO_CAT' });
  if (cat.lifecycle_stage !== 'appearance') {
    throw Object.assign(new Error('形象已经确认，不能继续重画'), { code: 'APPEARANCE_CONFIRMED' });
  }
  const activeJob = await db.selectFrom('image_jobs').select('id').where('cat_id', '=', cat.id)
    .where('kind', '=', 'birth').where('status', 'in', ['pending', 'running']).executeTakeFirst();
  if (activeJob) throw Object.assign(new Error('上一张图片仍在生成，请稍候'), { code: 'IMAGE_JOB_ACTIVE' });

  const pat = await getPatForUser(userId);
  if (!pat) throw Object.assign(new Error('请先填入 PAT'), { code: 'NO_PAT' });
  const customDescription = normalizeCustomAppearanceDescription(customDescriptionInput);
  // 重画时顺带换 model 与设置面板的「更换模型」共用同一段画师重建逻辑（#084 抽出）
  if (requestedModel) await switchImageArtistModel(cat, pat, requestedModel);

  const appearanceId = await enqueueBirthCandidate(cat.id, customDescription);
  await db.updateTable('cats').set({ appearance_status: 'pending', updated_at: new Date().toISOString() })
    .where('id', '=', cat.id).execute();
  return { ok: true, appearance_id: appearanceId, status: 'pending' };
}

// ---------- backlog #077：形象确认后的「重画申诉」（肢体异常等生图事故的自助出口） ----------

/**
 * 重画申诉次数上限。保守取 2：真实事故（五只脚/多余肢体）通常一两次即可拿到正常图，
 * 上限之外仍有运营兜底；重画消耗用户自己的 QCA Credits，限次是防「刷图」而非防修复。
 */
export const APPEARANCE_REPAINT_LIMIT = 2;

/** 事前告知文案：入口与请求响应都带上，用户在点之前就知道消耗自己的 Credits。 */
export const APPEARANCE_REPAINT_CREDITS_NOTICE =
  '重画会请云端画师重新画一张定妆照，消耗你自己的 Qoder Credits。新图画好后要你亲自确认才会替换主形象，你也可以保留原来的它。';

export type AppearanceRepaintState = {
  /** 入口是否可见：形象已确认（lifecycle_stage 非 appearance）才给这条申诉路径 */
  eligible: boolean;
  used: number;
  limit: number;
  remaining: number;
  /** 已有绘制任务在跑（复用既有活跃 job 校验语义），此时不能再发起 */
  image_job_active: boolean;
  /** 画好、等用户决定替换还是保留原图的候选图；有它时必须先决定 */
  pending_candidate: { id: string; image_url: string; created_at: string } | null;
  credits_notice: string;
};

/**
 * 已消耗的重画次数 = 已交付、正在进行、或用户主动取消的重画任务数。
 *
 * 计入 pending/running/succeeded/canceled，只排除 failed：
 * - succeeded：图画出来了、Credits 花掉了，即使用户最后选择保留原图也必须计入，
 *   否则「反复重画直到满意」可以无限循环；
 * - pending/running：占用中的额度，防并发绕过；
 * - **canceled 必须计入**（首轮独立验收发现的绕过路径）：`appearance/cancel` 是用户
 *   可自行触发的端点，而取消发生在图**已经开画之后**——云端可能已消耗 Credits。
 *   若不计入，用户只需「发起 → 取消」循环即可无限刷图（验收行为探针实测在上限 2 的
 *   声明下拿到 6 次），正是 backlog #077 要防的滥用形状；
 * - failed 不计入：云端没交付任何图，属系统侧失败，不该让用户承担额度损失。
 */
async function countRepaintAttempts(catId: string) {
  const row = await db.selectFrom('image_jobs')
    .select(({ fn }) => fn.count<number>('id').as('count'))
    .where('cat_id', '=', catId)
    .where('kind', '=', 'birth')
    .where('appearance_id', 'like', `${REPAINT_APPEARANCE_ID_PREFIX}%`)
    .where('status', 'in', ['pending', 'running', 'succeeded', 'canceled'])
    .executeTakeFirst();
  // count() 在 PG 下返回 bigint 字符串、SQLite 下返回 number——统一成 number
  return Number(row?.count || 0);
}

async function getAppearanceRepaintState(cat: CatRow): Promise<AppearanceRepaintState> {
  const eligible = cat.lifecycle_stage !== 'appearance';
  if (!eligible) {
    return {
      eligible: false, used: 0, limit: APPEARANCE_REPAINT_LIMIT, remaining: APPEARANCE_REPAINT_LIMIT,
      image_job_active: false, pending_candidate: null, credits_notice: APPEARANCE_REPAINT_CREDITS_NOTICE,
    };
  }
  const [used, activeJob, pendingCandidate] = await Promise.all([
    countRepaintAttempts(cat.id),
    db.selectFrom('image_jobs').select('id').where('cat_id', '=', cat.id)
      .where('kind', '=', 'birth').where('status', 'in', ['pending', 'running']).executeTakeFirst(),
    findPendingRepaintCandidate(cat.id),
  ]);
  return {
    eligible: true,
    used,
    limit: APPEARANCE_REPAINT_LIMIT,
    remaining: Math.max(0, APPEARANCE_REPAINT_LIMIT - used),
    image_job_active: Boolean(activeJob),
    pending_candidate: pendingCandidate,
    credits_notice: APPEARANCE_REPAINT_CREDITS_NOTICE,
  };
}

/**
 * 发起重画申诉：排一张新的出生图候选，**不替换**主形象。
 * 复用 image_jobs 队列（去重键、超时恢复、活跃 job 校验都是既有机制），只是候选 id 带
 * repaint- 前缀以便识别与限次。
 */
export async function requestAppearanceRepaint(userId: string, customDescriptionInput?: string) {
  const customDescription = normalizeCustomAppearanceDescription(customDescriptionInput);
  const cat = await getCatByUserId(userId);
  if (!cat) throw Object.assign(new Error('没有小猫'), { code: 'NO_CAT' });
  if (cat.lifecycle_stage === 'appearance') {
    throw Object.assign(new Error('形象还没确认，直接在建猫流程里重画就好'), { code: 'APPEARANCE_NOT_CONFIRMED' });
  }
  const state = await getAppearanceRepaintState(cat);
  if (state.pending_candidate) {
    throw Object.assign(new Error('上一张重画的新形象还等着你决定，先确认替换或保留原来的它'), { code: 'REPAINT_DECISION_PENDING' });
  }
  if (state.image_job_active) {
    throw Object.assign(new Error('上一张图片仍在生成，请稍候'), { code: 'IMAGE_JOB_ACTIVE' });
  }
  if (state.remaining <= 0) {
    throw Object.assign(new Error('重画次数已经用完了。如果它还是画得不对，来「给世界写信」告诉我们，我们帮你看看'), { code: 'REPAINT_LIMIT_REACHED' });
  }
  const pat = await getPatForUser(userId);
  if (!pat) throw Object.assign(new Error('请先填入 PAT'), { code: 'NO_PAT' });

  const appearanceId = await enqueueRepaintCandidate(cat.id, customDescription);
  await db.updateTable('cats').set({ appearance_status: 'pending', updated_at: new Date().toISOString() })
    .where('id', '=', cat.id).execute();
  const refreshed = await getCatByUserId(userId);
  return {
    ok: true,
    appearance_id: appearanceId,
    status: 'pending' as const,
    repaint: await getAppearanceRepaintState(refreshed!),
  };
}

/**
 * 用户明确确认后才替换主形象（#024：不静默换猫）。
 * 只接受本猫的、重画产生的、仍待决定的候选；主形象字段与 selection_status 在同一事务里翻转，
 * 老图保留在 cat_appearances（不删对象、不改 lifecycle_stage / 探险状态）。
 */
export async function confirmAppearanceRepaint(userId: string, appearanceId: string) {
  const cat = await getCatByUserId(userId);
  if (!cat) throw Object.assign(new Error('没有小猫'), { code: 'NO_CAT' });
  if (cat.lifecycle_stage === 'appearance') {
    throw Object.assign(new Error('形象还没确认，直接在建猫流程里选就好'), { code: 'APPEARANCE_NOT_CONFIRMED' });
  }
  if (!isRepaintAppearanceId(appearanceId)) {
    throw Object.assign(new Error('这张图不是重画的新形象'), { code: 'REPAINT_CANDIDATE_NOT_FOUND' });
  }
  const selected = await db.selectFrom('cat_appearances').selectAll().where('id', '=', appearanceId)
    .where('cat_id', '=', cat.id).where('kind', '=', 'birth')
    .where('selection_status', '=', 'candidate').executeTakeFirst();
  if (!selected) {
    throw Object.assign(new Error('新形象不存在或已经处理过了'), { code: 'REPAINT_CANDIDATE_NOT_FOUND' });
  }
  const now = new Date().toISOString();
  await db.transaction().execute(async (trx) => {
    // 被换下的主形象标 'replaced' 而不是 'candidate'：若它本身是上一次重画的图（repaint- 前缀），
    // 降级成 candidate 会让它重新被 findPendingRepaintCandidate 认成「等你决定的新形象」，
    // 把用户永久卡在决定态。'replaced' 与 'candidate' 一样不进档案历史（listAppearanceHistory
    // 只收 growth 与 selected），图与 OSS 对象都不删。
    // 同理只降级 selected，不碰 discarded——被放弃过的候选不该复活。
    await trx.updateTable('cat_appearances').set({ selection_status: 'replaced' })
      .where('cat_id', '=', cat.id).where('kind', '=', 'birth')
      .where('selection_status', '=', 'selected').execute();
    await trx.updateTable('cat_appearances').set({ selection_status: 'selected' }).where('id', '=', appearanceId).execute();
    await trx.updateTable('cats').set({
      selected_birth_appearance_id: appearanceId,
      appearance_confirmed_at: now,
      current_image_url: selected.object_key ? `/api/v1/cat-images/${appearanceId}` : selected.image_url || null,
      appearance_status: selected.image_url.includes('placeholder') ? 'placeholder' : 'ready',
      updated_at: now,
    }).where('id', '=', cat.id).execute();
  });
  return getCatProfile(userId);
}

/** 放弃这张重画：保留原来的主形象，新图标记为 discarded（不再等待决定，也不进档案历史）。 */
export async function discardAppearanceRepaint(userId: string) {
  const cat = await getCatByUserId(userId);
  if (!cat) throw Object.assign(new Error('没有小猫'), { code: 'NO_CAT' });
  const pending = await findPendingRepaintCandidate(cat.id);
  if (!pending) throw Object.assign(new Error('没有等待决定的新形象'), { code: 'REPAINT_CANDIDATE_NOT_FOUND' });
  await db.updateTable('cat_appearances').set({ selection_status: 'discarded' })
    .where('id', '=', pending.id).where('cat_id', '=', cat.id).execute();
  return getCatProfile(userId);
}

export async function updateDraftAppearance(userId: string, appearance: Appearance) {
  const cat = await getCatByUserId(userId);
  if (!cat) throw Object.assign(new Error('没有小猫'), { code: 'NO_CAT' });
  if (cat.lifecycle_stage !== 'appearance') {
    throw Object.assign(new Error('形象已经确认，不能修改外观'), { code: 'APPEARANCE_CONFIRMED' });
  }
  if (!isValidAppearance(appearance)) {
    throw Object.assign(new Error('请选择完整有效的外观'), { code: 'INVALID_APPEARANCE' });
  }
  const activeJob = await db.selectFrom('image_jobs').select('id').where('cat_id', '=', cat.id)
    .where('kind', '=', 'birth').where('status', 'in', ['pending', 'running']).executeTakeFirst();
  if (activeJob) throw Object.assign(new Error('请先取消当前绘制'), { code: 'IMAGE_JOB_ACTIVE' });
  await db.updateTable('cats').set({
    appearance: JSON.stringify(appearance), image_identity_anchor: null,
    appearance_status: 'canceled', updated_at: new Date().toISOString(),
  }).where('id', '=', cat.id).execute();
  return getCatProfile(userId);
}

export async function confirmBirthAppearance(userId: string, appearanceId: string) {
  const cat = await getCatByUserId(userId);
  if (!cat) throw Object.assign(new Error('没有小猫'), { code: 'NO_CAT' });
  if (cat.lifecycle_stage !== 'appearance') {
    if (cat.selected_birth_appearance_id === appearanceId) return getCatProfile(userId);
    throw Object.assign(new Error('形象已经确认'), { code: 'APPEARANCE_CONFIRMED' });
  }
  const selected = await db.selectFrom('cat_appearances').selectAll().where('id', '=', appearanceId)
    .where('cat_id', '=', cat.id).where('kind', '=', 'birth').executeTakeFirst();
  if (!selected) throw Object.assign(new Error('候选图片不存在或尚未生成完成'), { code: 'APPEARANCE_NOT_READY' });
  const anchor = buildCatIdentityAnchor({ name: cat.name, appearance: JSON.parse(cat.appearance) as Appearance });
  const now = new Date().toISOString();
  await db.transaction().execute(async (trx) => {
    await trx.updateTable('cat_appearances').set({ selection_status: 'candidate' })
      .where('cat_id', '=', cat.id).where('kind', '=', 'birth').execute();
    await trx.updateTable('cat_appearances').set({ selection_status: 'selected' }).where('id', '=', appearanceId).execute();
    await trx.updateTable('cats').set({
      lifecycle_stage: 'world',
      selected_birth_appearance_id: appearanceId,
      appearance_confirmed_at: now,
      image_identity_anchor: anchor,
      current_image_url: selected.object_key ? `/api/v1/cat-images/${appearanceId}` : selected.image_url || null,
      appearance_status: selected.image_url.includes('placeholder') ? 'placeholder' : 'ready',
      updated_at: now,
    }).where('id', '=', cat.id).execute();
  });
  return getCatProfile(userId);
}

/** 向持久 Travel Session 投递任务（Build 路径；不通过 Deployment run 开新 Session） */
export async function runTravelTaskForCatId(
  catId: string,
  options: { rotateToken?: boolean; refreshHealth?: boolean } = {},
) {
  const cat = await db.selectFrom('cats').selectAll().where('id', '=', catId).executeTakeFirst() as CatRow | undefined;
  if (catUsesForwardTravel(cat ?? {} as CatRow)) {
    return runForwardTravelTaskForCatId(catId, options);
  }
  if (!cat?.qca_agent_id || !cat.qca_env_id || !cat.qca_memstore_id) {
    throw Object.assign(new Error('尚未创建探险资源'), { code: 'NO_TRAVEL_RESOURCES' });
  }
  const pat = await getPatForUser(cat.user_id);
  if (!pat) throw Object.assign(new Error('请先填入 PAT'), { code: 'NO_PAT' });

  const owner = await db.selectFrom('users').select('display_name').where('id', '=', cat.user_id).executeTakeFirstOrThrow();
  const serverUrl = config.catApiPublicUrl;
  const rotateToken = options.rotateToken ?? false;
  let sessionId = cat.qca_travel_session_id;
  let catToken: string | undefined;

  if (rotateToken) {
    catToken = generateCatToken();
    await updateDeploymentTask(
      pat,
      cat.qca_deployment_id!,
      renderDailyTravelTask(cat.name, serverUrl),
      catToken,
    );
    await bootstrapTravelMemory(
      pat,
      cat.qca_memstore_id,
      travelMemoryBootstrapParams(cat, owner.display_name, serverUrl, catToken),
    );
    sessionId = await ensureTravelSession(pat, {
      agentId: cat.qca_agent_id,
      envId: cat.qca_env_id,
      memstoreId: cat.qca_memstore_id,
      serverUrl,
      catToken,
      existingSessionId: cat.qca_travel_session_id,
      forceRecreate: true,
    });
    await db.updateTable('cats').set({
      qca_travel_session_id: sessionId,
      qca_travel_session_token_hash: hashToken(catToken),
      cat_token_hash: hashToken(catToken),
      updated_at: new Date().toISOString(),
    }).where('id', '=', cat.id).execute();
  } else {
    if (!sessionId) {
      throw Object.assign(new Error('旅行 Session 尚未建立，请执行 repair'), { code: 'NO_TRAVEL_SESSION' });
    }
    const status = await getTravelSessionStatus(pat, sessionId);
    if (status.archived_at || status.status === 'archived') {
      throw Object.assign(new Error('旅行 Session 已失效，请执行 repair'), { code: 'TRAVEL_SESSION_INVALID' });
    }
  }

  if (cat.qca_deployment_id) {
    await pauseDeployment(pat, cat.qca_deployment_id).catch(() => undefined);
  }

  await syncGrowthCardIndex(pat, cat.qca_memstore_id, cat.user_id);
  await sendTravelTaskEvent(pat, sessionId!, renderDailyTravelTask(cat.name, serverUrl));
  await db.updateTable('cats').set({
    last_travel_dispatched_on: shanghaiDate(),
    updated_at: new Date().toISOString(),
  }).where('id', '=', cat.id).execute();
  if (options.refreshHealth !== false) {
    await refreshQcaSnapshot(cat.user_id, cat.id).catch(() => undefined);
  }
}

async function setupForwardChatAndIm(
  pat: QcaCredential,
  cat: CatRow,
  owner: { display_name: string },
) {
  if (!config.qcaForwardTravel || !cat.qca_forward_identity_id || !cat.qca_env_id) return;

  const model = cat.qca_model || await resolveQcaAgentModel(pat);
  const chatTemplateId = await ensureForwardChatSetup(pat, {
    catName: cat.name,
    personality: cat.personality,
    attrs: {
      courage: cat.attr_courage,
      curiosity: cat.attr_curiosity,
      affinity: cat.attr_affinity,
      insight: cat.attr_insight,
    },
    ownerNickname: owner.display_name,
    model,
    envId: cat.qca_env_id,
    identityId: cat.qca_forward_identity_id,
    existingChatTemplateId: cat.qca_forward_chat_template_id,
  });
  const imChannelId = await ensureImChannel(pat, {
    identityId: cat.qca_forward_identity_id,
    chatTemplateId,
    displayName: cat.name,
    existingChannelId: cat.qca_forward_im_channel_id,
  });
  const patch: { updated_at: string; qca_forward_chat_template_id?: string; qca_forward_im_channel_id?: string } = {
    updated_at: new Date().toISOString(),
  };
  if (chatTemplateId !== cat.qca_forward_chat_template_id) {
    patch.qca_forward_chat_template_id = chatTemplateId;
  }
  if (imChannelId && imChannelId !== cat.qca_forward_im_channel_id) {
    patch.qca_forward_im_channel_id = imChannelId;
  }
  if (patch.qca_forward_chat_template_id || patch.qca_forward_im_channel_id) {
    await db.updateTable('cats').set(patch).where('id', '=', cat.id).execute();
  }
}

async function migrateBuildCatToForward(
  userId: string,
  cat: CatRow,
  pat: QcaCredential,
  owner: { display_name: string },
) {
  if (!cat.qca_agent_id && !cat.qca_deployment_id) {
    throw Object.assign(new Error('尚未创建探险资源'), { code: 'NO_TRAVEL_RESOURCES' });
  }

  const serverUrl = config.catApiPublicUrl;
  const attrs = {
    courage: cat.attr_courage,
    curiosity: cat.attr_curiosity,
    affinity: cat.attr_affinity,
    insight: cat.attr_insight,
  };
  const systemPrompt = renderCatAgentPrompt({
    catName: cat.name,
    personality: cat.personality,
    attrs,
    ownerNickname: owner.display_name,
  });
  const taskInstruction = renderDailyTravelTask(cat.name, serverUrl);
  const model = cat.qca_model || await resolveQcaAgentModel(pat);
  const catToken = generateCatToken();
  const cron = cat.qca_deployment_id
    ? await readBuildTravelCron(pat, cat.qca_deployment_id)
    : undefined;

  const resources = await ensureForwardTravelResourcesForCat(pat, {
    catId: cat.id,
    catName: cat.name,
    systemPrompt,
    taskInstruction,
    serverUrl,
    catToken,
    model,
    ownerNickname: owner.display_name,
    personality: cat.personality,
    attrs,
    existingEnvId: cat.qca_env_id,
    existingMemstoreId: cat.qca_memstore_id,
    existingTemplateId: cat.qca_forward_travel_template_id,
    existingIdentityId: cat.qca_forward_identity_id,
    existingScheduleId: cat.qca_forward_schedule_id,
    cronExpression: cron?.expression,
    cronTimezone: cron?.timezone,
  });

  const legacyAgentId = cat.qca_agent_id;
  const legacyDeploymentId = cat.qca_deployment_id;
  const recalled = !cat.travel_schedule_enabled || cat.status === 'recalled';

  await db.updateTable('cats').set({
    qca_env_id: resources.envId,
    qca_memstore_id: resources.memstoreId,
    qca_forward_travel_template_id: resources.travelTemplateId,
    qca_forward_identity_id: resources.identityId,
    qca_forward_schedule_id: resources.scheduleId,
    qca_agent_id: null,
    qca_deployment_id: null,
    qca_chat_session_id: null,
    qca_travel_session_id: null,
    qca_travel_session_token_hash: null,
    cat_token_hash: hashToken(catToken),
    qca_forward_travel_session_token_hash: hashToken(catToken),
    updated_at: new Date().toISOString(),
  }).where('id', '=', cat.id).execute();

  await archiveLegacyBuildTravelOnly(pat, {
    agentId: legacyAgentId,
    deploymentId: legacyDeploymentId,
  });

  const migrated = await db.selectFrom('cats').selectAll().where('id', '=', cat.id).executeTakeFirstOrThrow();
  await setupForwardChatAndIm(pat, migrated, owner);

  if (recalled) {
    await pauseForwardSchedule(pat, resources.scheduleId);
  }
}

async function runForwardTravelTaskForCatId(
  catId: string,
  options: { rotateToken?: boolean; refreshHealth?: boolean } = {},
) {
  const cat = await db.selectFrom('cats').selectAll().where('id', '=', catId).executeTakeFirst() as CatRow | undefined;
  if (!cat?.qca_forward_schedule_id || !cat.qca_forward_travel_template_id || !cat.qca_forward_identity_id) {
    throw Object.assign(new Error('尚未创建探险资源'), { code: 'NO_TRAVEL_RESOURCES' });
  }
  const pat = await getPatForUser(cat.user_id);
  if (!pat) throw Object.assign(new Error('请先填入 PAT'), { code: 'NO_PAT' });

  const owner = await db.selectFrom('users').select('display_name').where('id', '=', cat.user_id).executeTakeFirstOrThrow();
  const serverUrl = config.catApiPublicUrl;
  const taskInstruction = renderDailyTravelTask(cat.name, serverUrl);
  const model = cat.qca_model || await resolveQcaAgentModel(pat);
  const growthCardContext = await getVerifiedGrowthCardContext(cat.user_id);
  await upsertForwardIdentityConfig(pat, {
    identityId: cat.qca_forward_identity_id,
    templateId: cat.qca_forward_travel_template_id,
    systemPrompt: `${renderCatAgentPrompt({
      catName: cat.name,
      personality: cat.personality,
      attrs: {
        courage: cat.attr_courage,
        curiosity: cat.attr_curiosity,
        affinity: cat.attr_affinity,
        insight: cat.attr_insight,
      },
      ownerNickname: owner.display_name,
    })}${growthCardContext}`,
    model,
  });
  const rotateToken = options.rotateToken ?? false;
  let catTokenForSync: string | undefined;

  if (rotateToken) {
    const catToken = generateCatToken();
    catTokenForSync = catToken;
    await updateForwardTravelTemplateEnv(pat, cat.qca_forward_travel_template_id, { serverUrl, catToken });
    if (cat.qca_memstore_id && cat.qca_forward_identity_id) {
      await bootstrapForwardTravelMemory(pat, {
        memstoreId: cat.qca_memstore_id,
        identityId: cat.qca_forward_identity_id,
        ...travelMemoryBootstrapParams(cat, owner.display_name, serverUrl, catToken),
      });
    }
    await updateForwardTravelScheduleTask(pat, cat.qca_forward_schedule_id, taskInstruction);
    await db.updateTable('cats').set({
      qca_forward_travel_session_token_hash: hashToken(catToken),
      cat_token_hash: hashToken(catToken),
      updated_at: new Date().toISOString(),
    }).where('id', '=', cat.id).execute();
  } else {
    await updateForwardTravelScheduleTask(pat, cat.qca_forward_schedule_id, taskInstruction);
  }

  if (cat.qca_memstore_id) {
    await syncGrowthCardIndexForIdentity(
      pat,
      cat.qca_memstore_id,
      cat.qca_forward_identity_id,
      cat.user_id,
    );
  }
  const run = await runForwardSchedule(pat, cat.qca_forward_schedule_id);
  const sessionId = typeof run.session_id === 'string' ? run.session_id : cat.qca_forward_travel_session_id;

  let memstoreId = cat.qca_memstore_id;
  if (cat.qca_forward_identity_id && cat.qca_memstore_id && catTokenForSync) {
    memstoreId = await syncIdentityMemoryStoreAfterRun(pat, {
      catId: cat.id,
      catName: cat.name,
      identityId: cat.qca_forward_identity_id,
      memstoreId: cat.qca_memstore_id,
      travelTemplateId: cat.qca_forward_travel_template_id,
      bootstrap: travelMemoryBootstrapParams(cat, owner.display_name, serverUrl, catTokenForSync),
    }).catch(() => cat.qca_memstore_id!);
  }

  if (cat.qca_memstore_id) {
    // 首次 run 可能刚 provision Identity 的 System Default Memory，运行后再补一次索引投影。
    await syncGrowthCardIndexForIdentity(
      pat,
      memstoreId ?? cat.qca_memstore_id,
      cat.qca_forward_identity_id,
      cat.user_id,
    );
  }

  await db.updateTable('cats').set({
    ...(sessionId ? { qca_forward_travel_session_id: sessionId } : {}),
    ...(memstoreId && memstoreId !== cat.qca_memstore_id ? { qca_memstore_id: memstoreId } : {}),
    last_travel_dispatched_on: shanghaiDate(),
    updated_at: new Date().toISOString(),
  }).where('id', '=', cat.id).execute();
  if (options.refreshHealth !== false) {
    await refreshQcaSnapshot(cat.user_id, cat.id).catch(() => undefined);
  }
}

export async function restoreForwardAdventureStartAfterFailure(catId: string, clearForwardResources: boolean) {
  await db.updateTable('cats').set({
    lifecycle_stage: 'world',
    ...(clearForwardResources ? {
      qca_env_id: null,
      qca_memstore_id: null,
      qca_forward_travel_template_id: null,
      qca_forward_identity_id: null,
      qca_forward_schedule_id: null,
      qca_forward_travel_session_id: null,
      qca_forward_travel_session_token_hash: null,
    } : {}),
    updated_at: new Date().toISOString(),
  }).where('id', '=', catId)
    .where('travel_schedule_enabled', '=', 0)
    .where('lifecycle_stage', '=', 'adventure_starting')
    .execute();
}

export async function startAdventure(userId: string) {
  const cat = await getCatByUserId(userId);
  if (!cat) throw Object.assign(new Error('没有小猫'), { code: 'NO_CAT' });
  if (cat.lifecycle_stage === 'appearance') {
    throw Object.assign(new Error('请先确认小猫形象'), { code: 'APPEARANCE_REQUIRED' });
  }
  if (cat.travel_schedule_enabled) return getCatProfile(userId);
  const claimed = await db.updateTable('cats').set({ lifecycle_stage: 'adventure_starting', updated_at: new Date().toISOString() })
    .where('id', '=', cat.id).where('travel_schedule_enabled', '=', 0)
    .where('lifecycle_stage', 'in', ['world', 'recalled']).executeTakeFirst();
  if (Number(claimed.numUpdatedRows || 0) === 0) {
    throw Object.assign(new Error('探险正在启动，请稍候'), { code: 'ADVENTURE_STARTING' });
  }

  const pat = await getPatForUser(userId);
  if (!pat) {
    await db.updateTable('cats').set({ lifecycle_stage: 'world' }).where('id', '=', cat.id).execute();
    throw Object.assign(new Error('请先填入 PAT'), { code: 'NO_PAT' });
  }

  const owner = await db.selectFrom('users').select('display_name').where('id', '=', userId).executeTakeFirstOrThrow();
  const serverUrl = config.catApiPublicUrl;
  const attrs = {
    courage: cat.attr_courage,
    curiosity: cat.attr_curiosity,
    affinity: cat.attr_affinity,
    insight: cat.attr_insight,
  };
  const systemPrompt = renderCatAgentPrompt({
    catName: cat.name,
    personality: cat.personality,
    attrs,
    ownerNickname: owner.display_name,
  });
  const taskInstruction = renderDailyTravelTask(cat.name, serverUrl);
  const model = cat.qca_model || await resolveQcaAgentModel(pat);

  if (config.qcaForwardTravel) {
    let forwardResources: ForwardTravelResources | undefined = cat.qca_forward_identity_id && cat.qca_forward_schedule_id
      ? {
          envId: cat.qca_env_id!,
          memstoreId: cat.qca_memstore_id!,
          travelTemplateId: cat.qca_forward_travel_template_id!,
          identityId: cat.qca_forward_identity_id,
          scheduleId: cat.qca_forward_schedule_id,
        }
      : undefined;
    let createdForward = false;
    try {
      if (!forwardResources) {
        const catToken = generateCatToken();
        forwardResources = await ensureForwardTravelResourcesForCat(pat, {
          catId: cat.id,
          catName: cat.name,
          systemPrompt,
          taskInstruction,
          serverUrl,
          catToken,
          model,
          ownerNickname: owner.display_name,
          personality: cat.personality,
          attrs,
        });
        createdForward = true;
        await db.updateTable('cats').set({
          qca_env_id: forwardResources.envId,
          qca_memstore_id: forwardResources.memstoreId,
          qca_forward_travel_template_id: forwardResources.travelTemplateId,
          qca_forward_identity_id: forwardResources.identityId,
          qca_forward_schedule_id: forwardResources.scheduleId,
          cat_token_hash: hashToken(catToken),
          qca_forward_travel_session_token_hash: hashToken(catToken),
          updated_at: new Date().toISOString(),
        }).where('id', '=', cat.id).execute();
      } else {
        const catToken = generateCatToken();
        await updateForwardTravelTemplateEnv(pat, forwardResources.travelTemplateId, { serverUrl, catToken });
        await upsertForwardIdentityConfig(pat, {
          identityId: forwardResources.identityId,
          templateId: forwardResources.travelTemplateId,
          systemPrompt,
          model,
        });
        await bootstrapTravelMemory(
          pat,
          forwardResources.memstoreId,
          travelMemoryBootstrapParams(cat, owner.display_name, serverUrl, catToken),
        );
        await db.updateTable('cats').set({
          cat_token_hash: hashToken(catToken),
          qca_forward_travel_session_token_hash: hashToken(catToken),
          updated_at: new Date().toISOString(),
        }).where('id', '=', cat.id).execute();
      }

      const forwardCat = await db.selectFrom('cats').selectAll().where('id', '=', cat.id).executeTakeFirstOrThrow();
      await setupForwardChatAndIm(pat, forwardCat, owner);

      const now = new Date().toISOString();
      await db.updateTable('cats').set({
        lifecycle_stage: 'scheduled',
        adventure_started_at: now,
        travel_schedule_enabled: 1,
        status: 'active',
        updated_at: now,
      }).where('id', '=', cat.id).execute();
      try {
        await runForwardTravelTaskForCatId(cat.id, { rotateToken: true });
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === QCA_CREDITS_UNAVAILABLE) {
          throw Object.assign(error, { schedule_enabled: true });
        }
        throw Object.assign(error instanceof Error ? error : new Error('第一次探险启动失败'), {
          code: 'INITIAL_RUN_FAILED',
          schedule_enabled: true,
        });
      }
      return getCatProfile(userId);
    } catch (error) {
      const scheduleEnabled = (error as { schedule_enabled?: boolean }).schedule_enabled;
      if (!scheduleEnabled) {
        if (createdForward && forwardResources) {
          await archiveForwardTravelResources(pat, forwardResources);
        }
        await restoreForwardAdventureStartAfterFailure(cat.id, createdForward);
      }
      throw error;
    }
  }

  let resources = cat.qca_env_id && cat.qca_agent_id && cat.qca_memstore_id && cat.qca_deployment_id
    ? {
        envId: cat.qca_env_id,
        agentId: cat.qca_agent_id,
        memstoreId: cat.qca_memstore_id,
        deploymentId: cat.qca_deployment_id,
      }
    : undefined;
  let createdResources = false;
  try {
    if (!resources) {
      const catToken = generateCatToken();
      resources = await createCatResources(pat, {
        catName: cat.name,
        catSlug: cat.id.slice(0, 8),
        systemPrompt,
        taskInstruction,
        serverUrl,
        catToken,
        model,
      });
      createdResources = true;
      await pauseDeployment(pat, resources.deploymentId);
      await bootstrapTravelMemory(
        pat,
        resources.memstoreId,
        travelMemoryBootstrapParams(cat, owner.display_name, serverUrl, catToken),
      );
      await db.updateTable('cats').set({
        qca_env_id: resources.envId,
        qca_agent_id: resources.agentId,
        qca_memstore_id: resources.memstoreId,
        qca_deployment_id: resources.deploymentId,
        cat_token_hash: hashToken(catToken),
        updated_at: new Date().toISOString(),
      }).where('id', '=', cat.id).execute();
    } else {
      await primeTravelRun(pat, cat, resources, owner.display_name);
    }

    // Deployment 仅保留 cron 计划作闹钟；实际任务投递到持久 Travel Session，避免每次 run 开新 Session
    await pauseDeployment(pat, resources.deploymentId).catch(() => undefined);
    const now = new Date().toISOString();
    await db.updateTable('cats').set({
      lifecycle_stage: 'scheduled',
      adventure_started_at: now,
      travel_schedule_enabled: 1,
      status: 'active',
      updated_at: now,
    }).where('id', '=', cat.id).execute();
    try {
      await runTravelTaskForCatId(cat.id, { rotateToken: true });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === QCA_CREDITS_UNAVAILABLE) {
        throw Object.assign(error, { schedule_enabled: true });
      }
      throw Object.assign(error instanceof Error ? error : new Error('第一次探险启动失败'), {
        code: 'INITIAL_RUN_FAILED',
        schedule_enabled: true,
      });
    }
    return getCatProfile(userId);
  } catch (error) {
    const scheduleEnabled = (error as { schedule_enabled?: boolean }).schedule_enabled;
    if (!scheduleEnabled) {
      if (createdResources && resources) await archiveResources(pat, resources);
      await db.updateTable('cats').set({
        lifecycle_stage: 'world',
        qca_env_id: createdResources ? null : cat.qca_env_id,
        qca_agent_id: createdResources ? null : cat.qca_agent_id,
        qca_memstore_id: createdResources ? null : cat.qca_memstore_id,
        qca_deployment_id: createdResources ? null : cat.qca_deployment_id,
        updated_at: new Date().toISOString(),
      }).where('id', '=', cat.id).execute();
    }
    throw error;
  }
}

/** 修复已创建的旅行 Agent：Build 路径补工具/Session；Forward 路径同步 Config；Forward 模式下可迁移存量 Build 猫 */
export async function repairTravelAgent(userId: string) {
  const cat = await getCatByUserId(userId);
  if (!cat) throw Object.assign(new Error('没有小猫'), { code: 'NO_CAT' });
  const mode: RepairTravelAudit['mode'] = config.qcaForwardTravel || catUsesForwardTravel(cat) ? 'forward' : 'build';
  const healthBefore = cachedQcaHealth(cat.qca_health_cache).status;
  const pat = await getPatForUser(userId);
  if (!pat) throw Object.assign(new Error('请先填入 PAT'), {
    code: 'NO_PAT',
    repair_audit: { mode, health_before: healthBefore, health_after: healthBefore } satisfies RepairTravelAudit,
  });

  const owner = await db.selectFrom('users').select('display_name').where('id', '=', userId).executeTakeFirstOrThrow();
  const systemPrompt = renderCatAgentPrompt({
    catName: cat.name,
    personality: cat.personality,
    attrs: {
      courage: cat.attr_courage,
      curiosity: cat.attr_curiosity,
      affinity: cat.attr_affinity,
      insight: cat.attr_insight,
    },
    ownerNickname: owner.display_name,
  });
  try {
    if (config.qcaForwardTravel && !catUsesForwardTravel(cat)) {
      await migrateBuildCatToForward(userId, cat, pat, owner);
      await runForwardTravelTaskForCatId(cat.id, { rotateToken: false, refreshHealth: false });
    } else if (catUsesForwardTravel(cat)) {
      if (!cat.qca_forward_identity_id || !cat.qca_forward_travel_template_id || !cat.qca_forward_schedule_id) {
        throw Object.assign(new Error('尚未创建探险资源'), { code: 'NO_TRAVEL_RESOURCES' });
      }
      await upsertForwardIdentityConfig(pat, {
        identityId: cat.qca_forward_identity_id,
        templateId: cat.qca_forward_travel_template_id,
        systemPrompt,
        model: cat.qca_model || await resolveQcaAgentModel(pat),
      });
      await setupForwardChatAndIm(pat, cat, owner);
      await runForwardTravelTaskForCatId(cat.id, { rotateToken: true, refreshHealth: false });
    } else {
      if (!cat.qca_agent_id || !cat.qca_deployment_id) {
        throw Object.assign(new Error('尚未创建探险资源'), { code: 'NO_TRAVEL_RESOURCES' });
      }

      await updateAgent(pat, cat.qca_agent_id, {
        system: systemPrompt,
        tools: travelAgentToolset(),
      });
      await runTravelTaskForCatId(cat.id, { rotateToken: true, refreshHealth: false });
    }

    // repair 的成功定义不是“QCA 写请求发出”，而是同一次请求内复检并持久化为 healthy+active。
    await refreshQcaSnapshot(userId, cat.id);
    const persisted = await db.selectFrom('cats').select(['status', 'qca_health_cache'])
      .where('id', '=', cat.id).executeTakeFirstOrThrow();
    const healthAfter = cachedQcaHealth(persisted.qca_health_cache).status;
    const audit: RepairTravelAudit = { mode, health_before: healthBefore, health_after: healthAfter };
    if (healthAfter !== 'healthy' || persisted.status !== 'active') {
      throw Object.assign(new Error('repair health verification did not recover the cat'), {
        code: 'REPAIR_HEALTH_STILL_BROKEN',
        repair_audit: audit,
      });
    }

    return { profile: await getCatProfile(userId), audit };
  } catch (error) {
    if (error && typeof error === 'object' && 'repair_audit' in error) throw error;
    const persisted = await db.selectFrom('cats').select('qca_health_cache').where('id', '=', cat.id).executeTakeFirst();
    const audit: RepairTravelAudit = {
      mode,
      health_before: healthBefore,
      health_after: cachedQcaHealth(persisted?.qca_health_cache ?? null).status,
    };
    if (error && typeof error === 'object') {
      Object.assign(error, { repair_audit: audit });
      throw error;
    }
    throw Object.assign(new Error('repair failed'), { code: 'REPAIR_FAILED', repair_audit: audit });
  }
}

export async function pauseLegacyTravelSchedules(log?: { info: (value: unknown, message?: string) => void; warn: (value: unknown, message?: string) => void }) {
  const cats = await db.selectFrom('cats').select(['id', 'user_id', 'qca_deployment_id'])
    .where('qca_deployment_id', 'is not', null)
    .where('travel_schedule_enabled', '=', 0)
    .where('adventure_started_at', 'is', null)
    .execute();
  for (const cat of cats) {
    const pat = await getPatForUser(cat.user_id);
    if (!pat || !cat.qca_deployment_id) continue;
    try {
      await pauseDeployment(pat, cat.qca_deployment_id);
      log?.info({ catId: cat.id }, 'paused legacy travel schedule for lifecycle migration');
    } catch (error) {
      log?.warn({ catId: cat.id, error: error instanceof Error ? error.message : 'unknown' }, 'failed to pause legacy travel schedule');
    }
  }
}

/** 编辑档案：仅支持改名与性格。天性由出生派生 + 旅行成长，不再提供手动分配 */
export async function updateCat(userId: string, input: { name?: string; personality?: string }) {
  const cat = await getCatByUserId(userId);
  if (!cat) throw Object.assign(new Error('没有猫'), { code: 'NO_CAT' });
  const pat = await getPatForUser(userId);
  if (!pat) throw Object.assign(new Error('请先填入 PAT'), { code: 'NO_PAT' });

  const name = input.name?.trim() ? input.name.trim().slice(0, 20) : cat.name;
  const personality = input.personality ?? cat.personality;
  const attrs = {
    courage: cat.attr_courage,
    curiosity: cat.attr_curiosity,
    affinity: cat.attr_affinity,
    insight: cat.attr_insight,
  };

  const user = await db.selectFrom('users').select('display_name').where('id', '=', userId).executeTakeFirstOrThrow();
  const systemPrompt = renderCatAgentPrompt({
    catName: name,
    personality,
    attrs,
    ownerNickname: user.display_name,
  });

  if (cat.qca_agent_id) await updateAgent(pat, cat.qca_agent_id, systemPrompt);
  if (catUsesForwardTravel(cat) && cat.qca_forward_identity_id && cat.qca_forward_travel_template_id) {
    await upsertForwardIdentityConfig(pat, {
      identityId: cat.qca_forward_identity_id,
      templateId: cat.qca_forward_travel_template_id,
      systemPrompt,
      model: cat.qca_model || await resolveQcaAgentModel(pat),
    });
  }

  await db.updateTable('cats').set({ name, personality, updated_at: new Date().toISOString() }).where('id', '=', cat.id).execute();

  return formatCat((await getCatByUserId(userId))!);
}

export async function recallCat(userId: string) {
  const cat = await getCatByUserId(userId);
  if (!cat) throw Object.assign(new Error('没有小猫'), { code: 'NO_CAT' });
  const pat = await getPatForUser(userId);
  if (pat) {
    if (catUsesForwardTravel(cat) && cat.qca_forward_schedule_id) {
      await pauseForwardSchedule(pat, cat.qca_forward_schedule_id);
    } else if (cat.qca_deployment_id) {
      await pauseDeployment(pat, cat.qca_deployment_id);
    }
  }
  await db.updateTable('cats').set({
    status: 'recalled', lifecycle_stage: 'recalled', travel_schedule_enabled: 0, updated_at: new Date().toISOString(),
  }).where('id', '=', cat.id).execute();
  return formatCat((await getCatByUserId(userId))!);
}

export async function releaseCat(userId: string) {
  const cat = await getCatByUserId(userId);
  if (!cat) throw Object.assign(new Error('没有小猫'), { code: 'NO_CAT' });
  const pat = await getPatForUser(userId);
  if (pat) {
    if (catUsesForwardTravel(cat) && cat.qca_forward_schedule_id) {
      await unpauseForwardSchedule(pat, cat.qca_forward_schedule_id);
    } else if (cat.qca_deployment_id) {
      await unpauseDeployment(pat, cat.qca_deployment_id);
    }
  }
  const hasTravel = catHasTravelResources(cat);
  await db.updateTable('cats').set({
    status: 'active',
    lifecycle_stage: hasTravel ? 'scheduled' : 'world',
    travel_schedule_enabled: hasTravel ? 1 : 0,
    updated_at: new Date().toISOString(),
  }).where('id', '=', cat.id).execute();
  return formatCat((await getCatByUserId(userId))!);
}

export async function updateOutfit(userId: string, outfit: { head?: string | null; neck?: string | null; back?: string | null }) {
  const cat = await getCatByUserId(userId);
  if (!cat) throw Object.assign(new Error('没有猫'), { code: 'NO_CAT' });
  const current = JSON.parse(cat.outfit) as Record<string, string | null>;
  for (const [slot, itemId] of Object.entries(outfit)) {
    if (itemId) {
      const owned = await db.selectFrom('cat_items as ci').innerJoin('world_items as wi', 'wi.id', 'ci.item_id')
        .select(['ci.id', 'wi.kind', 'wi.slot']).where('ci.cat_id', '=', cat.id).where('ci.item_id', '=', itemId).executeTakeFirst();
      if (!owned) throw Object.assign(new Error('未持有该物品'), { code: 'ITEM_NOT_OWNED' });
      if (owned.kind !== 'wearable') throw Object.assign(new Error('该物品不能穿戴'), { code: 'ITEM_NOT_WEARABLE' });
      if (owned.slot !== slot) throw Object.assign(new Error('物品槽位不匹配'), { code: 'ITEM_SLOT_MISMATCH' });
    }
    if (slot in current) current[slot] = itemId ?? null;
  }
  await db.updateTable('cats').set({ outfit: JSON.stringify(current), updated_at: new Date().toISOString() }).where('id', '=', cat.id).execute();
  return formatCat((await getCatByUserId(userId))!);
}

export async function getWorldMap(userId: string) {
  const cat = await getCatByUserId(userId);
  const mapMetadata = await db.selectFrom('world_meta').select(['key', 'value'])
    .where('key', 'in', ['map_manifest', 'region_map_locations']).execute();
  const metadata = new Map(mapMetadata.map((entry) => [entry.key, entry.value]));
  const mapManifest = metadata.get('map_manifest');
  const regionMapLocations = metadata.has('region_map_locations')
    ? JSON.parse(metadata.get('region_map_locations')!) as Record<string, { x: number; y: number }>
    : {};
  const locations = await db.selectFrom('world_locations').select(['id', 'name', 'description', 'mood_tags', 'min_attrs', 'map_x', 'map_y', 'region_id', 'map_priority'])
    .where('status', '=', 'active').execute();

  const checkins = cat
    ? await db.selectFrom('travels').select('location_id')
        .select(({ fn }) => [
          fn.min<string>('travel_date').as('first_visit'),
          fn.max<string>('travel_date').as('last_visit'),
          fn.count<number>('id').as('visits'),
        ])
        .where('cat_id', '=', cat.id).groupBy('location_id').execute()
    : [];

  const checkinMap = new Map(checkins.map((c) => [c.location_id, c]));

  // backlog #058：去过的地点附最近一次旅行的故事标题（云图志列表免点开可见）
  const lastTitles = new Map<string, string>();
  if (cat && checkins.length) {
    const latest = await db.selectFrom('travels as t')
      .leftJoin('postcards as p', 'p.travel_id', 't.id')
      .select(['t.location_id', 't.travel_date', 'p.title'])
      .where('t.cat_id', '=', cat.id)
      .orderBy('t.travel_date', 'asc')
      .execute();
    // 按 travel_date 升序覆盖写入 → 每个地点留下的是最近一次的标题
    for (const row of latest) {
      if (row.title) lastTitles.set(row.location_id, row.title);
    }
  }

  const heat = await db.selectFrom('travels').select('location_id')
    .select(({ fn }) => fn.count<number>('cat_id').distinct().as('cats')).groupBy('location_id').execute();
  const heatMap = new Map(heat.map((h) => [h.location_id, h.cats]));

  return {
    manifest: mapManifest ? JSON.parse(mapManifest) : { basemap_version: 'world-v1', min_zoom: 1, max_zoom: 2.6, regions: [] },
    locations: locations.map((l) => ({
      id: l.id,
      name: l.name,
      description: l.description,
      mood_tags: JSON.parse(l.mood_tags),
      min_attrs: JSON.parse(l.min_attrs),
      map: { x: l.map_x, y: l.map_y },
      region_map: regionMapLocations[l.id] || { x: 50, y: 50 },
      region_id: l.region_id,
      map_priority: l.map_priority,
      heat: heatMap.get(l.id) || 0,
      checkin: checkinMap.has(l.id)
        ? {
            first_visit: checkinMap.get(l.id)!.first_visit,
            last_visit: checkinMap.get(l.id)!.last_visit,
            // count() 在 PG 下返回 bigint 字符串、SQLite 下返回 number——统一成 number
            visits: Number(checkinMap.get(l.id)!.visits),
            last_title: lastTitles.get(l.id) || null,
          }
        : null,
    })),
  };
}

export { listBadgesForCat, formatCat };
