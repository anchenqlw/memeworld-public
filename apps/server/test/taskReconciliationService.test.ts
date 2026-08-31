import SqliteDatabase from 'better-sqlite3';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Kysely, SqliteDialect } from 'kysely';
import { migrateToLatest } from '../src/db/migrations.js';
import type { DatabaseSchema } from '../src/db/schema.js';

process.env.NODE_ENV = 'test';
process.env.QCA_MOCK = 'true';
process.env.PAT_ENCRYPTION_KEY = '1'.repeat(64);

type ReconcilerModule = typeof import('../src/services/taskReconciliationService.js');
let reconciliation: ReconcilerModule;
const databases: Array<Kysely<DatabaseSchema>> = [];

beforeAll(async () => {
  reconciliation = await import('../src/services/taskReconciliationService.js');
});

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.destroy()));
});

async function fixture(
  testHooks: Parameters<ReconcilerModule['createTaskReconciler']>[5] = {},
) {
  const database = new Kysely<DatabaseSchema>({
    dialect: new SqliteDialect({ database: new SqliteDatabase(':memory:') }),
  });
  databases.push(database);
  await migrateToLatest(database, 'sqlite');
  for (const cat of [
    { id: 'cat-build', userId: 'user-build', name: '建造猫', deployment: 'dep-1', schedule: null, active: true },
    { id: 'cat-forward', userId: 'user-forward', name: '前行猫', deployment: null, schedule: 'sched-1', active: true },
    { id: 'cat-inactive', userId: 'user-inactive', name: '休息猫', deployment: 'dep-2', schedule: null, active: false },
  ]) {
    await database.insertInto('users').values({
      id: cat.userId, provider_user_id: null, buc_id: null, display_name: '主人', email: null, avatar_url: null,
    }).execute();
    await database.insertInto('cats').values({
      id: cat.id, user_id: cat.userId, name: cat.name, personality: '好奇',
      attr_courage: 5, attr_curiosity: 5, attr_affinity: 5, attr_insight: 5,
      qca_model: null, qca_env_id: 'env-1', qca_agent_id: cat.deployment ? 'agent-1' : null,
      qca_memstore_id: 'mem-1', qca_deployment_id: cat.deployment, qca_image_env_id: null,
      qca_image_agent_id: null, image_identity_anchor: null, cat_token_hash: 'hash', appearance: '{}',
      current_image_url: null, qca_chat_session_id: null, selected_birth_appearance_id: null,
      appearance_confirmed_at: null, adventure_started_at: null,
      travel_schedule_enabled: cat.active ? 1 : 0, status: cat.active ? 'active' : 'recalled',
      qca_health_cache: null, qca_health_checked_at: null, qca_travel_session_id: null,
      qca_travel_session_token_hash: null, last_travel_dispatched_on: null,
      qca_forward_travel_template_id: cat.schedule ? 'tmpl-1' : null,
      qca_forward_identity_id: cat.schedule ? 'identity-1' : null,
      qca_forward_schedule_id: cat.schedule, qca_forward_travel_session_id: null,
      qca_forward_travel_session_token_hash: null, qca_forward_chat_template_id: null,
      qca_forward_im_channel_id: null, travel_wish_location_id: null,
      current_destination_location_id: null, current_destination_selected_on: null,
      current_destination_selected_at: null, lifecycle_stage: 'scheduled',
    }).execute();
  }
  const remote = new Map<string, string>();
  const writes: string[] = [];
  const provider = {
    getCredential: vi.fn(async () => ({ pat: 'memory-only-pat', site: 'global' as const })),
    readBuild: vi.fn(async (_credential: unknown, id: string) => remote.get(id) ?? null),
    writeBuild: vi.fn(async (_credential: unknown, id: string, instruction: string) => { writes.push(`build:${id}`); remote.set(id, instruction); }),
    readForward: vi.fn(async (_credential: unknown, id: string) => remote.get(id) ?? null),
    writeForward: vi.fn(async (_credential: unknown, id: string, instruction: string) => { writes.push(`forward:${id}`); remote.set(id, instruction); }),
  };
  let descriptor = { id: reconciliation.DAILY_TRAVEL_TASK_ID, version: 10, hash: 'a'.repeat(64) } as const;
  const reconciler = reconciliation.createTaskReconciler(
    database,
    provider,
    'sqlite',
    () => descriptor,
    (name) => `task-v${descriptor.version}:${name}`,
    testHooks,
  );
  return { database, provider, writes, remote, reconciler, setDescriptor: (version: number, hash: string) => { descriptor = { ...descriptor, version, hash }; } };
}

describe('cat task-version reconciliation', () => {
  it('plans only active eligible cats, preserves Build/Forward branches and skips an already applied hash', async () => {
    const { database, writes, reconciler } = await fixture();
    const planned = await reconciler.plan({ limit: 10 });
    expect(planned).toMatchObject({ scanned: 2, newly_pending: 2, scan_complete: true });
    const rows = await database.selectFrom('cat_task_reconciliations').selectAll().orderBy('cat_id').execute();
    expect(rows.map((row) => [row.cat_id, row.branch, row.status])).toEqual([
      ['cat-build', 'build', 'pending'], ['cat-forward', 'forward', 'pending'],
    ]);

    const first = await reconciler.execute({ limit: 10, rateLimitMs: 0, workerId: 'worker-a' });
    expect(first).toMatchObject({ attempted: 2, applied: 2, provider_writes: 2 });
    expect(writes).toEqual(['build:dep-1', 'forward:sched-1']);
    const replay = await reconciler.execute({ limit: 10, rateLimitMs: 0, workerId: 'worker-b' });
    expect(replay).toMatchObject({ attempted: 0, provider_writes: 0 });
    expect(writes).toHaveLength(2);
  });

  it('makes a version/hash upgrade deterministically pending without erasing the applied fact', async () => {
    const { database, reconciler, setDescriptor } = await fixture();
    await reconciler.plan({ limit: 10 });
    await reconciler.execute({ limit: 10, rateLimitMs: 0 });
    setDescriptor(11, 'b'.repeat(64));
    const upgraded = await reconciler.plan({ limit: 10 });
    expect(upgraded.newly_pending).toBe(2);
    const rows = await database.selectFrom('cat_task_reconciliations').selectAll().execute();
    expect(rows.every((row) => row.status === 'pending' && row.desired_version === 11)).toBe(true);
    expect(rows.every((row) => row.applied_version === 10 && row.applied_hash === 'a'.repeat(64))).toBe(true);
  });

  it('recovers provider-started response loss by reading the remote instruction before any second write', async () => {
    const { database, provider, writes, remote, reconciler } = await fixture();
    await reconciler.plan({ limit: 10 });
    await database.updateTable('cat_task_reconciliations').set({
      status: 'applied', applied_branch: 'forward', applied_resource_id: 'sched-1',
      applied_version: 10, applied_hash: 'a'.repeat(64),
    })
      .where('cat_id', '=', 'cat-forward').execute();
    provider.writeBuild.mockImplementationOnce(async (_credential, id, instruction) => {
      writes.push(`build:${id}`);
      remote.set(id, instruction);
      throw Object.assign(new Error('raw provider response must not persist'), { code: 'SOME_RAW_FAILURE' });
    });
    const failed = await reconciler.execute({ limit: 1, rateLimitMs: 0, workerId: 'worker-crash' });
    expect(failed.results[0]).toMatchObject({ status: 'provider_started', error_code: 'TASK_PROVIDER_ERROR' });
    await database.updateTable('cat_task_reconciliations').set({ next_attempt_at: null }).where('cat_id', '=', 'cat-build').execute();
    const recovered = await reconciler.execute({ limit: 1, rateLimitMs: 0, workerId: 'worker-takeover' });
    expect(recovered).toMatchObject({ applied: 1, provider_writes: 0 });
    expect(writes).toEqual(['build:dep-1']);
    const row = await database.selectFrom('cat_task_reconciliations').selectAll().where('cat_id', '=', 'cat-build').executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'applied', error_code: null, provider_started_at: null });
    expect(JSON.stringify(row)).not.toContain('raw provider response');
    expect(JSON.stringify(row)).not.toContain('memory-only-pat');
  });

  it('keeps provider_started when a successful write outlives its lease, then takeover readback closes without rewriting', async () => {
    const { database, provider, writes, remote, reconciler } = await fixture();
    await reconciler.plan({ limit: 10 });
    await database.updateTable('cat_task_reconciliations').set({
      status: 'applied', applied_branch: 'forward', applied_resource_id: 'sched-1',
      applied_version: 10, applied_hash: 'a'.repeat(64),
    })
      .where('cat_id', '=', 'cat-forward').execute();
    provider.writeBuild.mockImplementationOnce(async (_credential, id, instruction) => {
      writes.push(`build:${id}`);
      remote.set(id, instruction);
      await database.updateTable('cat_task_reconciliations').set({ lease_expires_at: '2000-01-01T00:00:00.000Z' })
        .where('cat_id', '=', 'cat-build').execute();
    });
    const stale = await reconciler.execute({ limit: 1, rateLimitMs: 0, workerId: 'worker-expired' });
    expect(stale.results[0]).toMatchObject({ status: 'lease_lost', error_code: 'TASK_LEASE_LOST' });
    const duringTakeover = await database.selectFrom('cat_task_reconciliations').select(['status', 'provider_started_at'])
      .where('cat_id', '=', 'cat-build').executeTakeFirstOrThrow();
    expect(duringTakeover.status).toBe('provider_started');
    expect(duringTakeover.provider_started_at).toBeTruthy();

    const recovered = await reconciler.execute({ limit: 1, rateLimitMs: 0, workerId: 'worker-after-expiry' });
    expect(recovered).toMatchObject({ applied: 1, provider_writes: 0 });
    expect(writes).toEqual(['build:dep-1']);
  });

  it('allows only one concurrent worker to claim a cat and fences the final state', async () => {
    const { database, provider, reconciler } = await fixture();
    await reconciler.plan({ limit: 10 });
    await database.updateTable('cat_task_reconciliations').set({
      status: 'applied', applied_branch: 'forward', applied_resource_id: 'sched-1',
      applied_version: 10, applied_hash: 'a'.repeat(64),
    })
      .where('cat_id', '=', 'cat-forward').execute();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    provider.writeBuild.mockImplementationOnce(async () => blocked);
    const first = reconciler.execute({ limit: 1, rateLimitMs: 0, workerId: 'worker-1' });
    await vi.waitFor(async () => {
      const row = await database.selectFrom('cat_task_reconciliations').select('status').where('cat_id', '=', 'cat-build').executeTakeFirstOrThrow();
      expect(row.status).toBe('provider_started');
    });
    const second = await reconciler.execute({ limit: 1, rateLimitMs: 0, workerId: 'worker-2' });
    expect(second.attempted).toBe(0);
    release();
    await expect(first).resolves.toMatchObject({ applied: 1, provider_writes: 1 });
    const row = await database.selectFrom('cat_task_reconciliations').select(['status', 'attempt_count', 'lease_epoch'])
      .where('cat_id', '=', 'cat-build').executeTakeFirstOrThrow();
    expect(row).toEqual({ status: 'applied', attempt_count: 1, lease_epoch: 1 });
  });

  it('defers a descriptor upgrade until the old provider write settles, then makes the new descriptor final', async () => {
    const { database, provider, writes, remote, reconciler, setDescriptor } = await fixture();
    await database.updateTable('cats').set({ travel_schedule_enabled: 0 })
      .where('id', '=', 'cat-forward').execute();
    await reconciler.plan({ limit: 10 });

    let announceStarted!: () => void;
    const started = new Promise<void>((resolve) => { announceStarted = resolve; });
    let releaseOldWrite!: () => void;
    const oldWriteBlocked = new Promise<void>((resolve) => { releaseOldWrite = resolve; });
    provider.writeBuild.mockImplementation(async (_credential, id, instruction) => {
      writes.push(`build:${id}:${instruction}`);
      announceStarted();
      await oldWriteBlocked;
      remote.set(id, instruction);
    });

    const oldExecute = reconciler.execute({ limit: 1, rateLimitMs: 0, workerId: 'worker-v10' });
    await started;
    setDescriptor(11, 'b'.repeat(64));
    const deferred = await reconciler.plan({ limit: 10 });
    expect(deferred).toMatchObject({
      newly_pending: 0, deferred_in_flight: 1, provider_settlement_required: 0,
    });
    const stillOld = await database.selectFrom('cat_task_reconciliations').selectAll()
      .where('cat_id', '=', 'cat-build').executeTakeFirstOrThrow();
    expect(stillOld).toMatchObject({
      desired_version: 10, desired_hash: 'a'.repeat(64), status: 'provider_started',
      lease_owner: 'worker-v10',
    });
    const noOvertake = await reconciler.execute({ limit: 1, rateLimitMs: 0, workerId: 'worker-v11-early' });
    expect(noOvertake).toMatchObject({ status: 'stale_rows', attempted: 0, provider_writes: 0 });

    releaseOldWrite();
    await expect(oldExecute).resolves.toMatchObject({ applied: 1, provider_writes: 1 });
    expect(remote.get('dep-1')).toBe('task-v10:建造猫');

    const upgraded = await reconciler.plan({ limit: 10 });
    expect(upgraded).toMatchObject({
      newly_pending: 1, deferred_in_flight: 0, provider_settlement_required: 0,
    });
    const final = await reconciler.execute({ limit: 1, rateLimitMs: 0, workerId: 'worker-v11-final' });
    expect(final).toMatchObject({ applied: 1, provider_writes: 1 });
    expect(remote.get('dep-1')).toBe('task-v11:建造猫');
    expect(writes).toEqual([
      'build:dep-1:task-v10:建造猫',
      'build:dep-1:task-v11:建造猫',
    ]);
  });

  it('requires explicit provider settlement instead of overtaking an uncertain old descriptor write', async () => {
    const { database, provider, writes, remote, reconciler, setDescriptor } = await fixture();
    await database.updateTable('cats').set({ travel_schedule_enabled: 0 })
      .where('id', '=', 'cat-forward').execute();
    await reconciler.plan({ limit: 10 });
    provider.writeBuild.mockImplementationOnce(async (_credential, id, instruction) => {
      writes.push(`build:${id}`);
      remote.set(id, instruction);
      throw Object.assign(new Error('response lost after provider accepted write'), { code: 'QCA_TEMPORARY_ERROR' });
    });
    const uncertain = await reconciler.execute({ limit: 1, rateLimitMs: 0, workerId: 'worker-v10-lost' });
    expect(uncertain.results[0]).toMatchObject({ status: 'provider_started', error_code: 'QCA_TEMPORARY_ERROR' });

    setDescriptor(11, 'b'.repeat(64));
    const deferred = await reconciler.plan({ limit: 10 });
    expect(deferred).toMatchObject({
      newly_pending: 0, deferred_in_flight: 1, provider_settlement_required: 1,
    });
    const noGuessing = await reconciler.execute({ limit: 1, rateLimitMs: 0, workerId: 'worker-v11-blocked' });
    expect(noGuessing).toMatchObject({ status: 'stale_rows', attempted: 0, provider_writes: 0 });
    expect(writes).toEqual(['build:dep-1']);
    expect(remote.get('dep-1')).toBe('task-v10:建造猫');
    const row = await database.selectFrom('cat_task_reconciliations').selectAll()
      .where('cat_id', '=', 'cat-build').executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      desired_version: 10, desired_hash: 'a'.repeat(64), status: 'provider_started', lease_owner: null,
    });
    await expect(reconciler.status()).resolves.toMatchObject({ provider_settlement_required: 1 });
  });

  it('reclaims an expired pre-provider lease without requiring remote settlement', async () => {
    const { database, writes, reconciler } = await fixture();
    await reconciler.plan({ limit: 10 });
    await database.updateTable('cat_task_reconciliations').set({
      status: 'applied', applied_branch: 'forward', applied_resource_id: 'sched-1',
      applied_version: 10, applied_hash: 'a'.repeat(64),
    }).where('cat_id', '=', 'cat-forward').execute();
    await database.updateTable('cat_task_reconciliations').set({
      status: 'leased', lease_owner: 'dead-before-provider', lease_epoch: 1,
      lease_expires_at: '2000-01-01T00:00:00.000Z', provider_started_at: null,
    }).where('cat_id', '=', 'cat-build').execute();

    const recovered = await reconciler.execute({ limit: 1, rateLimitMs: 0, workerId: 'safe-takeover' });
    expect(recovered).toMatchObject({ attempted: 1, applied: 1, provider_writes: 1 });
    expect(writes).toEqual(['build:dep-1']);
    const row = await database.selectFrom('cat_task_reconciliations').selectAll()
      .where('cat_id', '=', 'cat-build').executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      status: 'applied', lease_owner: null, provider_started_at: null,
      attempt_count: 1, lease_epoch: 2,
    });
  });

  it('upgrades an expired pre-provider lease directly to the new descriptor', async () => {
    const { database, writes, reconciler, setDescriptor } = await fixture();
    await database.updateTable('cats').set({ travel_schedule_enabled: 0 })
      .where('id', '=', 'cat-forward').execute();
    await reconciler.plan({ limit: 10 });
    await database.updateTable('cat_task_reconciliations').set({
      status: 'leased', lease_owner: 'dead-v10-before-provider', lease_epoch: 1,
      lease_expires_at: '2000-01-01T00:00:00.000Z', provider_started_at: null,
    }).where('cat_id', '=', 'cat-build').execute();
    setDescriptor(11, 'b'.repeat(64));

    const upgraded = await reconciler.plan({ limit: 10 });
    expect(upgraded).toMatchObject({
      newly_pending: 1, deferred_in_flight: 0, provider_settlement_required: 0,
    });
    const pending = await database.selectFrom('cat_task_reconciliations').selectAll()
      .where('cat_id', '=', 'cat-build').executeTakeFirstOrThrow();
    expect(pending).toMatchObject({
      desired_version: 11, desired_hash: 'b'.repeat(64), status: 'pending',
      lease_owner: null, provider_started_at: null,
    });
    const applied = await reconciler.execute({ limit: 1, rateLimitMs: 0, workerId: 'worker-v11-after-crash' });
    expect(applied).toMatchObject({ applied: 1, provider_writes: 1 });
    expect(writes).toEqual(['build:dep-1']);
  });

  it('never preempts a live pre-provider lease during a descriptor upgrade', async () => {
    const { database, reconciler, setDescriptor } = await fixture();
    await database.updateTable('cats').set({ travel_schedule_enabled: 0 })
      .where('id', '=', 'cat-forward').execute();
    await reconciler.plan({ limit: 10 });
    await database.updateTable('cat_task_reconciliations').set({
      status: 'leased', lease_owner: 'live-before-provider', lease_epoch: 1,
      lease_expires_at: '2999-01-01T00:00:00.000Z', provider_started_at: null,
    }).where('cat_id', '=', 'cat-build').execute();
    setDescriptor(11, 'b'.repeat(64));

    const deferred = await reconciler.plan({ limit: 10 });
    expect(deferred).toMatchObject({
      newly_pending: 0, deferred_in_flight: 1, provider_settlement_required: 0,
    });
    const row = await database.selectFrom('cat_task_reconciliations').selectAll()
      .where('cat_id', '=', 'cat-build').executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      desired_version: 10, desired_hash: 'a'.repeat(64), status: 'leased',
      lease_owner: 'live-before-provider', provider_started_at: null,
    });
    await expect(reconciler.status()).resolves.toMatchObject({ deferred_in_flight: 1 });
  });

  it('settles an expired readback takeover without any provider rewrite', async () => {
    const { database, writes, remote, reconciler } = await fixture();
    await reconciler.plan({ limit: 10 });
    await database.updateTable('cat_task_reconciliations').set({
      status: 'applied', applied_branch: 'forward', applied_resource_id: 'sched-1',
      applied_version: 10, applied_hash: 'a'.repeat(64),
    }).where('cat_id', '=', 'cat-forward').execute();
    await database.updateTable('cat_task_reconciliations').set({
      status: 'leased', lease_owner: 'dead-during-readback', lease_epoch: 2,
      lease_expires_at: '2000-01-01T00:00:00.000Z',
      provider_started_at: '2026-08-26T00:00:00.000Z',
    }).where('cat_id', '=', 'cat-build').execute();

    const unresolved = await reconciler.execute({ limit: 1, rateLimitMs: 0, workerId: 'settlement-readback-1' });
    expect(unresolved).toMatchObject({ attempted: 1, provider_writes: 0, provider_settlement_required: 1 });
    expect(unresolved.results[0]).toMatchObject({
      status: 'provider_settlement_required', error_code: 'TASK_PROVIDER_SETTLEMENT_REQUIRED',
    });
    expect(writes).toHaveLength(0);
    await expect(reconciler.status()).resolves.toMatchObject({ provider_settlement_required: 1 });

    remote.set('dep-1', 'task-v10:建造猫');
    const settled = await reconciler.execute({ limit: 1, rateLimitMs: 0, workerId: 'settlement-readback-2' });
    expect(settled).toMatchObject({ applied: 1, provider_writes: 0, provider_settlement_required: 0 });
    expect(writes).toHaveLength(0);
    const row = await database.selectFrom('cat_task_reconciliations').selectAll()
      .where('cat_id', '=', 'cat-build').executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'applied', provider_started_at: null, lease_owner: null });
  });

  it('settles an old descriptor by its persisted instruction hash before advancing the current descriptor', async () => {
    const { database, writes, remote, reconciler, setDescriptor } = await fixture();
    await database.updateTable('cats').set({ travel_schedule_enabled: 0 })
      .where('id', '=', 'cat-forward').execute();
    await reconciler.plan({ limit: 10 });
    const oldRow = await database.selectFrom('cat_task_reconciliations').selectAll()
      .where('cat_id', '=', 'cat-build').executeTakeFirstOrThrow();
    await database.updateTable('cat_task_reconciliations').set({
      status: 'leased', lease_owner: 'dead-v10-readback', lease_epoch: 2,
      lease_expires_at: '2000-01-01T00:00:00.000Z',
      provider_started_at: '2026-08-26T00:00:00.000Z',
    }).where('cat_id', '=', 'cat-build').execute();
    remote.set('dep-1', 'task-v10:建造猫');
    setDescriptor(11, 'b'.repeat(64));

    const deferred = await reconciler.plan({ limit: 10 });
    expect(deferred).toMatchObject({
      newly_pending: 0, deferred_in_flight: 1, provider_settlement_required: 1,
    });
    const settledOld = await reconciler.execute({ limit: 1, rateLimitMs: 0, workerId: 'settle-v10-under-v11' });
    expect(settledOld).toMatchObject({ applied: 1, provider_writes: 0 });
    expect(writes).toHaveLength(0);
    const settledRow = await database.selectFrom('cat_task_reconciliations').selectAll()
      .where('cat_id', '=', 'cat-build').executeTakeFirstOrThrow();
    expect(settledRow).toMatchObject({
      desired_version: 10, desired_hash: 'a'.repeat(64),
      desired_instruction_hash: oldRow.desired_instruction_hash,
      applied_version: 10, applied_instruction_hash: oldRow.desired_instruction_hash,
      status: 'applied', provider_started_at: null,
    });

    const upgraded = await reconciler.plan({ limit: 10 });
    expect(upgraded).toMatchObject({ newly_pending: 1, provider_settlement_required: 0 });
    const appliedNew = await reconciler.execute({ limit: 1, rateLimitMs: 0, workerId: 'write-v11-after-settlement' });
    expect(appliedNew).toMatchObject({ applied: 1, provider_writes: 1 });
    expect(writes).toEqual(['build:dep-1']);
    expect(remote.get('dep-1')).toBe('task-v11:建造猫');
  });

  it('cannot close an old worker after its descriptor/resource snapshot is replaced', async () => {
    const { database, provider, remote, reconciler } = await fixture();
    await database.updateTable('cats').set({ travel_schedule_enabled: 0 })
      .where('id', '=', 'cat-forward').execute();
    await reconciler.plan({ limit: 10 });
    let announceStarted!: () => void;
    const started = new Promise<void>((resolve) => { announceStarted = resolve; });
    let releaseWrite!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseWrite = resolve; });
    provider.writeBuild.mockImplementationOnce(async (_credential, id, instruction) => {
      announceStarted();
      await blocked;
      remote.set(id, instruction);
    });
    const oldExecute = reconciler.execute({ limit: 1, rateLimitMs: 0, workerId: 'worker-old-snapshot' });
    await started;
    await database.updateTable('cat_task_reconciliations').set({
      desired_version: 11, desired_hash: 'b'.repeat(64), target_resource_id: 'dep-replaced',
    }).where('cat_id', '=', 'cat-build').execute();
    releaseWrite();
    const stale = await oldExecute;
    expect(stale.results[0]).toMatchObject({ status: 'lease_lost', error_code: 'TASK_LEASE_LOST' });
    const row = await database.selectFrom('cat_task_reconciliations').selectAll()
      .where('cat_id', '=', 'cat-build').executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      desired_version: 11, desired_hash: 'b'.repeat(64), target_resource_id: 'dep-replaced',
      status: 'provider_started', applied_version: null, applied_hash: null,
    });
  });

  it('invalidates an applied Build target when the cat migrates to Forward', async () => {
    const { database, writes, reconciler } = await fixture();
    await reconciler.plan({ limit: 10 });
    await reconciler.execute({ limit: 10, rateLimitMs: 0 });
    await database.updateTable('cats').set({
      qca_forward_schedule_id: 'sched-migrated',
      qca_forward_travel_template_id: 'tmpl-migrated',
      qca_forward_identity_id: 'identity-migrated',
    }).where('id', '=', 'cat-build').execute();

    const changed = await reconciler.plan({ limit: 10 });
    expect(changed.newly_pending).toBe(1);
    const pending = await database.selectFrom('cat_task_reconciliations').selectAll()
      .where('cat_id', '=', 'cat-build').executeTakeFirstOrThrow();
    expect(pending).toMatchObject({
      branch: 'forward', target_resource_id: 'sched-migrated', status: 'pending',
      applied_branch: 'build', applied_resource_id: 'dep-1', applied_hash: 'a'.repeat(64),
    });
    await reconciler.execute({ limit: 1, rateLimitMs: 0 });
    expect(writes).toContain('forward:sched-migrated');
  });

  it('invalidates an applied Forward target when repair replaces its schedule', async () => {
    const { database, writes, reconciler } = await fixture();
    await reconciler.plan({ limit: 10 });
    await reconciler.execute({ limit: 10, rateLimitMs: 0 });
    await database.updateTable('cats').set({ qca_forward_schedule_id: 'sched-repaired' })
      .where('id', '=', 'cat-forward').execute();

    const changed = await reconciler.plan({ limit: 10 });
    expect(changed.newly_pending).toBe(1);
    await reconciler.execute({ limit: 1, rateLimitMs: 0 });
    expect(writes).toContain('forward:sched-repaired');
    const applied = await database.selectFrom('cat_task_reconciliations').selectAll()
      .where('cat_id', '=', 'cat-forward').executeTakeFirstOrThrow();
    expect(applied).toMatchObject({
      status: 'applied', branch: 'forward', target_resource_id: 'sched-repaired',
      applied_branch: 'forward', applied_resource_id: 'sched-repaired',
    });
  });

  it('fails closed before provider access when a resource changes after plan', async () => {
    const { database, provider, writes, reconciler } = await fixture();
    await reconciler.plan({ limit: 10 });
    await database.updateTable('cats').set({ qca_deployment_id: 'dep-repaired' })
      .where('id', '=', 'cat-build').execute();

    const result = await reconciler.execute({ limit: 1, rateLimitMs: 0, workerId: 'stale-plan' });
    expect(result.results[0]).toMatchObject({ status: 'retryable', error_code: 'TASK_PLAN_REQUIRED' });
    expect(writes).toHaveLength(0);
    expect(provider.getCredential).not.toHaveBeenCalled();
  });

  it('fails closed before provider access when per-cat rendered instruction changes after plan', async () => {
    const { database, provider, writes, reconciler } = await fixture();
    await reconciler.plan({ limit: 10 });
    await database.updateTable('cats').set({ name: '改名后的猫' })
      .where('id', '=', 'cat-build').execute();

    const result = await reconciler.execute({ limit: 1, rateLimitMs: 0, workerId: 'stale-render' });
    expect(result.results[0]).toMatchObject({ status: 'retryable', error_code: 'TASK_PLAN_REQUIRED' });
    expect(writes).toHaveLength(0);
    expect(provider.getCredential).not.toHaveBeenCalled();
  });

  it('fails closed before provider access when YAML changes without a new plan', async () => {
    const { provider, writes, reconciler, setDescriptor } = await fixture();
    await reconciler.plan({ limit: 10 });
    setDescriptor(11, 'b'.repeat(64));

    const result = await reconciler.execute({ limit: 1, rateLimitMs: 0, workerId: 'old-descriptor' });
    expect(result).toMatchObject({
      status: 'plan_required', error_code: 'TASK_PLAN_REQUIRED', attempted: 0, provider_writes: 0,
    });
    expect(writes).toHaveLength(0);
    expect(provider.getCredential).not.toHaveBeenCalled();
  });

  it('does not let an older pending descriptor starve current planned rows', async () => {
    const { database, provider, reconciler } = await fixture();
    await reconciler.plan({ limit: 10 });
    await database.insertInto('cat_task_reconciliations').values({
      cat_id: 'cat-inactive', task_id: reconciliation.DAILY_TRAVEL_TASK_ID,
      branch: 'build', target_resource_id: 'dep-2', desired_version: 9, desired_hash: '9'.repeat(64),
      desired_instruction_hash: '8'.repeat(64),
      applied_branch: null, applied_resource_id: null, applied_version: null, applied_hash: null,
      applied_instruction_hash: null,
      status: 'pending', attempt_count: 0, error_code: null, lease_owner: null,
      lease_epoch: 0, lease_expires_at: null, provider_started_at: null, applied_at: null,
      next_attempt_at: null, created_at: '2000-01-01T00:00:00.000Z', updated_at: '2000-01-01T00:00:00.000Z',
    }).execute();

    const current = await reconciler.execute({ limit: 1, rateLimitMs: 0, workerId: 'current-only' });
    expect(current).toMatchObject({ status: 'executed', attempted: 1, applied: 1, stale_rows: 1 });
    expect(current.results[0]?.cat_id).not.toBe('cat-inactive');
    await database.updateTable('cat_task_reconciliations').set({
      status: 'applied', applied_branch: 'build', applied_resource_id: 'dep-1',
      applied_version: 10, applied_hash: 'a'.repeat(64),
    }).where('cat_id', '=', 'cat-build').execute();
    await database.updateTable('cat_task_reconciliations').set({
      status: 'applied', applied_branch: 'forward', applied_resource_id: 'sched-1',
      applied_version: 10, applied_hash: 'a'.repeat(64),
    }).where('cat_id', '=', 'cat-forward').execute();
    const onlyStale = await reconciler.execute({ limit: 10, rateLimitMs: 0, workerId: 'stale-only' });
    expect(onlyStale).toMatchObject({
      status: 'stale_rows', error_code: 'TASK_PLAN_REQUIRED', attempted: 0, stale_rows: 1,
    });
    expect(provider.getCredential).toHaveBeenCalledTimes(1);
  });

  it('requires a current plan when the cursor is missing', async () => {
    const { provider, reconciler } = await fixture();
    const result = await reconciler.execute({ limit: 10, rateLimitMs: 0 });
    expect(result).toMatchObject({
      status: 'plan_required', error_code: 'TASK_PLAN_REQUIRED', attempted: 0, provider_writes: 0,
    });
    expect(provider.getCredential).not.toHaveBeenCalled();
  });

  it('rechecks the descriptor after claim and before provider access', async () => {
    let drift = false;
    const { provider, reconciler, setDescriptor } = await fixture({
      afterClaimLock: () => {
        if (!drift) {
          drift = true;
          setDescriptor(11, 'b'.repeat(64));
        }
      },
    });
    await reconciler.plan({ limit: 10 });
    const result = await reconciler.execute({ limit: 1, rateLimitMs: 0, workerId: 'mid-run-drift' });
    expect(result.results[0]).toMatchObject({ status: 'retryable', error_code: 'TASK_PLAN_REQUIRED' });
    expect(provider.getCredential).not.toHaveBeenCalled();
  });
});
