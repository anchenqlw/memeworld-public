import { db } from '../db/index.js';
import { v4 as uuid } from 'uuid';
import { shanghaiDate } from '../lib/date.js';
import { getCatByUserId, getPatForUser } from './catService.js';
import { createChatSession, qcaFetch, sendChatMessage, resolveQcaAgentModel } from './qca.js';
import { catUsesForwardTravel } from './qcaForwardService.js';
import {
  createForwardChatSession,
  ensureForwardChatSetup,
  getForwardChatSessionStatus,
  listForwardChatEvents,
  sendForwardChatMessage,
  type ForwardChatEvent,
  type VerifiedTravelContext,
} from './qcaForwardChatService.js';
import type { CatRow } from '../db/index.js';
import {
  getVerifiedGrowthCardContext,
  hasActiveGrowthCards,
  isExplicitGrowthCardQuestion,
  syncGrowthCardIndexForIdentity,
} from './growthCardMemoryService.js';

export type ChatHistoryMessage = {
  id: string;
  role: 'user' | 'cat';
  text: string;
  created_at: string;
  turn_id?: string;
  turn_status?: ChatTurnStatus;
  queue_position?: number;
};

export type ChatTurnStatus = 'queued' | 'processing' | 'cancel_requested' | 'completed' | 'canceled' | 'failed';

function eventText(event: ForwardChatEvent) {
  return (event.content ?? [])
    .filter((part) => part.type === 'text' && part.text?.trim())
    .map((part) => part.text!.trim())
    .join('\n')
    .trim();
}

export function normalizeChatEvents(events: ForwardChatEvent[]) {
  return events
    .map((event, index) => ({
      event,
      index,
      role: event.type === 'user.message'
        ? 'user' as const
        : event.type === 'agent.message' || event.type === 'assistant.message'
          ? 'cat' as const
          : null,
      text: eventText(event),
    }))
    .filter((item): item is typeof item & { role: 'user' | 'cat' } => Boolean(item.role && item.text))
    .sort((left, right) => {
      if (!left.event.created_at || !right.event.created_at) return left.index - right.index;
      return left.event.created_at.localeCompare(right.event.created_at) || left.index - right.index;
    });
}

export async function persistChatMessage(params: {
  catId: string;
  sessionId: string | null;
  role: 'user' | 'cat';
  content: string;
  createdAt?: string;
  sourceEventId?: string | null;
}) {
  const id = uuid();
  await db.insertInto('chat_messages').values({
    id,
    cat_id: params.catId,
    qca_session_id: params.sessionId,
    source_event_id: params.sourceEventId ?? null,
    role: params.role,
    content: params.content,
    created_at: params.createdAt ?? new Date().toISOString(),
  }).onConflict((oc) => oc.column('source_event_id').doNothing()).execute();
  return id;
}

async function importCurrentQcaHistory(
  pat: NonNullable<Awaited<ReturnType<typeof getPatForUser>>>,
  cat: CatRow,
) {
  const sessionId = cat.qca_chat_session_id;
  if (!sessionId) return;
  const page = catUsesForwardTravel(cat)
    ? await listForwardChatEvents(pat, sessionId)
    : await qcaFetch(pat, 'GET', `/sessions/${sessionId}/events?limit=100`) as { data?: ForwardChatEvent[] };
  const normalized = normalizeChatEvents(Array.isArray(page) ? page : page.data ?? []);
  const importStartedAt = Date.now();
  for (const [position, item] of normalized.entries()) {
    const remoteKey = item.event.id
      || item.event.event_id
      || `${item.event.created_at ?? item.index}:${item.event.type}:${item.text}`;
    const remoteTimestamp = item.event.created_at ? Date.parse(item.event.created_at) : Number.NaN;
    await persistChatMessage({
      catId: cat.id,
      sessionId,
      role: item.role,
      content: item.text,
      createdAt: Number.isFinite(remoteTimestamp)
        ? new Date(remoteTimestamp + position).toISOString()
        : new Date(importStartedAt + position).toISOString(),
      sourceEventId: `${sessionId}:${remoteKey}`,
    });
  }
}

export async function listChatHistory(userId: string, requestedLimit = 100): Promise<ChatHistoryMessage[]> {
  const cat = await getCatByUserId(userId);
  if (!cat) throw Object.assign(new Error('没有猫'), { code: 'NO_CAT' });
  const limit = Math.max(1, Math.min(100, Math.trunc(requestedLimit) || 100));
  let existing = await db.selectFrom('chat_messages').select('id').where('cat_id', '=', cat.id).limit(1).execute();
  if (existing.length === 0 && cat.qca_chat_session_id) {
    const pat = await getPatForUser(userId);
    if (pat) {
      try {
        await importCurrentQcaHistory(pat, cat);
      } catch {
        // 历史恢复是尽力而为；QCA 不可用不能阻塞用户打开本地对话。
      }
    }
    existing = await db.selectFrom('chat_messages').select('id').where('cat_id', '=', cat.id).limit(1).execute();
  }
  if (existing.length === 0) return [];
  const rows = await db.selectFrom('chat_messages')
    .select(['id', 'role', 'content', 'created_at'])
    .where('cat_id', '=', cat.id)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(limit)
    .execute();
  const ordered = rows.reverse();
  const turns = await db.selectFrom('chat_turns')
    .select(['id', 'user_message_id', 'reply_message_id', 'status', 'priority', 'created_at'])
    .where('cat_id', '=', cat.id)
    .orderBy('priority', 'desc')
    .orderBy('created_at', 'asc')
    .execute();
  const turnByMessage = new Map<string, typeof turns[number]>();
  const queuedPositions = new Map<string, number>();
  let queuePosition = 0;
  for (const turn of turns) {
    turnByMessage.set(turn.user_message_id, turn);
    if (turn.reply_message_id) turnByMessage.set(turn.reply_message_id, turn);
    if (turn.status === 'queued') queuedPositions.set(turn.id, ++queuePosition);
  }
  return ordered.map((row) => {
    const turn = turnByMessage.get(row.id);
    return {
      id: row.id,
      role: row.role === 'user' ? 'user' : 'cat',
      text: row.content,
      created_at: row.created_at,
      ...(turn ? {
        turn_id: turn.id,
        turn_status: turn.status as ChatTurnStatus,
        ...(turn.status === 'queued' ? { queue_position: queuedPositions.get(turn.id) } : {}),
      } : {}),
    };
  });
}

async function resolveBuildChatSession(
  pat: Awaited<ReturnType<typeof getPatForUser>>,
  cat: CatRow,
) {
  if (!pat || !cat.qca_agent_id || !cat.qca_env_id || !cat.qca_memstore_id) return null;

  let sessionId = cat.qca_chat_session_id;
  if (!sessionId) {
    sessionId = await createChatSession(pat, {
      agentId: cat.qca_agent_id,
      envId: cat.qca_env_id,
      memstoreId: cat.qca_memstore_id,
    });
    await db.updateTable('cats').set({ qca_chat_session_id: sessionId }).where('id', '=', cat.id).execute();
  }
  return sessionId;
}

async function resolveForwardChatSession(
  pat: NonNullable<Awaited<ReturnType<typeof getPatForUser>>>,
  cat: CatRow,
  ownerNickname: string,
) {
  if (!cat.qca_forward_identity_id || !cat.qca_env_id) return null;

  const today = shanghaiDate();
  const travel = await db.selectFrom('travels as t')
    .leftJoin('world_locations as wl', 'wl.id', 't.location_id')
    .leftJoin('world_events as we', 'we.id', 't.event_id')
    .leftJoin('postcards as p', 'p.travel_id', 't.id')
    .select([
      't.travel_date',
      't.narrative',
      't.mood',
      'wl.name as location_name',
      'we.name as event_name',
      'p.title as postcard_title',
      'p.content as postcard_content',
    ])
    .where('t.cat_id', '=', cat.id)
    .where('t.travel_date', '=', today)
    .executeTakeFirst();
  const travelContext: VerifiedTravelContext = {
    date: today,
    hasTravelToday: Boolean(travel),
    // backlog #088：猫记录已在手，零新查询。不透传的话 prompt 里没有任何「我此刻在哪」的事实，
    // 猫只能从「今日旅行状态：尚未完成回报」推断出「在家」——用户流浪中问它，它就说在家。
    wanderingMode: Boolean(cat.wandering_mode),
    locationName: travel?.location_name,
    eventName: travel?.event_name,
    mood: travel?.mood,
    narrative: travel?.narrative,
    postcardTitle: travel?.postcard_title,
    postcardContent: travel?.postcard_content,
  };

  const model = cat.qca_model || await resolveQcaAgentModel(pat);
  const growthCardContext = await getVerifiedGrowthCardContext(cat.user_id);
  const chatTemplateId = await ensureForwardChatSetup(pat, {
    catName: cat.name,
    personality: cat.personality,
    attrs: {
      courage: cat.attr_courage,
      curiosity: cat.attr_curiosity,
      affinity: cat.attr_affinity,
      insight: cat.attr_insight,
    },
    ownerNickname,
    model,
    envId: cat.qca_env_id,
    identityId: cat.qca_forward_identity_id,
    existingChatTemplateId: cat.qca_forward_chat_template_id,
    travelContext,
    growthCardContext,
  });
  if (chatTemplateId !== cat.qca_forward_chat_template_id) {
    await db.updateTable('cats').set({
      qca_forward_chat_template_id: chatTemplateId,
      updated_at: new Date().toISOString(),
    }).where('id', '=', cat.id).execute();
  }

  let sessionId = cat.qca_chat_session_id;
  if (sessionId) {
    try {
      const status = await getForwardChatSessionStatus(pat, sessionId);
      if (status.archived_at || status.status === 'archived' || status.status === 'terminated') {
        sessionId = null;
      }
    } catch {
      sessionId = null;
    }
  }
  if (!sessionId) {
    sessionId = await createForwardChatSession(pat, {
      identityId: cat.qca_forward_identity_id,
      chatTemplateId,
      catName: cat.name,
    });
    await db.updateTable('cats').set({
      qca_chat_session_id: sessionId,
      updated_at: new Date().toISOString(),
    }).where('id', '=', cat.id).execute();
  }
  if (cat.qca_memstore_id) {
    // Session 创建后 Forward System Default Memory 才可能出现；此时同步 canonical + 实际挂载 Store。
    await syncGrowthCardIndexForIdentity(
      pat,
      cat.qca_memstore_id,
      cat.qca_forward_identity_id,
      cat.user_id,
    );
  }
  return sessionId;
}

export type ExecuteChatTurnOptions = {
  userMessageId?: string;
  turnId?: string;
  onSessionResolved?: (sessionId: string | null) => Promise<void>;
  onCursorReady?: (cursor: string | null) => Promise<void>;
  onDeliveryStarted?: () => Promise<void>;
  onEventCursor?: (cursor: string | null) => Promise<void>;
  shouldCancel?: () => Promise<boolean>;
};

export async function executeChatTurn(
  userId: string,
  message: string,
  options: ExecuteChatTurnOptions = {},
): Promise<{ text: string; replyMessageId: string; sessionId: string | null }> {
  const cat = await getCatByUserId(userId);
  if (!cat) throw Object.assign(new Error('没有猫'), { code: 'NO_CAT' });
  const pat = await getPatForUser(userId);
  if (!pat) throw Object.assign(new Error('请先填入 PAT'), { code: 'NO_PAT' });

  const today = shanghaiDate();
  let interaction = await db.selectFrom('interactions').selectAll().where('cat_id', '=', cat.id)
    .where('date', '=', today).where('channel', '=', 'web').executeTakeFirst();

  if (!interaction) {
    await db.insertInto('interactions').values({ id: uuid(), cat_id: cat.id, channel: 'web', turns: 0, date: today })
      .onConflict((oc) => oc.columns(['cat_id', 'date', 'channel']).doNothing()).execute();
    interaction = await db.selectFrom('interactions').selectAll().where('cat_id', '=', cat.id)
      .where('date', '=', today).where('channel', '=', 'web').executeTakeFirst();
  }

  if (isExplicitGrowthCardQuestion(message) && !await hasActiveGrowthCards(userId)) {
    const userMessageAt = Date.now();
    const reply = '目前没有有效的成长卡片，所以这件事我还不知道。';
    if (!options.userMessageId) {
      await persistChatMessage({
        catId: cat.id,
        sessionId: cat.qca_chat_session_id,
        role: 'user',
        content: message,
        createdAt: new Date(userMessageAt).toISOString(),
      });
    }
    const replyMessageId = await persistChatMessage({
      catId: cat.id,
      sessionId: cat.qca_chat_session_id,
      role: 'cat',
      content: reply,
      createdAt: new Date(userMessageAt + 1).toISOString(),
    });
    await db.updateTable('interactions').set(({ eb }) => ({
      turns: eb('turns', '+', 1), qca_session_id: cat.qca_chat_session_id,
    })).where('id', '=', interaction!.id).execute();
    await options.onSessionResolved?.(cat.qca_chat_session_id);
    return { text: reply, replyMessageId, sessionId: cat.qca_chat_session_id };
  }

  const owner = await db.selectFrom('users').select('display_name').where('id', '=', userId).executeTakeFirstOrThrow();
  const useForward = catUsesForwardTravel(cat);
  const sessionId = useForward
    ? await resolveForwardChatSession(pat, cat, owner.display_name)
    : await resolveBuildChatSession(pat, cat);
  await options.onSessionResolved?.(sessionId);

  const userMessageAt = Date.now();
  if (!options.userMessageId) {
    await persistChatMessage({
      catId: cat.id,
      sessionId,
      role: 'user',
      content: message,
      createdAt: new Date(userMessageAt).toISOString(),
    });
  }

  const reply = sessionId
    ? (useForward
        ? await sendForwardChatMessage(pat, sessionId, message, {
            idempotencyKey: options.turnId ? `meme-chat-turn-${options.turnId}` : undefined,
            onCursorReady: options.onCursorReady,
            onDeliveryStarted: options.onDeliveryStarted,
            onEventCursor: options.onEventCursor,
            shouldCancel: options.shouldCancel,
          })
        : await sendChatMessage(pat, sessionId, message))
    : `喵~ ${cat.name} 听到了：${message.slice(0, 80)}`;

  const replyMessageId = await persistChatMessage({
    catId: cat.id,
    sessionId,
    role: 'cat',
    content: reply,
    createdAt: new Date(Math.max(Date.now(), userMessageAt + 1)).toISOString(),
  });

  await db.updateTable('interactions').set(({ eb }) => ({
    turns: eb('turns', '+', 1), qca_session_id: sessionId,
  })).where('id', '=', interaction!.id).execute();

  return { text: reply, replyMessageId, sessionId };
}

export async function chatWithCat(userId: string, message: string): Promise<string> {
  return (await executeChatTurn(userId, message)).text;
}
