import SqliteDatabase from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { Kysely, SqliteDialect, sql } from 'kysely';
import { LATEST_SCHEMA_VERSION, migrateToLatest } from '../src/db/migrations.js';
import type { DatabaseSchema } from '../src/db/schema.js';

const databases: Array<Kysely<DatabaseSchema>> = [];

function createDatabase() {
  const database = new Kysely<DatabaseSchema>({
    dialect: new SqliteDialect({ database: new SqliteDatabase(':memory:') }),
  });
  databases.push(database);
  return database;
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.destroy()));
});

describe('database migrations', () => {
  it('adds v37 reading fields and v38 task-reconciliation state without rewriting postcards', async () => {
    const database = createDatabase();
    await migrateToLatest(database, 'sqlite');
    const columns = await sql<{ name: string }>`PRAGMA table_info(postcards)`.execute(database);
    expect(columns.rows.map((column) => column.name)).toEqual(expect.arrayContaining([
      'reading_source_type', 'reading_source_id', 'reading_source_title',
    ]));
    const tables = await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'`.execute(database);
    expect(tables.rows.map((row) => row.name)).toEqual(expect.arrayContaining([
      'cat_task_reconciliations', 'task_reconcile_cursors',
    ]));
    const reconciliationColumns = await sql<{ name: string }>`PRAGMA table_info(cat_task_reconciliations)`.execute(database);
    expect(reconciliationColumns.rows.map((column) => column.name)).toEqual(expect.arrayContaining([
      'branch', 'target_resource_id', 'applied_branch', 'applied_resource_id',
      'desired_version', 'desired_hash', 'desired_instruction_hash',
      'applied_instruction_hash', 'lease_epoch', 'provider_started_at',
    ]));
    expect(LATEST_SCHEMA_VERSION).toBe(38);
  });

  it('capability-repairs the old v29 collision without deleting its marker or append-only event metadata', async () => {
    const database = createDatabase();
    await migrateToLatest(database, 'sqlite');

    await sql`INSERT INTO users (id, display_name, created_at, updated_at)
      VALUES ('migration-user', '迁移测试', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`.execute(database);
    await sql`INSERT INTO proposals (id, user_id, type, content, status, created_at)
      VALUES ('migration-proposal', 'migration-user', 'feature', '保留事件元数据', 'exported', CURRENT_TIMESTAMP)`.execute(database);
    await sql`INSERT INTO proposal_events
      (id, proposal_id, actor_type, actor_name, from_status, to_status, event_kind, idempotency_key, visibility, evidence_ref, public_note, created_at)
      VALUES ('migration-event', 'migration-proposal', 'creator', '皮卡', 'new', 'exported', 'feedback-archived',
        'migration:idempotency', 'private', 'sha:test', '保留', CURRENT_TIMESTAMP)`.execute(database);

    await database.schema.dropTable('cat_relationships').execute();
    await database.schema.dropTable('encounter_receipts').execute();
    await database.schema.dropTable('encounter_actions').execute();
    await database.schema.dropTable('encounters').execute();
    await database.deleteFrom('schema_migrations').where('version', '>=', 30).execute();

    expect((await database.selectFrom('schema_migrations')
      .select(({ fn }) => fn.max<number>('version').as('version'))
      .executeTakeFirstOrThrow()).version).toBe(29);

    await migrateToLatest(database, 'sqlite');

    const tables = await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'`.execute(database);
    expect(tables.rows.map((row) => row.name)).toEqual(expect.arrayContaining([
      'encounters', 'encounter_actions', 'encounter_receipts', 'cat_relationships', 'world_chronicle_revisions',
    ]));
    expect((await database.selectFrom('schema_migrations')
      .select(({ fn }) => fn.max<number>('version').as('version'))
      .executeTakeFirstOrThrow()).version).toBe(LATEST_SCHEMA_VERSION);
    expect(await database.selectFrom('proposal_events').select([
      'event_kind', 'idempotency_key', 'visibility', 'evidence_ref',
    ]).where('id', '=', 'migration-event').executeTakeFirstOrThrow()).toEqual({
      event_kind: 'feedback-archived', idempotency_key: 'migration:idempotency',
      visibility: 'private', evidence_ref: 'sha:test',
    });
  });

  it('forward-repairs the legacy evolution_jobs shape created by the old v29 branch', async () => {
    const database = createDatabase();
    await migrateToLatest(database, 'sqlite');
    await database.schema.alterTable('evolution_jobs').dropColumn('approval_scope_hash').execute();
    await database.schema.alterTable('evolution_jobs').dropColumn('lock_domains').execute();
    await database.schema.alterTable('evolution_jobs').dropColumn('lease_epoch').execute();
    await database.schema.alterTable('evolution_jobs').dropColumn('budget_limit').execute();
    await database.schema.alterTable('evolution_jobs').dropColumn('budget_used').execute();
    await database.deleteFrom('schema_migrations').where('version', '>=', 32).execute();

    await migrateToLatest(database, 'sqlite');

    const columns = await sql<{ name: string }>`PRAGMA table_info(evolution_jobs)`.execute(database);
    expect(columns.rows.map((column) => column.name)).toEqual(expect.arrayContaining([
      'lease_epoch', 'lock_domains', 'approval_scope_hash', 'budget_limit', 'budget_used',
    ]));
    for (const [table, expectedColumns] of [
      ['feedback_claims', ['lease_epoch', 'attempts', 'max_attempts', 'heartbeat_at', 'error_code']],
      ['feedback_archives', ['sanitized_ref', 'sanitized_sha256']],
      ['owner_approvals', ['updated_at']],
    ] as const) {
      const tableColumns = await sql<{ name: string }>`PRAGMA table_info(${sql.raw(table)})`.execute(database);
      expect(tableColumns.rows.map((column) => column.name)).toEqual(expect.arrayContaining([...expectedColumns]));
    }
    const tables = await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'`.execute(database);
    expect(tables.rows.map((row) => row.name)).toEqual(expect.arrayContaining([
      'cluster_membership_events', 'owner_approval_events', 'evolution_runtime_state', 'chat_turns',
    ]));
  });
});
