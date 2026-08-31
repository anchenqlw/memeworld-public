import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { hashToken } from '../lib/crypto.js';
import { requireUser } from './auth.js';
import {
  getPatForUser,
  getPatStatus,
  deletePat,
  getCatByUserId,
  getCatByTokenHash,
  getCatProfile,
  createCat,
  regenerateBirthAppearance,
  requestAppearanceRepaint,
  confirmAppearanceRepaint,
  discardAppearanceRepaint,
  updateDraftAppearance,
  confirmBirthAppearance,
  startAdventure,
  repairTravelAgent,
  updateCat,
  changeCatModel,
  recallCat,
  releaseCat,
  updateOutfit,
  getWorldMap,
  listBadgesForCat,
  type RepairTravelAudit,
} from '../services/catService.js';
import { listEnabledQcaModels, verifyPat } from '../services/qca.js';
import { getWorldDigest, getWorldToday, listTravels, reportCurrentDestination, reportTravel, setTravelWish, clearTravelWish, setWanderingMode } from '../services/travelService.js';
import { listEncounterReceipts, setMeetEnabled } from '../services/encounterService.js';
import { listChatHistory } from '../services/chatService.js';
import { QCA_CHAT_TIMEOUT } from '../services/qcaForwardChatService.js';
import { enqueueChatTurn, getChatTurn, waitForChatTurn } from '../services/chatTurnService.js';
import {
  createProposal,
  listMyProposals,
  exportProposals,
  exportProposalIssues,
  ackProposals,
  recordProductionVerification,
  getContributionSummary,
  listContributorLeaderboard,
  PROPOSAL_STATUSES,
  type ProposalStatus,
} from '../services/proposalService.js';
import { syncWorldFromRepo, getWorldVersion, listWorldChronicle } from '../services/worldSync.js';
import { createChronicleEntry, listChronicleRevisions, listManagedChronicle, updateChronicleEntry } from '../services/chronicleService.js';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { sql } from 'kysely';
import { checkRedis, consumeRateLimit } from '../infrastructure/redis.js';
import { imageStorage, storageFallbackHits } from '../infrastructure/imageStorage.js';
import { cancelBirthImageJob, regenerateLatestGrowthPhoto, repairImageJobs, repairPostcardPhoto } from '../services/imageJobService.js';
import { auditCatAppearanceForUser, getAppearanceImageForUser } from '../services/catImageService.js';
import { deleteOnboardingAnswer, getBondState, getGentleReturnMessage, getVisibleMemories, getWeeklyRecap, listOnboardingAnswers, respondToPostcard, saveOnboardingAnswers } from '../services/bondService.js';
import { QCA_CREDITS_UNAVAILABLE, toAdventureStartUserMessage, toQcaUserAlert } from '../lib/qcaErrors.js';
import { recoverQcaCredits } from '../services/qcaCreditRecoveryService.js';
import {
  cancelPatReplacement,
  confirmPatReplacement,
  getCatArchive,
  listCatArchives,
  requestPatReplacement,
} from '../services/patReplacementService.js';
import {
  createGrowthCard,
  deleteGrowthCard,
  getGrowthTags,
  listGrowthCards,
  retryGrowthCardSync,
  updateGrowthCard,
  type GrowthCardInput,
} from '../services/growthCardService.js';
import {
  executeCatTaskReconciliation,
  getCatTaskReconciliationStatus,
  planCatTaskReconciliation,
} from '../services/taskReconciliationService.js';

async function resolveCatFromToken(req: FastifyRequest, reply: FastifyReply) {
  const token = req.headers['x-cat-token'] as string;
  if (!token) {
    reply.status(401).send({ error: { code: 'NO_TOKEN', message: '缺少 X-Cat-Token' } });
    return null;
  }
  const tokenHash = hashToken(token);
  if (!await consumeRateLimit('cat-token', tokenHash, 10, 60_000)) {
    reply.status(429).send({ error: { code: 'RATE_LIMIT', message: '请求过于频繁' } });
    return null;
  }
  const cat = await getCatByTokenHash(tokenHash);
  if (!cat) {
    reply.status(401).send({ error: { code: 'INVALID_TOKEN', message: '无效 token' } });
    return null;
  }
  return cat;
}

function requireInternal(req: FastifyRequest, reply: FastifyReply): boolean {
  const key = req.headers['x-internal-key'] as string;
  if (key !== config.internalApiKey) {
    reply.status(403).send({ error: { code: 'FORBIDDEN', message: '无效内部凭证' } });
    return false;
  }
  return true;
}

function rejectLegacyEvolution(reply: FastifyReply) {
  if (!config.evolution.enabled || !['staging', 'production'].includes(config.nodeEnv)) return false;
  reply.status(410).send({ error: { code: 'LEGACY_EVOLUTION_DISABLED', message: '自进化 v2 启用后禁止使用 date + x-internal-key legacy 接口' } });
  return true;
}

export function buildAdventureRepairAudit(input: {
  userId: string;
  requestId: string;
  result: 'success' | 'failure' | 'rate_limited';
  code?: string;
  catId?: string;
  repair?: RepairTravelAudit;
}) {
  return {
    audit: 'adventure_repair',
    user_id: input.userId,
    ...(input.catId ? { cat_id: input.catId } : {}),
    result: input.result,
    ...(input.code ? { code: input.code } : {}),
    request_id: input.requestId,
    ...(input.repair ? {
      mode: input.repair.mode,
      health_before: input.repair.health_before,
      health_after: input.repair.health_after,
    } : {}),
  };
}

export function registerApiRoutes(app: FastifyInstance) {
  // PAT
  app.put('/api/v1/pat', { preHandler: requireUser }, async (req, reply) => {
    const { pat } = req.body as { pat?: string };
    if (!pat?.trim()) return reply.status(400).send({ error: { code: 'INVALID', message: 'PAT 不能为空' } });
    try {
      const credential = await verifyPat(pat.trim());
      const result = await requestPatReplacement(req.session.userId!, credential);
      return reply.status(result.requires_confirmation ? 202 : 200).send(result);
    } catch (error) {
      const typed = error as { code?: string; message?: string };
      const status = typed.code === 'QCA_TEMPORARY_ERROR' ? 503 : typed.code === 'QCA_PERMISSION_DENIED' ? 403 : 400;
      return reply.status(status)
        .send({ error: { code: typed.code || 'PAT_SAVE_FAILED', message: typed.message || 'PAT 保存失败' } });
    }
  });

  app.post('/api/v1/pat/replacements/:id/confirm', { preHandler: requireUser }, async (req, reply) => {
    try {
      return await confirmPatReplacement(req.session.userId!, (req.params as { id: string }).id);
    } catch (error) {
      const typed = error as { code?: string; message?: string };
      const status = typed.code === 'REPLACEMENT_NOT_FOUND' ? 404 : typed.code === 'IMAGE_JOB_ACTIVE' ? 409 : 400;
      return reply.status(status).send({
        error: {
          code: typed.code || 'REPLACEMENT_CONFIRM_FAILED',
          message: typed.message || '确认更换失败，请稍后重试',
        },
      });
    }
  });

  app.delete('/api/v1/pat/replacements/:id', { preHandler: requireUser }, async (req, reply) => {
    try {
      return await cancelPatReplacement(req.session.userId!, (req.params as { id: string }).id);
    } catch (error) {
      const typed = error as { code?: string; message?: string };
      return reply.status(404).send({ error: { code: typed.code || 'REPLACEMENT_NOT_FOUND', message: typed.message } });
    }
  });

  app.get('/api/v1/pat/status', { preHandler: requireUser }, async (req) => {
    const status = await getPatStatus(req.session.userId!);
    return status || { status: 'none', pat_hint: null, last_verified_at: null };
  });

  app.get('/api/v1/qca/models', { preHandler: requireUser }, async (req, reply) => {
    const pat = await getPatForUser(req.session.userId!);
    if (!pat) return reply.status(400).send({ error: { code: 'NO_PAT', message: '请先填入 PAT' } });
    try {
      return { models: await listEnabledQcaModels(pat) };
    } catch (error) {
      const typed = error as { code?: string; message?: string };
      const status = typed.code === 'QCA_TEMPORARY_ERROR' ? 503
        : typed.code === 'QCA_PERMISSION_DENIED' ? 403
          : typed.code === 'QCA_PAT_INVALID' ? 409 : 400;
      return reply.status(status).send({
        error: { code: typed.code || 'QCA_MODELS_FAILED', message: typed.message || '模型列表加载失败' },
      });
    }
  });

  app.post('/api/v1/qca/credits/recheck', { preHandler: requireUser }, async (req, reply) => {
    try {
      return await recoverQcaCredits(req.session.userId!);
    } catch (error) {
      const typed = error as { code?: string; message?: string; status?: number; help_url?: string };
      const status = typed.status
        || (typed.code === 'QCA_TEMPORARY_ERROR' ? 503
          : typed.code === 'QCA_PAT_INVALID' ? 409
            : typed.code === 'NO_CAT' ? 404 : 400);
      return reply.status(status).send({
        error: {
          code: typed.code || 'QCA_CREDITS_RECHECK_FAILED',
          message: typed.message || '云端暂时没有回音，请稍后再试。',
          ...(typed.help_url ? { help_url: typed.help_url } : {}),
        },
      });
    }
  });

  app.delete('/api/v1/pat', { preHandler: requireUser }, async (req, reply) => {
    if (await getCatByUserId(req.session.userId!)) {
      return reply.status(400).send({ error: { code: 'HAS_CAT', message: '请先召回猫再删除 PAT' } });
    }
    await deletePat(req.session.userId!);
    return reply.send({ ok: true });
  });

  app.get('/api/v1/cat-archives', { preHandler: requireUser }, async (req) => ({
    archives: await listCatArchives(req.session.userId!),
  }));

  app.get('/api/v1/cat-archives/:id', { preHandler: requireUser }, async (req, reply) => {
    const archive = await getCatArchive(req.session.userId!, (req.params as { id: string }).id);
    return archive || reply.status(404).send({ error: { code: 'ARCHIVE_NOT_FOUND', message: '归档不存在' } });
  });

  app.get('/api/v1/cat-images/:id', { preHandler: requireUser }, async (req, reply) => {
    const appearanceId = (req.params as { id: string }).id;
    try {
      const image = await getAppearanceImageForUser(req.session.userId!, appearanceId);
      if (!image) {
        return reply.status(404).send({ error: { code: 'IMAGE_NOT_FOUND', message: '图片不存在' } });
      }
      return reply.header('Content-Type', image.contentType).header('Cache-Control', 'private, max-age=3600').send(image.body);
    } catch (error) {
      const statusCode = typeof (error as { statusCode?: number }).statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : 502;
      req.log.error({ err: error, appearanceId, statusCode }, 'cat image proxy failed');
      return reply.status(502).send({
        error: {
          code: 'IMAGE_READ_FAILED',
          message: statusCode === 403
            ? '图片读取权限不足，请确认对象存储凭据已授予读取权限'
            : '图片读取失败，请稍后重试',
        },
      });
    }
  });

  // Cats
  app.post('/api/v1/cats', { preHandler: requireUser }, async (req, reply) => {
    const body = req.body as {
      name: string;
      personality: string;
      model: string;
      attrs?: { courage: number; curiosity: number; affinity: number; insight: number };
      appearance?: { baseColor: string; pattern: string; eyes: string; breed?: string };
      custom_description?: string;
    };
    try {
      const result = await createCat(req.session.userId!, body);
      const payload: Record<string, unknown> = {
        ...result.cat,
        message: '小猫档案已创建，正在生成第一张候选形象',
      };
      if (config.qcaMock) payload._dev_cat_token = result.catToken;
      return reply.send(payload);
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      if (err.code === 'CAT_EXISTS') return reply.status(409).send({ error: { code: err.code, message: err.message } });
      if (err.code === 'NO_PAT') return reply.status(400).send({ error: { code: err.code, message: err.message } });
      if (err.code === 'INVALID_ATTRS') return reply.status(400).send({ error: { code: err.code, message: err.message } });
      if (err.code === 'CUSTOM_APPEARANCE_INVALID') return reply.status(400).send({ error: { code: err.code, message: err.message } });
      if (err.code === 'QCA_MODEL_REQUIRED' || err.code === 'INVALID_QCA_MODEL') {
        return reply.status(400).send({ error: { code: err.code, message: err.message } });
      }
      throw e;
    }
  });

  app.post('/api/v1/cats/me/appearance/regenerate', { preHandler: requireUser }, async (req, reply) => {
    try {
      const { model, custom_description } = (req.body || {}) as { model?: string; custom_description?: string };
      return await regenerateBirthAppearance(req.session.userId!, model, custom_description);
    } catch (error) {
      const typed = error as { code?: string; message?: string };
      // regenerateBirthAppearance 也经 switchImageArtistModel 换 model，故同样可能抛 MODEL_CHANGE_CONFLICT（#084 三轮验收）
      const status = typed.code === 'NO_CAT' ? 404
        : typed.code === 'IMAGE_JOB_ACTIVE' || typed.code === 'MODEL_CHANGE_CONFLICT' ? 409 : 400;
      return reply.status(status)
        .send({ error: { code: typed.code || 'REGENERATE_FAILED', message: typed.message || '重画失败' } });
    }
  });

  app.post('/api/v1/cats/me/appearance/cancel', { preHandler: requireUser }, async (req, reply) => {
    try {
      return await cancelBirthImageJob(req.session.userId!);
    } catch (error) {
      const typed = error as { code?: string; message?: string };
      return reply.status(typed.code === 'NO_CAT' ? 404 : 400)
        .send({ error: { code: typed.code || 'CANCEL_IMAGE_FAILED', message: typed.message || '取消绘制失败' } });
    }
  });

  // #077：形象确认后的「重画申诉」——肢体异常（五只脚）等生图事故的自助出口。
  // 错误 code/message 走白名单固定文案（与 #072 repair 同款），未知异常不透传 error.message。
  const REPAINT_ERROR_COPY: Record<string, { status: number; message: string }> = {
    NO_CAT: { status: 404, message: '还没有猫' },
    NO_PAT: { status: 400, message: '请先绑定有效的 PAT 再试' },
    APPEARANCE_NOT_CONFIRMED: { status: 400, message: '形象还没确认，直接在建猫流程里重画就好' },
    IMAGE_JOB_ACTIVE: { status: 409, message: '上一张图片仍在生成，请稍候' },
    REPAINT_DECISION_PENDING: { status: 409, message: '上一张重画的新形象还等着你决定，先确认替换或保留原来的它' },
    REPAINT_LIMIT_REACHED: { status: 409, message: '重画次数已经用完了。如果它还是画得不对，来「给世界写信」告诉我们，我们帮你看看' },
    REPAINT_CANDIDATE_NOT_FOUND: { status: 404, message: '新形象不存在或已经处理过了' },
    CUSTOM_APPEARANCE_INVALID: { status: 400, message: '请只填写 60 字以内的小猫外貌特征，不要加入画师指令' },
  };

  const repaintFailure = (reply: FastifyReply, error: unknown, fallback: string) => {
    const rawCode = (error as { code?: unknown }).code;
    // Object.hasOwn：普通对象索引会命中 constructor/__proto__ 等继承属性（PR #63 复验发现）
    const known = typeof rawCode === 'string' && Object.hasOwn(REPAINT_ERROR_COPY, rawCode)
      ? REPAINT_ERROR_COPY[rawCode]
      : undefined;
    const code = known && typeof rawCode === 'string' ? rawCode : 'REPAINT_FAILED';
    return reply.status(known?.status ?? 400).send({ error: { code, message: known?.message ?? fallback } });
  };

  app.post('/api/v1/cats/me/appearance/repaint', { preHandler: requireUser }, async (req, reply) => {
    const userId = req.session.userId!;
    // 防连点（业务限次之外的第二道闸）：每用户 10 分钟 6 次请求。
    // 额度刻意宽于业务上限（APPEARANCE_REPAINT_LIMIT=2）——被拒的请求（未确认/待决定/活跃 job）
    // 同样计数，若额度贴着上限设，正常摸索的用户会被限流挡在真正的申请之外。
    if (!await consumeRateLimit('appearance-repaint', userId, 6, 10 * 60_000)) {
      return reply.status(429).send({ error: { code: 'RATE_LIMIT', message: '重画请求太频繁了，请稍等几分钟再试' } });
    }
    try {
      const { custom_description } = (req.body || {}) as { custom_description?: string };
      return await requestAppearanceRepaint(userId, custom_description);
    } catch (error) {
      return repaintFailure(reply, error, '重画申请没有成功，请稍后再试');
    }
  });

  app.post('/api/v1/cats/me/appearance/repaint/confirm', { preHandler: requireUser }, async (req, reply) => {
    try {
      const { appearance_id } = (req.body || {}) as { appearance_id?: string };
      if (!appearance_id) {
        return reply.status(400).send({ error: { code: 'INVALID', message: '请选择要替换的新形象' } });
      }
      return await confirmAppearanceRepaint(req.session.userId!, appearance_id);
    } catch (error) {
      return repaintFailure(reply, error, '替换没有成功，请稍后再试');
    }
  });

  app.delete('/api/v1/cats/me/appearance/repaint', { preHandler: requireUser }, async (req, reply) => {
    try {
      return await discardAppearanceRepaint(req.session.userId!);
    } catch (error) {
      return repaintFailure(reply, error, '保留原形象没有成功，请稍后再试');
    }
  });

  app.patch('/api/v1/cats/me/appearance', { preHandler: requireUser }, async (req, reply) => {
    try {
      const { appearance } = req.body as { appearance?: import('../lib/appearance.js').Appearance };
      if (!appearance) return reply.status(400).send({ error: { code: 'INVALID_APPEARANCE', message: '请选择完整外观' } });
      return await updateDraftAppearance(req.session.userId!, appearance);
    } catch (error) {
      const typed = error as { code?: string; message?: string };
      return reply.status(typed.code === 'NO_CAT' ? 404 : typed.code === 'IMAGE_JOB_ACTIVE' ? 409 : 400)
        .send({ error: { code: typed.code || 'UPDATE_APPEARANCE_FAILED', message: typed.message || '修改外观失败' } });
    }
  });

  app.post('/api/v1/cats/me/appearance/confirm', { preHandler: requireUser }, async (req, reply) => {
    try {
      const { appearance_id } = req.body as { appearance_id?: string };
      if (!appearance_id) return reply.status(400).send({ error: { code: 'INVALID', message: '请选择一张候选图片' } });
      return await confirmBirthAppearance(req.session.userId!, appearance_id);
    } catch (error) {
      const typed = error as { code?: string; message?: string };
      return reply.status(typed.code === 'NO_CAT' ? 404 : 400)
        .send({ error: { code: typed.code || 'CONFIRM_FAILED', message: typed.message || '确认失败' } });
    }
  });

  app.post('/api/v1/cats/me/adventure/start', { preHandler: requireUser }, async (req, reply) => {
    try {
      return await startAdventure(req.session.userId!);
    } catch (error) {
      const typed = error as { code?: string; message?: string; schedule_enabled?: boolean };
      const creditsAlert = typed.code === QCA_CREDITS_UNAVAILABLE ? toQcaUserAlert('travel') : null;
      return reply.status(typed.code === 'NO_CAT' ? 404 : typed.code === 'ADVENTURE_STARTING' ? 409 : 400)
        .send({ error: {
          code: typed.code || 'ADVENTURE_FAILED',
          message: creditsAlert?.message || toAdventureStartUserMessage(error),
          help_url: creditsAlert?.help_url,
          schedule_enabled: typed.schedule_enabled,
        } });
    }
  });

  // #072：repair 面向用户暴露后，code/message 全部走服务端白名单映射——
  // 已枚举 code 给固定文案，未知异常统一 REPAIR_FAILED + 固定文案，
  // 不调用 toAdventureStartUserMessage（它对未枚举分支会透传 error.message）。
  const REPAIR_ERROR_COPY: Record<string, { status: number; message: string }> = {
    NO_CAT: { status: 404, message: '还没有猫' },
    NO_PAT: { status: 400, message: '请先绑定有效的 PAT 再试' },
    NO_TRAVEL_RESOURCES: { status: 400, message: '还没有创建探险资源，先带它开始第一次探险吧' },
    REPAIR_HEALTH_STILL_BROKEN: { status: 409, message: '云端资源复检仍未恢复，请稍后再试或检查 PAT 与 Credits' },
    [QCA_CREDITS_UNAVAILABLE]: { status: 400, message: toQcaUserAlert('travel').message },
  };

  app.post('/api/v1/cats/me/adventure/repair', { preHandler: requireUser }, async (req, reply) => {
    const userId = req.session.userId!;
    // L-audit（EVOLUTION §7）：只记非敏感 ID / 动作 / 结果 / 白名单 code / request_id，
    // 禁止记录 PAT、QCA 原始响应或异常正文——审计本身也脱敏。
    const audit = (
      result: 'success' | 'failure' | 'rate_limited',
      code?: string,
      catId?: string,
      repair?: RepairTravelAudit,
    ) => {
      req.log.info(
        buildAdventureRepairAudit({ userId, requestId: req.id, result, code, catId, repair }),
        'L-audit: adventure repair',
      );
    };
    // #072：一键修复暴露给用户后加限流防连点（每用户 10 分钟 3 次）
    if (!await consumeRateLimit('adventure-repair', userId, 3, 10 * 60_000)) {
      audit('rate_limited', 'RATE_LIMIT');
      return reply.status(429).send({ error: { code: 'RATE_LIMIT', message: '修复请求太频繁了，请稍等几分钟再试' } });
    }
    try {
      const { profile, audit: repairAudit } = await repairTravelAgent(userId);
      audit('success', undefined, profile?.id, repairAudit);
      return profile;
    } catch (error) {
      const rawCode = (error as { code?: unknown }).code;
      const repairAudit = (error as { repair_audit?: RepairTravelAudit }).repair_audit;
      // Object.hasOwn：普通对象索引会命中 constructor/__proto__/toString 等继承属性，
      // 导致未知 code 被误认白名单命中并回显（PR #63 第二轮复验发现）。
      const known = typeof rawCode === 'string' && Object.hasOwn(REPAIR_ERROR_COPY, rawCode)
        ? REPAIR_ERROR_COPY[rawCode]
        : undefined;
      const code = known && typeof rawCode === 'string' ? rawCode : 'REPAIR_FAILED';
      audit('failure', code, undefined, repairAudit);
      return reply.status(known?.status ?? 400)
        .send({ error: { code, message: known?.message ?? '照看修复没有成功，请稍后再试' } });
    }
  });

  app.get('/api/v1/cats/me', { preHandler: requireUser }, async (req, reply) => {
    const cat = await getCatProfile(req.session.userId!);
    if (!cat) return reply.status(404).send({ error: { code: 'NO_CAT', message: '还没有猫' } });
    return cat;
  });

  app.patch('/api/v1/cats/me', { preHandler: requireUser }, async (req, reply) => {
    try {
      const cat = await updateCat(req.session.userId!, req.body as { name?: string; personality?: string });
      return cat;
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      return reply.status(400).send({ error: { code: err.code, message: err.message } });
    }
  });

  // #084：建猫向导之外唯一的换 model 入口。只重建画师资源，聊天/旅行的 Forward 配置读时取值故不动。
  app.patch('/api/v1/cats/me/model', { preHandler: requireUser }, async (req, reply) => {
    try {
      const { model } = (req.body || {}) as { model?: string };
      return await changeCatModel(req.session.userId!, model || '');
    } catch (error) {
      const typed = error as { code?: string; message?: string };
      const creditsAlert = typed.code === QCA_CREDITS_UNAVAILABLE ? toQcaUserAlert('image') : null;
      const status = typed.code === 'NO_CAT' ? 404
        // MODEL_CHANGE_CONFLICT：并发另一次更换先完成且换到了别的 model（#084 二轮验收）——
        // 属资源状态冲突而非入参错误，用 409 让前端知道可刷新后重试。
        : typed.code === 'IMAGE_JOB_ACTIVE' || typed.code === 'MODEL_CHANGE_CONFLICT' ? 409
          : typed.code === 'QCA_TEMPORARY_ERROR' ? 503 : 400;
      return reply.status(status).send({
        error: {
          code: typed.code || 'MODEL_CHANGE_FAILED',
          message: creditsAlert?.message || typed.message || '更换模型失败，请稍后再试',
          ...(creditsAlert ? { help_url: creditsAlert.help_url } : {}),
        },
      });
    }
  });

  app.post('/api/v1/cats/me/recall', { preHandler: requireUser }, async (req) => recallCat(req.session.userId!));
  app.post('/api/v1/cats/me/release', { preHandler: requireUser }, async (req) => releaseCat(req.session.userId!));

  // #056a：许愿下次旅行目的地（一次性，命中清除；min_attrs 门槛在服务端裁决）
  app.post('/api/v1/cats/me/travel-wish', { preHandler: requireUser }, async (req, reply) => {
    try {
      const body = req.body as { location_id?: string };
      if (!body?.location_id) return reply.status(400).send({ error: { code: 'INVALID_INPUT', message: '缺少 location_id' } });
      return await setTravelWish(req.session.userId!, body.location_id);
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      return reply.status(err.code === 'NO_CAT' ? 404 : 400).send({ error: { code: err.code, message: err.message } });
    }
  });
  app.delete('/api/v1/cats/me/travel-wish', { preHandler: requireUser }, async (req, reply) => {
    try {
      return await clearTravelWish(req.session.userId!);
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      return reply.status(404).send({ error: { code: err.code, message: err.message } });
    }
  });

  // #056b：流浪模式开关（纯视觉状态，不改旅行调度）
  app.patch('/api/v1/cats/me/wandering', { preHandler: requireUser }, async (req, reply) => {
    try {
      const body = req.body as { enabled?: boolean };
      if (typeof body?.enabled !== 'boolean') return reply.status(400).send({ error: { code: 'INVALID_INPUT', message: 'enabled 必须是布尔值' } });
      return await setWanderingMode(req.session.userId!, body.enabled);
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      return reply.status(404).send({ error: { code: err.code, message: err.message } });
    }
  });
  app.post('/api/v1/cats/me/repair', { preHandler: requireUser }, async (req, reply) => {
    try {
      return await repairImageJobs(req.session.userId!);
    } catch (error) {
      const typed = error as { code?: string; message?: string };
      return reply.status(typed.code === 'NO_CAT' ? 404 : 400)
        .send({ error: { code: typed.code || 'REPAIR_FAILED', message: typed.message || '修复失败' } });
    }
  });

  app.get('/api/v1/cats/me/travels', { preHandler: requireUser }, async (req) => {
    const cat = await getCatByUserId(req.session.userId!);
    if (!cat) return { travels: [] };
    const q = req.query as { page?: string; location_id?: string };
    return { travels: await listTravels(cat.id, { page: parseInt(q.page || '1', 10), locationId: q.location_id }) };
  });

  app.get('/api/v1/cats/me/encounters', { preHandler: requireUser }, async (req) => {
    const cat = await getCatByUserId(req.session.userId!);
    if (!cat) return { encounters: [] };
    const page = Math.max(1, parseInt((req.query as { page?: string }).page || '1', 10) || 1);
    return { encounters: await listEncounterReceipts(cat.id, page) };
  });

  app.patch('/api/v1/cats/me/social-settings', { preHandler: requireUser }, async (req, reply) => {
    const { meet_enabled } = (req.body || {}) as { meet_enabled?: unknown };
    if (typeof meet_enabled !== 'boolean') {
      return reply.status(400).send({ error: { code: 'INVALID_SOCIAL_SETTINGS', message: 'meet_enabled 必须是布尔值' } });
    }
    try {
      return await setMeetEnabled(req.session.userId!, meet_enabled);
    } catch (error) {
      const typed = error as { code?: string; message?: string };
      return reply.status(typed.code === 'NO_CAT' ? 404 : 400)
        .send({ error: { code: typed.code || 'SOCIAL_SETTINGS_FAILED', message: typed.message || '猫遇设置失败' } });
    }
  });

  app.get('/api/v1/cats/me/onboarding-answers', { preHandler: requireUser }, async (req) => ({
    answers: await listOnboardingAnswers(req.session.userId!),
  }));

  app.put('/api/v1/cats/me/onboarding-answers', { preHandler: requireUser }, async (req, reply) => {
    try {
      const { answers } = (req.body || {}) as { answers?: Array<{ question_id: string; choice_id?: string; answer_text?: string; skipped?: boolean }> };
      return { answers: await saveOnboardingAnswers(req.session.userId!, answers || []) };
    } catch (error) {
      const typed = error as { code?: string; message?: string };
      return reply.status(400).send({ error: { code: typed.code || 'INVALID_ANSWERS', message: typed.message || '保存失败' } });
    }
  });

  app.delete('/api/v1/cats/me/onboarding-answers/:questionId', { preHandler: requireUser }, async (req) => {
    const { questionId } = req.params as { questionId: string };
    return deleteOnboardingAnswer(req.session.userId!, questionId);
  });
  app.get('/api/v1/cats/me/memories', { preHandler: requireUser }, async (req) => ({ memories: await getVisibleMemories(req.session.userId!) }));
  app.get('/api/v1/cats/me/bond', { preHandler: requireUser }, async (req) => getBondState(req.session.userId!));
  app.get('/api/v1/cats/me/weekly-recap', { preHandler: requireUser }, async (req) => getWeeklyRecap(req.session.userId!));
  app.get('/api/v1/cats/me/return-message', { preHandler: requireUser }, async (req) => getGentleReturnMessage(req.session.userId!));

  const growthCardError = (reply: FastifyReply, error: unknown) => {
    const typed = error as { code?: string; message?: string };
    const status = typed.code === 'GROWTH_CARD_NOT_FOUND' || typed.code === 'NO_CAT' ? 404 : 400;
    return reply.status(status).send({ error: { code: typed.code || 'GROWTH_CARD_FAILED', message: typed.message || '成长卡片操作失败' } });
  };

  app.get('/api/v1/growth-cards', { preHandler: requireUser }, async (req) => ({
    cards: await listGrowthCards(req.session.userId!),
  }));
  app.post('/api/v1/growth-cards', { preHandler: requireUser }, async (req, reply) => {
    try { return await createGrowthCard(req.session.userId!, (req.body || {}) as GrowthCardInput); }
    catch (error) { return growthCardError(reply, error); }
  });
  app.patch('/api/v1/growth-cards/:id', { preHandler: requireUser }, async (req, reply) => {
    try { return await updateGrowthCard(req.session.userId!, (req.params as { id: string }).id, (req.body || {}) as GrowthCardInput); }
    catch (error) { return growthCardError(reply, error); }
  });
  app.delete('/api/v1/growth-cards/:id', { preHandler: requireUser }, async (req, reply) => {
    try { return await deleteGrowthCard(req.session.userId!, (req.params as { id: string }).id); }
    catch (error) { return growthCardError(reply, error); }
  });
  app.post('/api/v1/growth-cards/:id/retry-sync', { preHandler: requireUser }, async (req, reply) => {
    try { return await retryGrowthCardSync(req.session.userId!, (req.params as { id: string }).id); }
    catch (error) { return growthCardError(reply, error); }
  });
  app.get('/api/v1/cats/me/growth-tags', { preHandler: requireUser }, async (req) => getGrowthTags(req.session.userId!));

  app.post('/api/v1/postcards/:id/pat', { preHandler: requireUser }, async (req) => {
    const { id } = req.params as { id: string };
    return respondToPostcard(req.session.userId!, id, 'pat');
  });
  app.put('/api/v1/postcards/:id/reply', { preHandler: requireUser }, async (req) => {
    const { id } = req.params as { id: string };
    return respondToPostcard(req.session.userId!, id, 'reply', (req.body || {}) as { choice_id?: string; content?: string });
  });
  app.put('/api/v1/postcards/:id/cherish', { preHandler: requireUser }, async (req) => {
    const { id } = req.params as { id: string };
    return respondToPostcard(req.session.userId!, id, 'cherish');
  });
  app.post('/api/v1/postcards/:id/photo/repair', { preHandler: requireUser }, async (req, reply) => {
    try {
      return await repairPostcardPhoto(req.session.userId!, (req.params as { id: string }).id);
    } catch (error) {
      const typed = error as { code?: string; message?: string };
      return reply.status(typed.code === 'NOT_FOUND' ? 404 : 400)
        .send({ error: { code: typed.code || 'REPAIR_FAILED', message: typed.message || '照片重试失败' } });
    }
  });

  app.get('/api/v1/cats/me/badges', { preHandler: requireUser }, async (req) => {
    const cat = await getCatByUserId(req.session.userId!);
    if (!cat) return { badges: [] };
    return { badges: await listBadgesForCat(cat.id) };
  });

  app.patch('/api/v1/cats/me/outfit', { preHandler: requireUser }, async (req, reply) => {
    try {
      return await updateOutfit(req.session.userId!, req.body as { head?: string | null; neck?: string | null; back?: string | null });
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      return reply.status(400).send({ error: { code: err.code, message: err.message } });
    }
  });

  app.get('/api/v1/world/map', { preHandler: requireUser }, async (req) => getWorldMap(req.session.userId!));
  app.get('/api/v1/world/chronicle', { preHandler: requireUser }, async () => ({ entries: await listWorldChronicle() }));
  app.get('/api/v1/world/digest', { preHandler: requireUser }, async (req, reply) => {
    const digest = await getWorldDigest(req.session.userId!);
    return digest || reply.status(404).send({ error: { code: 'NO_CAT', message: '还没有猫' } });
  });

  app.get('/api/v1/cats/me/chat/history', { preHandler: requireUser }, async (req, reply) => {
    const rawLimit = Number((req.query as { limit?: string }).limit ?? 100);
    try {
      return { messages: await listChatHistory(req.session.userId!, rawLimit) };
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      return reply.status(400).send({ error: { code: err.code, message: err.message } });
    }
  });

  app.get('/api/v1/cats/me/chat/turns/:id', { preHandler: requireUser }, async (req, reply) => {
    try {
      return await getChatTurn(req.session.userId!, (req.params as { id: string }).id);
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      return reply.status(404).send({ error: { code: err.code || 'CHAT_TURN_NOT_FOUND', message: err.message } });
    }
  });

  app.post('/api/v1/cats/me/chat', { preHandler: requireUser }, async (req, reply) => {
    const { message, mode = 'queue', async: respondAsync = false } = req.body as {
      message?: string;
      mode?: 'queue' | 'interrupt';
      async?: boolean;
    };
    if (!message?.trim()) return reply.status(400).send({ error: { code: 'EMPTY', message: '消息不能为空' } });
    if (mode !== 'queue' && mode !== 'interrupt') {
      return reply.status(400).send({ error: { code: 'INVALID_CHAT_MODE', message: '不支持的发送方式' } });
    }

    try {
      const queued = await enqueueChatTurn(req.session.userId!, message.trim(), mode);
      if (respondAsync) return reply.status(202).send({ turn: queued });

      const turn = await waitForChatTurn(req.session.userId!, queued.id);
      if (turn.status !== 'completed' || !turn.reply) {
        const status = turn.status === 'canceled' ? 409 : 400;
        return reply.status(status).send({ error: {
          code: turn.error?.code || (turn.status === 'canceled' ? 'CHAT_TURN_CANCELED' : 'CHAT_TURN_FAILED'),
          message: turn.error?.message || (turn.status === 'canceled' ? '这轮思考已被你打断。' : '云上暂时没有回音。'),
        } });
      }
      const replyText = turn.reply;
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const chunks = replyText.match(/.{1,20}/g) || [replyText];
      for (const chunk of chunks) {
        reply.raw.write(`data: ${JSON.stringify({ type: 'delta', text: chunk })}\n\n`);
        await new Promise((r) => setTimeout(r, 30));
      }
      reply.raw.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      reply.raw.end();
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      const creditsAlert = err.code === QCA_CREDITS_UNAVAILABLE ? toQcaUserAlert('chat') : null;
      return reply.status(err.code === QCA_CHAT_TIMEOUT ? 504 : 400).send({ error: {
        code: err.code,
        message: creditsAlert?.message || err.message,
        help_url: creditsAlert?.help_url,
      } });
    }
  });

  // Proposals
  app.post('/api/v1/proposals', { preHandler: requireUser }, async (req, reply) => {
    const { type, content, client_context } = req.body as { type: 'feature' | 'bug'; content: string; client_context?: Record<string, unknown> };
    try {
      return await createProposal(req.session.userId!, type, content, client_context);
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      return reply.status(400).send({ error: { code: err.code, message: err.message } });
    }
  });

  app.get('/api/v1/proposals/mine', { preHandler: requireUser }, async (req) => ({
    proposals: await listMyProposals(req.session.userId!),
    contribution: await getContributionSummary(req.session.userId!),
  }));

  // Cat-facing APIs
  app.get('/api/v1/world/today', async (req, reply) => {
    const cat = await resolveCatFromToken(req, reply);
    if (!cat) return;
    return getWorldToday(cat.id);
  });

  app.post('/api/v1/travels/destination', async (req, reply) => {
    const cat = await resolveCatFromToken(req, reply);
    if (!cat) return;
    try {
      const { location_id } = (req.body || {}) as { location_id?: unknown };
      return { ok: true, ...(await reportCurrentDestination(cat.id, location_id)) };
    } catch (error) {
      const typed = error as { code?: string; message?: string; next_available_at?: string };
      return reply.status(typed.code === 'DESTINATION_ALREADY_SELECTED' ? 409 : 400).send({
        error: { code: typed.code || 'DESTINATION_REPORT_FAILED', message: typed.message || '目的地上报失败', next_available_at: typed.next_available_at },
      });
    }
  });

  app.post('/api/v1/travels/report', async (req, reply) => {
    const cat = await resolveCatFromToken(req, reply);
    if (!cat) return;
    try {
      const result = await reportTravel(cat.id, req.body as Parameters<typeof reportTravel>[1]);
      return {
        ok: true,
        travel_id: result.travelId,
        badges_earned: result.badges,
        item_dropped: result.itemDropped,
        encounter_id: result.encounter?.encounterId || null,
      };
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string; travelId?: string; next_available_at?: string };
      if (err.code === 'DUPLICATE') {
        return reply.status(409).send({ ok: false, travel_id: err.travelId, error: { code: 'DUPLICATE', message: err.message, next_available_at: err.next_available_at } });
      }
      return reply.status(400).send({ error: { code: err.code || 'ERROR', message: err.message } });
    }
  });

  // Internal
  app.post('/api/v1/internal/world/sync', async (req, reply) => {
    if (!requireInternal(req, reply)) return;
    const result = await syncWorldFromRepo();
    return { ok: true, ...result, world_version: await getWorldVersion() };
  });

  app.get('/api/v1/internal/world/chronicle', async (req, reply) => {
    if (!requireInternal(req, reply)) return;
    return { entries: await listManagedChronicle() };
  });

  app.get('/api/v1/internal/world/chronicle/:id/revisions', async (req, reply) => {
    if (!requireInternal(req, reply)) return;
    return { revisions: await listChronicleRevisions((req.params as { id: string }).id) };
  });

  app.post('/api/v1/internal/world/chronicle', async (req, reply) => {
    if (!requireInternal(req, reply)) return;
    try {
      return reply.status(201).send({ entry: await createChronicleEntry(req.body as Parameters<typeof createChronicleEntry>[0]) });
    } catch (error) {
      const typed = error as { code?: string; message?: string };
      return reply.status(400).send({ error: { code: typed.code || 'CHRONICLE_WRITE_FAILED', message: typed.message } });
    }
  });

  app.patch('/api/v1/internal/world/chronicle/:id', async (req, reply) => {
    if (!requireInternal(req, reply)) return;
    try {
      const { expected_revision, ...input } = (req.body || {}) as Parameters<typeof createChronicleEntry>[0] & { expected_revision: number };
      return { entry: await updateChronicleEntry((req.params as { id: string }).id, expected_revision, input) };
    } catch (error) {
      const typed = error as { code?: string; message?: string };
      const status = typed.code === 'CHRONICLE_NOT_FOUND' ? 404 : typed.code === 'REVISION_CONFLICT' ? 409 : 400;
      return reply.status(status).send({ error: { code: typed.code || 'CHRONICLE_WRITE_FAILED', message: typed.message } });
    }
  });

  app.get('/api/v1/internal/evolution/proposals/export', async (req, reply) => {
    if (rejectLegacyEvolution(reply)) return;
    if (!requireInternal(req, reply)) return;
    const date = (req.query as { date?: string }).date;
    if (!date) return reply.status(400).send({ error: { code: 'MISSING_DATE', message: '需要 date 参数' } });
    return { proposals: await exportProposals(date) };
  });

  app.get('/api/v1/internal/evolution/proposals/issues', async (req, reply) => {
    if (rejectLegacyEvolution(reply)) return;
    if (!requireInternal(req, reply)) return;
    const date = (req.query as { date?: string }).date;
    if (!date) return reply.status(400).send({ error: { code: 'MISSING_DATE', message: '需要 date 参数' } });
    return { issues: await exportProposalIssues(date) };
  });

  // #077 验收标准 1：个案形象审计（运营只读诊断）。
  // 判断用户反馈的肢体异常图属出生定妆照还是成长图——决定走 #077 重画申诉出口还是既有成长图重画。
  // 只读、无写操作；返回结构性事实，不含 image_url/prompt/object_key/PAT/QCA 资源 ID。
  // user_id 由调用方从 /internal/evolution/proposals/issues 取得（同一 INTERNAL_API_KEY 权限层）。
  app.get('/api/v1/internal/ops/cat-appearance-audit', async (req, reply) => {
    if (!requireInternal(req, reply)) return;
    const userId = (req.query as { user_id?: string }).user_id;
    if (!userId) return reply.status(400).send({ error: { code: 'MISSING_USER_ID', message: '需要 user_id 参数' } });
    return { audit: await auditCatAppearanceForUser(userId) };
  });

  // #134: plan/status are provider-read-free. The mutating path is separate and
  // requires a literal confirmation so a monitoring caller cannot accidentally
  // spend a user's QCA write quota merely by polling reconciliation health.
  app.post('/api/v1/internal/ops/cat-task-reconciliation/plan', async (req, reply) => {
    if (!requireInternal(req, reply)) return;
    const { limit } = (req.body || {}) as { limit?: number };
    return { ok: true, plan: await planCatTaskReconciliation({ limit }) };
  });

  app.get('/api/v1/internal/ops/cat-task-reconciliation/status', async (req, reply) => {
    if (!requireInternal(req, reply)) return;
    return { ok: true, reconciliation: await getCatTaskReconciliationStatus() };
  });

  app.post('/api/v1/internal/ops/cat-task-reconciliation/execute', async (req, reply) => {
    if (!requireInternal(req, reply)) return;
    const body = (req.body || {}) as { confirm_execute?: boolean; limit?: number; worker_id?: string };
    if (body.confirm_execute !== true) {
      return reply.status(400).send({
        error: { code: 'EXECUTE_CONFIRMATION_REQUIRED', message: '必须显式传 confirm_execute=true' },
      });
    }
    return {
      ok: true,
      reconciliation: await executeCatTaskReconciliation({ limit: body.limit, workerId: body.worker_id }),
    };
  });

  app.post('/api/v1/internal/evolution/proposals/ack', async (req, reply) => {
    if (rejectLegacyEvolution(reply)) return;
    if (!requireInternal(req, reply)) return;
    const { ids, status, backlog_ref, decision_note } = req.body as {
      ids: string[]; status: ProposalStatus; backlog_ref?: string; decision_note?: string;
    };
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100) {
      return reply.status(400).send({ error: { code: 'INVALID_IDS', message: 'ids 必须包含 1 到 100 个提案' } });
    }
    if (!PROPOSAL_STATUSES.includes(status)) {
      return reply.status(400).send({ error: { code: 'INVALID_STATUS', message: 'status 不是允许的提案状态' } });
    }
    try {
      const proposals = await ackProposals({
        ids, status, backlogRef: backlog_ref, decisionNote: decision_note,
      });
      return { ok: true, proposals };
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      return reply.status(err.code === 'NOT_FOUND' ? 404 : 400).send({ error: { code: err.code, message: err.message } });
    }
  });

  app.post('/api/v1/internal/evolution/proposals/production-verify', async (req, reply) => {
    if (rejectLegacyEvolution(reply)) return;
    if (!requireInternal(req, reply)) return;
    const { ids, release_sha, observed_at, evidence_ref } = req.body as {
      ids: string[]; release_sha: string; observed_at: string; evidence_ref: string;
    };
    try {
      const proposals = await recordProductionVerification({
        ids, releaseSha: release_sha, observedAt: observed_at, evidenceRef: evidence_ref,
      });
      return { ok: true, proposals };
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      return reply.status(err.code === 'NOT_FOUND' ? 404 : err.code === 'VERIFICATION_CONFLICT' ? 409 : 400)
        .send({ error: { code: err.code, message: err.message } });
    }
  });

  app.get('/api/v1/internal/evolution/contributors', async (req, reply) => {
    if (rejectLegacyEvolution(reply)) return;
    if (!requireInternal(req, reply)) return;
    const requested = Number((req.query as { limit?: string }).limit || 50);
    const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.floor(requested), 1), 200) : 50;
    return { contributors: await listContributorLeaderboard(limit) };
  });

  app.get('/healthz', async () => ({
    ok: true,
    env: config.nodeEnv,
    world_version: await getWorldVersion(),
    qca_mock: config.qcaMock,
    auth_mode: config.authMode,
    release_sha: config.releaseSha || null,
    evolution_control_plane: config.evolution.enabled,
  }));
  app.get('/readyz', async (_req, reply) => {
    try {
      await sql`SELECT 1`.execute(db);
      if (config.evolution.enabled) await sql`SELECT 1 FROM evolution_circuit LIMIT 1`.execute(db);
      await checkRedis();
      await imageStorage.checkReady();
      const worldVersion = await getWorldVersion();
      if (!worldVersion) throw new Error('world data is not initialized');
      const storageReadOk = await imageStorage.checkReadAccess();
      // ADR-0068 §决策 4：storage_read_ok 是新键；oss_read_ok 保留一个版本，避免灰度期间
      // 「新探针 + 旧 API」或「旧探针 + 新 API」互不认（health-probe.mjs 由 launchd 每小时跑）。
      return {
        ok: true,
        world_version: worldVersion,
        storage_read_ok: storageReadOk,
        oss_read_ok: storageReadOk,
        storage_driver: config.storageDriver,
        storage_fallback_enabled: config.legacyOssFallback,
        storage_fallback_hits: storageFallbackHits(),
      };
    } catch (error) {
      reqLogError(reply, error);
      return reply.status(503).send({ ok: false, error: 'NOT_READY' });
    }
  });

  if (config.nodeEnv !== 'production') {
    app.post('/api/v1/internal/dev/regenerate-growth-photo', { preHandler: requireUser }, async (req, reply) => {
      try {
        return await regenerateLatestGrowthPhoto(req.session.userId!);
      } catch (error) {
        const typed = error as { code?: string; message?: string };
        return reply.status(typed.code === 'NO_TRAVEL' ? 404 : typed.code === 'IMAGE_JOB_ACTIVE' ? 409 : 400)
          .send({ error: { code: typed.code || 'REGENERATE_GROWTH_FAILED', message: typed.message || '旅行照片重画失败' } });
      }
    });

    app.post('/api/v1/internal/dev/simulate-travel', { preHandler: requireUser }, async (req, reply) => {
      const cat = await getCatByUserId(req.session.userId!);
      if (!cat) return reply.status(404).send({ error: { code: 'NO_CAT', message: '没有猫' } });
      try {
        const result = await reportTravel(cat.id, {
          location_id: 'loc-cloud-lighthouse',
          event_id: 'evt-lighthouse-shooting-star',
          narrative: '（模拟）爬上云端灯塔，风很大，但流星很美。',
          mood: '宁静',
          attr_delta: { insight: 1 },
          postcard: { title: '灯塔上的流星', content: '主人，今晚我在灯塔看到了流星雨。' },
          memory_digest: '模拟旅行记忆',
        });
        return { ok: true, ...result };
      } catch (e: unknown) {
        const err = e as { code?: string; message?: string; travelId?: string };
        if (err.code === 'DUPLICATE') return reply.status(409).send({ ok: false, travel_id: err.travelId });
        return reply.status(400).send({ error: { code: err.code, message: err.message } });
      }
    });
  }
}

function reqLogError(reply: FastifyReply, error: unknown) {
  reply.log.error({ err: error }, 'readiness check failed');
}
