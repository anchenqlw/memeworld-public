import { db } from '../db/index.js';
import {
  QCA_CREDITS_UNAVAILABLE,
  qcaCreditsRecoveryPendingError,
} from '../lib/qcaErrors.js';
import { getCatByUserId, getPatForUser } from './catService.js';
import { listEnabledQcaModels } from './qca.js';
import { requiresCustomAppearanceReentry } from './customAppearanceService.js';

type CachedQcaHealth = {
  status?: string;
  alert?: unknown;
  adventure_presence?: unknown;
  credits_recovered_at?: string;
  [key: string]: unknown;
};

function parseHealthCache(value: string | null): CachedQcaHealth {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed as CachedQcaHealth : {};
  } catch {
    return {};
  }
}

export function isSelectedQcaModelAvailable(selectedModel: string | null, enabledModels: Array<{ id: string }>) {
  return Boolean(selectedModel && enabledModels.some((model) => model.id === selectedModel));
}

/**
 * 用户声明已充值后的主动复检。
 *
 * QCA 个人 PAT 没有公开余额查询接口；官方契约约定 Credits 耗尽后只保留 Lite 模型，
 * 因此以这只猫已经选择的模型重新出现在账户可用模型列表中作为零消耗恢复判据。
 */
export async function recoverQcaCredits(userId: string) {
  const [credential, cat] = await Promise.all([getPatForUser(userId), getCatByUserId(userId)]);
  if (!credential) throw Object.assign(new Error('云端契约需要重新连接，请先到设置里检查。'), { code: 'NO_PAT', status: 400 });
  if (!cat) throw Object.assign(new Error('还没有找到你的小猫。'), { code: 'NO_CAT', status: 404 });

  const models = await listEnabledQcaModels(credential);
  if (!isSelectedQcaModelAvailable(cat.qca_model, models)) {
    throw qcaCreditsRecoveryPendingError();
  }

  const now = new Date().toISOString();
  const latestImageJob = await db.selectFrom('image_jobs')
    .select(['id', 'kind', 'travel_id', 'status', 'last_error'])
    .where('cat_id', '=', cat.id)
    .orderBy('created_at', 'desc')
    .orderBy('updated_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  const customAppearanceReentryRequired = latestImageJob?.status === 'failed'
    && requiresCustomAppearanceReentry(latestImageJob.last_error);
  const failedCreditJobs = latestImageJob?.status === 'failed'
    && !customAppearanceReentryRequired
    && latestImageJob.last_error?.startsWith(QCA_CREDITS_UNAVAILABLE)
    ? [latestImageJob]
    : [];

  const health = parseHealthCache(cat.qca_health_cache);
  delete health.alert;
  const recoveredHealth: CachedQcaHealth = {
    ...health,
    credits_recovered_at: now,
    adventure_presence: { phase: 'idle', checked_at: now },
  };

  await db.transaction().execute(async (trx) => {
    if (failedCreditJobs.length > 0) {
      await trx.updateTable('image_jobs').set({
        status: 'pending',
        attempts: 0,
        available_at: now,
        started_at: null,
        finished_at: null,
        last_error: null,
        updated_at: now,
      }).where('id', '=', failedCreditJobs[0].id)
        .where('status', '=', 'failed')
        .execute();
    }

    const growthTravelIds = failedCreditJobs
      .filter((job) => job.kind === 'growth' && job.travel_id)
      .map((job) => job.travel_id as string);
    if (growthTravelIds.length > 0) {
      await trx.updateTable('postcards').set({ photo_status: 'generating' })
        .where('travel_id', 'in', growthTravelIds)
        .execute();
    }

    await trx.updateTable('cats').set({
      qca_health_cache: JSON.stringify(recoveredHealth),
      qca_health_checked_at: now,
      ...(failedCreditJobs.some((job) => job.kind === 'birth') ? { appearance_status: 'pending' } : {}),
      updated_at: now,
    }).where('id', '=', cat.id).execute();

    await trx.updateTable('pat_credentials').set({
      status: 'valid',
      last_verified_at: now,
      updated_at: now,
    }).where('user_id', '=', userId).execute();
  });

  return {
    ok: true as const,
    status: 'restored' as const,
    requeued: failedCreditJobs.length,
    reentry_required: customAppearanceReentryRequired ? 1 : 0,
    checked_at: now,
    message: customAppearanceReentryRequired
      ? '云端能量已经回来啦。上次的自定义外貌描述已安全清除，请重新填写后再画一张。'
      : failedCreditJobs.length > 0
      ? '云端能量已经回来啦，刚才停下的事情会继续完成。'
      : '云端能量已经回来啦，小猫又可以安心出发了。',
  };
}
