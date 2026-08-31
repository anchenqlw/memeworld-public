import type { FastifyBaseLogger } from 'fastify';
import { v4 as uuid, v7 as uuidv7 } from 'uuid';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { executeChatTurn, persistChatMessage, type ChatTurnStatus } from './chatService.js';
import { getCatByUserId, getPatForUser } from './catService.js';
import { catUsesForwardTravel } from './qcaForwardService.js';
import {
  cancelForwardChatTurn,
  getForwardChatSessionStatus,
  readForwardChatEventsAfter,
  selectNewAssistantReply,
  type ForwardChatEvent,
} from './qcaForwardChatService.js';
import { qcaFetch } from './qca.js';

const CHAT_WORKER_POLL_MS = 250;
const CHAT_WORKER_MAX_CATS = 4;
const CHAT_TURN_LEASE_MS = 120_000;
const CHAT_INTERRUPT_PRIORITY = 100;
const TERMINAL_STATUSES = ['completed', 'canceled', 'failed'] as const;
const ACTIVE_STATUSES = ['processing', 'cancel_requested'] as const;
const workerId = `chat-worker-${process.pid}-${uuid().slice(0, 8)}`;

export type ChatTurnView = {
  id: string;
  status: ChatTurnStatus;
  queue_position?: number;
  reply?: string;
  error?: { code: string; message: string };
};

let timer: ReturnType<typeof setTimeout> | null = null;
let stopping = false;
const activeCatRuns = new Map<string, Promise<void>>();
let workerLog: FastifyBaseLogger | null = null;

function isoAfter(ms: number) {
  return new Date(Date.now() + ms).toISOString();
}

function terminal(status: string): status is typeof TERMINAL_STATUSES[number] {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

function safeTurnError(error: unknown) {
  const typed = error as { code?: string; message?: string };
  if (typed.code === 'QCA_CREDITS_UNAVAILABLE') {
    return { code: typed.code, message: '云端能量暂时不够，这条消息没有执行。' };
  }
  if (typed.code === 'QCA_CHAT_TIMEOUT') {
    return { code: typed.code, message: '小猫这次想得有点久，请稍后再试。' };
  }
  if (typed.code === 'CHAT_TURN_CANCELED') {
    return { code: typed.code, message: '这轮思考已被你打断。' };
  }
  return { code: typed.code || 'CHAT_TURN_FAILED', message: '云上暂时没有回音，这条消息没有执行。' };
}

function isRemoteTurnBusy(error: unknown) {
  const typed = error as { code?: string; message?: string };
  return typed.code === 'QCA_API_ERROR' && /processing a turn|current turn/i.test(typed.message || '');
}

async function queuePosition(catId: string, turnId: string) {
  const queued = await db.selectFrom('chat_turns').select('id')
    .where('cat_id', '=', catId).where('status', '=', 'queued')
    .orderBy('priority', 'desc').orderBy('created_at', 'asc').execute();
  const index = queued.findIndex((turn) => turn.id === turnId);
  return index >= 0 ? index + 1 : undefined;
}

export async function getChatTurn(userId: string, turnId: string): Promise<ChatTurnView> {
  const row = await db.selectFrom('chat_turns as ct')
    .innerJoin('cats as c', 'c.id', 'ct.cat_id')
    .leftJoin('chat_messages as reply', 'reply.id', 'ct.reply_message_id')
    .select(['ct.id', 'ct.cat_id', 'ct.status', 'ct.error_code', 'reply.content as reply'])
    .where('ct.id', '=', turnId).where('c.user_id', '=', userId).executeTakeFirst();
  if (!row) throw Object.assign(new Error('聊天轮次不存在'), { code: 'CHAT_TURN_NOT_FOUND' });
  const status = row.status as ChatTurnStatus;
  return {
    id: row.id,
    status,
    ...(status === 'queued' ? { queue_position: await queuePosition(row.cat_id, row.id) } : {}),
    ...(row.reply ? { reply: row.reply } : {}),
    ...(status === 'failed' ? { error: safeTurnError({ code: row.error_code }) } : {}),
  };
}

export async function enqueueChatTurn(
  userId: string,
  message: string,
  mode: 'queue' | 'interrupt' = 'queue',
): Promise<ChatTurnView> {
  const cat = await getCatByUserId(userId);
  if (!cat) throw Object.assign(new Error('没有猫'), { code: 'NO_CAT' });
  if (!await getPatForUser(userId)) throw Object.assign(new Error('请先填入 PAT'), { code: 'NO_PAT' });

  const now = new Date().toISOString();
  // v7 保证同毫秒连续入队时仍可按 id 稳定恢复主人实际发送顺序。
  const userMessageId = uuidv7();
  const turnId = uuidv7();
  await db.transaction().execute(async (trx) => {
    await trx.insertInto('chat_messages').values({
      id: userMessageId,
      cat_id: cat.id,
      qca_session_id: cat.qca_chat_session_id,
      source_event_id: null,
      role: 'user',
      content: message,
      created_at: now,
    }).execute();
    await trx.insertInto('chat_turns').values({
      id: turnId,
      cat_id: cat.id,
      user_message_id: userMessageId,
      reply_message_id: null,
      qca_session_id: cat.qca_chat_session_id,
      status: 'queued',
      priority: mode === 'interrupt' ? CHAT_INTERRUPT_PRIORITY : 0,
      active_key: null,
      last_event_id: null,
      delivery_started_at: null,
      cancel_requested_at: null,
      lease_owner: null,
      lease_expires_at: null,
      error_code: null,
      started_at: null,
      completed_at: null,
      created_at: now,
      updated_at: now,
    }).execute();
    if (mode === 'interrupt') {
      await trx.updateTable('chat_turns').set({
        status: 'cancel_requested',
        cancel_requested_at: now,
        updated_at: now,
      }).where('cat_id', '=', cat.id).where('status', '=', 'processing').execute();
    }
  });
  kickChatWorker();
  return {
    id: turnId,
    status: 'queued',
    queue_position: await queuePosition(cat.id, turnId),
  };
}

async function claimNextTurn(catId: string) {
  const now = new Date().toISOString();
  const active = await db.selectFrom('chat_turns').selectAll()
    .where('cat_id', '=', catId).where('status', 'in', [...ACTIVE_STATUSES]).executeTakeFirst();
  if (active) {
    if (active.lease_owner === workerId) return active;
    if (active.lease_expires_at && active.lease_expires_at > now) return null;
    const reclaimed = await db.updateTable('chat_turns').set({
      lease_owner: workerId,
      lease_expires_at: isoAfter(CHAT_TURN_LEASE_MS),
      updated_at: now,
    }).where('id', '=', active.id).where('status', 'in', [...ACTIVE_STATUSES])
      .where((eb) => eb.or([
        eb('lease_expires_at', 'is', null),
        eb('lease_expires_at', '<=', now),
      ])).returningAll().executeTakeFirst();
    return reclaimed || null;
  }
  const next = await db.selectFrom('chat_turns').selectAll()
    .where('cat_id', '=', catId).where('status', '=', 'queued')
    .orderBy('priority', 'desc').orderBy('created_at', 'asc').executeTakeFirst();
  if (!next) return null;
  try {
    const claimed = await db.updateTable('chat_turns').set({
      status: 'processing',
      active_key: catId,
      lease_owner: workerId,
      lease_expires_at: isoAfter(CHAT_TURN_LEASE_MS),
      started_at: next.started_at || now,
      updated_at: now,
    }).where('id', '=', next.id).where('status', '=', 'queued').returningAll().executeTakeFirst();
    return claimed || null;
  } catch {
    // active_key 唯一约束是跨进程 single-flight；另一 worker 抢到时安全放弃。
    return null;
  }
}

async function markTerminal(
  turnId: string,
  status: 'completed' | 'canceled' | 'failed',
  values: { replyMessageId?: string; errorCode?: string } = {},
) {
  const now = new Date().toISOString();
  await db.updateTable('chat_turns').set({
    status,
    active_key: null,
    lease_owner: null,
    lease_expires_at: null,
    reply_message_id: values.replyMessageId ?? null,
    error_code: values.errorCode ?? null,
    completed_at: now,
    updated_at: now,
  }).where('id', '=', turnId).where('status', 'in', [...ACTIVE_STATUSES]).execute();
}

async function waitForSessionIdle(userId: string, sessionId: string, timeoutMs = 15_000) {
  const cat = await getCatByUserId(userId);
  const pat = await getPatForUser(userId);
  if (!cat || !pat) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = catUsesForwardTravel(cat)
      ? await getForwardChatSessionStatus(pat, sessionId)
      : await qcaFetch(pat, 'GET', `/sessions/${sessionId}`) as { status?: string; archived_at?: string | null };
    if (status.archived_at || ['idle', 'completed', 'canceled', 'cancelled', 'archived', 'terminated'].includes(status.status || '')) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function cancelActiveTurn(turn: Awaited<ReturnType<typeof claimNextTurn>>, userId: string) {
  if (!turn) return;
  const pat = await getPatForUser(userId);
  const cat = await getCatByUserId(userId);
  if (!pat || !cat || !turn.qca_session_id) {
    await markTerminal(turn.id, 'canceled', { errorCode: 'CHAT_TURN_CANCELED' });
    return;
  }
  try {
    if (catUsesForwardTravel(cat)) await cancelForwardChatTurn(pat, turn.qca_session_id);
    else await qcaFetch(pat, 'POST', `/sessions/${turn.qca_session_id}/cancel`, {});
    if (await waitForSessionIdle(userId, turn.qca_session_id)) {
      await markTerminal(turn.id, 'canceled', { errorCode: 'CHAT_TURN_CANCELED' });
      return;
    }
  } catch {
    // cancel 是 best effort；保持 cancel_requested 和 active_key，禁止后续消息并发投递。
  }
  await db.updateTable('chat_turns').set({
    lease_owner: null,
    lease_expires_at: isoAfter(2_000),
    updated_at: new Date().toISOString(),
  }).where('id', '=', turn.id).where('status', '=', 'cancel_requested').execute();
}

function latestAssistantReply(events: ForwardChatEvent[]) {
  return selectNewAssistantReply(events, new Set());
}

async function recoverDeliveredTurn(turn: NonNullable<Awaited<ReturnType<typeof claimNextTurn>>>, userId: string) {
  const cat = await getCatByUserId(userId);
  const pat = await getPatForUser(userId);
  if (!cat || !pat || !turn.qca_session_id) {
    await markTerminal(turn.id, 'failed', { errorCode: 'CHAT_TURN_RECOVERY_FAILED' });
    return;
  }
  if (turn.status === 'cancel_requested') {
    await cancelActiveTurn(turn, userId);
    return;
  }
  if (!catUsesForwardTravel(cat)) {
    await markTerminal(turn.id, 'failed', { errorCode: 'CHAT_TURN_RECOVERY_REQUIRED' });
    return;
  }
  try {
    // last_event_id 是投递前的稳定基线。必须翻完基线后的全部分页，不能只看最近 100 条，
    // 否则长会话或服务在收到回复后重启时会把已经存在云上的回复判成丢失。
    const page = await readForwardChatEventsAfter(pat, turn.qca_session_id, turn.last_event_id);
    const reply = latestAssistantReply(page.events);
    if (reply) {
      const replyMessageId = await persistChatMessage({
        catId: cat.id,
        sessionId: turn.qca_session_id,
        role: 'cat',
        content: reply,
      });
      await markTerminal(turn.id, 'completed', { replyMessageId });
      return;
    }
    const status = await getForwardChatSessionStatus(pat, turn.qca_session_id);
    if (status.status === 'idle' || status.archived_at) {
      await markTerminal(turn.id, 'failed', { errorCode: 'CHAT_TURN_REPLY_MISSING' });
    }
  } catch {
    // 下一次 lease 到期后继续安全对账；不重发未知结果的用户 event。
  }
}

async function processTurn(turn: NonNullable<Awaited<ReturnType<typeof claimNextTurn>>>, userId: string) {
  if (turn.status === 'cancel_requested') {
    await cancelActiveTurn(turn, userId);
    return;
  }
  if (turn.delivery_started_at) {
    await recoverDeliveredTurn(turn, userId);
    return;
  }
  const message = await db.selectFrom('chat_messages').select('content')
    .where('id', '=', turn.user_message_id).executeTakeFirstOrThrow();
  try {
    const result = await executeChatTurn(userId, message.content, {
      userMessageId: turn.user_message_id,
      turnId: turn.id,
      onSessionResolved: async (sessionId) => {
        await db.updateTable('chat_turns').set({ qca_session_id: sessionId, updated_at: new Date().toISOString() })
          .where('id', '=', turn.id).execute();
      },
      onCursorReady: async (cursor) => {
        await db.updateTable('chat_turns').set({ last_event_id: cursor, updated_at: new Date().toISOString() })
          .where('id', '=', turn.id).execute();
      },
      onDeliveryStarted: async () => {
        await db.updateTable('chat_turns').set({
          delivery_started_at: new Date().toISOString(),
          lease_expires_at: isoAfter(CHAT_TURN_LEASE_MS),
          updated_at: new Date().toISOString(),
        }).where('id', '=', turn.id).execute();
      },
      onEventCursor: async (cursor) => {
        await db.updateTable('chat_turns').set({
          lease_expires_at: isoAfter(CHAT_TURN_LEASE_MS),
          updated_at: new Date().toISOString(),
        }).where('id', '=', turn.id).execute();
      },
      shouldCancel: async () => {
        const current = await db.selectFrom('chat_turns').select('status').where('id', '=', turn.id).executeTakeFirst();
        return current?.status === 'cancel_requested';
      },
    });
    const current = await db.selectFrom('chat_turns').select('status').where('id', '=', turn.id).executeTakeFirst();
    if (current?.status === 'cancel_requested') {
      await markTerminal(turn.id, 'canceled', { errorCode: 'CHAT_TURN_CANCELED' });
    } else {
      await markTerminal(turn.id, 'completed', { replyMessageId: result.replyMessageId });
    }
  } catch (error) {
    if (isRemoteTurnBusy(error)) {
      await db.updateTable('chat_turns').set({
        status: 'queued', active_key: null, lease_owner: null, lease_expires_at: null,
        delivery_started_at: null, last_event_id: null, error_code: null, updated_at: new Date().toISOString(),
      }).where('id', '=', turn.id).where('status', '=', 'processing').execute();
      return;
    }
    const safe = safeTurnError(error);
    await markTerminal(turn.id, safe.code === 'CHAT_TURN_CANCELED' ? 'canceled' : 'failed', { errorCode: safe.code });
  }
}

async function processCat(catId: string) {
  const cat = await db.selectFrom('cats').select(['id', 'user_id']).where('id', '=', catId).executeTakeFirst();
  if (!cat) return;
  const turn = await claimNextTurn(catId);
  if (!turn) return;
  await processTurn(turn, cat.user_id);
}

async function scanChatQueue() {
  const now = new Date().toISOString();
  const candidates = await db.selectFrom('chat_turns').select('cat_id')
    .where((eb) => eb.or([
      eb('status', '=', 'queued'),
      eb.and([eb('status', 'in', [...ACTIVE_STATUSES]), eb('lease_expires_at', '<=', now)]),
    ]))
    .orderBy('priority', 'desc').orderBy('created_at', 'asc').limit(32).execute();
  for (const { cat_id: catId } of candidates) {
    if (stopping || activeCatRuns.size >= CHAT_WORKER_MAX_CATS) break;
    if (activeCatRuns.has(catId)) continue;
    const run = processCat(catId)
      .catch((error) => workerLog?.error({ err: error, catId }, 'chat worker iteration failed'))
      .finally(() => activeCatRuns.delete(catId));
    activeCatRuns.set(catId, run);
  }
}

function schedule(delay = CHAT_WORKER_POLL_MS) {
  if (stopping || timer) return;
  timer = setTimeout(() => {
    timer = null;
    void scanChatQueue().finally(() => schedule());
  }, delay);
  timer.unref();
}

export function kickChatWorker() {
  if (!workerLog || stopping) return;
  if (timer) clearTimeout(timer);
  timer = null;
  schedule(0);
}

export async function recoverStaleChatTurns() {
  const now = new Date().toISOString();
  await db.updateTable('chat_turns').set({
    status: 'queued', active_key: null, lease_owner: null, lease_expires_at: null, updated_at: now,
  }).where('status', '=', 'processing').where('delivery_started_at', 'is', null)
    .where((eb) => eb.or([eb('lease_expires_at', 'is', null), eb('lease_expires_at', '<=', now)])).execute();
}

export async function startChatWorker(log: FastifyBaseLogger) {
  if (workerLog) return;
  workerLog = log;
  stopping = false;
  await recoverStaleChatTurns();
  schedule(0);
}

export async function stopChatWorker() {
  stopping = true;
  if (timer) clearTimeout(timer);
  timer = null;
  await Promise.allSettled(activeCatRuns.values());
  activeCatRuns.clear();
  workerLog = null;
}

export async function waitForChatTurn(userId: string, turnId: string, timeoutMs = config.qcaChatTimeoutMs + 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const turn = await getChatTurn(userId, turnId);
    if (terminal(turn.status)) return turn;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Object.assign(new Error('小猫暂时没有回应，请稍后在历史消息里查看'), { code: 'QCA_CHAT_TIMEOUT' });
}
