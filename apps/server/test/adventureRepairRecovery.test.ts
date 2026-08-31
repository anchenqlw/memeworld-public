import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meme-repair-recovery-test-'));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'mock';
process.env.QCA_MOCK = 'true';
process.env.DB_DIALECT = process.env.DATABASE_URL ? 'postgres' : 'sqlite';
if (process.env.DB_DIALECT === 'sqlite') process.env.DATABASE_PATH = path.join(tempDir, 'meme.db');
process.env.CAT_IMAGES_DIR = path.join(tempDir, 'cat-images');
process.env.REPO_ROOT = repoRoot;
process.env.PAT_ENCRYPTION_KEY = '1'.repeat(64);
process.env.SESSION_SECRET = 'test-session-secret-at-least-32-characters';
process.env.INTERNAL_API_KEY = 'dev-internal-key';
process.env.REDIS_DRIVER ||= 'memory';
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
process.env.REDIS_NAMESPACE ||= `meme:test:${randomUUID()}`;
process.env.STORAGE_DRIVER ||= 'local';
process.env.IMAGE_WORKER_ENABLED = 'false';
process.env.TRAVEL_SCHEDULER_ENABLED = 'false';

type HealthMode = 'healthy' | 'broken' | 'unknown';
let healthMode: HealthMode = 'healthy';
let healthGate: { entered: () => void; wait: Promise<void> } | undefined;
let healthCalls = 0;
const rawProviderMarker = 'synthetic-provider-body-must-not-escape-233';

async function controlledHealth(mode: HealthMode) {
  healthCalls += 1;
  if (healthGate) {
    const gate = healthGate;
    healthGate = undefined;
    gate.entered();
    await gate.wait;
  }
  if (mode === 'unknown') throw new Error(rawProviderMarker);
  return { status: mode, details: { agent: mode === 'healthy' ? 'ok' : 'error' } };
}

vi.mock('../src/services/qca.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/services/qca.js')>();
  return { ...actual, checkResourceHealth: vi.fn(async () => controlledHealth(healthMode)) };
});

vi.mock('../src/services/qcaForwardService.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/services/qcaForwardService.js')>();
  return { ...actual, checkForwardTravelHealth: vi.fn(async () => controlledHealth(healthMode)) };
});

vi.mock('../src/services/chatTurnService.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/services/chatTurnService.js')>();
  return {
    ...actual,
    startChatWorker: vi.fn(async () => {}),
    stopChatWorker: vi.fn(async () => {}),
  };
});

let app: FastifyInstance;

beforeAll(async () => {
  const module = await import('../src/app.js');
  app = await module.buildApp();
  await app.ready();
});

beforeEach(() => {
  healthMode = 'healthy';
  healthGate = undefined;
  healthCalls = 0;
  delete process.env.QCA_FORWARD_TRAVEL;
});

afterAll(async () => {
  delete process.env.QCA_FORWARD_TRAVEL;
  if (app) await app.close();
  const { closeDatabase } = await import('../src/db/index.js');
  await closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function createRepairableCat(mode: 'build' | 'forward', status = 'broken') {
  const login = await app.inject({
    method: 'GET',
    url: `/api/v1/auth/login?json=1&fresh=1&nonce=${randomUUID()}`,
    headers: { accept: 'application/json' },
  });
  const cookie = login.cookies[0];
  const cookies = { [cookie.name]: cookie.value };
  await app.inject({ method: 'PUT', url: '/api/v1/pat', cookies, payload: { pat: `pt-repair-${randomUUID()}` } });
  const created = await app.inject({
    method: 'POST', url: '/api/v1/cats', cookies,
    payload: { name: '复检猫', personality: '谨慎', model: 'ultimate' },
  });
  expect(created.statusCode).toBe(200);

  const { db } = await import('../src/db/index.js');
  await db.updateTable('cats').set({
    status,
    lifecycle_stage: status === 'recalled' ? 'recalled' : 'scheduled',
    travel_schedule_enabled: status === 'recalled' ? 0 : 1,
    qca_env_id: `env_${mode}`,
    qca_memstore_id: `mem_${mode}`,
    qca_health_cache: JSON.stringify({ status: 'broken', details: { agent: 'error' } }),
    ...(mode === 'build' ? {
      qca_agent_id: 'agent_build',
      qca_deployment_id: 'deployment_build',
    } : {
      qca_forward_identity_id: 'identity_forward',
      qca_forward_travel_template_id: 'template_forward',
      qca_forward_schedule_id: 'schedule_forward',
    }),
  }).where('id', '=', created.json().id).execute();
  if (mode === 'forward') process.env.QCA_FORWARD_TRAVEL = 'true';
  return { cookies, catId: created.json().id as string };
}

async function repair(cookies: Record<string, string>) {
  return app.inject({ method: 'POST', url: '/api/v1/cats/me/adventure/repair', cookies, payload: {} });
}

describe('adventure repair persisted health recovery (ISSUES #233)', () => {
  it.each(['build', 'forward', 'build-to-forward'] as const)(
    '%s repair returns the unchanged CatProfile contract only after broken -> healthy -> active is persisted',
    async (mode) => {
      const { cookies, catId } = await createRepairableCat(mode === 'build-to-forward' ? 'build' : mode);
      if (mode === 'build-to-forward') process.env.QCA_FORWARD_TRAVEL = 'true';
      const response = await repair(cookies);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ id: catId, status: 'active', qca_health: { status: 'healthy' } });
      expect(response.json()).not.toHaveProperty('profile');
      expect(response.json()).not.toHaveProperty('audit');
      expect(response.json().qca_diagnosis).toBeUndefined();
      expect(healthCalls).toBe(1);
      if (mode !== 'build') expect(response.json().qca.forward_mode).toBe(true);

      const { db } = await import('../src/db/index.js');
      const row = await db.selectFrom('cats').select(['status', 'qca_health_cache'])
        .where('id', '=', catId).executeTakeFirstOrThrow();
      expect(row.status).toBe('active');
      expect(JSON.parse(row.qca_health_cache || '{}').status).toBe('healthy');
    },
  );

  it.each([
    ['broken health', 'broken' as const, 'broken'],
    ['unknown health', 'unknown' as const, 'broken'],
    ['recalled terminal state', 'healthy' as const, 'recalled'],
  ])('returns fixed REPAIR_HEALTH_STILL_BROKEN for %s without leaking provider output', async (_label, mode, status) => {
    healthMode = mode;
    const { cookies, catId } = await createRepairableCat('build', status);
    const response = await repair(cookies);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: 'REPAIR_HEALTH_STILL_BROKEN',
        message: '云端资源复检仍未恢复，请稍后再试或检查 PAT 与 Credits',
      },
    });
    expect(response.payload).not.toContain(rawProviderMarker);
    expect(healthCalls).toBe(1);

    const { db } = await import('../src/db/index.js');
    const row = await db.selectFrom('cats').select(['status', 'qca_health_cache'])
      .where('id', '=', catId).executeTakeFirstOrThrow();
    expect(row.status).toBe(status);
    expect(JSON.parse(row.qca_health_cache || '{}').status).toBe(mode === 'unknown' ? 'unknown' : mode);
  });

  it('keeps status transitions in one health-owned function and never revives terminal states', async () => {
    const { catStatusAfterQcaHealth } = await import('../src/services/catService.js');
    expect(catStatusAfterQcaHealth('broken', 'healthy')).toBe('active');
    expect(catStatusAfterQcaHealth('active', 'broken')).toBe('broken');
    expect(catStatusAfterQcaHealth('broken', 'unknown')).toBe('broken');
    expect(catStatusAfterQcaHealth('broken', 'not_started')).toBe('broken');
    expect(catStatusAfterQcaHealth('recalled', 'healthy')).toBe('recalled');
    expect(catStatusAfterQcaHealth('archived', 'healthy')).toBe('archived');
  });

  it('does not revive a cat recalled while a healthy provider check is in flight', async () => {
    const { cookies, catId } = await createRepairableCat('build');
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    let releaseHealth!: () => void;
    const wait = new Promise<void>((resolve) => { releaseHealth = resolve; });
    healthGate = { entered: signalEntered, wait };

    const responsePromise = repair(cookies);
    await entered;
    const { db } = await import('../src/db/index.js');
    await db.updateTable('cats').set({
      status: 'recalled', lifecycle_stage: 'recalled', travel_schedule_enabled: 0,
    }).where('id', '=', catId).execute();
    releaseHealth();

    const response = await responsePromise;
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('REPAIR_HEALTH_STILL_BROKEN');
    const row = await db.selectFrom('cats').select(['status', 'qca_health_cache'])
      .where('id', '=', catId).executeTakeFirstOrThrow();
    expect(row.status).toBe('recalled');
    expect(JSON.parse(row.qca_health_cache || '{}').status).toBe('healthy');
    expect(healthCalls).toBe(1);
  });
});
