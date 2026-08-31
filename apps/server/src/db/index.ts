import SqliteDatabase from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { Kysely, PostgresDialect, SqliteDialect } from 'kysely';
import { Pool } from 'pg';
import { config } from '../config.js';
import { migrateToLatest } from './migrations.js';
import type { DatabaseSchema } from './schema.js';

function createPostgresDialect(connectionString: string, max: number) {
  return new PostgresDialect({
    pool: new Pool({
      connectionString,
      max,
      ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
    }),
  });
}

function createDialect() {
  if (config.dbDialect !== 'sqlite' && config.dbDialect !== 'postgres') {
    throw new Error(`Unsupported DB_DIALECT: ${config.dbDialect}`);
  }
  if (config.nodeEnv === 'production' && config.dbDialect !== 'postgres') {
    throw new Error('Production database must use PostgreSQL; SQLite fallback is forbidden');
  }
  if (config.dbDialect === 'postgres') {
    if (!config.databaseUrl) throw new Error('DATABASE_URL is required when DB_DIALECT=postgres');
    return createPostgresDialect(config.databaseUrl, config.databasePoolSize);
  }
  const dir = path.dirname(config.databasePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const sqlite = new SqliteDatabase(config.databasePath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  return new SqliteDialect({ database: sqlite });
}

export const db = new Kysely<DatabaseSchema>({ dialect: createDialect() });

export async function runMigrations() {
  await migrateToLatest(db, config.dbDialect);
}

/**
 * Deployment migrations use their own connection so DDL never runs through the
 * application runtime pool. Production/staging must provide this explicitly.
 */
export async function runDeploymentMigrations() {
  if (!config.migrationDatabaseUrl) {
    if (config.nodeEnv === 'production' || config.nodeEnv === 'staging') {
      throw new Error('MIGRATION_DATABASE_URL is required for staging/production migrations');
    }
    await runMigrations();
    return;
  }

  if (!/^postgres(ql)?:\/\//.test(config.migrationDatabaseUrl)) {
    throw new Error('MIGRATION_DATABASE_URL must be a PostgreSQL connection URL');
  }

  const migrationDb = new Kysely<DatabaseSchema>({
    dialect: createPostgresDialect(config.migrationDatabaseUrl, 2),
  });
  try {
    await migrateToLatest(migrationDb, 'postgres');
  } finally {
    await migrationDb.destroy();
  }
}

export async function closeDatabase() {
  await db.destroy();
}

export type { CatRow } from './schema.js';
