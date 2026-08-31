import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { getPatForUser } from './catService.js';
import {
  revokeGrowthCardMemoryForIdentity,
  syncGrowthCardMemoryForIdentity,
} from './growthCardMemoryService.js';
import { archiveChatSession, type QcaCredential } from './qca.js';
import { archiveForwardChatSession } from './qcaForwardChatService.js';

export const GROWTH_CARD_TYPES = ['book', 'skill', 'interest', 'life'] as const;
export const GROWTH_CARD_VISIBILITIES = ['private', 'encounter', 'public'] as const;

type GrowthCardType = typeof GROWTH_CARD_TYPES[number];
type GrowthCardVisibility = typeof GROWTH_CARD_VISIBILITIES[number];

export type GrowthCardInput = {
  type?: string;
  title?: string;
  summary?: string;
  source_url?: string | null;
  tags?: unknown;
  visibility?: string;
};

function inputError(message: string) {
  return Object.assign(new Error(message), { code: 'INVALID_GROWTH_CARD' });
}

function normalizeText(value: unknown, label: string, min: number, max: number) {
  if (typeof value !== 'string') throw inputError(`${label}格式不正确`);
  const text = value.trim();
  if (text.length < min || text.length > max) throw inputError(`${label}需为 ${min}~${max} 字`);
  return text;
}

function normalizeUrl(value: unknown) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > 500) throw inputError('来源链接最多 500 字');
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') throw new Error();
    return url.toString();
  } catch {
    throw inputError('来源链接必须是有效的 https 地址');
  }
}

function normalizeTags(value: unknown) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 5) throw inputError('标签最多 5 个');
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') throw inputError('标签格式不正确');
    const tag = item.trim();
    if (tag.length < 1 || tag.length > 20) throw inputError('每个标签需为 1~20 字');
    if (!result.includes(tag)) result.push(tag);
  }
  return result;
}

function normalizeType(value: unknown): GrowthCardType {
  if (!GROWTH_CARD_TYPES.includes(value as GrowthCardType)) throw inputError('成长类型不正确');
  return value as GrowthCardType;
}

function normalizeVisibility(value: unknown): GrowthCardVisibility {
  if (!GROWTH_CARD_VISIBILITIES.includes(value as GrowthCardVisibility)) throw inputError('可见范围不正确');
  return value as GrowthCardVisibility;
}

function serializeCard<T extends { tags: string }>(card: T) {
  let tags: string[] = [];
  try { tags = JSON.parse(card.tags) as string[]; } catch { tags = []; }
  return { ...card, tags };
}

async function catForUser(userId: string) {
  const cat = await db.selectFrom('cats').select([
    'id',
    'name',
    'qca_memstore_id',
    'qca_forward_identity_id',
    'qca_chat_session_id',
  ])
    .where('user_id', '=', userId).where('status', '=', 'active').executeTakeFirst();
  if (!cat) throw Object.assign(new Error('还没有可以成长的小猫'), { code: 'NO_CAT' });
  return cat;
}

async function cardForUser(userId: string, cardId: string, includeDeleted = false) {
  let query = db.selectFrom('growth_cards').selectAll().where('id', '=', cardId).where('user_id', '=', userId);
  if (!includeDeleted) query = query.where('deleted_at', 'is', null);
  const card = await query.executeTakeFirst();
  if (!card) throw Object.assign(new Error('成长卡片不存在'), { code: 'GROWTH_CARD_NOT_FOUND' });
  return card;
}

async function syncCard(userId: string, cardId: string) {
  const card = await cardForUser(userId, cardId);
  const cat = await catForUser(userId);
  try {
    if (config.qcaMock) {
      await db.updateTable('growth_cards').set({ sync_status: 'synced', sync_error: null, updated_at: new Date().toISOString() })
        .where('id', '=', cardId).execute();
      return;
    }
    if (!cat.qca_memstore_id) throw new Error('请先开启小猫的第一次探险，再重试同步长期记忆');
    const credential = await getPatForUser(userId);
    if (!credential) throw new Error('Qoder 契约不可用，请先检查 PAT');
    await syncGrowthCardMemoryForIdentity(
      credential,
      cat.qca_memstore_id,
      cat.qca_forward_identity_id,
      userId,
      card,
    );
    await db.updateTable('growth_cards').set({ sync_status: 'synced', sync_error: null, updated_at: new Date().toISOString() })
      .where('id', '=', cardId).execute();
  } catch (error) {
    const message = error instanceof Error ? error.message : '长期记忆同步失败';
    await db.updateTable('growth_cards').set({ sync_status: 'failed', sync_error: message.slice(0, 300), updated_at: new Date().toISOString() })
      .where('id', '=', cardId).execute();
  }
}

async function rotateChatSessionAfterRevocation(
  cat: Awaited<ReturnType<typeof catForUser>>,
  credential?: QcaCredential,
) {
  if (!cat.qca_chat_session_id) return;
  try {
    if (!config.qcaMock && credential) {
      if (cat.qca_forward_identity_id) {
        await archiveForwardChatSession(credential, cat.qca_chat_session_id);
      } else {
        await archiveChatSession(credential, cat.qca_chat_session_id);
      }
    }
  } finally {
    // 即使云端归档失败，也不能让应用继续复用可能记住已撤回正文的旧 Session。
    await db.updateTable('cats').set({
      qca_chat_session_id: null,
      updated_at: new Date().toISOString(),
    }).where('id', '=', cat.id).execute();
  }
}

export async function listGrowthCards(userId: string) {
  const cards = await db.selectFrom('growth_cards').selectAll().where('user_id', '=', userId)
    .where('deleted_at', 'is', null).orderBy('updated_at', 'desc').execute();
  return cards.map(serializeCard);
}

export async function createGrowthCard(userId: string, input: GrowthCardInput) {
  const cat = await catForUser(userId);
  const now = new Date().toISOString();
  const id = randomUUID();
  await db.insertInto('growth_cards').values({
    id, user_id: userId, cat_id: cat.id,
    type: normalizeType(input.type), title: normalizeText(input.title, '标题', 1, 80),
    summary: normalizeText(input.summary, '摘要', 1, 3000), source_url: normalizeUrl(input.source_url),
    tags: JSON.stringify(normalizeTags(input.tags)), visibility: normalizeVisibility(input.visibility ?? 'private'),
    sync_status: 'pending', sync_error: null, deleted_at: null, created_at: now, updated_at: now,
  }).execute();
  await syncCard(userId, id);
  return serializeCard(await cardForUser(userId, id));
}

export async function updateGrowthCard(userId: string, cardId: string, input: GrowthCardInput) {
  const current = await cardForUser(userId, cardId);
  const values = {
    type: input.type === undefined ? current.type : normalizeType(input.type),
    title: input.title === undefined ? current.title : normalizeText(input.title, '标题', 1, 80),
    summary: input.summary === undefined ? current.summary : normalizeText(input.summary, '摘要', 1, 3000),
    source_url: input.source_url === undefined ? current.source_url : normalizeUrl(input.source_url),
    tags: input.tags === undefined ? current.tags : JSON.stringify(normalizeTags(input.tags)),
    visibility: input.visibility === undefined ? current.visibility : normalizeVisibility(input.visibility),
    sync_status: 'pending', sync_error: null, updated_at: new Date().toISOString(),
  };
  await db.updateTable('growth_cards').set(values).where('id', '=', cardId).where('user_id', '=', userId).execute();
  await syncCard(userId, cardId);
  return serializeCard(await cardForUser(userId, cardId));
}

export async function retryGrowthCardSync(userId: string, cardId: string) {
  await cardForUser(userId, cardId);
  await db.updateTable('growth_cards').set({ sync_status: 'pending', sync_error: null, updated_at: new Date().toISOString() })
    .where('id', '=', cardId).execute();
  await syncCard(userId, cardId);
  return serializeCard(await cardForUser(userId, cardId));
}

export async function deleteGrowthCard(userId: string, cardId: string) {
  await cardForUser(userId, cardId);
  const now = new Date().toISOString();
  await db.updateTable('growth_cards').set({ deleted_at: now, updated_at: now }).where('id', '=', cardId).where('user_id', '=', userId).execute();
  let memoryRevoked = false;
  const cat = await catForUser(userId);
  if (config.qcaMock) {
    await rotateChatSessionAfterRevocation(cat);
    memoryRevoked = true;
  } else {
    try {
      const credential = await getPatForUser(userId);
      let revokeFailure: unknown;
      if (!cat.qca_memstore_id) {
        revokeFailure = new Error('小猫长期记忆库不可用');
      } else if (!credential) {
        revokeFailure = new Error('Qoder 契约不可用，请先检查 PAT');
      } else {
        try {
          await revokeGrowthCardMemoryForIdentity(
            credential,
            cat.qca_memstore_id,
            cat.qca_forward_identity_id,
            userId,
            cardId,
            now,
          );
        } catch (error) {
          revokeFailure = error;
        }
      }
      // Store 撤回即使部分失败，也必须切断应用对旧聊天上下文的复用。
      await rotateChatSessionAfterRevocation(cat, credential ?? undefined);
      if (revokeFailure) throw revokeFailure;
      memoryRevoked = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : '长期记忆撤回失败';
      await db.updateTable('growth_cards').set({ sync_status: 'failed', sync_error: message.slice(0, 300) })
        .where('id', '=', cardId).execute();
    }
  }
  return { ok: true, memory_revoked: memoryRevoked };
}

export async function getGrowthTags(userId: string) {
  const cards = await db.selectFrom('growth_cards').select(['type', 'tags']).where('user_id', '=', userId)
    .where('deleted_at', 'is', null).execute();
  const counts = new Map<string, { source_count: number; types: Set<string> }>();
  for (const card of cards) {
    for (const tag of normalizeTags(JSON.parse(card.tags))) {
      const current = counts.get(tag) ?? { source_count: 0, types: new Set<string>() };
      current.source_count += 1;
      current.types.add(card.type);
      counts.set(tag, current);
    }
  }
  return {
    source_count: cards.length,
    tags: [...counts.entries()].map(([name, value]) => ({ name, source_count: value.source_count, types: [...value.types] }))
      .sort((a, b) => b.source_count - a.source_count || a.name.localeCompare(b.name, 'zh-CN')),
  };
}
