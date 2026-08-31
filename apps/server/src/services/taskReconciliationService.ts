import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { Kysely, Transaction } from 'kysely';
import { config } from '../config.js';
import { db } from '../db/index.js';
import type { DatabaseSchema } from '../db/schema.js';
import { getRepoRoot, renderDailyTravelTask } from '../lib/templates.js';
import { getPatForUser } from './catService.js';
import {
  readDeploymentTaskInstruction,
  updateDeploymentTaskInstruction,
  type QcaCredential,
} from './qca.js';
import {
  readForwardTravelScheduleTask,
  updateForwardTravelScheduleTask,
} from './qcaForwardService.js';

export const DAILY_TRAVEL_TASK_ID = 'cat.daily-travel';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_LEASE_SECONDS = 120;
const MAX_LEASE_SECONDS = 600;

type Db = Kysely<DatabaseSchema>;
type Tx = Transaction<DatabaseSchema>;
type Branch = 'build' | 'forward';
type FencedPatch = {
  branch?: string;
  target_resource_id?: string;
  status?: string;
  applied_branch?: string | null;
  applied_resource_id?: string | null;
  applied_version?: number | null;
  applied_hash?: string | null;
  applied_instruction_hash?: string | null;
  error_code?: string | null;
  lease_owner?: string | null;
  lease_expires_at?: string | null;
  provider_started_at?: string | null;
  applied_at?: string | null;
  next_attempt_at?: string | null;
  updated_at?: string;
};

type ClaimFence = {
  cat_id: string;
  task_id: string;
  lease_owner: string;
  lease_epoch: number;
  desired_version: number;
  desired_hash: string;
  desired_instruction_hash: string;
  branch: string;
  target_resource_id: string;
};

export type TaskDescriptor = {
  id: typeof DAILY_TRAVEL_TASK_ID;
  version: number;
  hash: string;
};

export type TaskReconcileProvider = {
  getCredential(userId: string): Promise<QcaCredential | null>;
  readBuild(credential: QcaCredential, resourceId: string): Promise<string | null>;
  writeBuild(credential: QcaCredential, resourceId: string, instruction: string): Promise<void>;
  readForward(credential: QcaCredential, resourceId: string): Promise<string | null>;
  writeForward(credential: QcaCredential, resourceId: string, instruction: string): Promise<void>;
};

export type TaskReconcileTestHooks = {
  afterClaimLock?: (claim: { catId: string; workerId: string }) => void | Promise<void>;
};

const defaultProvider: TaskReconcileProvider = {
  getCredential: getPatForUser,
  readBuild: readDeploymentTaskInstruction,
  writeBuild: updateDeploymentTaskInstruction,
  readForward: readForwardTravelScheduleTask,
  writeForward: updateForwardTravelScheduleTask,
};

function boundedLimit(value?: number) {
  return Number.isInteger(value) ? Math.min(Math.max(value!, 1), MAX_LIMIT) : DEFAULT_LIMIT;
}

function isoAfter(seconds: number) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

export function loadDailyTravelTaskDescriptor(repoRoot = getRepoRoot()): TaskDescriptor {
  const taskPath = path.join(repoRoot, 'tasks/cat/daily-travel.yaml');
  const raw = fs.readFileSync(taskPath, 'utf8');
  const parsed = yaml.load(raw) as { id?: unknown; version?: unknown } | null;
  if (parsed?.id !== DAILY_TRAVEL_TASK_ID || !Number.isInteger(parsed.version) || Number(parsed.version) < 1) {
    throw Object.assign(new Error('daily-travel task id/version 无效'), { code: 'TASK_DEFINITION_INVALID' });
  }
  return {
    id: DAILY_TRAVEL_TASK_ID,
    version: Number(parsed.version),
    hash: createHash('sha256').update(raw).digest('hex'),
  };
}

function taskErrorCode(error: unknown) {
  const candidate = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const allowed = new Set([
    'NO_PAT', 'TASK_RESOURCE_MISSING', 'TASK_LEASE_LOST', 'TASK_DEFINITION_INVALID',
    'TASK_PLAN_REQUIRED', 'TASK_PROVIDER_SETTLEMENT_REQUIRED',
    'QCA_PAT_INVALID', 'QCA_PERMISSION_DENIED', 'QCA_TEMPORARY_ERROR', 'QCA_API_ERROR',
    'QCA_CREDITS_UNAVAILABLE',
  ]);
  return allowed.has(candidate) ? candidate : 'TASK_PROVIDER_ERROR';
}

function providerBoundaryError(error: unknown) {
  return Object.assign(new Error('task provider operation did not reach a fenced terminal state'), {
    code: taskErrorCode(error),
    provider_started: true,
    provider_write_started: true,
  });
}

function crossedProviderBoundary(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'provider_started' in error && error.provider_started === true);
}

function providerWriteStarted(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'provider_write_started' in error && error.provider_write_started === true);
}

function isEligibleCat(cat: {
  status: string; lifecycle_stage: string; travel_schedule_enabled: number;
  qca_forward_schedule_id: string | null; qca_deployment_id: string | null;
}) {
  return cat.status === 'active'
    && cat.travel_schedule_enabled === 1
    && ['scheduled', 'world'].includes(cat.lifecycle_stage)
    && Boolean(cat.qca_forward_schedule_id || cat.qca_deployment_id);
}

function branchForCat(cat: { qca_forward_schedule_id: string | null }): Branch {
  return cat.qca_forward_schedule_id ? 'forward' : 'build';
}

function targetForCat(cat: {
  qca_forward_schedule_id: string | null;
  qca_deployment_id: string | null;
}) {
  const branch = branchForCat(cat);
  const resourceId = branch === 'forward' ? cat.qca_forward_schedule_id : cat.qca_deployment_id;
  return { branch, resourceId };
}

function taskPlanRequired(message: string) {
  return Object.assign(new Error(message), { code: 'TASK_PLAN_REQUIRED' });
}

async function lockCursor(trx: Tx, task: TaskDescriptor, dialect: 'sqlite' | 'postgres') {
  await trx.insertInto('task_reconcile_cursors').values({
    task_id: task.id,
    desired_version: task.version,
    desired_hash: task.hash,
    cursor_cat_id: null,
  }).onConflict((oc) => oc.column('task_id').doNothing()).execute();
  let query = trx.selectFrom('task_reconcile_cursors').selectAll().where('task_id', '=', task.id);
  if (dialect === 'postgres') query = query.forUpdate();
  return query.executeTakeFirstOrThrow();
}

export function createTaskReconciler(
  database: Db = db,
  provider: TaskReconcileProvider = defaultProvider,
  dialect: 'sqlite' | 'postgres' = config.dbDialect,
  taskLoader: () => TaskDescriptor = loadDailyTravelTaskDescriptor,
  renderInstruction: (catName: string, serverUrl: string) => string = renderDailyTravelTask,
  testHooks: TaskReconcileTestHooks = {},
) {
  async function plan(options: { limit?: number } = {}) {
    const task = taskLoader();
    const limit = boundedLimit(options.limit);
    return database.transaction().execute(async (trx) => {
      let cursor = await lockCursor(trx, task, dialect);
      if (cursor.desired_version !== task.version || cursor.desired_hash !== task.hash) {
        await trx.updateTable('task_reconcile_cursors').set({
          desired_version: task.version,
          desired_hash: task.hash,
          cursor_cat_id: null,
          scan_epoch: cursor.scan_epoch + 1,
          updated_at: new Date().toISOString(),
        }).where('task_id', '=', task.id).execute();
        cursor = { ...cursor, desired_version: task.version, desired_hash: task.hash, cursor_cat_id: null, scan_epoch: cursor.scan_epoch + 1 };
      }

      let catsQuery = trx.selectFrom('cats').select([
        'id', 'name', 'status', 'lifecycle_stage', 'travel_schedule_enabled',
        'qca_forward_schedule_id', 'qca_deployment_id',
      ]).where('status', '=', 'active')
        .where('travel_schedule_enabled', '=', 1)
        .where('lifecycle_stage', 'in', ['scheduled', 'world'])
        .where((eb) => eb.or([
          eb('qca_forward_schedule_id', 'is not', null),
          eb('qca_deployment_id', 'is not', null),
        ]))
        .orderBy('id', 'asc')
        .limit(limit);
      if (cursor.cursor_cat_id) catsQuery = catsQuery.where('id', '>', cursor.cursor_cat_id);
      const cats = await catsQuery.execute();

      let newlyPending = 0;
      let deferredInFlight = 0;
      let providerSettlementRequired = 0;
      const now = new Date().toISOString();
      for (const cat of cats) {
        const existing = await trx.selectFrom('cat_task_reconciliations').selectAll()
          .where('cat_id', '=', cat.id).where('task_id', '=', task.id).executeTakeFirst();
        const { branch, resourceId } = targetForCat(cat);
        if (!resourceId) continue;
        const desiredInstructionHash = sha256(renderInstruction(cat.name, config.catApiPublicUrl));
        if (!existing) {
          await trx.insertInto('cat_task_reconciliations').values({
            cat_id: cat.id, task_id: task.id, branch, target_resource_id: resourceId,
            desired_version: task.version, desired_hash: task.hash,
            desired_instruction_hash: desiredInstructionHash,
            applied_branch: null, applied_resource_id: null,
            applied_version: null, applied_hash: null, applied_instruction_hash: null,
            status: 'pending', error_code: null,
            lease_owner: null, lease_expires_at: null, provider_started_at: null,
            applied_at: null, next_attempt_at: null,
          }).execute();
          newlyPending += 1;
        } else {
          const targetChanged = existing.desired_version !== task.version
            || existing.desired_hash !== task.hash
            || existing.desired_instruction_hash !== desiredInstructionHash
            || existing.branch !== branch
            || existing.target_resource_id !== resourceId;
          const leaseActive = Boolean(existing.lease_expires_at && existing.lease_expires_at > now);
          const providerUncertain = existing.status === 'provider_started'
            || Boolean(existing.provider_started_at);

          // A provider operation cannot be cancelled once sent. Never let a new
          // descriptor/target overtake a live lease. Once the lease expires, a
          // row that never crossed provider_started is safe to reclaim/upgrade;
          // an uncertain provider result is readback/settlement-only.
          if ((existing.status === 'leased' || existing.status === 'provider_started') && leaseActive) {
            deferredInFlight += 1;
            continue;
          }
          if ((existing.status === 'leased' || existing.status === 'provider_started') && providerUncertain) {
            providerSettlementRequired += 1;
            if (targetChanged) deferredInFlight += 1;
            continue;
          }
          if (targetChanged) {
            await trx.updateTable('cat_task_reconciliations').set({
              branch, target_resource_id: resourceId,
              desired_version: task.version, desired_hash: task.hash,
              desired_instruction_hash: desiredInstructionHash,
              status: 'pending', error_code: null, lease_owner: null, lease_expires_at: null,
              provider_started_at: null, next_attempt_at: null, updated_at: new Date().toISOString(),
            }).where('cat_id', '=', cat.id).where('task_id', '=', task.id).execute();
            newlyPending += 1;
          } else if (existing.status === 'ineligible') {
            await trx.updateTable('cat_task_reconciliations').set({
              branch, target_resource_id: resourceId,
              status: existing.applied_hash === task.hash
                && existing.applied_instruction_hash === desiredInstructionHash
                && existing.applied_branch === branch
                && existing.applied_resource_id === resourceId ? 'applied' : 'pending',
              error_code: null, next_attempt_at: null, updated_at: new Date().toISOString(),
            }).where('cat_id', '=', cat.id).where('task_id', '=', task.id).execute();
            if (
              existing.applied_hash !== task.hash
              || existing.applied_instruction_hash !== desiredInstructionHash
              || existing.applied_branch !== branch
              || existing.applied_resource_id !== resourceId
            ) newlyPending += 1;
          }
        }
      }

      const scanComplete = cats.length < limit;
      const nextCursor = scanComplete ? null : cats.at(-1)?.id ?? cursor.cursor_cat_id;
      await trx.updateTable('task_reconcile_cursors').set({
        cursor_cat_id: nextCursor,
        updated_at: new Date().toISOString(),
      }).where('task_id', '=', task.id).execute();
      return {
        task_id: task.id, desired_version: task.version, desired_hash: task.hash,
        scan_epoch: cursor.scan_epoch, scanned: cats.length, newly_pending: newlyPending,
        deferred_in_flight: deferredInFlight,
        provider_settlement_required: providerSettlementRequired,
        next_cursor: nextCursor, scan_complete: scanComplete,
      };
    });
  }

  async function claim(
    workerId: string,
    leaseSeconds: number,
    task: TaskDescriptor | null,
    mode: 'write' | 'settlement',
  ) {
    const now = new Date().toISOString();
    return database.transaction().execute(async (trx) => {
      let query = trx.selectFrom('cat_task_reconciliations').selectAll()
        .where('task_id', '=', task?.id ?? DAILY_TRAVEL_TASK_ID)
        .where((eb) => eb.or([
          eb('applied_hash', 'is', null),
          eb('applied_hash', '!=', eb.ref('desired_hash')),
          eb('applied_instruction_hash', 'is', null),
          eb('applied_instruction_hash', '!=', eb.ref('desired_instruction_hash')),
          eb('applied_branch', 'is', null),
          eb('applied_branch', '!=', eb.ref('branch')),
          eb('applied_resource_id', 'is', null),
          eb('applied_resource_id', '!=', eb.ref('target_resource_id')),
        ]))
        .where((eb) => eb.or([eb('next_attempt_at', 'is', null), eb('next_attempt_at', '<=', now)]))
        .where((eb) => eb.or([eb('lease_expires_at', 'is', null), eb('lease_expires_at', '<=', now)]))
        .orderBy('updated_at', 'asc').orderBy('cat_id', 'asc').limit(1);
      if (mode === 'write') {
        if (!task) throw taskPlanRequired('write claim 必须绑定当前 task descriptor');
        query = query.where('desired_version', '=', task.version)
          .where('desired_hash', '=', task.hash)
          .where((eb) => eb.or([
            eb('status', 'in', ['pending', 'retryable']),
            eb.and([eb('status', '=', 'leased'), eb('provider_started_at', 'is', null)]),
          ]));
      } else {
        query = query.where((eb) => eb.or([
          eb('status', '=', 'provider_started'),
          eb.and([eb('status', '=', 'leased'), eb('provider_started_at', 'is not', null)]),
        ]));
      }
      if (dialect === 'postgres') query = query.forUpdate().skipLocked();
      const row = await query.executeTakeFirst();
      if (!row) return null;
      await testHooks.afterClaimLock?.({ catId: row.cat_id, workerId });
      const epoch = row.lease_epoch + 1;
      const result = await trx.updateTable('cat_task_reconciliations').set({
        status: 'leased', lease_owner: workerId, lease_epoch: epoch,
        lease_expires_at: isoAfter(leaseSeconds), attempt_count: row.attempt_count + 1,
        error_code: null, updated_at: now,
      }).where('cat_id', '=', row.cat_id).where('task_id', '=', row.task_id)
        .where('lease_epoch', '=', row.lease_epoch).executeTakeFirst();
      return Number(result.numUpdatedRows) === 1
        ? { ...row, lease_owner: workerId, lease_epoch: epoch, claim_mode: mode }
        : null;
    });
  }

  async function fencedSet(
    row: ClaimFence,
    values: FencedPatch,
  ) {
    const result = await database.updateTable('cat_task_reconciliations').set(values)
      .where('cat_id', '=', row.cat_id).where('task_id', '=', row.task_id)
      .where('lease_owner', '=', row.lease_owner).where('lease_epoch', '=', row.lease_epoch)
      .where('desired_version', '=', row.desired_version).where('desired_hash', '=', row.desired_hash)
      .where('desired_instruction_hash', '=', row.desired_instruction_hash)
      .where('branch', '=', row.branch).where('target_resource_id', '=', row.target_resource_id)
      .where('lease_expires_at', '>', new Date().toISOString()).executeTakeFirst();
    if (Number(result.numUpdatedRows) !== 1) {
      throw Object.assign(new Error('task reconciliation lease 已失效'), { code: 'TASK_LEASE_LOST' });
    }
  }

  async function validateClaimTarget(
    row: NonNullable<Awaited<ReturnType<typeof claim>>>,
    expectedTask: TaskDescriptor,
    options: { markProviderStarted: boolean; expectedUserId?: string; expectedInstructionHash?: string }
      = { markProviderStarted: false },
  ) {
    const currentTask = taskLoader();
    if (currentTask.id !== expectedTask.id
      || currentTask.version !== expectedTask.version
      || currentTask.hash !== expectedTask.hash
      || row.task_id !== expectedTask.id
      || row.desired_version !== expectedTask.version
      || row.desired_hash !== expectedTask.hash) {
      throw taskPlanRequired('仓库任务已变化，必须先重新 plan');
    }
    return database.transaction().execute(async (trx) => {
      let reconcileQuery = trx.selectFrom('cat_task_reconciliations').selectAll()
        .where('cat_id', '=', row.cat_id).where('task_id', '=', row.task_id);
      if (dialect === 'postgres') reconcileQuery = reconcileQuery.forUpdate();
      const current = await reconcileQuery.executeTakeFirst();
      const now = new Date().toISOString();
      if (!current
        || current.lease_owner !== row.lease_owner
        || current.lease_epoch !== row.lease_epoch
        || !current.lease_expires_at
        || current.lease_expires_at <= now
        || current.desired_version !== row.desired_version
        || current.desired_hash !== row.desired_hash
        || current.desired_instruction_hash !== row.desired_instruction_hash
        || current.branch !== row.branch
        || current.target_resource_id !== row.target_resource_id) {
        throw Object.assign(new Error('task reconciliation lease 已失效'), { code: 'TASK_LEASE_LOST' });
      }

      let catQuery = trx.selectFrom('cats').select([
        'id', 'user_id', 'name', 'status', 'lifecycle_stage', 'travel_schedule_enabled',
        'qca_forward_schedule_id', 'qca_deployment_id',
      ]).where('id', '=', row.cat_id);
      if (dialect === 'postgres') catQuery = catQuery.forUpdate();
      const cat = await catQuery.executeTakeFirst();
      if (!cat || !isEligibleCat(cat)) return null;
      const { branch, resourceId } = targetForCat(cat);
      if (!resourceId
        || branch !== current.branch
        || resourceId !== current.target_resource_id
        || (options.expectedUserId && cat.user_id !== options.expectedUserId)) {
        throw taskPlanRequired('猫的 QCA 资源已变化，必须先重新 plan');
      }
      if (options.expectedInstructionHash
        && sha256(renderInstruction(cat.name, config.catApiPublicUrl)) !== options.expectedInstructionHash) {
        throw taskPlanRequired('猫任务渲染结果已变化，必须先重新 plan');
      }
      if (options.markProviderStarted) {
        const result = await trx.updateTable('cat_task_reconciliations').set({
          status: 'provider_started', provider_started_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).where('cat_id', '=', row.cat_id).where('task_id', '=', row.task_id)
          .where('lease_owner', '=', row.lease_owner).where('lease_epoch', '=', row.lease_epoch)
          .where('desired_version', '=', row.desired_version).where('desired_hash', '=', row.desired_hash)
          .where('desired_instruction_hash', '=', row.desired_instruction_hash)
          .where('branch', '=', row.branch).where('target_resource_id', '=', row.target_resource_id)
          .where('lease_expires_at', '>', now).executeTakeFirst();
        if (Number(result.numUpdatedRows) !== 1) {
          throw Object.assign(new Error('task reconciliation lease 已失效'), { code: 'TASK_LEASE_LOST' });
        }
      }
      return { cat, branch, resourceId };
    });
  }

  async function validateSettlementClaim(row: NonNullable<Awaited<ReturnType<typeof claim>>>) {
    return database.transaction().execute(async (trx) => {
      let reconcileQuery = trx.selectFrom('cat_task_reconciliations').selectAll()
        .where('cat_id', '=', row.cat_id).where('task_id', '=', row.task_id);
      if (dialect === 'postgres') reconcileQuery = reconcileQuery.forUpdate();
      const current = await reconcileQuery.executeTakeFirst();
      const now = new Date().toISOString();
      if (!current
        || current.lease_owner !== row.lease_owner
        || current.lease_epoch !== row.lease_epoch
        || !current.lease_expires_at
        || current.lease_expires_at <= now
        || current.desired_version !== row.desired_version
        || current.desired_hash !== row.desired_hash
        || current.desired_instruction_hash !== row.desired_instruction_hash
        || current.branch !== row.branch
        || current.target_resource_id !== row.target_resource_id
        || !current.provider_started_at
        || !['build', 'forward'].includes(current.branch)) {
        throw Object.assign(new Error('task settlement lease 已失效'), { code: 'TASK_LEASE_LOST' });
      }
      const cat = await trx.selectFrom('cats').select(['id', 'user_id'])
        .where('id', '=', row.cat_id).executeTakeFirst();
      if (!cat) throw Object.assign(new Error('task settlement cat 不存在'), { code: 'TASK_RESOURCE_MISSING' });
      return {
        userId: cat.user_id,
        branch: current.branch as Branch,
        resourceId: current.target_resource_id,
      };
    });
  }

  async function processSettlementClaim(row: NonNullable<Awaited<ReturnType<typeof claim>>>) {
    const fence = {
      cat_id: row.cat_id, task_id: row.task_id,
      lease_owner: row.lease_owner, lease_epoch: row.lease_epoch,
      desired_version: row.desired_version, desired_hash: row.desired_hash,
      desired_instruction_hash: row.desired_instruction_hash,
      branch: row.branch, target_resource_id: row.target_resource_id,
    };
    const target = await validateSettlementClaim(row);
    const credential = await provider.getCredential(target.userId);
    if (!credential) throw Object.assign(new Error('task settlement 没有可用 PAT'), { code: 'NO_PAT' });
    const current = target.branch === 'forward'
      ? await provider.readForward(credential, target.resourceId)
      : await provider.readBuild(credential, target.resourceId);
    if (current !== null && sha256(current) === row.desired_instruction_hash) {
      await fencedSet(fence, {
        branch: target.branch, target_resource_id: target.resourceId,
        status: 'applied', applied_branch: target.branch, applied_resource_id: target.resourceId,
        applied_version: row.desired_version, applied_hash: row.desired_hash,
        applied_instruction_hash: row.desired_instruction_hash,
        applied_at: new Date().toISOString(), error_code: null,
        lease_owner: null, lease_expires_at: null, provider_started_at: null,
        next_attempt_at: null, updated_at: new Date().toISOString(),
      });
      return { cat_id: row.cat_id, status: 'applied' as const, wrote_provider: false };
    }
    await fencedSet(fence, {
      status: 'provider_started', error_code: 'TASK_PROVIDER_SETTLEMENT_REQUIRED',
      lease_owner: null, lease_expires_at: null, next_attempt_at: null,
      updated_at: new Date().toISOString(),
    });
    return {
      cat_id: row.cat_id, status: 'provider_settlement_required' as const,
      error_code: 'TASK_PROVIDER_SETTLEMENT_REQUIRED' as const, wrote_provider: false,
    };
  }

  async function processClaim(row: NonNullable<Awaited<ReturnType<typeof claim>>>, task: TaskDescriptor) {
    if (row.claim_mode === 'settlement') return processSettlementClaim(row);
    const fence = {
      cat_id: row.cat_id, task_id: row.task_id,
      lease_owner: row.lease_owner, lease_epoch: row.lease_epoch,
      desired_version: row.desired_version, desired_hash: row.desired_hash,
      desired_instruction_hash: row.desired_instruction_hash,
      branch: row.branch, target_resource_id: row.target_resource_id,
    };
    let target = await validateClaimTarget(row, task);
    if (!target) {
      await fencedSet(fence, {
        status: 'ineligible', error_code: 'TASK_RESOURCE_MISSING', lease_owner: null,
        lease_expires_at: null, next_attempt_at: null, updated_at: new Date().toISOString(),
      });
      return { cat_id: row.cat_id, status: 'ineligible' as const, wrote_provider: false };
    }
    let instruction = renderInstruction(target.cat.name, config.catApiPublicUrl);
    if (sha256(instruction) !== row.desired_instruction_hash) {
      throw taskPlanRequired('猫任务渲染结果已变化，必须先重新 plan');
    }
    const credential = await provider.getCredential(target.cat.user_id);
    if (!credential) throw Object.assign(new Error('active cat 没有可用 PAT'), { code: 'NO_PAT' });

    // The target validation and provider_started transition share one database
    // transaction. A concurrent repair is therefore ordered either before this
    // boundary (and fails closed with TASK_PLAN_REQUIRED) or after it (and
    // invalidates this lease when the next plan records the replacement).
    target = await validateClaimTarget(row, task, {
      markProviderStarted: true,
      expectedUserId: target.cat.user_id,
      expectedInstructionHash: row.desired_instruction_hash,
    });
    if (!target) throw taskPlanRequired('猫已不再满足任务对账条件，必须先重新 plan');
    instruction = renderInstruction(target.cat.name, config.catApiPublicUrl);
    try {
      if (target.branch === 'forward') await provider.writeForward(credential, target.resourceId, instruction);
      else await provider.writeBuild(credential, target.resourceId, instruction);
      await fencedSet(fence, {
        branch: target.branch, target_resource_id: target.resourceId,
        status: 'applied', applied_branch: target.branch, applied_resource_id: target.resourceId,
        applied_version: row.desired_version, applied_hash: row.desired_hash,
        applied_instruction_hash: row.desired_instruction_hash,
        applied_at: new Date().toISOString(), error_code: null, lease_owner: null,
        lease_expires_at: null, provider_started_at: null, next_attempt_at: null,
        updated_at: new Date().toISOString(),
      });
    } catch (error) {
      throw providerBoundaryError(error);
    }
    return { cat_id: row.cat_id, status: 'applied' as const, wrote_provider: true };
  }

  async function failClaim(
    row: NonNullable<Awaited<ReturnType<typeof claim>>>,
    error: unknown,
    providerStarted = Boolean(row.provider_started_at) || crossedProviderBoundary(error),
  ) {
    const code = taskErrorCode(error);
    const delay = Math.min(3600, 2 ** Math.min(row.attempt_count, 8) * 15);
    const result = await database.updateTable('cat_task_reconciliations').set({
      status: providerStarted ? 'provider_started' : 'retryable',
      error_code: code, lease_owner: null, lease_expires_at: null,
      next_attempt_at: isoAfter(delay), updated_at: new Date().toISOString(),
    }).where('cat_id', '=', row.cat_id).where('task_id', '=', row.task_id)
      .where('lease_owner', '=', row.lease_owner).where('lease_epoch', '=', row.lease_epoch)
      .where('desired_version', '=', row.desired_version).where('desired_hash', '=', row.desired_hash)
      .where('desired_instruction_hash', '=', row.desired_instruction_hash)
      .where('branch', '=', row.branch).where('target_resource_id', '=', row.target_resource_id)
      .where('lease_expires_at', '>', new Date().toISOString()).executeTakeFirst();
    if (Number(result.numUpdatedRows) !== 1) {
      return {
        cat_id: row.cat_id, status: 'lease_lost' as const, error_code: 'TASK_LEASE_LOST',
        wrote_provider: providerWriteStarted(error),
      };
    }
    return {
      cat_id: row.cat_id,
      status: providerStarted ? 'provider_started' as const : 'retryable' as const,
      error_code: code,
      wrote_provider: providerWriteStarted(error),
    };
  }

  async function execute(options: {
    workerId?: string; limit?: number; leaseSeconds?: number; rateLimitMs?: number;
  } = {}) {
    const workerId = options.workerId?.trim() || `task-reconcile-${randomUUID()}`;
    const limit = boundedLimit(options.limit);
    const leaseSeconds = Number.isInteger(options.leaseSeconds)
      ? Math.min(Math.max(options.leaseSeconds!, 30), MAX_LEASE_SECONDS)
      : DEFAULT_LEASE_SECONDS;
    const rateLimitMs = Number.isInteger(options.rateLimitMs)
      ? Math.min(Math.max(options.rateLimitMs!, 0), 10_000)
      : 250;
    const task = taskLoader();
    const cursor = await database.selectFrom('task_reconcile_cursors').selectAll()
      .where('task_id', '=', task.id).executeTakeFirst();
    const emptyResult = (status: 'plan_required' | 'stale_rows' | 'idle', staleRows = 0) => ({
      task_id: task.id, worker_id: workerId, status,
      error_code: status === 'idle' ? null : 'TASK_PLAN_REQUIRED',
      desired_version: task.version, desired_hash: task.hash,
      attempted: 0, applied: 0, provider_writes: 0, retryable: 0,
      ineligible: 0, lease_lost: 0, stale_rows: staleRows,
      provider_settlement_required: 0, results: [],
    });
    if (!cursor || cursor.desired_version !== task.version || cursor.desired_hash !== task.hash) {
      return emptyResult('plan_required');
    }
    const results: Array<Awaited<ReturnType<typeof processClaim>> | Awaited<ReturnType<typeof failClaim>>> = [];
    for (let index = 0; index < limit; index += 1) {
      let row = await claim(workerId, leaseSeconds, task, 'write');
      if (!row) row = await claim(workerId, leaseSeconds, null, 'settlement');
      if (!row) break;
      try {
        results.push(await processClaim(row, task));
      } catch (error) {
        results.push(await failClaim(row, error));
      }
      if (rateLimitMs > 0 && index + 1 < limit) await sleep(rateLimitMs);
    }
    const stale = await database.selectFrom('cat_task_reconciliations')
      .select(({ fn }) => fn.count<number>('cat_id').as('count'))
      .where('task_id', '=', task.id)
      .where('status', 'in', ['pending', 'retryable', 'leased', 'provider_started'])
      .where((eb) => eb.or([
        eb('desired_version', '!=', task.version),
        eb('desired_hash', '!=', task.hash),
      ])).executeTakeFirst();
    const staleRows = Number(stale?.count ?? 0);
    if (results.length === 0) return emptyResult(staleRows > 0 ? 'stale_rows' : 'idle', staleRows);
    return {
      task_id: task.id, worker_id: workerId, status: 'executed' as const, error_code: null,
      desired_version: task.version, desired_hash: task.hash, attempted: results.length,
      applied: results.filter((item) => item.status === 'applied').length,
      provider_writes: results.filter((item) => item.wrote_provider).length,
      retryable: results.filter((item) => item.status === 'retryable' || item.status === 'provider_started').length,
      provider_settlement_required: results.filter((item) => item.status === 'provider_settlement_required').length,
      ineligible: results.filter((item) => item.status === 'ineligible').length,
      lease_lost: results.filter((item) => item.status === 'lease_lost').length,
      stale_rows: staleRows,
      results,
    };
  }

  async function status() {
    const task = taskLoader();
    const now = new Date().toISOString();
    const rows = await database.selectFrom('cat_task_reconciliations')
      .select(['status']).select(({ fn }) => fn.count<number>('cat_id').as('count'))
      .where('task_id', '=', task.id).groupBy('status').execute();
    const deferred = await database.selectFrom('cat_task_reconciliations')
      .select(({ fn }) => fn.count<number>('cat_id').as('count'))
      .where('task_id', '=', task.id).where('status', 'in', ['leased', 'provider_started'])
      .where('lease_expires_at', '>', now).executeTakeFirst();
    const settlement = await database.selectFrom('cat_task_reconciliations')
      .select(({ fn }) => fn.count<number>('cat_id').as('count'))
      .where('task_id', '=', task.id).where('status', 'in', ['leased', 'provider_started'])
      .where('provider_started_at', 'is not', null)
      .where((eb) => eb.or([eb('lease_expires_at', 'is', null), eb('lease_expires_at', '<=', now)]))
      .executeTakeFirst();
    return {
      task_id: task.id, desired_version: task.version, desired_hash: task.hash,
      counts: Object.fromEntries(rows.map((row) => [row.status, Number(row.count)])),
      deferred_in_flight: Number(deferred?.count ?? 0),
      provider_settlement_required: Number(settlement?.count ?? 0),
    };
  }

  return { plan, execute, status };
}

const taskReconciler = createTaskReconciler();

export const planCatTaskReconciliation = taskReconciler.plan;
export const executeCatTaskReconciliation = taskReconciler.execute;
export const getCatTaskReconciliationStatus = taskReconciler.status;
