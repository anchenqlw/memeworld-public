import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';

const STATUSES = ['draft', 'published', 'archived'] as const;
const SOURCE_KINDS = ['seed', 'owner', 'proposal'] as const;
type ChronicleStatus = typeof STATUSES[number];
type SourceKind = typeof SOURCE_KINDS[number];

export type ChronicleWriteInput = {
  date: string;
  title: string;
  summary: string;
  change_type: string;
  source_kind?: SourceKind;
  proposal_id?: string | null;
  contributor_cat_name?: string | null;
  status?: ChronicleStatus;
  actor_name: string;
  change_note?: string | null;
};

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function text(value: unknown, field: string, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    fail('INVALID_CHRONICLE', `${field} 必须为 1~${max} 字`);
  }
  return value.trim();
}

function validateDate(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('INVALID_CHRONICLE', 'date 必须为 YYYY-MM-DD');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail('INVALID_CHRONICLE', 'date 不是有效日期');
  return value;
}

function normalize(input: ChronicleWriteInput) {
  const sourceKind = input.source_kind || 'owner';
  const status = input.status || 'published';
  if (!SOURCE_KINDS.includes(sourceKind)) fail('INVALID_CHRONICLE', 'source_kind 不受支持');
  if (!STATUSES.includes(status)) fail('INVALID_CHRONICLE', 'status 不受支持');
  const proposalId = input.proposal_id?.trim() || null;
  const contributor = input.contributor_cat_name?.trim() || null;
  if (sourceKind === 'proposal' && (!proposalId || !contributor)) {
    fail('INVALID_CHRONICLE', '玩家提案条目必须包含 proposal_id 与 contributor_cat_name');
  }
  return {
    date: validateDate(input.date),
    title: text(input.title, 'title', 80),
    summary: text(input.summary, 'summary', 1000),
    change_type: text(input.change_type, 'change_type', 30),
    source_kind: sourceKind,
    proposal_id: proposalId,
    contributor_cat_name: contributor,
    status,
    actor_name: text(input.actor_name, 'actor_name', 80),
    change_note: input.change_note?.trim().slice(0, 500) || null,
  };
}

function snapshot(row: Record<string, unknown>) {
  const { created_at: _createdAt, updated_at: _updatedAt, ...content } = row;
  return JSON.stringify(content);
}

export async function createChronicleEntry(input: ChronicleWriteInput) {
  const data = normalize(input);
  const now = new Date().toISOString();
  const id = `chronicle-${data.date}-${randomUUID().slice(0, 8)}`;
  return db.transaction().execute(async (trx) => {
    const row = await trx.insertInto('world_chronicle').values({
      id, date: data.date, title: data.title, summary: data.summary, change_type: data.change_type,
      source_kind: data.source_kind, proposal_id: data.proposal_id, contributor_cat_name: data.contributor_cat_name,
      history_file: `runtime:chronicle/${id}`, status: data.status, revision: 1,
      published_at: data.status === 'published' ? now : null, updated_at: now,
    }).returningAll().executeTakeFirstOrThrow();
    await trx.insertInto('world_chronicle_revisions').values({
      id: randomUUID(), chronicle_id: id, revision: 1, snapshot: snapshot(row as unknown as Record<string, unknown>),
      actor_name: data.actor_name, change_note: data.change_note,
    }).execute();
    return row;
  });
}

export async function updateChronicleEntry(id: string, expectedRevision: number, input: ChronicleWriteInput) {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) fail('INVALID_REVISION', 'expected_revision 必须为正整数');
  const data = normalize(input);
  const now = new Date().toISOString();
  return db.transaction().execute(async (trx) => {
    const current = await trx.selectFrom('world_chronicle').selectAll().where('id', '=', id).executeTakeFirst();
    if (!current) fail('CHRONICLE_NOT_FOUND', '编年史条目不存在');
    if (current.revision !== expectedRevision) fail('REVISION_CONFLICT', `条目已更新，当前 revision=${current.revision}`);
    const publishedAt = data.status === 'published' ? (current.published_at || now) : current.published_at;
    const result = await trx.updateTable('world_chronicle').set({
      date: data.date, title: data.title, summary: data.summary, change_type: data.change_type,
      source_kind: data.source_kind, proposal_id: data.proposal_id, contributor_cat_name: data.contributor_cat_name,
      status: data.status, revision: expectedRevision + 1, published_at: publishedAt, updated_at: now,
    }).where('id', '=', id).where('revision', '=', expectedRevision).executeTakeFirst();
    if (Number(result.numUpdatedRows || 0) !== 1) fail('REVISION_CONFLICT', '条目已被其他写入更新');
    const row = await trx.selectFrom('world_chronicle').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    await trx.insertInto('world_chronicle_revisions').values({
      id: randomUUID(), chronicle_id: id, revision: expectedRevision + 1,
      snapshot: snapshot(row as unknown as Record<string, unknown>), actor_name: data.actor_name, change_note: data.change_note,
    }).execute();
    return row;
  });
}

export function listManagedChronicle() {
  return db.selectFrom('world_chronicle').selectAll().orderBy('date', 'desc').orderBy('updated_at', 'desc').execute();
}

export function listChronicleRevisions(id: string) {
  return db.selectFrom('world_chronicle_revisions').selectAll().where('chronicle_id', '=', id).orderBy('revision', 'desc').execute();
}
