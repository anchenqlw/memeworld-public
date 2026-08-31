import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { isNonRetryableQcaError } from '../lib/qcaErrors.js';
import { cancelImageSessionForCat, generateBirthAppearance, generateGrowthAppearance, newRepaintAppearanceId, setEncounterPhotoStatusForTravel } from './catImageService.js';
import {
  CUSTOM_APPEARANCE_REENTRY_REQUIRED,
  normalizeCustomAppearanceDescription,
} from './customAppearanceService.js';

type ImageJobKind = 'birth' | 'growth';
export type ClaimedJob = {
  id: string;
  cat_id: string;
  kind: string;
  travel_id: string | null;
  appearance_id: string | null;
  custom_description: string | null;
  attempts: number;
};

let timer: NodeJS.Timeout | null = null;
let stopping = false;
let activeRun: Promise<void> | null = null;

function dedupeKey(kind: ImageJobKind, catId: string, travelId?: string, appearanceId?: string) {
  return kind === 'birth'
    ? `birth:${catId}:${appearanceId || 'legacy'}`
    : `growth:${catId}:${travelId}${appearanceId ? `:${appearanceId}` : ''}`;
}

export async function enqueueImageJob(
  kind: ImageJobKind,
  catId: string,
  travelId?: string,
  appearanceId?: string,
  customDescription?: string | null,
) {
  const now = new Date().toISOString();
  const result = await db.insertInto('image_jobs').values({
    id: randomUUID(),
    dedupe_key: dedupeKey(kind, catId, travelId, appearanceId),
    cat_id: catId,
    kind,
    travel_id: travelId || null,
    appearance_id: appearanceId || null,
    custom_description: normalizeCustomAppearanceDescription(customDescription),
    status: 'pending',
    attempts: 0,
    available_at: now,
  }).onConflict((oc) => oc.column('dedupe_key').doNothing()).executeTakeFirst();
  return Number(result.numInsertedOrUpdatedRows || 0) > 0;
}

export async function enqueueBirthCandidate(catId: string, customDescription?: string | null) {
  const appearanceId = randomUUID();
  const enqueued = await enqueueImageJob('birth', catId, undefined, appearanceId, customDescription);
  if (!enqueued) throw new Error('无法创建出生图任务');
  return appearanceId;
}

/**
 * backlog #077：形象确认后的「重画申诉」候选。
 * 复用同一 image_jobs 队列/去重键/超时恢复/活跃 job 校验，只是 appearance_id 带 repaint- 前缀，
 * 使候选在不新增列的前提下可被识别与计数（见 catImageService.REPAINT_APPEARANCE_ID_PREFIX）。
 */
export async function enqueueRepaintCandidate(catId: string, customDescription?: string | null) {
  const appearanceId = newRepaintAppearanceId();
  const enqueued = await enqueueImageJob('birth', catId, undefined, appearanceId, customDescription);
  if (!enqueued) throw new Error('无法创建重画任务');
  return appearanceId;
}

async function ensureRepairJob(kind: ImageJobKind, catId: string, travelId?: string, appearanceId?: string) {
  const now = new Date().toISOString();
  const reset = await db.updateTable('image_jobs').set({
    status: 'pending', attempts: 0, available_at: now, started_at: null,
    finished_at: null, last_error: null, updated_at: now,
  }).where('dedupe_key', '=', dedupeKey(kind, catId, travelId, appearanceId))
    .where('status', 'not in', ['pending', 'running'])
    .where((eb) => eb.or([
      eb('last_error', 'is', null),
      eb('last_error', 'not like', `%${CUSTOM_APPEARANCE_REENTRY_REQUIRED}%`),
    ])).executeTakeFirst();
  if (Number(reset.numUpdatedRows || 0) > 0) return 1;
  return await enqueueImageJob(kind, catId, travelId, appearanceId) ? 1 : 0;
}

export async function repairImageJobs(userId: string) {
  const cat = await db.selectFrom('cats').select(['id']).where('user_id', '=', userId).executeTakeFirst();
  if (!cat) throw Object.assign(new Error('没有猫'), { code: 'NO_CAT' });

  const now = new Date().toISOString();
  const customAppearanceFailed = await db.selectFrom('image_jobs').select('id')
    .where('cat_id', '=', cat.id).where('kind', '=', 'birth').where('status', '=', 'failed')
    .where('last_error', 'like', `%${CUSTOM_APPEARANCE_REENTRY_REQUIRED}%`).executeTakeFirst();
  const reset = await db.updateTable('image_jobs').set({
    status: 'pending',
    attempts: 0,
    available_at: now,
    started_at: null,
    finished_at: null,
    last_error: null,
    updated_at: now,
  }).where('cat_id', '=', cat.id).where('status', '=', 'failed')
    .where((eb) => eb.or([
      eb('last_error', 'is', null),
      eb('last_error', 'not like', `%${CUSTOM_APPEARANCE_REENTRY_REQUIRED}%`),
    ])).executeTakeFirst();

  let enqueued = Number(reset.numUpdatedRows || 0);
  const birth = await db.selectFrom('cat_appearances').select('id').where('cat_id', '=', cat.id)
    .where('kind', '=', 'birth').executeTakeFirst();
  const activeBirthJob = await db.selectFrom('image_jobs').select('id').where('cat_id', '=', cat.id)
    .where('kind', '=', 'birth').where('status', 'in', ['pending', 'running']).executeTakeFirst();
  if (!birth && !activeBirthJob && !customAppearanceFailed) {
    enqueued += await ensureRepairJob('birth', cat.id, undefined, randomUUID());
  }

  const missingGrowth = await db.selectFrom('travels as t')
    .leftJoin('cat_appearances as ca', (join) => join.onRef('ca.travel_id', '=', 't.id').on('ca.kind', '=', 'growth'))
    .select('t.id').where('t.cat_id', '=', cat.id).where('ca.id', 'is', null).execute();
  for (const travel of missingGrowth) {
    enqueued += await ensureRepairJob('growth', cat.id, travel.id);
  }
  if (enqueued > 0) {
    await db.updateTable('cats').set({ appearance_status: 'pending', updated_at: now }).where('id', '=', cat.id).execute();
  }
  return { ok: true, enqueued, reentry_required: Boolean(customAppearanceFailed) };
}

export async function repairPostcardPhoto(userId: string, postcardId: string) {
  const row = await db.selectFrom('postcards as p').innerJoin('travels as t', 't.id', 'p.travel_id')
    .innerJoin('cats as c', 'c.id', 't.cat_id').select(['p.photo_status', 't.id as travel_id', 'c.id as cat_id'])
    .where('p.id', '=', postcardId).where('c.user_id', '=', userId).executeTakeFirst();
  if (!row) throw Object.assign(new Error('明信片不存在'), { code: 'NOT_FOUND' });
  if (row.photo_status !== 'failed') return { ok: true, enqueued: 0, status: row.photo_status };
  const enqueued = await ensureRepairJob('growth', row.cat_id, row.travel_id);
  if (enqueued) await db.updateTable('postcards').set({ photo_status: 'pending' }).where('travel_id', '=', row.travel_id).execute();
  return { ok: true, enqueued, status: enqueued ? 'pending' : row.photo_status };
}

/** 仅供非 production 的登录态回归：保留原图，追加重画最近一次旅行照片。 */
export async function regenerateLatestGrowthPhoto(userId: string) {
  const latest = await db.selectFrom('cats as c')
    .innerJoin('travels as t', 't.cat_id', 'c.id')
    .select(['c.id as cat_id', 't.id as travel_id'])
    .where('c.user_id', '=', userId)
    .orderBy('t.travel_date', 'desc')
    .orderBy('t.id', 'desc')
    .executeTakeFirst();
  if (!latest) throw Object.assign(new Error('还没有可以重画的旅行'), { code: 'NO_TRAVEL' });
  const active = await db.selectFrom('image_jobs').select('id')
    .where('cat_id', '=', latest.cat_id).where('kind', '=', 'growth')
    .where('status', 'in', ['pending', 'running']).executeTakeFirst();
  if (active) throw Object.assign(new Error('上一张旅行照片仍在生成，请稍候'), { code: 'IMAGE_JOB_ACTIVE' });

  const variantId = randomUUID();
  const enqueued = await enqueueImageJob('growth', latest.cat_id, latest.travel_id, variantId);
  if (!enqueued) throw new Error('无法创建旅行照片重画任务');
  await db.updateTable('postcards').set({ photo_status: 'generating' })
    .where('travel_id', '=', latest.travel_id).execute();
  return { ok: true, travel_id: latest.travel_id, status: 'pending' as const };
}

async function recoverTimedOutJobs() {
  const timeoutMs = Math.min(config.imageWorker.runningTimeoutMs, config.imageWorker.sessionTimeoutMs);
  const cutoff = new Date(Date.now() - timeoutMs).toISOString();
  const timedOut = await db.selectFrom('image_jobs')
    .select(['id', 'cat_id', 'kind', 'attempts', 'qca_session_id', 'custom_description'])
    .where('status', '=', 'running').where('started_at', '<', cutoff).execute();
  for (const job of timedOut) {
    const terminal = job.kind === 'birth' || job.attempts >= config.imageWorker.maxAttempts;
    if (job.qca_session_id) {
      try { await cancelImageSessionForCat(job.cat_id, job.qca_session_id); } catch { /* best effort */ }
    }
    const recovered = await db.updateTable('image_jobs').set({
      status: terminal ? 'failed' : 'pending',
      available_at: new Date().toISOString(),
      finished_at: terminal ? new Date().toISOString() : null,
      last_error: sanitizeImageJobError(
        Object.assign(new Error('RecoveredWorkerTimeout'), {
          code: job.kind === 'birth' ? 'IMAGE_SESSION_TIMEOUT' : 'WORKER_TIMEOUT',
        }),
        job.custom_description,
      ),
      ...(terminal ? { custom_description: null } : {}),
      updated_at: new Date().toISOString(),
    }).where('id', '=', job.id).where('status', '=', 'running').executeTakeFirst();
    if (Number(recovered.numUpdatedRows || 0) === 0) continue;
    if (job.kind === 'birth' && terminal) {
      await db.updateTable('cats').set({ appearance_status: 'failed', updated_at: new Date().toISOString() })
        .where('id', '=', job.cat_id).execute();
    }
  }
}

async function claimJob(catId?: string): Promise<ClaimedJob | null> {
  const now = new Date().toISOString();
  let candidateQuery = db.selectFrom('image_jobs').select(['id']).where('status', '=', 'pending')
    .where('available_at', '<=', now);
  if (catId) candidateQuery = candidateQuery.where('cat_id', '=', catId);
  const candidate = await candidateQuery.orderBy('available_at').orderBy('created_at').executeTakeFirst();
  if (!candidate) return null;
  const claimed = await db.updateTable('image_jobs').set((eb) => ({
    status: 'running',
    attempts: eb('attempts', '+', 1),
    started_at: now,
    updated_at: now,
  })).where('id', '=', candidate.id).where('status', '=', 'pending')
    .returning(['id', 'cat_id', 'kind', 'travel_id', 'appearance_id', 'custom_description', 'attempts']).executeTakeFirst();
  return claimed || null;
}

function safeDiagnosticToken(value: unknown, fallback: string) {
  const normalized = typeof value === 'string' ? value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 48) : '';
  return normalized || fallback;
}

export function sanitizeImageJobError(error: unknown, customDescription?: string | null) {
  const rawCode = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const rawStatus = error && typeof error === 'object' && 'status' in error ? Number(error.status) : undefined;
  const name = safeDiagnosticToken(error instanceof Error ? error.name : undefined, 'ImageJobError');
  if (customDescription) {
    // Provider message 可能只回显描述片段或把原文放在截断边界外，不能做字符串替换式脱敏。
    // 有自由描述时完全丢弃 message，只保留定长、字符受限的结构化元数据。
    const code = safeDiagnosticToken(rawCode, 'IMAGE_JOB_ERROR');
    const status = Number.isInteger(rawStatus) ? `:status=${rawStatus}` : '';
    return `${code}:${CUSTOM_APPEARANCE_REENTRY_REQUIRED}:name=${name}${status}`;
  }
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? `${error.code}:`
    : '';
  const status = typeof error === 'object' && error && 'status' in error && Number.isInteger(Number(error.status))
    ? `:status=${Number(error.status)}`
    : '';
  const rawMessage = error instanceof Error ? error.message : '';
  const message = rawMessage
    .replace(/pt-[A-Za-z0-9_-]+/g, 'pt-***')
    .replace(/(authorization|token|secret|password)=?\s*[^\s,;]+/gi, '$1=***')
    .replace(/https?:\/\/[^\s]+/g, '[url]')
    .slice(0, 320);
  return `${code}${name}${status}${message ? `:${message}` : ''}`.slice(0, 400);
}

export async function processJob(job: ClaimedJob) {
  if (job.kind === 'birth') {
    await generateBirthAppearance(job.cat_id, job.appearance_id || randomUUID(), {
      customDescription: job.custom_description,
      onSessionCreated: async (sessionId) => {
        await writeActiveImageJobSession(job.id, sessionId);
      },
      isCancelled: async () => {
        const current = await db.selectFrom('image_jobs').select(['status', 'cancel_requested_at'])
          .where('id', '=', job.id).executeTakeFirst();
        return !current || current.status === 'canceled' || Boolean(current.cancel_requested_at);
      },
    });
  } else if (job.kind === 'growth' && job.travel_id) {
    await generateGrowthAppearance(job.cat_id, job.travel_id, { force: Boolean(job.appearance_id) });
  } else {
    throw new Error('InvalidImageJob');
  }
  const now = new Date().toISOString();
  const completed = await db.updateTable('image_jobs').set({
    status: 'succeeded', finished_at: now, last_error: null, custom_description: null, updated_at: now,
  }).where('id', '=', job.id).where('status', '=', 'running').executeTakeFirst();
  if (Number(completed.numUpdatedRows || 0) === 0) {
    throw Object.assign(new Error('图片任务已结束，放弃 worker 成功回写'), { code: 'IMAGE_JOB_CANCELED' });
  }
  if (job.kind === 'growth' && job.travel_id) {
    await db.updateTable('postcards').set({ photo_status: 'ready' }).where('travel_id', '=', job.travel_id).execute();
  }
}

export async function runImageJobOnce(
  log?: Pick<FastifyBaseLogger, 'warn'>,
  processor: (job: ClaimedJob) => Promise<void> = processJob,
  catId?: string,
) {
  await recoverTimedOutJobs();
  const job = await claimJob(catId);
  if (!job) return;
  try {
    await processor(job);
  } catch (error) {
    const errorCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    const errorStatus = error && typeof error === 'object' && 'status' in error ? Number(error.status) : undefined;
    const canceled = errorCode === 'IMAGE_JOB_CANCELED';
    const terminal = canceled || errorCode === 'IMAGE_SESSION_TIMEOUT'
      || (errorCode === 'QCA_API_ERROR' && errorStatus === 409)
      || isNonRetryableQcaError(error) || job.attempts >= config.imageWorker.maxAttempts;
    const now = new Date().toISOString();
    const delayMs = Math.min(60_000, 2 ** job.attempts * 1_000);
    const transitioned = await db.updateTable('image_jobs').set({
      status: canceled ? 'canceled' : terminal ? 'failed' : 'pending',
      available_at: new Date(Date.now() + delayMs).toISOString(),
      finished_at: terminal ? now : null,
      last_error: sanitizeImageJobError(error, job.custom_description),
      ...(terminal ? { custom_description: null } : {}),
      updated_at: now,
    }).where('id', '=', job.id).where('status', '=', 'running').executeTakeFirst();
    if (Number(transitioned.numUpdatedRows || 0) === 0) return;
    await db.updateTable('cats').set({
      appearance_status: job.kind === 'birth'
        ? (canceled ? 'canceled' : terminal ? 'failed' : 'pending')
        : ((await db.selectFrom('cats').select('selected_birth_appearance_id').where('id', '=', job.cat_id)
            .executeTakeFirst())?.selected_birth_appearance_id ? 'ready' : 'failed'),
      updated_at: now,
    }).where('id', '=', job.cat_id).execute();
    if (job.kind === 'growth' && job.travel_id) {
      const encounterUpdated = await setEncounterPhotoStatusForTravel(job.travel_id, terminal ? 'failed' : 'generating');
      if (!encounterUpdated) {
        await db.updateTable('postcards').set({ photo_status: terminal ? 'failed' : 'generating' })
          .where('travel_id', '=', job.travel_id).execute();
      }
    }
    log?.warn({ jobId: job.id, kind: job.kind, terminal, error: sanitizeImageJobError(error, job.custom_description) }, 'image job failed');
  }
}

/**
 * 确定性回归入口：只领取指定猫的下一项任务，避免共享数据库中的其它待处理夹具抢占断言目标。
 * production scheduler 必须继续调用未过滤的 runImageJobOnce()，维持全局队列语义。
 */
export async function runImageJobOnceForCat(
  catId: string,
  log?: Pick<FastifyBaseLogger, 'warn'>,
  processor: (job: ClaimedJob) => Promise<void> = processJob,
) {
  return runImageJobOnce(log, processor, catId);
}

export async function cancelBirthImageJob(userId: string) {
  const cat = await db.selectFrom('cats').select(['id']).where('user_id', '=', userId).executeTakeFirst();
  if (!cat) throw Object.assign(new Error('没有小猫'), { code: 'NO_CAT' });
  const job = await db.selectFrom('image_jobs').select(['id', 'status', 'qca_session_id', 'custom_description'])
    .where('cat_id', '=', cat.id).where('kind', '=', 'birth')
    .where('status', 'in', ['pending', 'running']).orderBy('created_at', 'desc').executeTakeFirst();
  if (!job) return { ok: true, canceled: false, session_canceled: false };

  const now = new Date().toISOString();
  let canceled = false;
  await db.transaction().execute(async (trx) => {
    const result = await trx.updateTable('image_jobs').set({
      status: 'canceled', cancel_requested_at: now, finished_at: now,
      last_error: sanitizeImageJobError(
        Object.assign(new Error('UserCanceled'), { code: 'IMAGE_JOB_CANCELED' }),
        job.custom_description,
      ),
      custom_description: null, updated_at: now,
    }).where('id', '=', job.id).where('status', 'in', ['pending', 'running']).executeTakeFirst();
    canceled = Number(result.numUpdatedRows || 0) > 0;
    if (!canceled) return;
    await trx.updateTable('cats').set({ appearance_status: 'canceled', updated_at: now })
      .where('id', '=', cat.id).execute();
  });

  if (!canceled) return { ok: true, canceled: false, session_canceled: false };

  let sessionCanceled = false;
  if (job.qca_session_id) {
    try {
      await cancelImageSessionForCat(cat.id, job.qca_session_id);
      sessionCanceled = true;
    } catch {
      // Worker 仍会在下一次轮询看到 canceled 并再次取消；前端不应继续被锁死。
    }
  }
  return { ok: true, canceled: true, session_canceled: sessionCanceled };
}

/** session id 只能写活跃任务；0 行表示取消/超时已经获胜，worker 必须停止。 */
export async function writeActiveImageJobSession(jobId: string, sessionId: string) {
  const updated = await db.updateTable('image_jobs')
    .set({ qca_session_id: sessionId, updated_at: new Date().toISOString() })
    .where('id', '=', jobId)
    .where('status', 'not in', ['succeeded', 'failed', 'canceled'])
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows || 0) === 0) {
    throw Object.assign(new Error('图片任务已结束，拒绝 session 回写'), { code: 'IMAGE_JOB_CANCELED' });
  }
}

function schedule(log: FastifyBaseLogger, delay = config.imageWorker.pollIntervalMs) {
  if (stopping) return;
  timer = setTimeout(() => {
    activeRun = runImageJobOnce(log)
      .catch((error) => log.error({ err: error }, 'image worker iteration failed'))
      .finally(() => {
        activeRun = null;
        schedule(log);
      });
  }, delay);
  timer.unref();
}

export async function startImageWorker(log: FastifyBaseLogger) {
  if (!config.imageWorker.enabled || timer || activeRun) return;
  stopping = false;
  await recoverTimedOutJobs();
  schedule(log, 0);
}

export async function stopImageWorker() {
  stopping = true;
  if (timer) clearTimeout(timer);
  timer = null;
  await activeRun;
}
