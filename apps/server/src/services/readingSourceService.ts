import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { Kysely, Transaction } from 'kysely';
import type { DatabaseSchema } from '../db/schema.js';
import { getRepoRoot } from '../lib/templates.js';
import { config } from '../config.js';

export const READING_INTERVAL = 7;

export type OwnerBookSource = { id: string; title: string; brief: string };
export type WorldBookSource = OwnerBookSource & { rights: 'original' };
export type ReadingSource = {
  source_type: 'growth_card' | 'world_book';
  source_id: string;
  title: string;
  brief: string;
};
export type ReadingSourceRef = Pick<ReadingSource, 'source_type' | 'source_id'>;

type DbExecutor = Kysely<DatabaseSchema> | Transaction<DatabaseSchema>;

export function selectReadingSource(input: {
  completedTravelCount: number;
  ownerBooks: readonly OwnerBookSource[];
  worldBooks: readonly WorldBookSource[];
}): ReadingSource | null {
  const nextTravelNumber = input.completedTravelCount + 1;
  if (nextTravelNumber % READING_INTERVAL !== 0) return null;
  const cycleIndex = Math.floor(nextTravelNumber / READING_INTERVAL) - 1;
  if (input.ownerBooks.length > 0) {
    const book = input.ownerBooks[cycleIndex % input.ownerBooks.length];
    return { source_type: 'growth_card', source_id: book.id, title: book.title, brief: book.brief };
  }
  if (input.worldBooks.length > 0) {
    const book = input.worldBooks[cycleIndex % input.worldBooks.length];
    return { source_type: 'world_book', source_id: book.id, title: book.title, brief: book.brief };
  }
  return null;
}

function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > max) {
    throw new Error(`world/genes/books.yaml: ${field} 必须为 1~${max} 字符`);
  }
  return value.trim();
}

export function loadWorldBooks(): WorldBookSource[] {
  const file = path.join(getRepoRoot(), 'world/genes/books.yaml');
  const parsed = yaml.load(fs.readFileSync(file, 'utf8')) as { books?: unknown };
  if (!Array.isArray(parsed?.books) || parsed.books.length < 1) {
    throw new Error('world/genes/books.yaml: books 必须为非空数组');
  }
  const ids = new Set<string>();
  return parsed.books.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new Error(`world/genes/books.yaml: books[${index}] 格式错误`);
    const row = raw as Record<string, unknown>;
    const id = requireText(row.id, `books[${index}].id`, 80);
    if (!/^book-cloud-[a-z0-9-]+$/.test(id) || ids.has(id)) {
      throw new Error(`world/genes/books.yaml: books[${index}].id 非法或重复`);
    }
    ids.add(id);
    if (row.rights !== 'original') {
      throw new Error(`world/genes/books.yaml: books[${index}].rights 必须为 original`);
    }
    return {
      id,
      title: requireText(row.title, `books[${index}].title`, 40),
      brief: requireText(row.brief, `books[${index}].brief`, 240),
      rights: 'original' as const,
    };
  });
}

export async function resolveReadingSource(
  catId: string,
  database: DbExecutor,
  options: { lockActiveBooks?: boolean } = {},
): Promise<ReadingSource | null> {
  const countRow = await database.selectFrom('travels').select(({ fn }) => fn.count<number>('id').as('count'))
    .where('cat_id', '=', catId).executeTakeFirstOrThrow();
  let activeBookQuery = database.selectFrom('growth_cards').select(['id', 'title', 'summary'])
    .where('cat_id', '=', catId).where('type', '=', 'book').where('deleted_at', 'is', null)
    .orderBy('updated_at', 'desc').orderBy('id', 'asc');
  if (options.lockActiveBooks && config.dbDialect === 'postgres') activeBookQuery = activeBookQuery.forUpdate();
  const activeBooks = await activeBookQuery.execute();
  return selectReadingSource({
    completedTravelCount: Number(countRow.count),
    ownerBooks: activeBooks.map((card) => ({ id: card.id, title: card.title, brief: card.summary })),
    worldBooks: loadWorldBooks(),
  });
}

export function normalizeReadingSourceRef(value: unknown): ReadingSourceRef | null {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('postcard.reading_source 格式不正确'), { code: 'INVALID_READING_SOURCE' });
  }
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source).sort();
  if (keys.join(',') !== 'source_id,source_type'
    || (source.source_type !== 'growth_card' && source.source_type !== 'world_book')
    || typeof source.source_id !== 'string'
    || source.source_id.length < 1
    || source.source_id.length > 80) {
    throw Object.assign(new Error('postcard.reading_source 只接受服务端给出的 source_type/source_id'), {
      code: 'INVALID_READING_SOURCE',
    });
  }
  return { source_type: source.source_type, source_id: source.source_id };
}
