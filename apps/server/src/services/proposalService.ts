import { db } from '../db/index.js';
import { config } from '../config.js';
import { v4 as uuid } from 'uuid';
import { compareDbTimestamps, dbTimestampMs, shanghaiDate, shanghaiDateFromDbText } from '../lib/date.js';
import { sql, type Transaction } from 'kysely';
import type { DatabaseSchema } from '../db/schema.js';
import { PRODUCTION_VERIFIED_PUBLIC_NOTE, proposalPublicNote } from './proposalPublicNote.js';

type ProposalContext = {
  occurred_at?: unknown; user_agent?: unknown; pathname?: unknown; scene?: unknown; panel?: unknown;
  app_build?: unknown; viewport?: unknown; last_ui_error?: unknown; cat_snapshot?: unknown; alerts?: unknown;
};

export type ProposalStatus = 'new' | 'exported' | 'triaged' | 'accepted' | 'partially-accepted' | 'rejected' | 'in-progress' | 'shipped';
export type ProposalPublicStatus = 'received' | 'under-review' | 'accepted' | 'partially-accepted' | 'in-progress' | 'validating' | 'verified' | 'not-planned';

export const PROPOSAL_STATUSES: readonly ProposalStatus[] = [
  'new', 'exported', 'triaged', 'accepted', 'partially-accepted', 'rejected', 'in-progress', 'shipped',
] as const;

type AckOptions = {
  ids: string[];
  status: ProposalStatus;
  backlogRef?: string;
  decisionNote?: string;
};

type AckTestHooks = {
  /** Test-only barrier used to prove the PostgreSQL row lock mutation; production callers omit it. */
  afterProposalRead?: (id: string) => Promise<void>;
};

type ProductionVerificationOptions = {
  ids: string[];
  releaseSha: string;
  observedAt: string;
  evidenceRef: string;
};

type VerificationRuntime = { nodeEnv: string; releaseSha: string };

const allowedTransitions: Record<ProposalStatus, ProposalStatus[]> = {
  new: ['exported', 'triaged', 'accepted', 'partially-accepted', 'rejected'],
  exported: ['triaged', 'accepted', 'partially-accepted', 'rejected'],
  triaged: ['accepted', 'partially-accepted', 'rejected'],
  accepted: ['in-progress', 'shipped'],
  'partially-accepted': ['in-progress', 'shipped'],
  rejected: [],
  'in-progress': ['shipped'],
  shipped: [],
};

const ACCEPTED_STATUSES = new Set<ProposalStatus>(['accepted', 'partially-accepted', 'in-progress', 'shipped']);

export function projectProposalPublicStatus(status: string, productionVerified: boolean): ProposalPublicStatus {
  if (status === 'new') return 'received';
  if (status === 'exported' || status === 'triaged') return 'under-review';
  if (status === 'accepted') return 'accepted';
  if (status === 'partially-accepted') return 'partially-accepted';
  if (status === 'in-progress') return 'in-progress';
  if (status === 'shipped') return productionVerified ? 'verified' : 'validating';
  if (status === 'rejected') return 'not-planned';
  return 'under-review';
}

function safeContext(input: ProposalContext | undefined) {
  if (!input || typeof input !== 'object') return null;
  const short = (value: unknown, max: number) => typeof value === 'string' ? value.slice(0, max) : undefined;
  const result = {
    occurred_at: short(input.occurred_at, 40), user_agent: short(input.user_agent, 300), pathname: short(input.pathname, 200),
    scene: short(input.scene, 40), panel: short(input.panel, 40), app_build: short(input.app_build, 120),
    viewport: short(input.viewport, 30), last_ui_error: short(input.last_ui_error, 300),
    cat_snapshot: input.cat_snapshot && typeof input.cat_snapshot === 'object' ? input.cat_snapshot : undefined,
    alerts: input.alerts && typeof input.alerts === 'object' ? input.alerts : undefined,
  };
  return JSON.stringify(result).slice(0, 2000);
}

async function ensureContributionEvent(
  trx: Transaction<DatabaseSchema>, userId: string, proposalId: string, eventType: 'accepted' | 'shipped', points: number,
) {
  await trx.insertInto('contribution_events').values({
    id: `contrib_${uuid().slice(0, 12)}`, user_id: userId, proposal_id: proposalId, event_type: eventType, points,
    reason: eventType === 'accepted' ? '提案被采纳' : '提案已上线',
  }).onConflict((oc) => oc.columns(['proposal_id', 'event_type']).doNothing()).execute();
}

async function awardShippedReward(trx: Transaction<DatabaseSchema>, proposalId: string, userId: string) {
  const cat = await trx.selectFrom('cats').select('id').where('user_id', '=', userId)
    .where('status', '=', 'active').orderBy('created_at', 'desc').executeTakeFirst();
  if (!cat) return 'pending' as const;
  await trx.insertInto('cat_badges').values({
    id: `cb_${uuid().slice(0, 12)}`, cat_id: cat.id, badge_id: 'badge-proposal-shipped', reason: `提案 ${proposalId} 已上线`,
  }).onConflict((oc) => oc.columns(['cat_id', 'badge_id']).doNothing()).execute();
  await trx.insertInto('cat_items').values({
    id: `ci_${uuid().slice(0, 12)}`, cat_id: cat.id, item_id: 'item-creator-bell', source: `proposal:${proposalId}`,
  }).onConflict((oc) => oc.columns(['cat_id', 'item_id']).doNothing()).execute();
  return 'awarded' as const;
}

async function reconcilePendingRewards(userId: string) {
  const pending = await db.selectFrom('proposals as p')
    .innerJoin('proposal_events as pe', (join) => join.onRef('pe.proposal_id', '=', 'p.id').on('pe.event_kind', '=', 'production-verified'))
    .select('p.id').distinct().where('p.user_id', '=', userId).where('p.status', '=', 'shipped')
    .where('p.reward_status', '=', 'pending').execute();
  if (!pending.length) return;
  await db.transaction().execute(async (trx) => {
    for (const proposal of pending) {
      const rewardStatus = await awardShippedReward(trx, proposal.id, userId);
      if (rewardStatus === 'awarded') {
        await trx.updateTable('proposals').set({ reward_status: rewardStatus }).where('id', '=', proposal.id).execute();
      }
    }
  });
}

export async function createProposal(userId: string, type: 'feature' | 'bug', content: string, clientContext?: ProposalContext) {
  if (content.length > 200) throw Object.assign(new Error('内容不超过 200 字'), { code: 'TOO_LONG' });
  const today = shanghaiDate();
  const created = await db.selectFrom('proposals').select('created_at').where('user_id', '=', userId).execute();
  if (created.filter((item) => shanghaiDateFromDbText(item.created_at) === today).length >= 3) {
    throw Object.assign(new Error('每人每日最多 3 条提案'), { code: 'DAILY_LIMIT' });
  }

  const id = `prop_${uuid().slice(0, 8)}`;
  const createdAt = new Date().toISOString();
  const reporter = await db.selectFrom('users as u').leftJoin('cats as c', (join) => join.onRef('c.user_id', '=', 'u.id').on('c.status', '=', 'active'))
    .select(['u.display_name', 'c.name as cat_name']).where('u.id', '=', userId).orderBy('c.created_at', 'desc').executeTakeFirstOrThrow();
  const publicNote = proposalPublicNote('new');
  await db.transaction().execute(async (trx) => {
    await trx.insertInto('proposals').values({
      id, user_id: userId, type, content, context: type === 'bug' ? safeContext(clientContext) : null,
      reporter_display_name: reporter.display_name, reporter_cat_name: reporter.cat_name ?? null, public_note: publicNote,
      created_at: createdAt,
    }).execute();
    await trx.insertInto('proposal_events').values({
      id: `pe_${uuid().slice(0, 12)}`, proposal_id: id, actor_type: 'creator', actor_name: '皮卡',
      from_status: null, to_status: 'new', public_note: publicNote,
      created_at: createdAt,
    }).execute();
  });
  return { id, type, content, status: 'new', public_note: publicNote };
}

export async function listMyProposals(userId: string) {
  await reconcilePendingRewards(userId);
  const proposals = await db.selectFrom('proposals').select([
    'id', 'type', 'content', 'context', 'status', 'backlog_ref', 'public_note', 'contribution_points',
    'reward_status', 'accepted_at', 'shipped_at', 'created_at', 'exported_at', 'reporter_cat_name',
  ]).where('user_id', '=', userId).execute();
  proposals.sort((a, b) => compareDbTimestamps(b.created_at, a.created_at) || b.id.localeCompare(a.id));
  if (!proposals.length) return [];
  const events = await db.selectFrom('proposal_events').select([
    'id', 'proposal_id', 'actor_type', 'actor_name', 'from_status', 'to_status', 'event_kind', 'visibility',
    'evidence_ref', 'public_note', 'created_at',
  ]).where('proposal_id', 'in', proposals.map((proposal) => proposal.id)).execute();
  return proposals.map((proposal) => {
    const proposalEvents = events.filter((event) => event.proposal_id === proposal.id)
      .sort((a, b) => compareDbTimestamps(a.created_at, b.created_at) || a.id.localeCompare(b.id));
    const verified = [...proposalEvents].reverse().find((event) => event.event_kind === 'production-verified');
    const productionVerified = Boolean(verified);
    const acceptedPoints = ACCEPTED_STATUSES.has(proposal.status as ProposalStatus) ? 10 : 0;
    const publicEvents = proposalEvents.filter((event) => event.visibility === 'public').map((event) => ({
      ...event,
      public_note: proposalPublicNote(event.to_status, event.event_kind === 'production-verified'),
    }));
    return {
      ...proposal,
      public_status: projectProposalPublicStatus(proposal.status, productionVerified),
      production_verified_at: verified?.created_at ?? null,
      production_evidence_ref: verified?.evidence_ref ?? null,
      public_note: proposalPublicNote(proposal.status, productionVerified),
      contribution_points: acceptedPoints + (productionVerified ? 40 : 0),
      reward_status: productionVerified ? proposal.reward_status : 'none',
      events: publicEvents,
    };
  });
}

export async function getContributionSummary(userId: string) {
  await reconcilePendingRewards(userId);
  const proposals = await db.selectFrom('proposals').select(['id', 'status', 'reward_status']).where('user_id', '=', userId).execute();
  if (!proposals.length) return { points: 0, accepted: 0, shipped: 0, pending_rewards: 0 };
  const verifiedRows = await db.selectFrom('proposal_events').select('proposal_id').distinct()
    .where('proposal_id', 'in', proposals.map((proposal) => proposal.id))
    .where('event_kind', '=', 'production-verified').execute();
  const verified = new Set(verifiedRows.map((row) => row.proposal_id));
  const accepted = proposals.filter((proposal) => ACCEPTED_STATUSES.has(proposal.status as ProposalStatus)).length;
  const shipped = proposals.filter((proposal) => verified.has(proposal.id)).length;
  return {
    points: accepted * 10 + shipped * 40,
    accepted,
    shipped,
    pending_rewards: proposals.filter((proposal) => verified.has(proposal.id) && proposal.reward_status === 'pending').length,
  };
}

export async function exportProposals(date: string) {
  const proposals = await db.selectFrom('proposals').selectAll().where('status', '=', 'new').execute();
  return proposals.filter((proposal) => shanghaiDateFromDbText(proposal.created_at) === date);
}

export async function exportProposalIssues(date: string) {
  const all = await db.selectFrom('proposals').selectAll().execute();
  const proposals = all.filter((proposal) => shanghaiDateFromDbText(proposal.created_at) === date)
    .sort((a, b) => compareDbTimestamps(a.created_at, b.created_at) || a.id.localeCompare(b.id));
  if (!proposals.length) return [];
  const events = await db.selectFrom('proposal_events').selectAll()
    .where('proposal_id', 'in', proposals.map((proposal) => proposal.id)).execute();
  return proposals.map((proposal) => ({ ...proposal, events: events.filter((event) => event.proposal_id === proposal.id)
    .sort((a, b) => compareDbTimestamps(a.created_at, b.created_at) || a.id.localeCompare(b.id)) }));
}

export async function ackProposals(options: AckOptions, testHooks: AckTestHooks = {}) {
  const results: Array<{ id: string; status: ProposalStatus; contribution_points: number; reward_status: string }> = [];
  await db.transaction().execute(async (trx) => {
    for (const id of options.ids) {
      let proposalQuery = trx.selectFrom('proposals').selectAll().where('id', '=', id);
      if (config.dbDialect === 'postgres') proposalQuery = proposalQuery.forUpdate();
      const proposal = await proposalQuery.executeTakeFirst();
      if (!proposal) throw Object.assign(new Error(`提案不存在：${id}`), { code: 'NOT_FOUND' });
      await testHooks.afterProposalRead?.(id);
      const priorEvents = await trx.selectFrom('proposal_events').select('created_at').where('proposal_id', '=', id).execute();
      const latestEventMs = priorEvents.reduce((latest, event) => Math.max(latest, dbTimestampMs(event.created_at)), 0);
      const now = new Date(Math.max(Date.now(), latestEventMs + 1)).toISOString();
      const current = proposal.status as ProposalStatus;
      if (current !== options.status && !allowedTransitions[current]?.includes(options.status)) {
        throw Object.assign(new Error(`不允许将提案从 ${current} 更新为 ${options.status}`), { code: 'INVALID_TRANSITION' });
      }
      if (ACCEPTED_STATUSES.has(options.status)) {
        await ensureContributionEvent(trx, proposal.user_id, id, 'accepted', 10);
      }
      let rewardStatus = proposal.reward_status;
      const points = await trx.selectFrom('contribution_events').select(({ fn }) => fn.sum<number>('points').as('points'))
        .where('proposal_id', '=', id).executeTakeFirstOrThrow();
      const contributionPoints = Number(points.points ?? 0);
      // 自由文本永不进入公开存储或投影。若以后要公开更多细节，必须新增结构化
      // 白名单契约；decisionNote 仍只在内部保留。
      const publicNote = proposalPublicNote(options.status);
      await trx.updateTable('proposals').set({
        status: options.status,
        ...(options.backlogRef !== undefined ? { backlog_ref: options.backlogRef || null } : {}),
        ...(options.decisionNote !== undefined ? { decision_note: options.decisionNote || null } : {}),
        public_note: publicNote,
        ...(options.status === 'exported' ? { exported_at: now } : {}),
        ...(['accepted', 'partially-accepted', 'in-progress', 'shipped'].includes(options.status) && !proposal.accepted_at ? { accepted_at: now } : {}),
        ...(options.status === 'shipped' && !proposal.shipped_at ? { shipped_at: now } : {}),
        contribution_points: contributionPoints,
        reward_status: rewardStatus,
      }).where('id', '=', id).execute();
      if (current !== options.status) {
        await trx.insertInto('proposal_events').values({
          id: `pe_${uuid().slice(0, 12)}`, proposal_id: id, actor_type: 'creator', actor_name: '皮卡',
          from_status: current, to_status: options.status, event_kind: 'status-changed',
          idempotency_key: `legacy-status:${id}:${options.status}`, visibility: 'public',
          evidence_ref: options.backlogRef ?? null, public_note: publicNote, created_at: now,
        }).onConflict((oc) => oc.column('idempotency_key').doNothing()).execute();
      }
      results.push({ id, status: options.status, contribution_points: contributionPoints, reward_status: rewardStatus });
    }
  });
  return results;
}

export async function recordProductionVerification(
  options: ProductionVerificationOptions,
  runtime: VerificationRuntime = { nodeEnv: config.nodeEnv, releaseSha: config.releaseSha },
) {
  if (runtime.nodeEnv !== 'production') {
    throw Object.assign(new Error('production verified 事件只能由 production runtime 写入'), { code: 'NOT_PRODUCTION_RUNTIME' });
  }
  if (!/^[0-9a-f]{40}$/.test(options.releaseSha) || options.releaseSha !== runtime.releaseSha) {
    throw Object.assign(new Error('release_sha 必须逐字匹配当前 production runtime exact'), { code: 'RELEASE_SHA_MISMATCH' });
  }
  if (!Array.isArray(options.ids) || options.ids.length === 0 || options.ids.length > 100) {
    throw Object.assign(new Error('ids 必须包含 1 到 100 个提案'), { code: 'INVALID_IDS' });
  }
  if (!Number.isFinite(Date.parse(options.observedAt)) || !options.observedAt.endsWith('Z')) {
    throw Object.assign(new Error('observed_at 必须是 UTC ISO 时间'), { code: 'INVALID_OBSERVED_AT' });
  }
  const expectedEvidence = `release-observe:production:${options.releaseSha}:${options.observedAt}`;
  if (options.evidenceRef !== expectedEvidence) {
    throw Object.assign(new Error('evidence_ref 必须绑定 production、runtime exact 与观察完成时间'), { code: 'INVALID_EVIDENCE_REF' });
  }

  const results: Array<{ id: string; public_status: 'verified'; production_verified_at: string; production_evidence_ref: string }> = [];
  await db.transaction().execute(async (trx) => {
    for (const id of [...new Set(options.ids)]) {
      let proposalQuery = trx.selectFrom('proposals').selectAll().where('id', '=', id);
      if (config.dbDialect === 'postgres') proposalQuery = proposalQuery.forUpdate();
      const proposal = await proposalQuery.executeTakeFirst();
      if (!proposal) throw Object.assign(new Error(`提案不存在：${id}`), { code: 'NOT_FOUND' });
      if (proposal.status !== 'shipped') {
        throw Object.assign(new Error(`提案 ${id} 尚未进入 shipped/validating，不能写 production verified`), { code: 'NOT_SHIPPED' });
      }
      const idempotencyKey = `production-verified:${id}:${options.releaseSha}`;
      const existing = await trx.selectFrom('proposal_events')
        .select(['created_at', 'evidence_ref']).where('idempotency_key', '=', idempotencyKey).executeTakeFirst();
      if (existing && (existing.created_at !== options.observedAt || existing.evidence_ref !== options.evidenceRef)) {
        throw Object.assign(new Error(`提案 ${id} 的同一 release exact 已有不同 production 验证证据`), {
          code: 'VERIFICATION_CONFLICT',
        });
      }
      await trx.insertInto('proposal_events').values({
        id: `pe_${uuid().slice(0, 12)}`, proposal_id: id, actor_type: 'release-observe', actor_name: '发布观察器',
        from_status: 'shipped', to_status: 'verified', event_kind: 'production-verified',
        idempotency_key: idempotencyKey, visibility: 'public',
        evidence_ref: options.evidenceRef, public_note: PRODUCTION_VERIFIED_PUBLIC_NOTE, created_at: options.observedAt,
      }).onConflict((oc) => oc.column('idempotency_key').doNothing()).execute();
      await ensureContributionEvent(trx, proposal.user_id, id, 'shipped', 40);
      const rewardStatus = await awardShippedReward(trx, id, proposal.user_id);
      const points = await trx.selectFrom('contribution_events').select(({ fn }) => fn.sum<number>('points').as('points'))
        .where('proposal_id', '=', id).executeTakeFirstOrThrow();
      await trx.updateTable('proposals').set({
        public_note: PRODUCTION_VERIFIED_PUBLIC_NOTE,
        contribution_points: Number(points.points ?? 0),
        reward_status: rewardStatus,
      }).where('id', '=', id).execute();
      results.push({
        id,
        public_status: 'verified',
        production_verified_at: options.observedAt,
        production_evidence_ref: options.evidenceRef,
      });
    }
  });
  return results;
}

export async function listContributorLeaderboard(limit = 50) {
  const rows = await db.selectFrom('contribution_events as ce').innerJoin('users as u', 'u.id', 'ce.user_id')
    .select(['u.id as user_id', 'u.display_name'])
    .select(({ fn }) => fn.sum<number>('ce.points').as('points'))
    .groupBy(['u.id', 'u.display_name']).orderBy('points', 'desc').limit(limit).execute();
  return rows.map((row) => ({ ...row, points: Number(row.points ?? 0) }));
}
