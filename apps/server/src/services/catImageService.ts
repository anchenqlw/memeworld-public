import { v4 as uuid } from 'uuid';
import { db, type CatRow } from '../db/index.js';
import { config } from '../config.js';
import { imageStorage } from '../infrastructure/imageStorage.js';
import { webpKeyFor, writeWebpDerivative } from '../infrastructure/imageDerivative.js';
import type { Appearance } from '../lib/appearance.js';
import { decryptPat } from '../lib/crypto.js';
import { buildBirthPrompt, buildGrowthPrompt, buildCatIdentityAnchor, buildEncounterPhotoPrompt } from '../lib/meandmeImageStyle.js';
import {
  createImageArtistResources,
  runImageGenSession,
  downloadQcaFile,
  archiveImageArtistResources,
  IMAGE_ARTIST_POLICY_VERSION,
  cancelImageGenSession,
  type ImageArtistResources,
} from './qcaImage.js';
import { resolveQcaAgentModel, type QcaCredential } from './qca.js';
import { buildCustomAppearancePrompts } from './customAppearanceService.js';

export { buildBirthPrompt, buildGrowthPrompt, buildCatIdentityAnchor, buildEncounterPhotoPrompt } from '../lib/meandmeImageStyle.js';

async function resolveIdentityAnchor(cat: CatRow): Promise<string> {
  if (cat.image_identity_anchor) return cat.image_identity_anchor;
  const anchor = buildCatIdentityAnchor({
    name: cat.name,
    appearance: JSON.parse(cat.appearance) as Appearance,
  });
  await db.updateTable('cats').set({ image_identity_anchor: anchor, updated_at: new Date().toISOString() }).where('id', '=', cat.id).execute();
  return anchor;
}

export type AppearanceRecord = {
  id: string;
  cat_id: string;
  kind: 'birth' | 'growth';
  image_url: string;
  object_key: string | null;
  selection_status: string;
  prompt: string;
  travel_id: string | null;
  created_at: string;
};

export function publicImageUrl(appearance: { id: string; object_key: string | null; image_url: string | null }) {
  if (appearance.object_key) return `/api/v1/cat-images/${appearance.id}`;
  return appearance.image_url || '';
}

// ---------- backlog #077：形象确认后的「重画申诉」候选标记 ----------

/**
 * 重画申诉产生的出生图候选，用 id 前缀自我标记。
 *
 * 为什么用 id 前缀而不是新列/新表：本条目硬约束不动 schema，而「限次」与「哪张是待确认的重画候选」
 * 都需要可判定的标记。出生图任务的 appearance_id 由服务端在入队时生成（enqueueImageJob →
 * generateBirthAppearance 以它为 cat_appearances.id），因此前缀同时落在 image_jobs.appearance_id
 * 与 cat_appearances.id 上，两处都可查。
 *
 * 刻意不用「created_at > appearance_confirmed_at」判定：cat_appearances.created_at 走
 * SQLite CURRENT_TIMESTAMP（'2026-08-01 03:04:05'），而 appearance_confirmed_at 走
 * new Date().toISOString()（'2026-08-01T03:04:05.123Z'）——空格 < 'T'，字符串比较会把确认之后
 * 生成的候选判成更早，方向恰好相反。
 */
export const REPAINT_APPEARANCE_ID_PREFIX = 'repaint-';

export function newRepaintAppearanceId() {
  return `${REPAINT_APPEARANCE_ID_PREFIX}${uuid()}`;
}

export function isRepaintAppearanceId(id: string) {
  return id.startsWith(REPAINT_APPEARANCE_ID_PREFIX);
}

/** 待用户决定的重画候选（最多一张：请求端要求先决定再画下一张） */
export async function findPendingRepaintCandidate(catId: string) {
  const row = await db.selectFrom('cat_appearances').select(['id', 'image_url', 'object_key', 'created_at'])
    .where('cat_id', '=', catId).where('kind', '=', 'birth')
    .where('selection_status', '=', 'candidate')
    .where('id', 'like', `${REPAINT_APPEARANCE_ID_PREFIX}%`)
    .orderBy('created_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
  if (!row) return null;
  return { id: row.id, image_url: publicImageUrl(row), created_at: String(row.created_at) };
}

async function getPatForCat(userId: string): Promise<QcaCredential | null> {
  const row = await db.selectFrom('pat_credentials').select(['encrypted_pat', 'qca_site', 'status']).where('user_id', '=', userId).executeTakeFirst();
  if (!row || row.status !== 'valid') return null;
  return { pat: decryptPat(row.encrypted_pat), site: row.qca_site as QcaCredential['site'], userId };
}

export function needsImageArtistReplacement(cat: Pick<CatRow, 'qca_image_env_id' | 'qca_image_agent_id' | 'qca_image_policy_version'>) {
  return !cat.qca_image_env_id || !cat.qca_image_agent_id || cat.qca_image_policy_version < IMAGE_ARTIST_POLICY_VERSION;
}

async function ensureImageArtist(cat: CatRow, credential: QcaCredential): Promise<ImageArtistResources> {
  if (!needsImageArtistReplacement(cat)) {
    return { envId: cat.qca_image_env_id!, agentId: cat.qca_image_agent_id! };
  }
  const model = cat.qca_model || await resolveQcaAgentModel(credential);
  const resources = await createImageArtistResources(credential, cat.name, cat.id.slice(0, 8), model);
  const previous = { envId: cat.qca_image_env_id || '', agentId: cat.qca_image_agent_id || '' };
  // 乐观并发（#084 二轮验收指出本处未被保护）：本函数与「更换 model」路径写同一组画师字段，
  // 两者并发时无条件 UPDATE 会让先写的画师永久孤立在用户 QCA 账号。以画师 id 为令牌
  // （每次创建必不同，不像 qca_model 会回退）；败者自清刚建的资源并复用赢家已落库的画师。
  const updated = await db.updateTable('cats').set({
    qca_image_env_id: resources.envId, qca_image_agent_id: resources.agentId,
    qca_image_policy_version: IMAGE_ARTIST_POLICY_VERSION, updated_at: new Date().toISOString(),
  })
    .where('id', '=', cat.id)
    .where((eb) => cat.qca_image_env_id === null
      ? eb('qca_image_env_id', 'is', null)
      : eb('qca_image_env_id', '=', cat.qca_image_env_id))
    .executeTakeFirst();
  if (!Number(updated?.numUpdatedRows ?? 0)) {
    await archiveImageArtistResources(credential, { envId: resources.envId, agentId: resources.agentId });
    const fresh = await db.selectFrom('cats').select(['qca_image_env_id', 'qca_image_agent_id'])
      .where('id', '=', cat.id).executeTakeFirst();
    if (fresh?.qca_image_env_id && fresh.qca_image_agent_id) {
      return { envId: fresh.qca_image_env_id, agentId: fresh.qca_image_agent_id };
    }
    throw Object.assign(new Error('画师资源正在被另一次操作重建，请稍后再试'), { code: 'IMAGE_ARTIST_BUSY' });
  }
  if (previous.envId || previous.agentId) await archiveImageArtistResources(credential, previous);
  return resources;
}

export async function getCurrentImageUrl(catId: string): Promise<string | null> {
  const cat = await db.selectFrom('cats').select('selected_birth_appearance_id').where('id', '=', catId).executeTakeFirst();
  // 用户确认的出生图是永久角色定妆照；成长图只属于明信片/手账/相册，不能替换主头像。
  const row = cat?.selected_birth_appearance_id
    ? await db.selectFrom('cat_appearances').select(['id', 'image_url', 'object_key'])
        .where('id', '=', cat.selected_birth_appearance_id).executeTakeFirst()
    : await db.selectFrom('cat_appearances').select(['id', 'image_url', 'object_key']).where('cat_id', '=', catId)
        .where('kind', '=', 'birth').orderBy('created_at', 'desc').limit(1).executeTakeFirst();
  if (!row) return null;
  return publicImageUrl(row) || null;
}

export async function listAppearanceHistory(catId: string): Promise<AppearanceRecord[]> {
  const rows = await db.selectFrom('cat_appearances').selectAll().where('cat_id', '=', catId)
    .where((eb) => eb.or([eb('kind', '=', 'growth'), eb('selection_status', '=', 'selected')]))
    .orderBy('created_at').execute();
  return Promise.all(rows.map(resolveAppearanceUrl)) as Promise<AppearanceRecord[]>;
}

export async function listBirthCandidates(catId: string): Promise<AppearanceRecord[]> {
  const rows = await db.selectFrom('cat_appearances').selectAll().where('cat_id', '=', catId)
    .where('kind', '=', 'birth').orderBy('created_at').execute();
  return Promise.all(rows.map(resolveAppearanceUrl)) as Promise<AppearanceRecord[]>;
}

async function resolveAppearanceUrl<T extends { id: string; image_url: string; object_key: string | null }>(row: T) {
  return { ...row, image_url: publicImageUrl(row) };
}

export type AppearanceImage = { body: Buffer; contentType: string };

/**
 * 优先返回 q90 WebP 衍生图，未命中回落 PNG 母版（ADR-0068 §决策 2）。
 * 衍生 key 不落库，由母版 key 换扩展名推导——回填完成前老图会多一次廉价 404。
 */
export async function getAppearanceImageForUser(userId: string, appearanceId: string): Promise<AppearanceImage | null> {
  const appearance = await db.selectFrom('cat_appearances as ca')
    .innerJoin('cats as c', 'c.id', 'ca.cat_id')
    .select('ca.object_key')
    .where('ca.id', '=', appearanceId)
    .where('c.user_id', '=', userId)
    .executeTakeFirst();
  if (!appearance?.object_key) return null;
  const webpKey = webpKeyFor(appearance.object_key);
  if (webpKey) {
    const webp = await imageStorage.tryGetBody(webpKey);
    if (webp) return { body: webp, contentType: 'image/webp' };
  }
  return { body: await imageStorage.getBody(appearance.object_key), contentType: 'image/png' };
}

async function saveAppearanceFromBuffer(params: {
  appearanceId?: string;
  catId: string;
  kind: 'birth' | 'growth';
  prompt: string;
  buffer: Buffer;
  travelId?: string;
}): Promise<AppearanceRecord> {
  const id = params.appearanceId || uuid();
  const objectKey = `cats/${params.catId}/${params.kind}/${id}.png`;
  const stored = await imageStorage.put(objectKey, params.buffer);
  await writeWebpDerivative(stored.objectKey, params.buffer);
  await db.transaction().execute(async (trx) => {
    await trx.insertInto('cat_appearances').values({
      id, cat_id: params.catId, kind: params.kind, image_url: stored.publicUrl,
      local_path: stored.objectKey, object_key: stored.objectKey,
      prompt: params.prompt, travel_id: params.travelId || null,
      selection_status: params.kind === 'birth' ? 'candidate' : 'history',
    }).execute();
    await trx.updateTable('cats').set({
      appearance_status: 'ready', updated_at: new Date().toISOString(),
    }).where('id', '=', params.catId).execute();
    if (params.kind === 'growth' && params.travelId) {
      await trx.updateTable('postcards').set({
        photo_object_key: stored.objectKey, photo_status: 'ready', photo_prompt: params.prompt,
      }).where('travel_id', '=', params.travelId).execute();
    }
  });
  return resolveAppearanceUrl(await db.selectFrom('cat_appearances').selectAll().where('id', '=', id).executeTakeFirstOrThrow()) as Promise<AppearanceRecord>;
}

async function generateViaQca(
  cat: CatRow,
  credential: QcaCredential,
  params: {
    kind: 'birth' | 'growth'; prompt: string; travelId?: string; appearanceId?: string;
    persistedPrompt?: string;
    onSessionCreated?: (sessionId: string) => Promise<void>;
    isCancelled?: () => Promise<boolean>;
  }
): Promise<AppearanceRecord> {
  const artist = await ensureImageArtist(cat, credential);
  const fileName = `meme_${params.kind}_${cat.name}_${Date.now()}`;
  const fileId = await runImageGenSession(credential, {
    envId: artist.envId,
    agentId: artist.agentId,
    prompt: params.prompt,
    fileName,
    catName: cat.name,
    kind: params.kind,
    onSessionCreated: params.onSessionCreated,
    isCancelled: params.isCancelled,
  });
  const buffer = await downloadQcaFile(credential, fileId);
  if (!buffer.length) throw new Error('QCA 下载的图片为空');
  return saveAppearanceFromBuffer({
    catId: cat.id,
    appearanceId: params.appearanceId,
    kind: params.kind,
    prompt: params.persistedPrompt ?? params.prompt,
    buffer,
    travelId: params.travelId,
  });
}

async function setPlaceholder(catId: string, appearanceId: string) {
  const placeholder = '/assets/cat-placeholder.png';
  await db.transaction().execute(async (trx) => {
    await trx.insertInto('cat_appearances').values({
      id: appearanceId, cat_id: catId, kind: 'birth', image_url: placeholder, local_path: placeholder,
      object_key: null, prompt: 'QCA_MOCK placeholder', travel_id: null, selection_status: 'candidate',
    }).execute();
    await trx.updateTable('cats').set({
      appearance_status: 'placeholder', updated_at: new Date().toISOString(),
    }).where('id', '=', catId).execute();
  });
}

/** 建猫：生成并存档原始形象 */
export async function generateBirthAppearance(
  catId: string,
  appearanceId = uuid(),
  control: {
    customDescription?: string | null;
    onSessionCreated?: (sessionId: string) => Promise<void>;
    isCancelled?: () => Promise<boolean>;
  } = {},
): Promise<AppearanceRecord | null> {
  const existing = await db.selectFrom('cat_appearances').selectAll().where('id', '=', appearanceId).executeTakeFirst();
  if (existing) return resolveAppearanceUrl(existing) as Promise<AppearanceRecord>;
  const cat = await db.selectFrom('cats').selectAll().where('id', '=', catId).executeTakeFirst() as CatRow | undefined;
  if (!cat) return null;

  await db.updateTable('cats').set({ appearance_status: 'generating' }).where('id', '=', catId).execute();

  const appearance = JSON.parse(cat.appearance) as Appearance;
  const identityAnchor = await resolveIdentityAnchor(cat);
  const { prompt: basePrompt } = buildBirthPrompt({
    name: cat.name,
    personality: cat.personality,
    appearance,
    attrs: {
      courage: cat.attr_courage,
      curiosity: cat.attr_curiosity,
      affinity: cat.attr_affinity,
      insight: cat.attr_insight,
    },
    identityAnchor,
  });
  const customPrompts = buildCustomAppearancePrompts(basePrompt, control.customDescription);

  const pat = await getPatForCat(cat.user_id);

  if (config.qcaMock) {
    await setPlaceholder(catId, appearanceId);
    return db.selectFrom('cat_appearances').selectAll().where('id', '=', appearanceId).executeTakeFirstOrThrow() as Promise<AppearanceRecord>;
  }

  if (!pat) {
    await db.updateTable('cats').set({ appearance_status: 'failed' }).where('id', '=', catId).execute();
    throw Object.assign(new Error('请先填入 PAT'), { code: 'NO_PAT' });
  }

  return generateViaQca(cat, pat, {
    kind: 'birth', prompt: customPrompts.imagePrompt, persistedPrompt: customPrompts.persistedPrompt, appearanceId,
    onSessionCreated: control.onSessionCreated,
    isCancelled: control.isCancelled,
  });
}

export async function cancelImageSessionForCat(catId: string, sessionId: string): Promise<void> {
  const cat = await db.selectFrom('cats').select('user_id').where('id', '=', catId).executeTakeFirst();
  if (!cat) return;
  const credential = await getPatForCat(cat.user_id);
  if (!credential) throw Object.assign(new Error('请先填入 PAT'), { code: 'NO_PAT' });
  await cancelImageGenSession(credential, sessionId);
}

/**
 * 旅行后：生成成长形象。
 * QCA ImageGen 暂不支持参考图，一致性靠 prompt 中的外貌文字约束。
 */
export async function generateGrowthAppearance(
  catId: string,
  travelId: string,
  options: { force?: boolean } = {},
): Promise<AppearanceRecord | null> {
  const encounterReceipt = await db.selectFrom('encounter_receipts').select('id')
    .where('travel_id', '=', travelId).executeTakeFirst();
  if (encounterReceipt) return generateEncounterPhotoForTravel(catId, travelId);

  const existing = await db.selectFrom('cat_appearances').selectAll().where('cat_id', '=', catId)
    .where('kind', '=', 'growth').where('travel_id', '=', travelId).executeTakeFirst();
  if (existing && !options.force) return existing as AppearanceRecord;
  const cat = await db.selectFrom('cats').selectAll().where('id', '=', catId).executeTakeFirst() as CatRow | undefined;
  const travel = await db.selectFrom('travels as t').leftJoin('world_locations as wl', 'wl.id', 't.location_id')
    .select(['t.narrative', 't.mood', 'wl.name as location_name']).where('t.id', '=', travelId).executeTakeFirst() as {
    narrative: string;
    mood: string | null;
    location_name: string;
  } | undefined;
  if (!cat || !travel) return null;

  const appearance = JSON.parse(cat.appearance) as Appearance;
  const identityAnchor = await resolveIdentityAnchor(cat);
  const prompt = buildGrowthPrompt({
    name: cat.name,
    personality: cat.personality,
    appearance,
    narrative: travel.narrative,
    mood: travel.mood || undefined,
    locationName: travel.location_name || '未知地点',
    attrs: {
      courage: cat.attr_courage,
      curiosity: cat.attr_curiosity,
      affinity: cat.attr_affinity,
      insight: cat.attr_insight,
    },
    identityAnchor,
    hasRef: false,
  });

  await db.updateTable('cats').set({ appearance_status: 'generating' }).where('id', '=', catId).execute();

  const pat = await getPatForCat(cat.user_id);

  if (config.qcaMock) {
    await db.updateTable('cats').set({ appearance_status: 'ready' }).where('id', '=', catId).execute();
    return null;
  }

  if (!pat) {
    await db.updateTable('cats').set({ appearance_status: 'ready' }).where('id', '=', catId).execute();
    throw Object.assign(new Error('请先填入 PAT'), { code: 'NO_PAT' });
  }

  return generateViaQca(cat, pat, { kind: 'growth', prompt, travelId });
}

type EncounterPhotoParticipant = {
  receipt_id: string;
  cat_id: string;
  travel_id: string;
  appearance: string;
};

async function getEncounterPhotoContext(travelId: string) {
  const encounter = await db.selectFrom('encounter_receipts as er')
    .innerJoin('encounters as e', 'e.id', 'er.encounter_id')
    .leftJoin('world_locations as wl', 'wl.id', 'e.location_id')
    .select(['e.id as encounter_id', 'wl.name as location_name', 'er.summary'])
    .where('er.travel_id', '=', travelId).executeTakeFirst();
  if (!encounter) return null;
  const participants = await db.selectFrom('encounter_receipts as er')
    .innerJoin('cats as c', 'c.id', 'er.cat_id')
    .select(['er.id as receipt_id', 'er.cat_id', 'er.travel_id', 'c.appearance'])
    .where('er.encounter_id', '=', encounter.encounter_id).orderBy('er.cat_id').execute() as EncounterPhotoParticipant[];
  if (participants.length !== 2) return null;
  return { ...encounter, participants };
}

function encounterAppearanceId(receiptId: string) {
  return `encounter-photo-${receiptId}`;
}

async function persistSharedEncounterPhoto(
  context: NonNullable<Awaited<ReturnType<typeof getEncounterPhotoContext>>>,
  prompt: string,
  source: { buffer?: Buffer; objectKey?: string; publicUrl?: string },
  requestedTravelId: string,
) {
  const stored = source.objectKey
    ? { objectKey: source.objectKey, publicUrl: source.publicUrl || '' }
    : await imageStorage.put(`encounters/${context.encounter_id}/photo.png`, source.buffer!);
  // 复用既有对象时衍生图已在首次写入时生成，不重复编码。
  if (!source.objectKey) await writeWebpDerivative(stored.objectKey, source.buffer!);
  const createdAt = new Date().toISOString();
  await db.transaction().execute(async (trx) => {
    for (const participant of context.participants) {
      const appearanceId = encounterAppearanceId(participant.receipt_id);
      await trx.insertInto('cat_appearances').values({
        id: appearanceId, cat_id: participant.cat_id, kind: 'growth',
        image_url: stored.publicUrl, local_path: stored.objectKey, object_key: stored.objectKey,
        prompt, travel_id: participant.travel_id, selection_status: 'history', created_at: createdAt,
      }).onConflict((conflict) => conflict.column('id').doUpdateSet({
        image_url: stored.publicUrl, local_path: stored.objectKey, object_key: stored.objectKey,
        prompt, travel_id: participant.travel_id, selection_status: 'history',
      })).execute();
      await trx.updateTable('encounter_receipts').set({ photo_appearance_id: appearanceId })
        .where('id', '=', participant.receipt_id).execute();
      await trx.updateTable('postcards').set({
        photo_object_key: stored.objectKey, photo_status: 'ready', photo_prompt: prompt,
      }).where('travel_id', '=', participant.travel_id).execute();
    }
    await trx.updateTable('encounters').set({ photo_status: 'succeeded' })
      .where('id', '=', context.encounter_id).execute();
  });
  const current = context.participants.find((participant) => participant.travel_id === requestedTravelId)!;
  return db.selectFrom('cat_appearances').selectAll()
    .where('id', '=', encounterAppearanceId(current.receipt_id)).executeTakeFirstOrThrow() as Promise<AppearanceRecord>;
}

/** 只生成一次猫遇合照，并用两条受各自主人才可读取的 appearance 记录共享同一私有对象。 */
export async function generateEncounterPhotoForTravel(catId: string, travelId: string): Promise<AppearanceRecord | null> {
  const context = await getEncounterPhotoContext(travelId);
  if (!context) return null;
  const payer = context.participants.find((participant) => participant.cat_id === catId);
  if (!payer) return null;
  const prompt = buildEncounterPhotoPrompt({
    leftAppearance: JSON.parse(context.participants[0].appearance) as Appearance,
    rightAppearance: JSON.parse(context.participants[1].appearance) as Appearance,
    locationName: context.location_name || '云世界路口',
    encounterSummary: context.summary,
  });

  const existing = await db.selectFrom('encounter_receipts as er')
    .innerJoin('cat_appearances as ca', 'ca.id', 'er.photo_appearance_id')
    .select(['ca.object_key', 'ca.image_url']).where('er.encounter_id', '=', context.encounter_id)
    .where('ca.object_key', 'is not', null).executeTakeFirst();
  if (existing?.object_key) {
    return persistSharedEncounterPhoto(context, prompt, { objectKey: existing.object_key, publicUrl: existing.image_url }, travelId);
  }

  const claim = await db.updateTable('encounters').set({ photo_status: 'generating' })
    .where('id', '=', context.encounter_id).where('photo_status', 'in', ['pending', 'failed']).executeTakeFirst();
  if (Number(claim.numUpdatedRows || 0) === 0) {
    throw Object.assign(new Error('猫遇合照正在生成'), { code: 'ENCOUNTER_PHOTO_BUSY' });
  }

  if (config.qcaMock) {
    const onePixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    return persistSharedEncounterPhoto(context, prompt, { buffer: onePixelPng }, travelId);
  }

  const cat = await db.selectFrom('cats').selectAll().where('id', '=', catId).executeTakeFirst() as CatRow | undefined;
  if (!cat) return null;
  const credential = await getPatForCat(cat.user_id);
  if (!credential) throw Object.assign(new Error('请先填入 PAT'), { code: 'NO_PAT' });
  const artist = await ensureImageArtist(cat, credential);
  const fileId = await runImageGenSession(credential, {
    envId: artist.envId, agentId: artist.agentId, prompt,
    fileName: `meme_encounter_${context.encounter_id}_${Date.now()}`,
    catName: '两只旅行猫', kind: 'encounter',
  });
  const buffer = await downloadQcaFile(credential, fileId);
  if (!buffer.length) throw new Error('QCA 下载的猫遇合照为空');
  return persistSharedEncounterPhoto(context, prompt, { buffer }, travelId);
}

export async function setEncounterPhotoStatusForTravel(travelId: string, status: 'generating' | 'failed') {
  const receipt = await db.selectFrom('encounter_receipts').select('encounter_id')
    .where('travel_id', '=', travelId).executeTakeFirst();
  if (!receipt) return false;
  const travels = await db.selectFrom('encounter_receipts').select('travel_id')
    .where('encounter_id', '=', receipt.encounter_id).execute();
  await db.transaction().execute(async (trx) => {
    await trx.updateTable('encounters').set({ photo_status: status === 'failed' ? 'failed' : 'pending' })
      .where('id', '=', receipt.encounter_id).execute();
    await trx.updateTable('postcards').set({ photo_status: status })
      .where('travel_id', 'in', travels.map((row) => row.travel_id)).execute();
  });
  return true;
}

/** #077 验收标准 1：个案形象审计（运营只读诊断）。
 *
 * 场景：用户反馈「猫有五只脚」（prop_b484a28c）时，需先判断异常图是**出生定妆照**还是**成长图**——
 * 前者要走 #077 新增的重画申诉出口，后者用既有 `regenerateLatestGrowthPhoto` 即可当场修复。
 * 此前没有任何只读入口能回答这个问题，个案排查只能读生产库连接串（凭据面过大）。
 *
 * 脱敏边界（硬约束）：只返回判定所需的结构性事实——猫 ID / 生命周期 / 主形象归属与 kind / 计数。
 * **不返回** image_url / local_path / object_key / prompt / PAT / QCA 资源 ID / 用户身份字段，
 * 调用方拿不到图片本体也拿不到凭据。仅 INTERNAL_API_KEY 可访问（与既有内部端点同一权限层）。
 * HEALTH.md 长期人工项「检查恰好两猫无额外肢体」亦可复用本接口定位样本。 */
export async function auditCatAppearanceForUser(userId: string) {
  const cat = await db.selectFrom('cats')
    .select(['id', 'name', 'lifecycle_stage', 'selected_birth_appearance_id', 'appearance_confirmed_at'])
    .where('user_id', '=', userId).executeTakeFirst();
  if (!cat) return { found: false as const };

  const appearances = await db.selectFrom('cat_appearances')
    .select(['id', 'kind', 'selection_status', 'travel_id', 'created_at'])
    .where('cat_id', '=', cat.id).orderBy('created_at', 'desc').execute();

  const main = appearances.find((row) => row.id === cat.selected_birth_appearance_id) ?? null;
  const latestGrowth = appearances.find((row) => row.kind === 'growth') ?? null;

  return {
    found: true as const,
    cat_id: cat.id,
    cat_name: cat.name,
    lifecycle_stage: cat.lifecycle_stage,
    appearance_confirmed: !!cat.appearance_confirmed_at,
    // 主形象归属判定——这是本接口的核心问题：异常图属出生定妆照还是成长图
    main_appearance: main
      ? {
        id: main.id, kind: main.kind, selection_status: main.selection_status,
        is_repaint: isRepaintAppearanceId(main.id), created_at: main.created_at,
      }
      : null,
    latest_growth_appearance: latestGrowth
      ? { id: latestGrowth.id, travel_id: latestGrowth.travel_id, created_at: latestGrowth.created_at }
      : null,
    counts: {
      total: appearances.length,
      by_kind: appearances.reduce<Record<string, number>>((acc, row) => {
        acc[row.kind] = (acc[row.kind] ?? 0) + 1; return acc;
      }, {}),
      repaint_candidates: appearances.filter((row) => isRepaintAppearanceId(row.id)).length,
    },
    // 修复路径建议（供运营判断，不自动执行任何写操作）
    suggested_repair_path: main?.kind === 'growth'
      ? 'regenerateLatestGrowthPhoto（成长图异常，既有路径即可修复）'
      : cat.appearance_confirmed_at
        ? '#077 形象重画申诉出口（出生定妆照异常且已确认形象）'
        : 'regenerateBirthAppearance（形象未确认，既有候选重画路径）',
  };
}
