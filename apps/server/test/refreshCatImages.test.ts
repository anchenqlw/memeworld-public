import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import SqliteDatabase from 'better-sqlite3';
import { Kysely, SqliteDialect, sql } from 'kysely';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { migrateToLatest } from '../src/db/migrations.js';
import type { DatabaseSchema } from '../src/db/schema.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const cli = path.join(repoRoot, 'apps/server/src/scripts/refreshCatImages.ts');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meme-safe-refresh-cli-'));
const databasePath = path.join(tempDir, 'fixture.db');
const untouchedPath = path.join(tempDir, 'must-not-open.db');
const imageDir = path.join(tempDir, 'cat-images');

function openFixture() {
  return new Kysely<DatabaseSchema>({
    dialect: new SqliteDialect({ database: new SqliteDatabase(databasePath) }),
  });
}

function runCli(args: string[], target = databasePath) {
  return spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DB_DIALECT: 'sqlite',
      DATABASE_URL: '',
      MIGRATION_DATABASE_URL: '',
      DATABASE_PATH: target,
      CAT_IMAGES_DIR: imageDir,
      QCA_MOCK: 'false',
      QCA_API_BASE: 'http://127.0.0.1:9/forbidden-in-cli-test',
      IMAGE_WORKER_ENABLED: 'false',
      TRAVEL_SCHEDULER_ENABLED: 'false',
    },
  });
}

beforeAll(async () => {
  const database = openFixture();
  await migrateToLatest(database, 'sqlite');
  await sql`INSERT INTO users (id, display_name) VALUES ('refresh-user', '刷新测试')`.execute(database);
  await sql`INSERT INTO cats
    (id, user_id, name, personality, attr_courage, attr_curiosity, attr_affinity, attr_insight,
      cat_token_hash, appearance, lifecycle_stage, selected_birth_appearance_id, current_image_url, appearance_status)
    VALUES
    ('refresh-cat', 'refresh-user', '不该被重画', '安静', 25, 25, 25, 25,
      'token-hash', '{}', 'world', 'birth-old', '/api/v1/cat-images/birth-old', 'ready')`.execute(database);
  await sql`INSERT INTO travels (id, cat_id, travel_date, location_id, narrative)
    VALUES ('travel-old', 'refresh-cat', '2026-08-25', 'cloud-garden', '旧旅行')`.execute(database);
  await sql`INSERT INTO cat_appearances
    (id, cat_id, kind, image_url, local_path, object_key, prompt, travel_id, selection_status)
    VALUES
    ('birth-old', 'refresh-cat', 'birth', '', 'cats/refresh-cat/birth/birth-old.png',
      'cats/refresh-cat/birth/birth-old.png', '旧出生图', NULL, 'selected'),
    ('growth-old', 'refresh-cat', 'growth', '', 'cats/refresh-cat/growth/growth-old.png',
      'cats/refresh-cat/growth/growth-old.png', '旧成长图', 'travel-old', 'history')`.execute(database);
  await sql`INSERT INTO postcards
    (id, travel_id, title, content, photo_object_key, photo_status, photo_prompt)
    VALUES ('postcard-old', 'travel-old', '旧明信片', '保留',
      'cats/refresh-cat/growth/growth-old.png', 'ready', '旧成长图')`.execute(database);
  await database.destroy();
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('refresh:cat-images safe CLI', () => {
  it('作为模块导入时零 DB、零输出且不改 process.exitCode', () => {
    const importOnlyPath = path.join(tempDir, 'import-must-not-open.db');
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--eval', `
      import(${JSON.stringify(pathToFileURL(cli).href)}).then(() => {
        process.stdout.write(JSON.stringify({ exitCode: process.exitCode ?? null }));
      });
    `], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'test', DB_DIALECT: 'sqlite', DATABASE_URL: '', MIGRATION_DATABASE_URL: '',
        DATABASE_PATH: importOnlyPath,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ exitCode: null });
    expect(fs.existsSync(importOnlyPath)).toBe(false);
  });

  it('无参数、--all 与旧 positional 形式都在打开数据库前 fail-closed', () => {
    for (const args of [[], ['--all'], ['refresh-cat']]) {
      const result = runCli(args, untouchedPath);
      expect(result.status).toBe(2);
      expect(`${result.stdout}${result.stderr}`).toContain('--cat-id');
      expect(fs.existsSync(untouchedPath)).toBe(false);
    }
  });

  it('--apply 在打开数据库前明确拒绝，安全批次切换未实现', () => {
    const result = runCli(['--cat-id', 'refresh-cat', '--apply'], untouchedPath);
    expect(result.status).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toContain('SAFE_BATCH_CUTOVER_NOT_IMPLEMENTED');
    expect(fs.existsSync(untouchedPath)).toBe(false);
  });

  it('默认仅生成单猫 JSON plan，数据库与对象目录保持不变', async () => {
    const beforeDb = openFixture();
    const before = {
      cat: await beforeDb.selectFrom('cats').select([
        'selected_birth_appearance_id', 'current_image_url', 'appearance_status',
      ]).where('id', '=', 'refresh-cat').executeTakeFirstOrThrow(),
      appearances: await beforeDb.selectFrom('cat_appearances').selectAll()
        .where('cat_id', '=', 'refresh-cat').orderBy('id').execute(),
      postcards: await beforeDb.selectFrom('postcards').selectAll().where('id', '=', 'postcard-old').execute(),
      jobs: await beforeDb.selectFrom('image_jobs').selectAll().where('cat_id', '=', 'refresh-cat').execute(),
    };
    await beforeDb.destroy();

    const result = runCli(['--cat-id', 'refresh-cat']);
    expect(result.status, result.stderr).toBe(0);
    const plan = JSON.parse(result.stdout);
    expect(plan).toMatchObject({
      schema_version: 1,
      mode: 'dry-run',
      safe_to_apply: false,
      blocked_reason: 'SAFE_BATCH_CUTOVER_NOT_IMPLEMENTED',
      cat_id: 'refresh-cat',
      existing: { appearances: 2, travels: 1 },
    });
    expect(plan.items).toEqual([
      { key: 'birth', kind: 'birth', current_appearance_id: 'birth-old' },
      { key: 'growth:travel-old', kind: 'growth', travel_id: 'travel-old', current_appearance_id: 'growth-old' },
    ]);

    const afterDb = openFixture();
    expect(await afterDb.selectFrom('cats').select([
      'selected_birth_appearance_id', 'current_image_url', 'appearance_status',
    ]).where('id', '=', 'refresh-cat').executeTakeFirstOrThrow()).toEqual(before.cat);
    expect(await afterDb.selectFrom('cat_appearances').selectAll()
      .where('cat_id', '=', 'refresh-cat').orderBy('id').execute()).toEqual(before.appearances);
    expect(await afterDb.selectFrom('postcards').selectAll().where('id', '=', 'postcard-old').execute()).toEqual(before.postcards);
    expect(await afterDb.selectFrom('image_jobs').selectAll().where('cat_id', '=', 'refresh-cat').execute()).toEqual(before.jobs);
    await afterDb.destroy();
    expect(fs.existsSync(imageDir)).toBe(false);
  });

  it('不存在的猫返回非零且不退化为全库 plan', () => {
    const result = runCli(['--cat-id', 'missing-cat']);
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('CAT_NOT_FOUND');
    expect(result.stdout).not.toContain('refresh-cat');
  });
});
