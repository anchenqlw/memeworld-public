import { createHash, randomUUID } from 'node:crypto';
import { sql, type Selectable, type Transaction } from 'kysely';
import { config } from '../config.js';
import { db } from '../db/index.js';
import type { DatabaseSchema } from '../db/schema.js';

export type EvolutionEnvironment = 'staging' | 'production';
export type CircuitState = 'ACTIVE' | 'DEGRADED' | 'FROZEN' | 'RECOVERING';

type DbExecutor = Transaction<DatabaseSchema> | typeof db;
type EvolutionJob = Selectable<DatabaseSchema['evolution_jobs']>;

type FeedbackArtifact = {
  proposal_id: string;
  event_id: string;
  archive_commit_sha: string;
  idempotency_key: string;
  sanitized_ref: string;
  sanitized_sha256: string;
};

export type JobPayload = Record<string, unknown> & {
  accepted_or_partial?: boolean;
  draft_candidate_authorized?: boolean;
  agent_ready?: boolean;
  dependencies_ready?: boolean;
  allowed_paths?: string[];
  risk_level?: string;
  excluded_risks?: string[];
  dependency_job_ids?: string[];
  lock_domains?: string[];
  authorization_source?: string;
  work_item_ref?: string;
  work_item_title?: string;
  work_item_summary?: string;
  acceptance?: string;
  policy_version?: string;
  standing_policy_version?: string;
  source_claim_id?: string;
  proposal_ids?: string[];
  archive_commit_sha?: string;
  sanitized_artifacts?: Array<{ proposal_id: string; ref: string; sha256: string }>;
  head_sha?: string;
};

const AUTO_PROTECTED_PREFIXES = [
  '.env', '.env.example', '.github/', 'AGENTS.md', 'EVOLUTION.md', 'Dockerfile', 'Dockerfile.server',
  'apps/server/package.json', 'apps/web/Dockerfile', 'apps/web/package.json', 'package.json', 'package-lock.json',
  'config/', 'evolution/', 'infra/', 'railway.json', 'scripts/', 'state/', 'tasks/', 'world/',
  'docs/decisions/', 'docs/architecture/self-evolution-control-plane.md',
  'apps/server/src/config.ts', 'apps/server/src/db/', 'apps/server/src/lib/evolutionAuth.ts',
  'apps/server/src/routes/evolution.ts', 'apps/server/src/services/evolutionControlPlane.ts', 'apps/server/src/scripts/',
] as const;

const IMPLEMENTATION_PAYLOAD_KEYS = new Set([
  'accepted_or_partial', 'draft_candidate_authorized', 'agent_ready', 'dependencies_ready',
  'allowed_paths', 'lock_domains', 'risk_level', 'excluded_risks', 'dependency_job_ids',
  'authorization_source', 'work_item_ref', 'work_item_title', 'work_item_summary',
  'acceptance', 'policy_version', 'standing_policy_version',
]);

const KNOWN_JOB_TASK_IDS = new Set([
  'evolution.daily-triage', 'evolution.issue-implementation', 'evolution.pr-assurance',
  'evolution.control-plane-audit', 'evolution.evidence-writer', 'evolution.weekly-delivery-review',
  'ops.health-check', 'ops.synthetic-e2e', 'ops.capacity-product-review', 'ops.alert-response', 'ops.deploy',
]);
const INTERNAL_DISPATCH_TASK_IDS = new Set([
  'evolution.daily-triage', 'evolution.evidence-writer', 'ops.alert-response',
]);

function controlError(code: string, message: string, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function nowIso() { return new Date().toISOString(); }
function plusSeconds(seconds: number) { return new Date(Date.now() + seconds * 1000).toISOString(); }
function sha256(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

function serializeBoundedJson(value: unknown, name: string, maxBytes = 131_072) {
  let serialized: string;
  try { serialized = JSON.stringify(value ?? {}); } catch { throw controlError('INVALID_JSON_VALUE', `${name} 必须可序列化`); }
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw controlError('PAYLOAD_TOO_LARGE', `${name} 超过 ${maxBytes} 字节上限`, 413);
  }
  return serialized;
}

function boundedStringList(value: unknown, name: string, required = false, maxItems = 100, maxLength = 1024) {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || value.length > maxItems || (required && value.length === 0)) {
    throw controlError('INVALID_INPUT', `${name} 必须是 1..${maxItems} 条字符串数组`);
  }
  return normalizedStrings(value.map((item) => validateBoundedString(item, name, maxLength)));
}

function normalizedStrings(values: string[] | undefined) {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].sort();
}

function validateBoundedString(value: unknown, name: string, max = 512) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw controlError('INVALID_INPUT', `${name} 必须是非空、无控制字符且不超过 ${max} 字符的字符串`);
  }
  return value.trim();
}

function canonicalRepoPath(value: string, allowGlob = true) {
  const path = validateBoundedString(value, 'repository path', 512);
  if (path.startsWith('/') || path.startsWith('~') || path.includes('\\') || /^[A-Za-z]:/.test(path)) {
    throw controlError('INVALID_ALLOWED_PATH', `路径必须是仓库相对 POSIX 路径：${path}`);
  }
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw controlError('INVALID_ALLOWED_PATH', `路径不能包含空段、. 或 ..：${path}`);
  }
  if (!allowGlob && /[*?\[\]{}]/.test(path)) {
    throw controlError('INVALID_ALLOWED_PATH', `该字段不允许 glob：${path}`);
  }
  if (allowGlob && /[\[\]{}!]/.test(path)) {
    throw controlError('INVALID_ALLOWED_PATH', `仅支持 *、** 和 ? glob：${path}`);
  }
  return path;
}

function staticGlobPrefix(pattern: string) {
  const index = pattern.search(/[?*]/);
  return index < 0 ? pattern : pattern.slice(0, index);
}

function overlapsProtectedPath(pattern: string, protectedPrefix: string) {
  const staticPrefix = staticGlobPrefix(pattern);
  if (!staticPrefix) return true;
  const protectedBase = protectedPrefix.endsWith('/') ? protectedPrefix : `${protectedPrefix}/`;
  const patternBase = pattern.endsWith('/') ? pattern : `${pattern}/`;
  return pattern === protectedPrefix || pattern.startsWith(protectedBase) || protectedPrefix.startsWith(patternBase) ||
    protectedPrefix.startsWith(staticPrefix) || staticPrefix.startsWith(protectedBase);
}

function canonicalAllowedPaths(values: string[] | undefined) {
  return normalizedStrings(values).map((value) => canonicalRepoPath(value));
}

function deriveLockDomains(paths: string[]) {
  const domains = new Set<string>();
  for (const path of paths) {
    const staticPath = staticGlobPrefix(path);
    if (staticPath.startsWith('apps/server/')) domains.add('server');
    else if (staticPath.startsWith('apps/web/')) domains.add('web');
    else if (staticPath.startsWith('world/')) domains.add('world');
    else if (staticPath.startsWith('docs/')) domains.add('docs');
    else if (staticPath.startsWith('state/')) domains.add('state-ledger');
    else domains.add(staticPath.split('/')[0] || 'repository-root');
  }
  return [...domains].sort();
}

function deriveJobLockDomains(taskId: string, payload: JobPayload) {
  const domains = new Set(deriveLockDomains(canonicalAllowedPaths(payload.allowed_paths)));
  const fixedDomains: Record<string, string[]> = {
    'evolution.evidence-writer': ['evolution-ledger'],
    'ops.health-check': ['health-ledger'],
    'ops.alert-response': ['health-ledger', 'platform-ops'],
    'ops.deploy': ['global-release-train', 'health-ledger', 'platform-ops'],
  };
  for (const domain of fixedDomains[taskId] ?? []) domains.add(domain);
  return [...domains].sort();
}

function assertCallerLockDomains(payload: JobPayload, derived: string[]) {
  if (!payload.lock_domains) return;
  if (JSON.stringify(normalizedStrings(payload.lock_domains)) !== JSON.stringify(derived)) {
    throw controlError('LOCK_DOMAIN_MISMATCH', 'lock_domains 必须由服务端从 allowed_paths 确定性推导，调用方不能扩大或缩小锁域', 409);
  }
}

function standingPolicySafe(payload: JobPayload) {
  const paths = canonicalAllowedPaths(payload.allowed_paths);
  const version = payload.standing_policy_version ?? '';
  return payload.authorization_source === `standing-policy:${version}` && version === config.evolution.standingDraftPolicyVersion &&
    ['L1', 'L2'].includes(payload.risk_level ?? '') && normalizedStrings(payload.excluded_risks).length === 0 &&
    paths.length > 0 && paths.every((path) => !AUTO_PROTECTED_PREFIXES.some((prefix) => overlapsProtectedPath(path, prefix)));
}

function standingPolicyScopeHash(policyVersion: string) {
  return sha256({
    policy_version: policyVersion,
    purpose: 'automatic-draft-pr-only',
    risk_levels: ['L1', 'L2'],
    protected_prefixes: [...AUTO_PROTECTED_PREFIXES].sort(),
    merge: false,
    release: false,
  });
}

export function getStandingPolicyDescriptor(policyVersion: string, environment: EvolutionEnvironment = 'staging') {
  const version = validateBoundedString(policyVersion, 'policy version', 128);
  if (version !== config.evolution.standingDraftPolicyVersion) {
    throw controlError('POLICY_VERSION_MISMATCH', '请求的 standing policy version 与部署配置不一致', 409);
  }
  return {
    action: 'standing-work-item-policy', subject: version,
    scope_hash: standingPolicyScopeHash(version), environment,
    effect: 'automatic-draft-pr-only', protected_prefixes: [...AUTO_PROTECTED_PREFIXES].sort(),
  };
}

function canonicalJobPayload(payload: JobPayload) {
  const paths = canonicalAllowedPaths(payload.allowed_paths);
  const locks = deriveLockDomains(paths);
  assertCallerLockDomains(payload, locks);
  const normalized: JobPayload = {
    ...payload,
    allowed_paths: paths,
    excluded_risks: normalizedStrings(payload.excluded_risks),
    dependency_job_ids: normalizedStrings(payload.dependency_job_ids),
    lock_domains: locks,
    proposal_ids: normalizedStrings(payload.proposal_ids),
  };
  for (const key of [
    'risk_level', 'authorization_source', 'work_item_ref', 'work_item_title', 'work_item_summary',
    'acceptance', 'policy_version', 'standing_policy_version', 'source_claim_id', 'source_job_id',
    'archive_commit_sha', 'head_sha', 'repository', 'base_ref', 'deterministic_gate',
    'review_policy_version', 'evidence_ref',
  ]) {
    if (typeof normalized[key] === 'string') normalized[key] = normalized[key].trim();
  }
  return normalized;
}

function canonicalImplementationPayload(payload: JobPayload): JobPayload {
  const unknown = Object.keys(payload).filter((key) => !IMPLEMENTATION_PAYLOAD_KEYS.has(key));
  if (unknown.length) {
    throw controlError('UNBOUND_IMPLEMENTATION_INPUT', `B 任务包含未绑定 Owner scope 的字段：${unknown.sort().join(', ')}`, 409);
  }
  const normalized = canonicalJobPayload({
    accepted_or_partial: payload.accepted_or_partial,
    draft_candidate_authorized: payload.draft_candidate_authorized,
    agent_ready: payload.agent_ready,
    dependencies_ready: payload.dependencies_ready,
    allowed_paths: payload.allowed_paths,
    lock_domains: payload.lock_domains,
    risk_level: payload.risk_level,
    excluded_risks: payload.excluded_risks,
    dependency_job_ids: payload.dependency_job_ids,
    authorization_source: payload.authorization_source,
    work_item_ref: payload.work_item_ref,
    work_item_title: payload.work_item_title,
    work_item_summary: payload.work_item_summary,
    acceptance: payload.acceptance,
    policy_version: payload.policy_version,
    standing_policy_version: payload.standing_policy_version,
  });
  return {
    accepted_or_partial: normalized.accepted_or_partial,
    draft_candidate_authorized: normalized.draft_candidate_authorized,
    agent_ready: normalized.agent_ready,
    dependencies_ready: normalized.dependencies_ready,
    allowed_paths: normalized.allowed_paths,
    lock_domains: normalized.lock_domains,
    risk_level: normalized.risk_level,
    excluded_risks: normalized.excluded_risks,
    dependency_job_ids: normalized.dependency_job_ids,
    authorization_source: normalized.authorization_source,
    work_item_ref: normalized.work_item_ref,
    work_item_title: normalized.work_item_title,
    work_item_summary: normalized.work_item_summary,
    acceptance: normalized.acceptance,
    policy_version: normalized.policy_version,
    standing_policy_version: normalized.standing_policy_version,
  } satisfies JobPayload;
}

export function computeWorkItemScopeHash(subject: string, payload: JobPayload) {
  const normalized = canonicalImplementationPayload(payload);
  return sha256({
    subject: validateBoundedString(subject, 'scope subject', 256),
    accepted_or_partial: normalized.accepted_or_partial === true,
    draft_candidate_authorized: normalized.draft_candidate_authorized === true,
    agent_ready: normalized.agent_ready === true,
    dependencies_ready: normalized.dependencies_ready === true,
    allowed_paths: normalized.allowed_paths,
    lock_domains: normalized.lock_domains,
    risk_level: normalized.risk_level ?? '',
    excluded_risks: normalized.excluded_risks,
    dependency_job_ids: normalized.dependency_job_ids,
    acceptance: normalized.acceptance?.trim() ?? '',
    policy_version: normalized.policy_version ?? '',
    standing_policy_version: normalized.standing_policy_version ?? '',
    authorization_source: normalized.authorization_source ?? '',
    work_item_ref: normalized.work_item_ref ?? '',
    work_item_title: normalized.work_item_title?.trim() ?? '',
    work_item_summary: normalized.work_item_summary?.trim() ?? '',
  });
}

export function describeWorkItemScope(subject: string, payload: JobPayload) {
  const normalized = canonicalImplementationPayload(payload);
  return { subject, scope_hash: computeWorkItemScopeHash(subject, normalized), payload: normalized };
}

function opaqueReporterRef(userId: string) {
  return `reporter_${createHash('sha256').update(`meandme-evolution:${userId}`).digest('hex').slice(0, 20)}`;
}

async function proposalRecords(ids: string[]) {
  if (!ids.length) return [];
  const proposals = await db.selectFrom('proposals').select([
    'id', 'user_id', 'type', 'content', 'context', 'created_at', 'status',
  ]).where('id', 'in', ids).orderBy('created_at', 'asc').orderBy('id', 'asc').execute();
  const events = await db.selectFrom('proposal_events').select(['id', 'proposal_id', 'event_kind', 'created_at'])
    .where('proposal_id', 'in', ids).orderBy('created_at', 'asc').execute();
  return proposals.map(({ user_id, ...proposal }) => ({
    ...proposal,
    reporter_ref: opaqueReporterRef(user_id),
    source_events: events.filter((event) => event.proposal_id === proposal.id),
  }));
}

async function getRuntimeStateIn(executor: DbExecutor, environment: EvolutionEnvironment) {
  const state = await executor.selectFrom('evolution_runtime_state').selectAll()
    .where('environment', '=', environment).executeTakeFirst();
  if (!state) throw controlError('RUNTIME_STATE_MISSING', '该环境缺少自进化运行时状态，保持 fail-closed', 503);
  return state;
}

async function lockRuntimeIn(executor: DbExecutor, environment: EvolutionEnvironment) {
  if (config.dbDialect === 'postgres') {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`${environment}:evolution-runtime`}))`.execute(executor);
  }
}

async function lockCircuitIn(executor: DbExecutor, environment: EvolutionEnvironment) {
  if (config.dbDialect === 'postgres') {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`${environment}:evolution-circuit`}))`.execute(executor);
  }
}

async function lockApprovalIn(
  executor: DbExecutor,
  environment: string,
  action: string,
  subject: string,
  scopeHash: string,
) {
  if (config.dbDialect === 'postgres') {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`${environment}:approval:${action}:${subject}:${scopeHash}`}))`.execute(executor);
  }
}

function runtimeReady(state: Awaited<ReturnType<typeof getRuntimeStateIn>>) {
  return state.environment_ready === 1 && state.identities_ready === 1 && state.owner_activated === 1;
}

async function requireRuntimeReady(executor: DbExecutor, environment: EvolutionEnvironment) {
  await lockRuntimeIn(executor, environment);
  const state = await getRuntimeStateIn(executor, environment);
  if (!runtimeReady(state)) throw controlError('RUNTIME_NOT_READY', 'environment、scoped identities 与 Owner activation 必须全部就绪', 409);
  return state;
}

export async function getEvolutionRuntimeState(environment: EvolutionEnvironment) {
  return getRuntimeStateIn(db, environment);
}

async function appendJobEvent(executor: DbExecutor, jobId: string, eventKind: string, actor: string, detail: unknown) {
  await executor.insertInto('evolution_job_events').values({
    id: `eje_${randomUUID()}`, job_id: jobId, event_kind: eventKind, actor,
    detail: serializeBoundedJson(detail, 'job event detail'),
  }).execute();
}

function taskAllowedByCircuit(taskId: string, state: CircuitState) {
  if (state === 'ACTIVE') return true;
  return new Set([
    'evolution.control-plane-audit', 'evolution.evidence-writer', 'evolution.weekly-delivery-review', 'evolution.pr-assurance',
    'ops.health-check', 'ops.synthetic-e2e', 'ops.capacity-product-review', 'ops.alert-response',
  ]).has(taskId);
}

function taskClaimAllowedByCircuit(taskId: string, state: CircuitState) {
  if (state === 'ACTIVE') return true;
  return new Set([
    'evolution.control-plane-audit', 'evolution.evidence-writer', 'evolution.weekly-delivery-review',
    'ops.health-check', 'ops.synthetic-e2e', 'ops.capacity-product-review', 'ops.alert-response',
  ]).has(taskId);
}

async function freezeForEvidenceFailureIn(executor: DbExecutor, job: EvolutionJob, reason: string) {
  if (job.task_id !== 'evolution.evidence-writer') return;
  await lockCircuitIn(executor, job.environment as EvolutionEnvironment);
  const fingerprint = `${job.environment}:evolution-evidence-writer`;
  const previousIncident = await executor.selectFrom('evolution_incidents').select(['id', 'status'])
    .where('environment', '=', job.environment).where('fingerprint', '=', fingerprint).executeTakeFirst();
  const incident = await upsertIncidentIn(executor, {
    fingerprint,
    environment: job.environment as EvolutionEnvironment,
    service: 'evolution-evidence-writer',
    severity: 'P0',
    summary: `共享证据单写者终态失败：${reason}`,
  });
  const circuit = await executor.selectFrom('evolution_circuit').selectAll()
    .where('environment', '=', job.environment).executeTakeFirstOrThrow();
  if (circuit.state !== 'FROZEN') {
    const updated = await executor.updateTable('evolution_circuit').set({
      state: 'FROZEN', reason: 'evidence-writer-terminal-failure', evidence_ref: job.id, updated_at: nowIso(),
    }).where('environment', '=', job.environment).where('state', '=', circuit.state).executeTakeFirst();
    if (Number(updated.numUpdatedRows) !== 1) throw controlError('CIRCUIT_RACE', '证据失败冻结时 circuit 已被并发修改', 409);
    await executor.insertInto('evolution_circuit_events').values({
      id: `ece_${randomUUID()}`, environment: job.environment, from_state: circuit.state, to_state: 'FROZEN',
      actor: 'control-plane', reason: `evidence-writer-terminal-failure:${reason}`, evidence_ref: job.id,
    }).execute();
  }
  if (!previousIncident || previousIncident.status === 'resolved') {
    const responsePayload: JobPayload = {
      incident_id: incident.id,
      incident_fingerprint: incident.fingerprint,
      incident_service: incident.service,
      incident_severity: incident.severity,
      incident_summary: incident.summary,
      evidence_ref: job.id,
    };
    const inputHash = sha256(responsePayload);
    await enqueueEvolutionJobIn(executor, {
      task_id: 'ops.alert-response', environment: job.environment as EvolutionEnvironment, input_hash: inputHash,
      idempotency_key: `alert-response:${job.environment}:${incident.id}:${incident.occurrence_count}`,
      max_attempts: 3, priority: 0, payload: responsePayload,
    });
  }
  await blockDisallowedJobsIn(
    executor, job.environment as EvolutionEnvironment, 'FROZEN', 'control-plane', 'EVIDENCE_WRITER_FAILED',
  );
}

async function blockJobIn(executor: DbExecutor, job: EvolutionJob, actor: string, reason: string) {
  const updated = await executor.updateTable('evolution_jobs').set({
    status: 'blocked', error_code: reason, lease_owner: null, lease_expires_at: null, updated_at: nowIso(),
  }).where('id', '=', job.id).where('status', 'in', ['queued', 'leased', 'running']).executeTakeFirst();
  if (Number(updated.numUpdatedRows) !== 1) return false;
  await executor.deleteFrom('evolution_resource_leases').where('job_id', '=', job.id).execute();
  await appendJobEvent(executor, job.id, 'blocked', actor, { reason, lease_epoch: job.lease_epoch });
  await enqueueEvidenceJobIn(executor, job, 'blocked', { reason, lease_epoch: job.lease_epoch });
  await freezeForEvidenceFailureIn(executor, job, reason);
  const payload = parseJson<JobPayload>(job.payload, {});
  if (job.task_id === 'evolution.issue-implementation' && payload.work_item_ref) {
    await executor.updateTable('evolution_work_items').set({ status: 'blocked', updated_at: nowIso() })
      .where('environment', '=', job.environment).where('backlog_ref', '=', payload.work_item_ref)
      .where('implementation_job_id', '=', job.id).execute();
  }
  return true;
}

async function blockDisallowedJobsIn(executor: DbExecutor, environment: EvolutionEnvironment, state: CircuitState, actor: string, reason: string) {
  const active = await executor.selectFrom('evolution_jobs').selectAll().where('environment', '=', environment)
    .where('status', 'in', ['leased', 'running']).execute();
  for (const job of active) {
    if (!taskAllowedByCircuit(job.task_id, state)) await blockJobIn(executor, job, actor, reason);
  }
}

export async function updateEvolutionRuntimeState(input: {
  environment: EvolutionEnvironment;
  environment_ready: boolean;
  identities_ready: boolean;
  owner_activated: boolean;
  development_max_concurrency: number;
  evidence_ref: string;
}) {
  if (![1, 2].includes(input.development_max_concurrency) ||
    input.development_max_concurrency > config.evolution.developmentMaxConcurrency) {
    throw controlError('INVALID_CONCURRENCY', '运行时开发并发必须为 1 或 2，且不能超过部署硬上限', 409);
  }
  const evidence = validateBoundedString(input.evidence_ref, 'evidence_ref', 1024);
  return db.transaction().execute(async (trx) => {
    await lockRuntimeIn(trx, input.environment);
    await lockCircuitIn(trx, input.environment);
    await trx.updateTable('evolution_runtime_state').set({
      environment_ready: input.environment_ready ? 1 : 0,
      identities_ready: input.identities_ready ? 1 : 0,
      owner_activated: input.owner_activated ? 1 : 0,
      development_max_concurrency: input.development_max_concurrency,
      evidence_ref: evidence, updated_by: 'owner:scoped-token', updated_at: nowIso(),
    }).where('environment', '=', input.environment).executeTakeFirstOrThrow();
    if (!input.environment_ready || !input.identities_ready || !input.owner_activated) {
      const circuit = await trx.selectFrom('evolution_circuit').selectAll().where('environment', '=', input.environment).executeTakeFirstOrThrow();
      if (circuit.state !== 'FROZEN') {
        await trx.updateTable('evolution_circuit').set({ state: 'FROZEN', reason: 'runtime-readiness-revoked', evidence_ref: evidence, updated_at: nowIso() })
          .where('environment', '=', input.environment).where('state', '=', circuit.state).executeTakeFirstOrThrow();
        await trx.insertInto('evolution_circuit_events').values({
          id: `ece_${randomUUID()}`, environment: input.environment, from_state: circuit.state, to_state: 'FROZEN',
          actor: 'owner', reason: 'runtime-readiness-revoked', evidence_ref: evidence,
        }).execute();
      }
      await blockDisallowedJobsIn(trx, input.environment, 'FROZEN', 'owner', 'RUNTIME_READINESS_REVOKED');
    }
    return getRuntimeStateIn(trx, input.environment);
  });
}

export async function claimFeedback(environment: EvolutionEnvironment, leaseOwner: string, limit = 50, leaseSeconds = 1200) {
  const owner = validateBoundedString(leaseOwner, 'lease_owner', 256);
  if (!Number.isFinite(limit) || !Number.isFinite(leaseSeconds)) throw controlError('INVALID_CLAIM_LIMIT', 'limit 和 lease_seconds 必须是有限数字');
  const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 100);
  const boundedLease = Math.min(Math.max(Math.floor(leaseSeconds), 60), 3600);
  const result = await db.transaction().execute(async (trx) => {
    await requireRuntimeReady(trx, environment);
    if (config.dbDialect === 'postgres') {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`${environment}:feedback-intake`}))`.execute(trx);
    }
    const active = await trx.selectFrom('feedback_claims').selectAll().where('environment', '=', environment)
      .where('status', '=', 'leased').orderBy('created_at', 'asc').executeTakeFirst();
    if (active && active.expires_at > nowIso()) {
      if (active.lease_owner !== owner) throw controlError('FEEDBACK_CLAIM_BUSY', '该环境已有活跃反馈 claim', 409);
      return { claim: active, ids: parseJson<string[]>(active.proposal_ids, []), replay: true, hasMore: false };
    }
    if (active) {
      const expiredStatus = active.attempts >= active.max_attempts ? 'dead-letter' : 'retry';
      await trx.updateTable('feedback_claims').set({ status: expiredStatus, error_code: 'LEASE_EXPIRED', updated_at: nowIso() })
        .where('id', '=', active.id).where('status', '=', 'leased').execute();
      if (expiredStatus === 'dead-letter') {
        await enqueueFeedbackEvidenceJobIn(trx, environment, active.id, active.lease_epoch, expiredStatus, {
          error_code: 'LEASE_EXPIRED', proposal_count: parseJson<string[]>(active.proposal_ids, []).length,
        });
      }
    }
    const retry = await trx.selectFrom('feedback_claims').selectAll().where('environment', '=', environment)
      .where('status', '=', 'retry').orderBy('updated_at', 'asc').executeTakeFirst();
    if (retry) {
      const expiresAt = plusSeconds(boundedLease);
      await trx.updateTable('feedback_claims').set({
        status: 'leased', lease_owner: owner, lease_epoch: retry.lease_epoch + 1, attempts: retry.attempts + 1,
        expires_at: expiresAt, heartbeat_at: nowIso(), error_code: null, updated_at: nowIso(),
      }).where('id', '=', retry.id).where('status', '=', 'retry').executeTakeFirstOrThrow();
      const claimed = await trx.selectFrom('feedback_claims').selectAll().where('id', '=', retry.id).executeTakeFirstOrThrow();
      return { claim: claimed, ids: parseJson<string[]>(claimed.proposal_ids, []), replay: true, hasMore: false };
    }

    const deadClaims = await trx.selectFrom('feedback_claims').select('proposal_ids').where('environment', '=', environment)
      .where('status', '=', 'dead-letter').execute();
    const deadIds = normalizedStrings(deadClaims.flatMap((claim) => parseJson<string[]>(claim.proposal_ids, [])));
    let query = trx.selectFrom('proposals as p').leftJoin('feedback_archives as a', 'a.proposal_id', 'p.id')
      .select(['p.id', 'p.created_at']).where('a.proposal_id', 'is', null);
    if (deadIds.length) query = query.where('p.id', 'not in', deadIds);
    const rows = await query.orderBy('p.created_at', 'asc').orderBy('p.id', 'asc').limit(boundedLimit + 1).execute();
    const selected = rows.slice(0, boundedLimit);
    const cursor = await trx.selectFrom('workflow_cursors').select('cursor_value').where('id', '=', 'feedback-intake')
      .where('environment', '=', environment).executeTakeFirst();
    const cursorValue = cursor?.cursor_value ?? 'cursor:genesis';
    if (!selected.length) return { claim: null, ids: [], replay: false, hasMore: false, cursor: cursorValue };
    const claimId = `fclaim_${randomUUID()}`;
    const ids = selected.map((row) => row.id);
    await trx.insertInto('feedback_claims').values({
      id: claimId, environment, lease_owner: owner, proposal_ids: JSON.stringify(ids), cursor_from: cursorValue,
      cursor_to: `cursor:${randomUUID()}`, expires_at: plusSeconds(boundedLease), lease_epoch: 1, attempts: 1,
      max_attempts: 3, heartbeat_at: nowIso(), error_code: null, updated_at: nowIso(),
    }).execute();
    const claim = await trx.selectFrom('feedback_claims').selectAll().where('id', '=', claimId).executeTakeFirstOrThrow();
    return { claim, ids, replay: false, hasMore: rows.length > boundedLimit };
  });
  if (!result.claim) return {
    claim_id: null, cursor: result.cursor, next_cursor: result.cursor, lease_epoch: null,
    lease_expires_at: null, has_more: false, records: [], replay: false,
  };
  return {
    claim_id: result.claim.id, cursor: result.claim.cursor_from, next_cursor: result.claim.cursor_to,
    lease_epoch: result.claim.lease_epoch, lease_expires_at: result.claim.expires_at,
    has_more: result.hasMore || await hasUnarchivedFeedback(result.ids),
    records: await proposalRecords(result.ids), replay: result.replay,
  };
}

async function hasUnarchivedFeedback(excluding: string[] = []) {
  let query = db.selectFrom('proposals as p').leftJoin('feedback_archives as a', 'a.proposal_id', 'p.id')
    .select('p.id').where('a.proposal_id', 'is', null);
  if (excluding.length) query = query.where('p.id', 'not in', excluding);
  return Boolean(await query.executeTakeFirst());
}

export async function heartbeatFeedbackClaim(environment: EvolutionEnvironment, claimId: string, leaseOwner: string, leaseEpoch: number, leaseSeconds = 1200) {
  if (!Number.isInteger(leaseEpoch) || !Number.isFinite(leaseSeconds)) throw controlError('LEASE_FENCE_REQUIRED', 'feedback heartbeat 必须携带有效 epoch');
  const expiresAt = plusSeconds(Math.min(Math.max(Math.floor(leaseSeconds), 60), 3600));
  return db.transaction().execute(async (trx) => {
    await requireRuntimeReady(trx, environment);
    const updated = await trx.updateTable('feedback_claims').set({ expires_at: expiresAt, heartbeat_at: nowIso(), updated_at: nowIso() })
      .where('id', '=', claimId).where('environment', '=', environment).where('status', '=', 'leased')
      .where('lease_owner', '=', leaseOwner).where('lease_epoch', '=', leaseEpoch).where('expires_at', '>', nowIso()).executeTakeFirst();
    if (Number(updated.numUpdatedRows) !== 1) throw controlError('LEASE_INVALID', 'feedback claim lease 无效或已过期', 409);
    return { ok: true, lease_epoch: leaseEpoch, lease_expires_at: expiresAt };
  });
}

export async function failFeedbackClaim(environment: EvolutionEnvironment, claimId: string, leaseOwner: string, leaseEpoch: number, errorCode: string, retryable: boolean) {
  const owner = validateBoundedString(leaseOwner, 'lease_owner', 256);
  if (!Number.isInteger(leaseEpoch)) throw controlError('LEASE_FENCE_REQUIRED', 'feedback fail 必须携带有效 epoch');
  const code = validateBoundedString(errorCode, 'error_code', 128);
  return db.transaction().execute(async (trx) => {
    await requireRuntimeReady(trx, environment);
    if (config.dbDialect === 'postgres') {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`${environment}:feedback-intake`}))`.execute(trx);
    }
    const claim = await trx.selectFrom('feedback_claims').selectAll().where('id', '=', claimId).where('environment', '=', environment).executeTakeFirst();
    if (!claim || claim.status !== 'leased' || claim.lease_owner !== owner || claim.lease_epoch !== leaseEpoch || claim.expires_at <= nowIso()) {
      throw controlError('LEASE_INVALID', 'feedback claim lease 无效或已过期', 409);
    }
    const status = retryable && claim.attempts < claim.max_attempts ? 'retry' : 'dead-letter';
    const updated = await trx.updateTable('feedback_claims').set({ status, error_code: code, updated_at: nowIso() })
      .where('id', '=', claimId).where('status', '=', 'leased').where('lease_owner', '=', owner)
      .where('lease_epoch', '=', leaseEpoch).where('expires_at', '>', nowIso()).executeTakeFirst();
    if (Number(updated.numUpdatedRows) !== 1) throw controlError('LEASE_INVALID', 'feedback claim 已被其他请求终结', 409);
    if (status === 'dead-letter') {
      await enqueueFeedbackEvidenceJobIn(trx, environment, claimId, leaseEpoch, status, {
        error_code: code, proposal_count: parseJson<string[]>(claim.proposal_ids, []).length,
      });
    }
    return { ok: true, status };
  });
}

function validateFeedbackArtifact(artifact: FeedbackArtifact) {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(artifact.archive_commit_sha)) {
    throw controlError('INVALID_COMMIT_SHA', 'archive_commit_sha 必须是完整 Git SHA');
  }
  if (!/^[0-9a-f]{64}$/i.test(artifact.sanitized_sha256)) {
    throw controlError('INVALID_SANITIZED_DIGEST', 'sanitized_sha256 必须是 SHA-256');
  }
  const ref = canonicalRepoPath(artifact.sanitized_ref, false);
  if (!ref.startsWith('evolution/issues/') && !ref.startsWith('evolution/proposals/')) {
    throw controlError('INVALID_SANITIZED_REF', 'sanitized_ref 只能指向 evolution/issues 或 evolution/proposals');
  }
  validateBoundedString(artifact.idempotency_key, 'idempotency_key', 256);
}

type EnqueueInput = {
  task_id: string; environment: EvolutionEnvironment; input_hash: string; payload?: JobPayload;
  idempotency_key: string; max_attempts?: number; priority?: number; budget_limit?: number;
  approval_action?: string; approval_subject?: string; approval_scope_hash?: string;
};

function validateJobGuards(taskId: string, environment: EvolutionEnvironment, payload: JobPayload, approvalAction?: string, approvalSubject?: string) {
  if (taskId === 'evolution.issue-implementation') {
    if ((!payload.accepted_or_partial && !payload.draft_candidate_authorized) || !payload.agent_ready || !payload.dependencies_ready || !payload.allowed_paths?.length ||
      !payload.work_item_ref?.startsWith('backlog:') ||
      !payload.work_item_title?.trim() || !payload.work_item_summary?.trim() || !payload.acceptance?.trim() ||
      !payload.policy_version?.trim() || !['L1', 'L2'].includes(payload.risk_level ?? '')) {
      throw controlError('WORK_ITEM_NOT_READY', 'B 任务必须绑定 accepted、ready、最小路径、验收标准和 policy version');
    }
    if (normalizedStrings(payload.excluded_risks).length) throw controlError('EXCLUDED_RISK', '该 work item 不允许自动开发');
    const standingApprovedShape = payload.draft_candidate_authorized === true && standingPolicySafe(payload) && approvalAction === 'standing-work-item-policy' &&
      approvalSubject === payload.standing_policy_version;
    const exactApprovedShape = payload.accepted_or_partial === true && approvalAction === 'work-item-authorization' && Boolean(approvalSubject);
    if (!standingApprovedShape && !exactApprovedShape) {
      throw controlError('OWNER_APPROVAL_REQUIRED', 'B 任务必须绑定结构化 Owner work-item authorization');
    }
  }
  if (taskId === 'evolution.pr-assurance') {
    const repository = typeof payload.repository === 'string' ? payload.repository : '';
    const baseRef = typeof payload.base_ref === 'string' ? payload.base_ref : '';
    if (payload.deterministic_gate !== 'success' || !Number.isInteger(payload.pr_number) || Number(payload.pr_number) <= 0 ||
      !/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(String(payload.head_sha ?? '')) ||
      repository.length > 256 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
      !baseRef || baseRef.length > 256 || /[\u0000-\u001f\u007f]/.test(baseRef) ||
      baseRef.startsWith('/') || baseRef.endsWith('/') || baseRef.includes('..') || baseRef.includes('@{') ||
      /[~^:?*\[\]\\]/.test(baseRef) || payload.review_policy_version !== config.evolution.reviewPolicyVersion) {
      throw controlError('INVALID_REVIEW_ENVELOPE', 'C job 必须来自成功确定性门禁并绑定 repo、PR、exact head SHA、合法 base ref 与当前 review policy', 409);
    }
  }
  if (taskId === 'ops.deploy') {
    const requiredAction = environment === 'production' ? 'production-release' : 'rollout-merge';
    if (approvalAction !== requiredAction || !approvalSubject) {
      throw controlError('OWNER_APPROVAL_REQUIRED', `${environment} 发布必须绑定 ${requiredAction} exact bundle approval`);
    }
  }
}

async function hasValidApproval(executor: DbExecutor, action: string, subject: string, scopeHash: string, environment: string) {
  return Boolean(await executor.selectFrom('owner_approvals').select('id').where('action', '=', action)
    .where('subject', '=', subject).where('scope_hash', '=', scopeHash).where('environment', '=', environment)
    .where('revoked_at', 'is', null).where('expires_at', '>', nowIso()).executeTakeFirst());
}

async function enqueueEvolutionJobIn(trx: DbExecutor, input: EnqueueInput) {
  const taskId = validateBoundedString(input.task_id, 'task_id', 128);
  if (!KNOWN_JOB_TASK_IDS.has(taskId)) throw controlError('UNKNOWN_TASK_ID', `${taskId} 不在控制面任务注册表`, 409);
  const inputHash = validateBoundedString(input.input_hash, 'input_hash', 256);
  const idempotencyKey = validateBoundedString(input.idempotency_key, 'idempotency_key', 256);
  let approvalAction = input.approval_action
    ? validateBoundedString(input.approval_action, 'approval_action', 128) : null;
  let approvalSubject = input.approval_subject
    ? validateBoundedString(input.approval_subject, 'approval_subject', 256) : null;
  const canonicalPayload = taskId === 'evolution.issue-implementation'
    ? canonicalImplementationPayload(input.payload ?? {})
    : canonicalJobPayload(input.payload ?? {});
  const reviewPayload: JobPayload = taskId === 'evolution.pr-assurance' ? canonicalJobPayload({
    repository: canonicalPayload.repository,
    pr_number: canonicalPayload.pr_number,
    head_sha: canonicalPayload.head_sha,
    base_ref: canonicalPayload.base_ref,
    deterministic_gate: canonicalPayload.deterministic_gate,
    review_policy_version: canonicalPayload.review_policy_version,
    source_job_id: canonicalPayload.source_job_id,
  }) : canonicalPayload;
  let payload: JobPayload = { ...reviewPayload, lock_domains: deriveJobLockDomains(taskId, reviewPayload) };
  if (Boolean(approvalAction) !== Boolean(approvalSubject) ||
    (input.approval_scope_hash && (!approvalAction || !approvalSubject))) {
    throw controlError('INVALID_APPROVAL_BINDING', 'approval action、subject 与 scope hash 必须形成完整绑定', 409);
  }
  let approvalScopeHash = approvalAction && approvalSubject
    ? validateBoundedString(input.approval_scope_hash ?? inputHash, 'approval_scope_hash', 256) : null;
  if (taskId === 'evolution.pr-assurance' && (approvalAction || approvalSubject || approvalScopeHash)) {
    throw controlError('REVIEW_APPROVAL_CALLER_FORBIDDEN', '受控 C 的来源授权只能由服务端从 B source job 继承', 409);
  }
  validateJobGuards(taskId, input.environment, payload, approvalAction ?? undefined, approvalSubject ?? undefined);
  if (taskId === 'evolution.pr-assurance' && inputHash !== payload.head_sha) {
    throw controlError('REVIEW_INPUT_HASH_MISMATCH', 'C input_hash 必须等于 exact head SHA', 409);
  }
  const scopeSubject = payload.work_item_ref ?? approvalSubject ?? undefined;
  if (taskId === 'evolution.issue-implementation' && scopeSubject &&
    inputHash !== computeWorkItemScopeHash(scopeSubject, payload)) {
    throw controlError('SCOPE_HASH_MISMATCH', 'input_hash 与完整规范化 work-item scope 不一致', 409);
  }
  if (payload.dependency_job_ids?.length) {
    const dependencies = await trx.selectFrom('evolution_jobs').select(['id', 'environment'])
      .where('id', 'in', payload.dependency_job_ids).execute();
    if (dependencies.length !== payload.dependency_job_ids.length ||
      dependencies.some((dependency) => dependency.environment !== input.environment)) {
      throw controlError('INVALID_JOB_DEPENDENCY', 'dependency_job_ids 必须全部引用同环境已存在任务', 409);
    }
  }
  if (approvalAction && approvalSubject && approvalScopeHash) {
    await lockApprovalIn(trx, input.environment, approvalAction, approvalSubject, approvalScopeHash);
    if (!await hasValidApproval(trx, approvalAction, approvalSubject, approvalScopeHash, input.environment)) {
      throw controlError('OWNER_APPROVAL_INVALID', 'Owner approval 不存在、已过期或已撤销', 409);
    }
  }
  if (taskId === 'evolution.pr-assurance' && payload.source_job_id) {
    const sourceJobId = validateBoundedString(payload.source_job_id, 'source_job_id', 256);
    const source = await trx.selectFrom('evolution_jobs').selectAll().where('id', '=', sourceJobId)
      .where('environment', '=', input.environment).where('task_id', '=', 'evolution.issue-implementation').executeTakeFirst();
    const sourceResult = source?.status === 'succeeded' ? parseJson<Record<string, unknown>>(source.result ?? '{}', {}) : {};
    const expectedUrl = `https://github.com/${payload.repository}/pull/${payload.pr_number}`;
    if (!source || source.status !== 'succeeded' || sourceResult.draft !== true ||
      sourceResult.head_sha !== payload.head_sha || sourceResult.draft_pr_number !== payload.pr_number ||
      sourceResult.draft_pr_url !== expectedUrl) {
      throw controlError('REVIEW_SOURCE_JOB_MISMATCH', '受控 B PR 必须绑定同环境、成功且 PR/head 完全一致的 source job', 409);
    }
    if (!source.approval_action || !source.approval_subject || !source.approval_scope_hash) {
      throw controlError('REVIEW_SOURCE_APPROVAL_MISSING', '受控 B source job 缺少完整 Owner/standing authorization', 409);
    }
    await lockApprovalIn(trx, source.environment, source.approval_action, source.approval_subject, source.approval_scope_hash);
    if (!await hasValidApproval(
      trx, source.approval_action, source.approval_subject, source.approval_scope_hash, source.environment,
    )) {
      throw controlError('REVIEW_SOURCE_APPROVAL_INVALID', 'B source authorization 已过期或撤销，不能生成新的 C 证据', 409);
    }
    approvalAction = source.approval_action;
    approvalSubject = source.approval_subject;
    approvalScopeHash = source.approval_scope_hash;
    const evidence = await trx.selectFrom('evolution_jobs').selectAll()
      .where('idempotency_key', '=', `evidence:${source.id}:succeeded:${source.lease_epoch}`)
      .where('environment', '=', input.environment).where('task_id', '=', 'evolution.evidence-writer').executeTakeFirst();
    if (!evidence) throw controlError('REVIEW_SOURCE_EVIDENCE_MISSING', 'B 终态必须已原子生成 evidence job 才能进入 C', 409);
    const sourcePayload = parseJson<JobPayload>(source.payload, {});
    payload = {
      ...payload,
      dependency_job_ids: [evidence.id],
      source_evidence_job_id: evidence.id,
      source_scope_hash: source.input_hash,
      source_work_item_ref: sourcePayload.work_item_ref,
      source_work_item_title: sourcePayload.work_item_title,
      source_work_item_summary: sourcePayload.work_item_summary,
      source_allowed_paths: sourcePayload.allowed_paths,
      source_lock_domains: parseJson<string[]>(source.lock_domains, []),
      source_risk_level: sourcePayload.risk_level,
      source_acceptance: sourcePayload.acceptance,
      source_authorization: sourcePayload.authorization_source,
    };
  }
  const id = `ejob_${randomUUID()}`;
  const payloadJson = serializeBoundedJson(payload, 'job payload');
  await trx.insertInto('evolution_jobs').values({
    id, task_id: taskId, environment: input.environment, input_hash: inputHash,
    payload: payloadJson, idempotency_key: idempotencyKey,
    max_attempts: Math.min(Math.max(Math.floor(input.max_attempts ?? 3), 1), 10),
    priority: Math.min(Math.max(Math.floor(input.priority ?? 100), 0), 1000),
    budget_limit: Math.min(Math.max(Math.floor(input.budget_limit ?? 100000), 1), 10_000_000),
    lease_owner: null, lease_epoch: 0, lease_expires_at: null, heartbeat_at: null,
    lock_domains: JSON.stringify(payload.lock_domains ?? []), approval_action: approvalAction,
    approval_subject: approvalSubject, approval_scope_hash: approvalScopeHash,
    result: null, error_code: null, updated_at: nowIso(),
  }).onConflict((oc) => oc.column('idempotency_key').doNothing()).execute();
  const job = await trx.selectFrom('evolution_jobs').selectAll().where('idempotency_key', '=', idempotencyKey).executeTakeFirstOrThrow();
  if (job.id !== id && (job.task_id !== taskId || job.environment !== input.environment || job.input_hash !== inputHash ||
    job.payload !== payloadJson || job.approval_action !== approvalAction ||
    job.approval_subject !== approvalSubject || job.approval_scope_hash !== approvalScopeHash)) {
    throw controlError('IDEMPOTENCY_CONFLICT', 'idempotency_key 已绑定到不同的不可变任务输入', 409);
  }
  if (job.id === id) await appendJobEvent(trx, id, 'queued', 'control-plane', { input_hash: inputHash, lock_domains: payload.lock_domains });
  if (taskId === 'evolution.issue-implementation') await bindImplementationWorkItemIn(trx, job, payload);
  return job;
}

async function bindImplementationWorkItemIn(executor: DbExecutor, job: EvolutionJob, payload: JobPayload) {
  const backlogRef = validateBoundedString(payload.work_item_ref, 'work_item_ref', 256);
  const title = validateBoundedString(payload.work_item_title, 'work_item_title', 256);
  const summary = validateBoundedString(payload.work_item_summary, 'work_item_summary', 4000);
  const acceptance = validateBoundedString(payload.acceptance, 'acceptance', 4000);
  const paths = canonicalAllowedPaths(payload.allowed_paths);
  const locks = deriveLockDomains(paths);
  const existing = await executor.selectFrom('evolution_work_items').selectAll()
    .where('environment', '=', job.environment).where('backlog_ref', '=', backlogRef).executeTakeFirst();
  const immutableMatch = Boolean(existing && existing.title === title && existing.summary === summary &&
    existing.risk_level === payload.risk_level && existing.allowed_paths === JSON.stringify(paths) &&
    existing.lock_domains === JSON.stringify(locks) && existing.acceptance === acceptance &&
    existing.policy_version === payload.policy_version && existing.authorization_source === payload.authorization_source);
  if (existing?.implementation_job_id === job.id) {
    if (!immutableMatch) throw controlError('WORK_ITEM_JOB_MISMATCH', 'work item 与已绑定 implementation job 的不可变 scope 不一致', 409);
    return existing;
  }
  if (existing && existing.status === 'queued' && !existing.implementation_job_id && immutableMatch) {
    await executor.updateTable('evolution_work_items').set({ implementation_job_id: job.id, updated_at: nowIso() })
      .where('id', '=', existing.id).where('implementation_job_id', 'is', null).executeTakeFirstOrThrow();
    return executor.selectFrom('evolution_work_items').selectAll().where('id', '=', existing.id).executeTakeFirstOrThrow();
  }
  if (existing && ['queued', 'in-progress', 'draft-pr-open'].includes(existing.status) &&
    (existing.implementation_job_id || !immutableMatch)) {
    throw controlError('ACTIVE_WORK_ITEM_IMMUTABLE', '活跃 work item 已绑定其他实现或 scope 已漂移', 409);
  }
  if (!existing) {
    await executor.insertInto('evolution_work_items').values({
      id: `work_${randomUUID()}`, environment: job.environment, backlog_ref: backlogRef, cluster_id: null,
      title, summary, risk_level: payload.risk_level!, allowed_paths: JSON.stringify(paths), lock_domains: JSON.stringify(locks),
      acceptance, status: 'queued', authorization_source: payload.authorization_source ?? null,
      policy_version: payload.policy_version ?? null, implementation_job_id: job.id, branch_name: null,
      draft_pr_number: null, draft_pr_url: null, head_sha: null, version: 1, updated_at: nowIso(),
    }).execute();
  } else {
    await executor.updateTable('evolution_work_items').set({
      title, summary, risk_level: payload.risk_level!, allowed_paths: JSON.stringify(paths), lock_domains: JSON.stringify(locks),
      acceptance, status: 'queued', authorization_source: payload.authorization_source ?? null,
      policy_version: payload.policy_version ?? null, implementation_job_id: job.id,
      branch_name: null, draft_pr_number: null, draft_pr_url: null, head_sha: null,
      version: existing.version + 1, updated_at: nowIso(),
    }).where('id', '=', existing.id).executeTakeFirstOrThrow();
  }
  return executor.selectFrom('evolution_work_items').selectAll()
    .where('environment', '=', job.environment).where('backlog_ref', '=', backlogRef).executeTakeFirstOrThrow();
}

export async function archiveFeedbackClaim(environment: EvolutionEnvironment, claimId: string, leaseOwner: string, leaseEpoch: number, artifacts: FeedbackArtifact[]) {
  if (!artifacts.length || artifacts.length > 100) throw controlError('INVALID_ARTIFACTS', 'artifacts 必须包含 1 到 100 条记录');
  if (!Number.isInteger(leaseEpoch)) throw controlError('LEASE_FENCE_REQUIRED', 'archive 必须携带 feedback lease epoch');
  artifacts.forEach(validateFeedbackArtifact);
  return db.transaction().execute(async (trx) => {
    await requireRuntimeReady(trx, environment);
    if (config.dbDialect === 'postgres') {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`${environment}:feedback-intake`}))`.execute(trx);
    }
    const claim = await trx.selectFrom('feedback_claims').selectAll().where('id', '=', claimId)
      .where('environment', '=', environment).executeTakeFirst();
    if (!claim) throw controlError('CLAIM_NOT_FOUND', '反馈 claim 不存在', 404);
    if (claim.lease_owner !== leaseOwner || claim.lease_epoch !== leaseEpoch) throw controlError('LEASE_INVALID', 'feedback claim fencing token 不匹配', 409);
    const expectedIds = parseJson<string[]>(claim.proposal_ids, []).sort();
    const actualIds = artifacts.map((item) => item.proposal_id).sort();
    if (new Set(actualIds).size !== actualIds.length || JSON.stringify(expectedIds) !== JSON.stringify(actualIds)) {
      throw controlError('PARTIAL_BATCH_FORBIDDEN', '必须完整 archive 整个 claim，且不能重复或跳过记录');
    }
    if (claim.status === 'acked') {
      for (const artifact of artifacts) {
        const stored = await trx.selectFrom('feedback_archives').selectAll().where('proposal_id', '=', artifact.proposal_id).executeTakeFirst();
        if (!stored || stored.claim_id !== claimId || stored.event_id !== artifact.event_id ||
          stored.archive_commit_sha !== artifact.archive_commit_sha || stored.idempotency_key !== artifact.idempotency_key ||
          stored.sanitized_ref !== artifact.sanitized_ref || stored.sanitized_sha256 !== artifact.sanitized_sha256) {
          throw controlError('IDEMPOTENCY_CONFLICT', '已归档 artifact 与重放输入不一致', 409);
        }
      }
      return { ok: true, replay: true, cursor: claim.cursor_to };
    }
    if (claim.status !== 'leased' || claim.expires_at <= nowIso()) throw controlError('CLAIM_EXPIRED', '反馈 claim 已过期或不再可写', 409);
    const commitShas = new Set(artifacts.map((item) => item.archive_commit_sha));
    if (commitShas.size !== 1) throw controlError('MIXED_ARCHIVE_COMMITS', '同一 claim 必须绑定同一个归档 commit');

    for (const artifact of artifacts) {
      const sourceEvent = await trx.selectFrom('proposal_events').select('id').where('id', '=', artifact.event_id)
        .where('proposal_id', '=', artifact.proposal_id).executeTakeFirst();
      if (!sourceEvent) throw controlError('INVALID_SOURCE_EVENT', 'event_id 必须属于对应 proposal', 409);
      await trx.insertInto('feedback_archives').values({
        proposal_id: artifact.proposal_id, claim_id: claimId, event_id: artifact.event_id,
        archive_commit_sha: artifact.archive_commit_sha, idempotency_key: artifact.idempotency_key,
        sanitized_ref: artifact.sanitized_ref, sanitized_sha256: artifact.sanitized_sha256,
      }).onConflict((oc) => oc.column('proposal_id').doNothing()).execute();
      const stored = await trx.selectFrom('feedback_archives').selectAll().where('proposal_id', '=', artifact.proposal_id).executeTakeFirstOrThrow();
      if (stored.claim_id !== claimId || stored.event_id !== artifact.event_id || stored.archive_commit_sha !== artifact.archive_commit_sha ||
        stored.idempotency_key !== artifact.idempotency_key || stored.sanitized_ref !== artifact.sanitized_ref ||
        stored.sanitized_sha256 !== artifact.sanitized_sha256) {
        throw controlError('IDEMPOTENCY_CONFLICT', 'proposal 已绑定到不同 archive artifact', 409);
      }
      const proposal = await trx.selectFrom('proposals').select(['status']).where('id', '=', artifact.proposal_id).executeTakeFirstOrThrow();
      if (proposal.status === 'new') {
        const note = '我已经把这封信安全收进评估队列，接下来会认真评估。';
        await trx.updateTable('proposals').set({ status: 'exported', exported_at: nowIso(), public_note: note })
          .where('id', '=', artifact.proposal_id).where('status', '=', 'new').execute();
        await trx.insertInto('proposal_events').values({
          id: `pe_${randomUUID()}`, proposal_id: artifact.proposal_id, actor_type: 'creator', actor_name: '皮卡',
          from_status: 'new', to_status: 'exported', event_kind: 'feedback-archived',
          idempotency_key: `archive-event:${artifact.idempotency_key}`, visibility: 'public',
          evidence_ref: artifact.archive_commit_sha, public_note: note,
        }).onConflict((oc) => oc.column('idempotency_key').doNothing()).execute();
      }
    }
    const archiveCommit = [...commitShas][0];
    await trx.insertInto('workflow_cursors').values({
      id: 'feedback-intake', environment, cursor_value: claim.cursor_to, archive_commit_sha: archiveCommit, updated_at: nowIso(),
    }).onConflict((oc) => oc.columns(['id', 'environment']).doUpdateSet({
      cursor_value: claim.cursor_to, archive_commit_sha: archiveCommit, updated_at: nowIso(),
    })).execute();
    const triagePayload: JobPayload = {
      source_claim_id: claimId, proposal_ids: expectedIds, archive_commit_sha: archiveCommit,
      policy_version: config.evolution.triagePolicyVersion,
      sanitized_artifacts: artifacts.map((item) => ({ proposal_id: item.proposal_id, ref: item.sanitized_ref, sha256: item.sanitized_sha256 }))
        .sort((a, b) => a.proposal_id.localeCompare(b.proposal_id)),
    };
    const inputHash = sha256(triagePayload);
    await enqueueEvolutionJobIn(trx, {
      task_id: 'evolution.daily-triage', environment, input_hash: inputHash,
      idempotency_key: `triage:${environment}:${claimId}:${inputHash}`, payload: triagePayload, max_attempts: 3,
    });
    await enqueueFeedbackEvidenceJobIn(trx, environment, claimId, leaseEpoch, 'succeeded', {
      archive_commit_sha: archiveCommit,
      cursor_from: claim.cursor_from,
      cursor_to: claim.cursor_to,
      proposal_count: expectedIds.length,
      triage_input_hash: inputHash,
    });
    await trx.updateTable('feedback_claims').set({ status: 'acked', updated_at: nowIso() })
      .where('id', '=', claimId).where('status', '=', 'leased').where('lease_epoch', '=', leaseEpoch).executeTakeFirstOrThrow();
    return { ok: true, replay: false, cursor: claim.cursor_to, triage_input_hash: inputHash };
  });
}

export async function reconcileFeedback(environment: EvolutionEnvironment) {
  const [unarchived, expiredClaims, deadLetter, cursor] = await Promise.all([
    db.selectFrom('proposals as p').leftJoin('feedback_archives as a', 'a.proposal_id', 'p.id')
      .select(({ fn }) => fn.count<number>('p.id').as('count')).where('a.proposal_id', 'is', null).executeTakeFirstOrThrow(),
    db.selectFrom('feedback_claims').select(({ fn }) => fn.count<number>('id').as('count')).where('environment', '=', environment)
      .where('status', '=', 'leased').where('expires_at', '<=', nowIso()).executeTakeFirstOrThrow(),
    db.selectFrom('feedback_claims').select(({ fn }) => fn.count<number>('id').as('count')).where('environment', '=', environment)
      .where('status', '=', 'dead-letter').executeTakeFirstOrThrow(),
    db.selectFrom('workflow_cursors').selectAll().where('id', '=', 'feedback-intake').where('environment', '=', environment).executeTakeFirst(),
  ]);
  return { environment, unarchived: Number(unarchived.count), expired_claims: Number(expiredClaims.count), dead_letter_claims: Number(deadLetter.count), cursor: cursor ?? null };
}

async function requireTriageLease(trx: DbExecutor, input: { environment: EvolutionEnvironment; job_id: string; lease_owner: string; lease_epoch: number }) {
  await requireRuntimeReady(trx, input.environment);
  await lockCircuitIn(trx, input.environment);
  const job = await trx.selectFrom('evolution_jobs').selectAll().where('id', '=', input.job_id).executeTakeFirst();
  if (!job || job.environment !== input.environment || job.task_id !== 'evolution.daily-triage' ||
    job.lease_owner !== input.lease_owner || job.lease_epoch !== input.lease_epoch ||
    !['leased', 'running'].includes(job.status) || !job.lease_expires_at || job.lease_expires_at <= nowIso()) {
    throw controlError('TRIAGE_LEASE_INVALID', 'cluster/work-item 写入必须绑定活跃 A2 lease 与 fencing epoch', 409);
  }
  const circuit = await trx.selectFrom('evolution_circuit').select('state').where('environment', '=', input.environment).executeTakeFirstOrThrow();
  if (!taskAllowedByCircuit(job.task_id, circuit.state as CircuitState)) throw controlError('CIRCUIT_BLOCKED', '当前 circuit 不允许 A2 写入', 409);
  return { job, payload: parseJson<JobPayload>(job.payload, {}) };
}

export async function upsertFeedbackCluster(input: {
  environment: EvolutionEnvironment; job_id: string; lease_owner: string; lease_epoch: number;
  fingerprint: string; title: string; summary: string; classification: string;
  confidence: number; policy_version: string;
  members: Array<{ proposal_id: string; reason: string; confidence: number }>;
}) {
  const fingerprint = validateBoundedString(input.fingerprint, 'fingerprint', 256);
  validateBoundedString(input.title, 'title', 256);
  validateBoundedString(input.summary, 'summary', 4000);
  if (input.policy_version !== config.evolution.triagePolicyVersion) throw controlError('POLICY_VERSION_MISMATCH', 'triage policy version 与部署配置不一致', 409);
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1 || !input.members.length) {
    throw controlError('INVALID_CLUSTER', 'cluster confidence 必须在 0..1 且至少包含一条反馈');
  }
  return db.transaction().execute(async (trx) => {
    const { payload } = await requireTriageLease(trx, input);
    if (config.dbDialect === 'postgres') await sql`SELECT pg_advisory_xact_lock(hashtext(${`${input.environment}:cluster:${fingerprint}`}))`.execute(trx);
    const proposalIds = normalizedStrings(input.members.map((member) => member.proposal_id));
    const authorized = new Set(payload.proposal_ids ?? []);
    if (proposalIds.some((id) => !authorized.has(id))) throw controlError('TRIAGE_INPUT_SCOPE_VIOLATION', 'cluster 只能引用本 A2 批次内 proposal', 409);
    const proposals = await trx.selectFrom('proposals').select('id').where('id', 'in', proposalIds).execute();
    if (proposals.length !== proposalIds.length) throw controlError('UNKNOWN_CLUSTER_MEMBER', 'cluster 包含不存在的 proposal', 409);
    for (const member of input.members) {
      validateBoundedString(member.reason, 'membership reason', 2000);
      if (!Number.isFinite(member.confidence) || member.confidence < 0 || member.confidence > 1) {
        throw controlError('INVALID_MEMBERSHIP', 'membership confidence 必须在 0..1');
      }
    }
    const proposedId = `cluster_${randomUUID()}`;
    await trx.insertInto('feedback_clusters').values({
      id: proposedId, environment: input.environment, fingerprint, title: input.title, summary: input.summary,
      classification: input.classification, confidence: input.confidence, policy_version: input.policy_version,
      sample_count: proposalIds.length, updated_at: nowIso(),
    }).onConflict((oc) => oc.columns(['environment', 'fingerprint']).doNothing()).execute();
    const cluster = await trx.selectFrom('feedback_clusters').selectAll().where('environment', '=', input.environment)
      .where('fingerprint', '=', fingerprint).executeTakeFirstOrThrow();
    await trx.updateTable('feedback_clusters').set({
      title: input.title, summary: input.summary, classification: input.classification, confidence: input.confidence,
      policy_version: input.policy_version, updated_at: nowIso(),
    }).where('id', '=', cluster.id).execute();
    const previous = await trx.selectFrom('cluster_memberships').selectAll().where('cluster_id', '=', cluster.id).execute();
    const previousByProposal = new Map(previous.map((row) => [row.proposal_id, row]));
    for (const member of input.members) {
      const old = previousByProposal.get(member.proposal_id);
      await trx.insertInto('cluster_memberships').values({
        cluster_id: cluster.id, proposal_id: member.proposal_id, reason: member.reason, confidence: member.confidence,
        algorithm_version: input.policy_version, active: 1, updated_at: nowIso(),
      }).onConflict((oc) => oc.columns(['cluster_id', 'proposal_id']).doUpdateSet({
        reason: member.reason, confidence: member.confidence, algorithm_version: input.policy_version, active: 1, updated_at: nowIso(),
      })).execute();
      const changed = !old || old.active !== 1 || old.reason !== member.reason || old.confidence !== member.confidence || old.algorithm_version !== input.policy_version;
      if (changed) await trx.insertInto('cluster_membership_events').values({
        id: `cme_${randomUUID()}`, cluster_id: cluster.id, proposal_id: member.proposal_id,
        event_kind: !old || old.active !== 1 ? 'linked' : 'updated', reason: member.reason,
        confidence: member.confidence, algorithm_version: input.policy_version, job_id: input.job_id, lease_epoch: input.lease_epoch,
      }).execute();
    }
    for (const old of previous.filter((row) => row.active === 1 && authorized.has(row.proposal_id) && !proposalIds.includes(row.proposal_id))) {
      await trx.updateTable('cluster_memberships').set({ active: 0, updated_at: nowIso() })
        .where('cluster_id', '=', cluster.id).where('proposal_id', '=', old.proposal_id).where('active', '=', 1).execute();
      await trx.insertInto('cluster_membership_events').values({
        id: `cme_${randomUUID()}`, cluster_id: cluster.id, proposal_id: old.proposal_id, event_kind: 'unlinked',
        reason: old.reason, confidence: old.confidence, algorithm_version: input.policy_version,
        job_id: input.job_id, lease_epoch: input.lease_epoch,
      }).execute();
    }
    const activeCount = await trx.selectFrom('cluster_memberships').select(({ fn }) => fn.count<number>('proposal_id').as('count'))
      .where('cluster_id', '=', cluster.id).where('active', '=', 1).executeTakeFirstOrThrow();
    await trx.updateTable('feedback_clusters').set({ sample_count: Number(activeCount.count), updated_at: nowIso() })
      .where('id', '=', cluster.id).execute();
    return trx.selectFrom('feedback_clusters').selectAll().where('id', '=', cluster.id).executeTakeFirstOrThrow();
  });
}

export async function upsertEvolutionWorkItem(input: {
  environment: EvolutionEnvironment; job_id: string; lease_owner: string; lease_epoch: number;
  backlog_ref: string; cluster_id?: string; title: string; summary: string; risk_level: string;
  allowed_paths: string[]; acceptance: string; policy_version: string; standing_policy_version?: string;
  excluded_risks?: string[]; dependency_job_ids?: string[]; auto_authorize?: boolean;
}) {
  const backlogRef = validateBoundedString(input.backlog_ref, 'backlog_ref', 256);
  if (!backlogRef.startsWith('backlog:') || !input.cluster_id || !['L1', 'L2', 'L3'].includes(input.risk_level)) {
    throw controlError('INVALID_WORK_ITEM', 'work item 必须绑定 backlog_ref、同批次 cluster 与合法 risk_level');
  }
  validateBoundedString(input.title, 'title', 256);
  validateBoundedString(input.summary, 'summary', 4000);
  validateBoundedString(input.acceptance, 'acceptance', 4000);
  if (input.policy_version !== config.evolution.triagePolicyVersion) throw controlError('POLICY_VERSION_MISMATCH', 'triage policy version 与部署配置不一致', 409);
  const paths = canonicalAllowedPaths(input.allowed_paths);
  if (!paths.length) throw controlError('INVALID_WORK_ITEM', 'allowed_paths 不能为空');
  const lockDomains = deriveLockDomains(paths);
  const standingVersion = input.standing_policy_version ?? config.evolution.standingDraftPolicyVersion;
  const payload: JobPayload = canonicalImplementationPayload({
    accepted_or_partial: false, draft_candidate_authorized: input.auto_authorize === true,
    agent_ready: true, dependencies_ready: true,
    allowed_paths: paths, lock_domains: lockDomains, risk_level: input.risk_level,
    excluded_risks: input.excluded_risks ?? [], dependency_job_ids: input.dependency_job_ids ?? [],
    authorization_source: input.auto_authorize ? `standing-policy:${standingVersion}` : undefined,
    work_item_ref: backlogRef, work_item_title: input.title, work_item_summary: input.summary,
    acceptance: input.acceptance, policy_version: input.policy_version,
    standing_policy_version: input.auto_authorize ? standingVersion : undefined,
  });
  if (input.auto_authorize && !standingPolicySafe(payload)) {
    throw controlError('AUTO_AUTHORIZATION_FORBIDDEN', '该范围超出 standing Draft policy，必须由 Owner 单独授权', 409);
  }
  return db.transaction().execute(async (trx) => {
    const { payload: triagePayload } = await requireTriageLease(trx, input);
    if (config.dbDialect === 'postgres') await sql`SELECT pg_advisory_xact_lock(hashtext(${`${input.environment}:work-item:${backlogRef}`}))`.execute(trx);
    if (input.cluster_id) {
      const cluster = await trx.selectFrom('feedback_clusters').selectAll().where('id', '=', input.cluster_id)
        .where('environment', '=', input.environment).executeTakeFirst();
      if (!cluster) throw controlError('CLUSTER_NOT_FOUND', 'work item 引用的同环境 cluster 不存在', 404);
      const authorized = new Set(triagePayload.proposal_ids ?? []);
      const members = await trx.selectFrom('cluster_memberships').select('proposal_id').where('cluster_id', '=', input.cluster_id)
        .where('active', '=', 1).execute();
      if (!members.some((member) => authorized.has(member.proposal_id))) {
        throw controlError('TRIAGE_INPUT_SCOPE_VIOLATION', 'work item cluster 必须包含本 A2 批次的活跃成员', 409);
      }
    }
    if (input.auto_authorize && standingVersion !== config.evolution.standingDraftPolicyVersion) {
      throw controlError('POLICY_VERSION_MISMATCH', 'standing policy version 与部署配置不一致', 409);
    }
    if (input.auto_authorize && !await hasValidApproval(
      trx, 'standing-work-item-policy', standingVersion, standingPolicyScopeHash(standingVersion), input.environment)) {
      throw controlError('STANDING_POLICY_NOT_APPROVED', 'standing policy 尚未由 Owner 以精确 policy hash 激活', 409);
    }
    const existing = await trx.selectFrom('evolution_work_items').selectAll().where('environment', '=', input.environment)
      .where('backlog_ref', '=', backlogRef).executeTakeFirst();
    if (existing && ['queued', 'in-progress', 'draft-pr-open'].includes(existing.status)) {
      const unchanged = existing.cluster_id === (input.cluster_id ?? null) && existing.title === input.title &&
        existing.summary === input.summary && existing.risk_level === input.risk_level && existing.allowed_paths === JSON.stringify(paths) &&
        existing.acceptance === input.acceptance && existing.policy_version === input.policy_version;
      if (!unchanged) throw controlError('ACTIVE_WORK_ITEM_IMMUTABLE', '活跃 work item 的授权 scope 不可原地漂移', 409);
      const job = existing.implementation_job_id
        ? await trx.selectFrom('evolution_jobs').selectAll().where('id', '=', existing.implementation_job_id).executeTakeFirst() : null;
      return { work_item: existing, job };
    }
    const proposedId = existing?.id ?? `work_${randomUUID()}`;
    const nextVersion = existing ? existing.version + 1 : 1;
    await trx.insertInto('evolution_work_items').values({
      id: proposedId, environment: input.environment, backlog_ref: backlogRef, cluster_id: input.cluster_id ?? null,
      title: input.title, summary: input.summary, risk_level: input.risk_level, allowed_paths: JSON.stringify(paths),
      lock_domains: JSON.stringify(lockDomains), acceptance: input.acceptance,
      status: input.auto_authorize ? 'queued' : 'awaiting-owner', authorization_source: payload.authorization_source ?? null,
      policy_version: input.policy_version, implementation_job_id: null, branch_name: null, draft_pr_number: null,
      draft_pr_url: null, head_sha: null, version: nextVersion, updated_at: nowIso(),
    }).onConflict((oc) => oc.columns(['environment', 'backlog_ref']).doUpdateSet({
      cluster_id: input.cluster_id ?? null, title: input.title, summary: input.summary, risk_level: input.risk_level,
      allowed_paths: JSON.stringify(paths), lock_domains: JSON.stringify(lockDomains), acceptance: input.acceptance,
      status: input.auto_authorize ? 'queued' : 'awaiting-owner', authorization_source: payload.authorization_source ?? null,
      policy_version: input.policy_version, implementation_job_id: null, branch_name: null, draft_pr_number: null,
      draft_pr_url: null, head_sha: null, version: nextVersion, updated_at: nowIso(),
    })).execute();
    const workItem = await trx.selectFrom('evolution_work_items').selectAll().where('environment', '=', input.environment)
      .where('backlog_ref', '=', backlogRef).executeTakeFirstOrThrow();
    if (!input.auto_authorize) return { work_item: workItem, job: null };
    const scopeHash = computeWorkItemScopeHash(backlogRef, payload);
    const job = await enqueueEvolutionJobIn(trx, {
      task_id: 'evolution.issue-implementation', environment: input.environment, input_hash: scopeHash,
      idempotency_key: `implementation:${input.environment}:${backlogRef}:v${workItem.version}:${scopeHash}`, max_attempts: 3,
      payload, approval_action: 'standing-work-item-policy', approval_subject: standingVersion,
      approval_scope_hash: standingPolicyScopeHash(standingVersion),
    });
    await trx.updateTable('evolution_work_items').set({ implementation_job_id: job.id, status: 'queued', updated_at: nowIso() })
      .where('id', '=', workItem.id).execute();
    return {
      work_item: await trx.selectFrom('evolution_work_items').selectAll().where('id', '=', workItem.id).executeTakeFirstOrThrow(),
      job,
    };
  });
}

type OwnerApprovalInput = {
  action: string; subject: string; scope_hash: string; environment: EvolutionEnvironment; expires_at: string;
};

async function createOwnerApprovalIn(trx: DbExecutor, input: OwnerApprovalInput) {
  const action = validateBoundedString(input.action, 'action', 128);
  const subject = validateBoundedString(input.subject, 'subject', 256);
  const scopeHash = validateBoundedString(input.scope_hash, 'scope_hash', 256);
  const expiry = new Date(input.expires_at).getTime();
  if (!Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 30 * 24 * 3600_000) {
    throw controlError('INVALID_EXPIRY', 'approval expiry 必须在未来 30 天内');
  }
  await lockApprovalIn(trx, input.environment, action, subject, scopeHash);
  const existing = await trx.selectFrom('owner_approvals').selectAll().where('action', '=', action).where('subject', '=', subject)
    .where('scope_hash', '=', scopeHash).where('environment', '=', input.environment).executeTakeFirst();
  const id = existing?.id ?? `approval_${randomUUID()}`;
  if (existing) {
    await trx.updateTable('owner_approvals').set({ actor: 'owner:scoped-token', expires_at: input.expires_at, revoked_at: null, updated_at: nowIso() })
      .where('id', '=', id).executeTakeFirstOrThrow();
  } else {
    await trx.insertInto('owner_approvals').values({
      id, action, subject, scope_hash: scopeHash, environment: input.environment, actor: 'owner:scoped-token',
      expires_at: input.expires_at, revoked_at: null, updated_at: nowIso(),
    }).execute();
  }
  await trx.insertInto('owner_approval_events').values({
    id: `oae_${randomUUID()}`, approval_id: id, event_kind: existing ? 'renewed' : 'granted', actor: 'owner:scoped-token',
    detail: JSON.stringify({ expires_at: input.expires_at }),
  }).execute();
  return trx.selectFrom('owner_approvals').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
}

export async function createOwnerApproval(input: OwnerApprovalInput) {
  return db.transaction().execute((trx) => createOwnerApprovalIn(trx, input));
}

export async function authorizeAndEnqueueWorkItem(input: {
  environment: EvolutionEnvironment;
  subject: string;
  payload: JobPayload;
  expires_at: string;
}) {
  const subject = validateBoundedString(input.subject, 'subject', 256);
  if (!subject.startsWith('backlog:')) throw controlError('INVALID_WORK_ITEM', 'Owner authorization subject 必须是 canonical backlog:* 引用');
  const payload = canonicalImplementationPayload({
    ...input.payload,
    accepted_or_partial: true,
    draft_candidate_authorized: false,
    authorization_source: 'owner-work-item-authorization',
    work_item_ref: subject,
    standing_policy_version: undefined,
  });
  const scopeHash = computeWorkItemScopeHash(subject, payload);
  return db.transaction().execute(async (trx) => {
    if (config.dbDialect === 'postgres') {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`${input.environment}:work-item:${subject}`}))`.execute(trx);
    }
    const approval = await createOwnerApprovalIn(trx, {
      action: 'work-item-authorization', subject, scope_hash: scopeHash,
      environment: input.environment, expires_at: input.expires_at,
    });
    const job = await enqueueEvolutionJobIn(trx, {
      task_id: 'evolution.issue-implementation', environment: input.environment, input_hash: scopeHash,
      idempotency_key: `implementation:${input.environment}:${subject}:${scopeHash}`, max_attempts: 3,
      payload, approval_action: 'work-item-authorization', approval_subject: subject, approval_scope_hash: scopeHash,
    });
    return { scope: { subject, scope_hash: scopeHash, payload }, approval, job };
  });
}

export async function revokeOwnerApproval(approvalId: string, reason: string) {
  const id = validateBoundedString(approvalId, 'approval id', 256);
  const revokeReason = validateBoundedString(reason, 'reason', 1000);
  return db.transaction().execute(async (trx) => {
    const initial = await trx.selectFrom('owner_approvals').selectAll().where('id', '=', id).executeTakeFirst();
    if (!initial) throw controlError('APPROVAL_NOT_FOUND', 'approval 不存在', 404);
    await lockApprovalIn(trx, initial.environment, initial.action, initial.subject, initial.scope_hash);
    const approval = await trx.selectFrom('owner_approvals').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    if (!approval.revoked_at) {
      await trx.updateTable('owner_approvals').set({ revoked_at: nowIso(), updated_at: nowIso() }).where('id', '=', id).executeTakeFirstOrThrow();
      await trx.insertInto('owner_approval_events').values({
        id: `oae_${randomUUID()}`, approval_id: id, event_kind: 'revoked', actor: 'owner:scoped-token',
        detail: JSON.stringify({ reason: revokeReason }),
      }).execute();
      const boundJobs = await trx.selectFrom('evolution_jobs').selectAll().where('environment', '=', approval.environment)
        .where('approval_action', '=', approval.action).where('approval_subject', '=', approval.subject)
        .where('approval_scope_hash', '=', approval.scope_hash).execute();
      for (const job of boundJobs.filter((item) => ['queued', 'leased', 'running'].includes(item.status))) {
        await blockJobIn(trx, job, 'owner:scoped-token', 'APPROVAL_REVOKED');
      }
      for (const job of boundJobs.filter((item) => item.task_id === 'evolution.issue-implementation')) {
        const payload = parseJson<JobPayload>(job.payload, {});
        if (payload.work_item_ref) {
          await trx.updateTable('evolution_work_items').set({ status: 'blocked', updated_at: nowIso() })
            .where('environment', '=', job.environment).where('backlog_ref', '=', payload.work_item_ref)
            .where('implementation_job_id', '=', job.id)
            .where('status', 'in', ['queued', 'in-progress', 'draft-pr-open']).execute();
        }
      }
    }
    return { ok: true, approval_id: id, revoked_at: nowIso() };
  });
}

export async function enqueueEvolutionJob(input: EnqueueInput) {
  const taskId = typeof input.task_id === 'string' ? input.task_id.trim() : '';
  if (INTERNAL_DISPATCH_TASK_IDS.has(taskId)) {
    throw controlError('INTERNAL_DISPATCH_ONLY', `${input.task_id} 只能由对应控制面事务生成`, 403);
  }
  return db.transaction().execute((trx) => enqueueEvolutionJobIn(trx, input));
}

async function enqueueEvidenceJobIn(executor: DbExecutor, source: EvolutionJob, terminalStatus: string, terminalDetail: unknown) {
  if (source.task_id === 'evolution.evidence-writer') return null;
  const sourcePayload = parseJson<JobPayload>(source.payload, {});
  const payload: JobPayload = {
    source_job_id: source.id,
    source_task_id: source.task_id,
    source_input_hash: source.input_hash,
    source_lease_epoch: source.lease_epoch,
    terminal_status: terminalStatus,
    terminal_detail: terminalDetail,
    work_item_ref: sourcePayload.work_item_ref,
    source_budget_used: source.budget_used,
    source_budget_limit: source.budget_limit,
  };
  const inputHash = sha256(payload);
  return enqueueEvolutionJobIn(executor, {
    task_id: 'evolution.evidence-writer', environment: source.environment as EvolutionEnvironment,
    input_hash: inputHash, idempotency_key: `evidence:${source.id}:${terminalStatus}:${source.lease_epoch}`,
    max_attempts: 3, priority: 10, payload,
  });
}

async function enqueueFeedbackEvidenceJobIn(
  executor: DbExecutor,
  environment: EvolutionEnvironment,
  claimId: string,
  leaseEpoch: number,
  terminalStatus: string,
  terminalDetail: unknown,
) {
  const payload: JobPayload = {
    source_claim_id: claimId,
    source_task_id: 'creator.daily-inbox',
    source_lease_epoch: leaseEpoch,
    terminal_status: terminalStatus,
    terminal_detail: terminalDetail,
  };
  const inputHash = sha256(payload);
  return enqueueEvolutionJobIn(executor, {
    task_id: 'evolution.evidence-writer', environment, input_hash: inputHash,
    idempotency_key: `evidence:feedback:${claimId}:${terminalStatus}:${leaseEpoch}`,
    max_attempts: 3, priority: 10, payload,
  });
}

async function recycleExpiredJobsIn(trx: DbExecutor, environment: EvolutionEnvironment) {
  const cutoff = nowIso();
  const expired = await trx.selectFrom('evolution_jobs').selectAll().where('environment', '=', environment)
    .where('status', 'in', ['leased', 'running']).where('lease_expires_at', '<=', cutoff).execute();
  for (const job of expired) {
    const status = job.attempts >= job.max_attempts ? 'dead-letter' : 'queued';
    const updated = await trx.updateTable('evolution_jobs').set({
      status, lease_owner: null, lease_expires_at: null, updated_at: nowIso(), error_code: 'LEASE_EXPIRED',
    }).where('id', '=', job.id).where('status', 'in', ['leased', 'running']).where('lease_epoch', '=', job.lease_epoch)
      .where('lease_expires_at', '<=', cutoff).executeTakeFirst();
    if (Number(updated.numUpdatedRows) === 1) {
      await trx.deleteFrom('evolution_resource_leases').where('job_id', '=', job.id).where('lease_epoch', '=', job.lease_epoch).execute();
      await appendJobEvent(trx, job.id, status, 'control-plane', { reason: 'lease-expired', lease_epoch: job.lease_epoch });
      if (status === 'dead-letter') {
        await enqueueEvidenceJobIn(trx, job, status, { reason: 'lease-expired' });
        await freezeForEvidenceFailureIn(trx, job, 'lease-expired');
      }
      const payload = parseJson<JobPayload>(job.payload, {});
      if (job.task_id === 'evolution.issue-implementation' && payload.work_item_ref) {
        await trx.updateTable('evolution_work_items').set({ status, updated_at: nowIso() })
          .where('environment', '=', environment).where('backlog_ref', '=', payload.work_item_ref)
          .where('implementation_job_id', '=', job.id).execute();
      }
    }
  }
}

export async function claimEvolutionJob(environment: EvolutionEnvironment, leaseOwner: string, taskIds: string[], leaseSeconds = 1800) {
  const owner = validateBoundedString(leaseOwner, 'lease_owner', 256);
  const tasks = normalizedStrings(taskIds);
  if (!tasks.length || !Number.isFinite(leaseSeconds)) throw controlError('INVALID_CLAIM', 'task_ids 与 lease_seconds 非法');
  return db.transaction().execute(async (trx) => {
    const runtime = await requireRuntimeReady(trx, environment);
    await lockCircuitIn(trx, environment);
    if (config.dbDialect === 'postgres') await sql`SELECT pg_advisory_xact_lock(hashtext(${`${environment}:evolution-claim`}))`.execute(trx);
    await recycleExpiredJobsIn(trx, environment);
    const existingWorkerJob = await trx.selectFrom('evolution_jobs').select('id').where('environment', '=', environment)
      .where('lease_owner', '=', owner).where('status', 'in', ['leased', 'running']).where('lease_expires_at', '>', nowIso()).executeTakeFirst();
    if (existingWorkerJob) throw controlError('WORKER_ALREADY_LEASED', '同一 worker identity 同时只能持有一个活跃 job', 409);
    const circuit = await trx.selectFrom('evolution_circuit').selectAll().where('environment', '=', environment).executeTakeFirstOrThrow();
    const candidates = await trx.selectFrom('evolution_jobs').selectAll().where('environment', '=', environment)
      .where('status', '=', 'queued').where('task_id', 'in', tasks).orderBy('priority', 'asc').orderBy('created_at', 'asc').limit(50).execute();
    for (const job of candidates) {
      if (!taskClaimAllowedByCircuit(job.task_id, circuit.state as CircuitState)) continue;
      if (job.approval_action && job.approval_subject) {
        const approvalScopeHash = job.approval_scope_hash ?? job.input_hash;
        await lockApprovalIn(trx, environment, job.approval_action, job.approval_subject, approvalScopeHash);
        if (!await hasValidApproval(trx, job.approval_action, job.approval_subject, approvalScopeHash, environment)) continue;
      }
      const payload = parseJson<JobPayload>(job.payload, {});
      if (job.task_id === 'evolution.issue-implementation') {
        const workItem = payload.work_item_ref
          ? await trx.selectFrom('evolution_work_items').select(['implementation_job_id', 'status'])
            .where('environment', '=', environment).where('backlog_ref', '=', payload.work_item_ref).executeTakeFirst()
          : null;
        if (!workItem || workItem.implementation_job_id !== job.id || !['queued', 'in-progress'].includes(workItem.status)) {
          await blockJobIn(trx, job, 'control-plane', 'WORK_ITEM_BINDING_LOST');
          continue;
        }
      }
      if (payload.dependency_job_ids?.length) {
        const dependencies = await trx.selectFrom('evolution_jobs').select(['id', 'environment', 'status'])
          .where('id', 'in', payload.dependency_job_ids).execute();
        if (dependencies.length !== payload.dependency_job_ids.length ||
          dependencies.some((item) => item.environment !== environment)) {
          await blockJobIn(trx, job, 'control-plane', 'DEPENDENCY_INVALID');
          continue;
        }
        if (dependencies.some((item) => ['failed', 'dead-letter', 'blocked'].includes(item.status))) {
          await blockJobIn(trx, job, 'control-plane', 'DEPENDENCY_FAILED');
          continue;
        }
        if (dependencies.some((item) => item.status !== 'succeeded')) continue;
      }
      const maxConcurrency = job.task_id === 'evolution.issue-implementation'
        ? Math.min(runtime.development_max_concurrency, config.evolution.developmentMaxConcurrency)
        : job.task_id === 'evolution.pr-assurance' ? 2 : 1;
      const active = await trx.selectFrom('evolution_jobs').select(({ fn }) => fn.count<number>('id').as('count'))
        .where('environment', '=', environment).where('task_id', '=', job.task_id)
        .where('status', 'in', ['leased', 'running']).executeTakeFirstOrThrow();
      if (Number(active.count) >= maxConcurrency) continue;
      const lockDomains = deriveJobLockDomains(job.task_id, payload);
      if (JSON.stringify(lockDomains) !== JSON.stringify(parseJson<string[]>(job.lock_domains, []))) {
        await blockJobIn(trx, job, 'control-plane', 'LOCK_SCOPE_CORRUPT');
        continue;
      }
      if (lockDomains.length) {
        const conflicts = await trx.selectFrom('evolution_resource_leases').select(['domain', 'job_id'])
          .where('environment', '=', environment).where('domain', 'in', lockDomains).where('expires_at', '>', nowIso()).execute();
        if (conflicts.some((lease) => lease.job_id !== job.id)) continue;
      }
      const expiresAt = plusSeconds(Math.min(Math.max(Math.floor(leaseSeconds), 60), 3600));
      const nextEpoch = job.lease_epoch + 1;
      const updated = await trx.updateTable('evolution_jobs').set({
        status: 'leased', lease_owner: owner, lease_epoch: nextEpoch, lease_expires_at: expiresAt,
        heartbeat_at: nowIso(), attempts: job.attempts + 1, updated_at: nowIso(), error_code: null,
      }).where('id', '=', job.id).where('status', '=', 'queued').where('lease_epoch', '=', job.lease_epoch).executeTakeFirst();
      if (Number(updated.numUpdatedRows) !== 1) continue;
      for (const domain of lockDomains) {
        await trx.insertInto('evolution_resource_leases').values({
          environment, domain, job_id: job.id, lease_owner: owner, lease_epoch: nextEpoch, expires_at: expiresAt, updated_at: nowIso(),
        }).onConflict((oc) => oc.columns(['environment', 'domain']).doUpdateSet({
          job_id: job.id, lease_owner: owner, lease_epoch: nextEpoch, expires_at: expiresAt, updated_at: nowIso(),
        })).execute();
      }
      await appendJobEvent(trx, job.id, 'leased', owner, { attempt: job.attempts + 1, lease_epoch: nextEpoch, lock_domains: lockDomains });
      if (job.task_id === 'evolution.issue-implementation' && payload.work_item_ref) {
        await trx.updateTable('evolution_work_items').set({ status: 'in-progress', updated_at: nowIso() })
          .where('environment', '=', environment).where('backlog_ref', '=', payload.work_item_ref)
          .where('implementation_job_id', '=', job.id).execute();
      }
      const leased = await trx.selectFrom('evolution_jobs').selectAll().where('id', '=', job.id).executeTakeFirstOrThrow();
      if (job.task_id === 'evolution.pr-assurance' && payload.source_job_id && payload.source_evidence_job_id) {
        const source = await trx.selectFrom('evolution_jobs').selectAll().where('id', '=', String(payload.source_job_id)).executeTakeFirstOrThrow();
        const evidence = await trx.selectFrom('evolution_jobs').selectAll().where('id', '=', String(payload.source_evidence_job_id)).executeTakeFirstOrThrow();
        return {
          ...leased,
          context: {
            source_job: {
              id: source.id, input_hash: source.input_hash, payload: parseJson<JobPayload>(source.payload, {}),
              result: parseJson<Record<string, unknown>>(source.result ?? '{}', {}),
              approval_action: source.approval_action, approval_subject: source.approval_subject,
              approval_scope_hash: source.approval_scope_hash,
            },
            evidence_job: {
              id: evidence.id, result: parseJson<Record<string, unknown>>(evidence.result ?? '{}', {}),
            },
          },
        };
      }
      return leased;
    }
    return null;
  });
}

async function activeJobGuard(trx: DbExecutor, jobId: string, leaseOwner: string, leaseEpoch: number, allowedTaskIds: string[]) {
  const job = await trx.selectFrom('evolution_jobs').selectAll().where('id', '=', jobId).executeTakeFirst();
  if (!job) throw controlError('JOB_NOT_FOUND', 'job 不存在', 404);
  if (!allowedTaskIds.includes(job.task_id)) throw controlError('WORKER_SCOPE_MISMATCH', 'worker 不能操作其他角色的 job', 403);
  if (job.lease_owner !== leaseOwner || job.lease_epoch !== leaseEpoch || !['leased', 'running'].includes(job.status) ||
    !job.lease_expires_at || job.lease_expires_at <= nowIso()) throw controlError('LEASE_INVALID', 'job lease 无效或已过期', 409);
  const runtime = await getRuntimeStateIn(trx, job.environment as EvolutionEnvironment);
  if (!runtimeReady(runtime)) return { job, blocked: 'RUNTIME_NOT_READY' };
  const circuit = await trx.selectFrom('evolution_circuit').select('state').where('environment', '=', job.environment).executeTakeFirstOrThrow();
  if (!taskAllowedByCircuit(job.task_id, circuit.state as CircuitState)) return { job, blocked: 'CIRCUIT_BLOCKED' };
  if (job.approval_action && job.approval_subject && !await hasValidApproval(
    trx, job.approval_action, job.approval_subject, job.approval_scope_hash ?? job.input_hash, job.environment)) {
    return { job, blocked: 'APPROVAL_INVALID' };
  }
  return { job, blocked: null };
}

async function withActiveJob<T>(jobId: string, leaseOwner: string, leaseEpoch: number, allowedTaskIds: string[],
  operation: (trx: Transaction<DatabaseSchema>, job: EvolutionJob) => Promise<T>) {
  const outcome = await db.transaction().execute(async (trx) => {
    const reference = await trx.selectFrom('evolution_jobs').select([
      'id', 'environment', 'approval_action', 'approval_subject', 'approval_scope_hash', 'input_hash',
    ]).where('id', '=', jobId).executeTakeFirst();
    if (!reference) throw controlError('JOB_NOT_FOUND', 'job 不存在', 404);
    const environment = reference.environment as EvolutionEnvironment;
    await lockRuntimeIn(trx, environment);
    await lockCircuitIn(trx, environment);
    if (config.dbDialect === 'postgres') await sql`SELECT pg_advisory_xact_lock(hashtext(${`job:${jobId}`}))`.execute(trx);
    if (reference.approval_action && reference.approval_subject) {
      await lockApprovalIn(trx, reference.environment, reference.approval_action, reference.approval_subject,
        reference.approval_scope_hash ?? reference.input_hash);
    }
    const guarded = await activeJobGuard(trx, jobId, leaseOwner, leaseEpoch, allowedTaskIds);
    if (guarded.blocked) {
      await blockJobIn(trx, guarded.job, 'control-plane', guarded.blocked);
      return { blocked: guarded.blocked, value: null as T | null };
    }
    return { blocked: null, value: await operation(trx, guarded.job) };
  });
  if (outcome.blocked) throw controlError(outcome.blocked, `job 因 ${outcome.blocked} 已立即阻塞`, 409);
  return outcome.value as T;
}

export async function heartbeatEvolutionJob(jobId: string, leaseOwner: string, leaseEpoch: number, allowedTaskIds: string[], leaseSeconds = 1800, budgetUsed?: number) {
  if (!Number.isFinite(leaseSeconds) || (budgetUsed !== undefined && !Number.isFinite(budgetUsed))) {
    throw controlError('INVALID_HEARTBEAT', 'lease_seconds 和 budget_used 必须是有限数字');
  }
  return withActiveJob(jobId, leaseOwner, leaseEpoch, allowedTaskIds, async (trx, job) => {
    const nextBudget = budgetUsed === undefined ? job.budget_used : Math.max(Math.floor(budgetUsed), 0);
    if (nextBudget > job.budget_limit) {
      await blockJobIn(trx, job, leaseOwner, 'BUDGET_EXCEEDED');
      return { budgetExceeded: true, value: null };
    }
    const expiresAt = plusSeconds(Math.min(Math.max(Math.floor(leaseSeconds), 60), 3600));
    const updated = await trx.updateTable('evolution_jobs').set({
      status: 'running', heartbeat_at: nowIso(), lease_expires_at: expiresAt, budget_used: nextBudget, updated_at: nowIso(),
    }).where('id', '=', jobId).where('lease_owner', '=', leaseOwner).where('lease_epoch', '=', leaseEpoch)
      .where('status', 'in', ['leased', 'running']).where('lease_expires_at', '>', nowIso()).executeTakeFirst();
    if (Number(updated.numUpdatedRows) !== 1) throw controlError('LEASE_INVALID', 'job lease 已被其他请求终结或替换', 409);
    await trx.updateTable('evolution_resource_leases').set({ expires_at: expiresAt, updated_at: nowIso() })
      .where('job_id', '=', jobId).where('lease_owner', '=', leaseOwner).where('lease_epoch', '=', leaseEpoch).execute();
    return { budgetExceeded: false, value: { ok: true, lease_epoch: leaseEpoch, lease_expires_at: expiresAt, budget_used: nextBudget, budget_limit: job.budget_limit } };
  }).then((outcome) => {
    if (outcome.budgetExceeded) throw controlError('BUDGET_EXCEEDED', 'job 已超过结构化预算并被阻塞', 409);
    return outcome.value;
  });
}

function globMatches(pattern: string, path: string) {
  const escaped = pattern.replace(/[.+^$()|\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]').replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}$`).test(path);
}

function normalizeCompletion(job: EvolutionJob, result: unknown) {
  const value = result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : {};
  if (job.task_id === 'evolution.issue-implementation') {
    const branch = validateBoundedString(value.branch_name, 'branch_name', 256);
    const url = validateBoundedString(value.draft_pr_url, 'draft_pr_url', 1024);
    const headSha = validateBoundedString(value.head_sha, 'head_sha', 64);
    const number = Number(value.draft_pr_number);
    const changedPaths = Array.isArray(value.changed_paths) ? value.changed_paths.map((path) => canonicalRepoPath(String(path), false)) : [];
    const tests = boundedStringList(value.tests, 'tests', true, 100, 1024);
    if (value.draft !== true || !branch.startsWith('evo/') || !Number.isInteger(number) || number <= 0 ||
      !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(url) || !/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(headSha) || !changedPaths.length) {
      throw controlError('INVALID_IMPLEMENTATION_RESULT', 'B 完成结果必须绑定 evo/* 分支、Draft PR、完整 head SHA 与 changed_paths', 409);
    }
    const payload = parseJson<JobPayload>(job.payload, {});
    const allowed = canonicalAllowedPaths(payload.allowed_paths);
    if (changedPaths.some((path) => !allowed.some((pattern) => globMatches(pattern, path)))) {
      throw controlError('CHANGED_PATH_OUT_OF_SCOPE', 'Draft PR 包含授权范围外路径', 409);
    }
    return {
      draft: true, branch_name: branch, draft_pr_url: url, draft_pr_number: number, head_sha: headSha,
      changed_paths: normalizedStrings(changedPaths), tests, budget_used: job.budget_used, budget_limit: job.budget_limit,
    };
  }
  if (job.task_id === 'evolution.pr-assurance') {
    const headSha = validateBoundedString(value.head_sha, 'head_sha', 64);
    const verdict = value.verdict;
    const recommendation = value.recommendation;
    const evidenceRef = validateBoundedString(value.evidence_ref, 'evidence_ref', 1024);
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(headSha) || !['pass', 'fail'].includes(String(verdict)) ||
      !['recommend', 'request-changes', 'block'].includes(String(recommendation)) ||
      (verdict === 'pass' && recommendation !== 'recommend') || (verdict === 'fail' && recommendation === 'recommend')) {
      throw controlError('INVALID_REVIEW_RESULT', 'C 结果必须绑定 exact head SHA、相容的 verdict/recommendation 与 evidence_ref', 409);
    }
    const payload = parseJson<JobPayload>(job.payload, {});
    if (payload.head_sha && payload.head_sha !== headSha) throw controlError('HEAD_SHA_MISMATCH', 'C 结果 SHA 与任务输入不一致', 409);
    return {
      head_sha: headSha, verdict, recommendation, evidence_ref: evidenceRef,
      summary: typeof value.summary === 'string' ? validateBoundedString(value.summary, 'review summary', 4000) : undefined,
      risks: boundedStringList(value.risks, 'review risks', false, 100, 2000),
      gaps: boundedStringList(value.gaps, 'review gaps', false, 100, 2000),
      checks: boundedStringList(value.checks, 'review checks', false, 200, 1024),
    };
  }
  if (job.task_id === 'evolution.evidence-writer') {
    const commitSha = validateBoundedString(value.commit_sha, 'commit_sha', 64);
    const changedPaths = Array.isArray(value.changed_paths)
      ? value.changed_paths.map((item) => canonicalRepoPath(String(item), false)) : [];
    const allowedPrefixes = ['evolution/backlog/', 'evolution/issues/', 'evolution/reviews/', 'evolution/runs/', 'state/', 'world/history/'];
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(commitSha) || !changedPaths.length ||
      !changedPaths.some((path) => path.startsWith('evolution/runs/')) ||
      changedPaths.some((path) => !allowedPrefixes.some((prefix) => path.startsWith(prefix)))) {
      throw controlError('INVALID_EVIDENCE_RESULT', 'E evidence result 必须绑定完整 commit SHA 和共享账本白名单路径', 409);
    }
    return { commit_sha: commitSha, changed_paths: normalizedStrings(changedPaths) };
  }
  serializeBoundedJson(value, 'job result');
  return value;
}

export async function completeEvolutionJob(jobId: string, leaseOwner: string, leaseEpoch: number, allowedTaskIds: string[], result: unknown) {
  return withActiveJob(jobId, leaseOwner, leaseEpoch, allowedTaskIds, async (trx, job) => {
    const normalizedResult = normalizeCompletion(job, result);
    const resultJson = serializeBoundedJson(normalizedResult, 'job result');
    const updated = await trx.updateTable('evolution_jobs').set({
      status: 'succeeded', result: resultJson, lease_owner: null, lease_expires_at: null, updated_at: nowIso(),
    }).where('id', '=', jobId).where('lease_owner', '=', leaseOwner).where('lease_epoch', '=', leaseEpoch)
      .where('status', 'in', ['leased', 'running']).where('lease_expires_at', '>', nowIso()).executeTakeFirst();
    if (Number(updated.numUpdatedRows) !== 1) throw controlError('LEASE_INVALID', 'job lease 已被其他请求终结或替换', 409);
    await trx.deleteFrom('evolution_resource_leases').where('job_id', '=', jobId).where('lease_epoch', '=', leaseEpoch).execute();
    await appendJobEvent(trx, jobId, 'succeeded', leaseOwner, normalizedResult);
    await enqueueEvidenceJobIn(trx, job, 'succeeded', normalizedResult);
    const payload = parseJson<JobPayload>(job.payload, {});
    if (job.task_id === 'evolution.issue-implementation' && payload.work_item_ref) {
      const implementation = normalizedResult as Record<string, unknown>;
      const projection = await trx.updateTable('evolution_work_items').set({
        status: 'draft-pr-open', branch_name: String(implementation.branch_name),
        draft_pr_number: Number(implementation.draft_pr_number), draft_pr_url: String(implementation.draft_pr_url),
        head_sha: String(implementation.head_sha), updated_at: nowIso(),
      }).where('environment', '=', job.environment).where('backlog_ref', '=', payload.work_item_ref)
        .where('implementation_job_id', '=', job.id).executeTakeFirst();
      if (Number(projection.numUpdatedRows) !== 1) {
        throw controlError('WORK_ITEM_BINDING_LOST', 'B 终态不能投影到其他版本或其他 job 的 work item', 409);
      }
    }
    return { ok: true };
  });
}

export async function failEvolutionJob(jobId: string, leaseOwner: string, leaseEpoch: number, allowedTaskIds: string[], errorCode: string, retryable: boolean, detail: unknown) {
  const code = validateBoundedString(errorCode, 'error_code', 128);
  const detailJson = serializeBoundedJson(detail, 'job failure detail');
  return withActiveJob(jobId, leaseOwner, leaseEpoch, allowedTaskIds, async (trx, job) => {
    const status = retryable && job.attempts < job.max_attempts ? 'queued' : retryable ? 'dead-letter' : 'failed';
    const updated = await trx.updateTable('evolution_jobs').set({
      status, error_code: code, result: detailJson, lease_owner: null, lease_expires_at: null, updated_at: nowIso(),
    }).where('id', '=', jobId).where('lease_owner', '=', leaseOwner).where('lease_epoch', '=', leaseEpoch)
      .where('status', 'in', ['leased', 'running']).where('lease_expires_at', '>', nowIso()).executeTakeFirst();
    if (Number(updated.numUpdatedRows) !== 1) throw controlError('LEASE_INVALID', 'job lease 已被其他请求终结或替换', 409);
    await trx.deleteFrom('evolution_resource_leases').where('job_id', '=', jobId).where('lease_epoch', '=', leaseEpoch).execute();
    await appendJobEvent(trx, jobId, status, leaseOwner, { error_code: code, detail });
    if (status !== 'queued') await enqueueEvidenceJobIn(trx, job, status, { error_code: code, detail });
    if (status !== 'queued') await freezeForEvidenceFailureIn(trx, job, code);
    const payload = parseJson<JobPayload>(job.payload, {});
    if (job.task_id === 'evolution.issue-implementation' && payload.work_item_ref) {
      await trx.updateTable('evolution_work_items').set({ status, updated_at: nowIso() })
        .where('environment', '=', job.environment).where('backlog_ref', '=', payload.work_item_ref)
        .where('implementation_job_id', '=', job.id).execute();
    }
    return { ok: true, status };
  });
}

export async function getCircuit(environment: EvolutionEnvironment) {
  return db.selectFrom('evolution_circuit').selectAll().where('environment', '=', environment).executeTakeFirstOrThrow();
}

export async function transitionCircuit(environment: EvolutionEnvironment, to: CircuitState, actor: 'monitor' | 'alert' | 'owner', reason: string, evidenceRef?: string) {
  validateBoundedString(reason, 'reason', 1000);
  const evidence = evidenceRef === undefined ? undefined : validateBoundedString(evidenceRef, 'evidence_ref', 1024);
  if (!['ACTIVE', 'DEGRADED', 'FROZEN', 'RECOVERING'].includes(to)) throw controlError('INVALID_CIRCUIT_STATE', '未知 circuit state');
  return db.transaction().execute(async (trx) => {
    await lockRuntimeIn(trx, environment);
    await lockCircuitIn(trx, environment);
    const current = await trx.selectFrom('evolution_circuit').selectAll().where('environment', '=', environment).executeTakeFirstOrThrow();
    const allowed = actor === 'owner'
      ? new Set(['ACTIVE:FROZEN', 'DEGRADED:FROZEN', 'RECOVERING:FROZEN', 'FROZEN:RECOVERING', 'RECOVERING:ACTIVE'])
      : new Set(['ACTIVE:DEGRADED', 'ACTIVE:FROZEN', 'DEGRADED:FROZEN', 'RECOVERING:FROZEN']);
    if (!allowed.has(`${current.state}:${to}`)) throw controlError('INVALID_CIRCUIT_TRANSITION', `${actor} 不允许 ${current.state} → ${to}`, 409);
    if (to === 'RECOVERING' || to === 'ACTIVE') {
      await requireRuntimeReady(trx, environment);
      if (!evidence) throw controlError('RECOVERY_EVIDENCE_REQUIRED', '恢复 circuit 必须绑定 evidence_ref', 409);
    }
    const updated = await trx.updateTable('evolution_circuit').set({
      state: to, reason, evidence_ref: evidence ?? null, updated_at: nowIso(),
    }).where('environment', '=', environment).where('state', '=', current.state).executeTakeFirst();
    if (Number(updated.numUpdatedRows) !== 1) throw controlError('CIRCUIT_RACE', 'circuit 已被并发请求修改，请重试', 409);
    await trx.insertInto('evolution_circuit_events').values({
      id: `ece_${randomUUID()}`, environment, from_state: current.state, to_state: to, actor,
      reason, evidence_ref: evidence ?? null,
    }).execute();
    await blockDisallowedJobsIn(trx, environment, to, actor, `CIRCUIT_${to}`);
    return trx.selectFrom('evolution_circuit').selectAll().where('environment', '=', environment).executeTakeFirstOrThrow();
  });
}

type IncidentInput = {
  fingerprint: string; environment: EvolutionEnvironment; service: string; severity: string; summary: string; resolved?: boolean;
};

function normalizeIncidentInput(input: IncidentInput): IncidentInput {
  const severity = validateBoundedString(input.severity, 'severity', 32);
  if (!['P0', 'P1', 'P2'].includes(severity)) throw controlError('INVALID_INCIDENT_SEVERITY', 'severity 只能是 P0、P1 或 P2');
  return {
    fingerprint: validateBoundedString(input.fingerprint, 'fingerprint', 256),
    environment: input.environment,
    service: validateBoundedString(input.service, 'service', 128),
    severity,
    summary: validateBoundedString(input.summary, 'summary', 4000),
    resolved: input.resolved === true,
  };
}

async function upsertIncidentIn(executor: DbExecutor, rawInput: IncidentInput) {
  const input = normalizeIncidentInput(rawInput);
  const id = `incident_${randomUUID()}`;
  const observedAt = nowIso();
  await executor.insertInto('evolution_incidents').values({
    id, fingerprint: input.fingerprint, environment: input.environment, service: input.service, severity: input.severity,
    summary: input.summary, status: input.resolved ? 'resolved' : 'open', resolved_at: input.resolved ? observedAt : null,
    last_seen_at: observedAt,
  }).onConflict((oc) => oc.columns(['fingerprint', 'environment']).doUpdateSet({
    occurrence_count: sql`evolution_incidents.occurrence_count + 1`, last_seen_at: observedAt,
    service: input.service, severity: input.severity, summary: input.summary,
    status: input.resolved ? 'resolved' : 'open', resolved_at: input.resolved ? observedAt : null,
  })).execute();
  return executor.selectFrom('evolution_incidents').selectAll().where('fingerprint', '=', input.fingerprint)
    .where('environment', '=', input.environment).executeTakeFirstOrThrow();
}

export async function upsertIncident(input: IncidentInput) {
  return db.transaction().execute((trx) => upsertIncidentIn(trx, input));
}

export async function upsertIncidentAndFreeze(input: IncidentInput & { evidence_ref: string }) {
  const evidenceRef = validateBoundedString(input.evidence_ref, 'evidence_ref', 1024);
  if (input.resolved) throw controlError('INVALID_INCIDENT_FREEZE', 'resolved incident 不能触发冻结', 409);
  const incidentInput = normalizeIncidentInput(input);
  return db.transaction().execute(async (trx) => {
    await lockCircuitIn(trx, incidentInput.environment);
    const previousIncident = await trx.selectFrom('evolution_incidents').select(['id', 'status'])
      .where('fingerprint', '=', incidentInput.fingerprint).where('environment', '=', incidentInput.environment).executeTakeFirst();
    const incident = await upsertIncidentIn(trx, incidentInput);
    const current = await trx.selectFrom('evolution_circuit').selectAll()
      .where('environment', '=', incidentInput.environment).executeTakeFirstOrThrow();
    if (current.state !== 'FROZEN') {
      const updated = await trx.updateTable('evolution_circuit').set({
        state: 'FROZEN', reason: `incident:${incidentInput.fingerprint}`, evidence_ref: evidenceRef, updated_at: nowIso(),
      }).where('environment', '=', incidentInput.environment).where('state', '=', current.state).executeTakeFirst();
      if (Number(updated.numUpdatedRows) !== 1) throw controlError('CIRCUIT_RACE', 'incident 冻结时 circuit 已被并发修改', 409);
      await trx.insertInto('evolution_circuit_events').values({
        id: `ece_${randomUUID()}`, environment: incidentInput.environment, from_state: current.state, to_state: 'FROZEN',
        actor: 'alert', reason: `incident:${incidentInput.fingerprint}`, evidence_ref: evidenceRef,
      }).execute();
    }
    await blockDisallowedJobsIn(trx, incidentInput.environment, 'FROZEN', 'alert', 'CIRCUIT_FROZEN');
    let responseJob: EvolutionJob | null = null;
    if (!previousIncident || previousIncident.status === 'resolved') {
      const responsePayload: JobPayload = {
        incident_id: incident.id,
        incident_fingerprint: incident.fingerprint,
        incident_service: incident.service,
        incident_severity: incident.severity,
        incident_summary: incident.summary,
        evidence_ref: evidenceRef,
      };
      const inputHash = sha256(responsePayload);
      responseJob = await enqueueEvolutionJobIn(trx, {
        task_id: 'ops.alert-response', environment: incidentInput.environment, input_hash: inputHash,
        idempotency_key: `alert-response:${incidentInput.environment}:${incident.id}:${incident.occurrence_count}`,
        max_attempts: 3, priority: 0, payload: responsePayload,
      });
    }
    const circuit = await trx.selectFrom('evolution_circuit').selectAll()
      .where('environment', '=', incidentInput.environment).executeTakeFirstOrThrow();
    return { incident, circuit, response_job: responseJob };
  });
}

export async function recordMetricSample(input: {
  environment: EvolutionEnvironment; metric: string; value: number; unit: string; dimensions?: Record<string, string>;
}) {
  const metric = validateBoundedString(input.metric, 'metric', 128);
  const unit = validateBoundedString(input.unit, 'unit', 64);
  if (!Number.isFinite(input.value)) throw controlError('INVALID_METRIC', 'metric value 必须是有限数字');
  const entries = Object.entries(input.dimensions ?? {});
  if (entries.length > 20) throw controlError('INVALID_METRIC_DIMENSIONS', 'metric dimensions 最多 20 项');
  const dimensions = Object.fromEntries(entries.map(([key, value]) => [
    validateBoundedString(key, 'metric dimension key', 64),
    validateBoundedString(value, 'metric dimension value', 256),
  ]));
  const id = `metric_${randomUUID()}`;
  await db.insertInto('evolution_metric_samples').values({
    id, environment: input.environment, metric, value: input.value, unit,
    dimensions: serializeBoundedJson(dimensions, 'metric dimensions', 8192),
  }).execute();
  return { id };
}

export async function reconcileEvolutionControlPlane(environment: EvolutionEnvironment) {
  const [activeJobs, resourceLeases, runtime, circuit] = await Promise.all([
    db.selectFrom('evolution_jobs').selectAll().where('environment', '=', environment).where('status', 'in', ['leased', 'running']).execute(),
    db.selectFrom('evolution_resource_leases').selectAll().where('environment', '=', environment).execute(),
    getRuntimeStateIn(db, environment), getCircuit(environment),
  ]);
  const activeIds = new Set(activeJobs.map((job) => job.id));
  const orphanLeases = resourceLeases.filter((lease) => !activeIds.has(lease.job_id) || lease.expires_at <= nowIso());
  const missingLeases = activeJobs.flatMap((job) => {
    const expected = normalizedStrings(parseJson<string[]>(job.lock_domains, []));
    const actual = new Set(resourceLeases.filter((lease) => lease.job_id === job.id && lease.lease_epoch === job.lease_epoch).map((lease) => lease.domain));
    return expected.filter((domain) => !actual.has(domain)).map((domain) => ({ job_id: job.id, domain, lease_epoch: job.lease_epoch }));
  });
  const duplicateWorkers = activeJobs.flatMap((job, index) => activeJobs.slice(index + 1)
    .filter((other) => other.lease_owner === job.lease_owner).map((other) => ({ lease_owner: job.lease_owner, job_ids: [job.id, other.id] })));
  const expiredJobs = activeJobs.filter((job) => !job.lease_expires_at || job.lease_expires_at <= nowIso()).map((job) => job.id);
  const forbiddenActive = activeJobs.filter((job) => !taskAllowedByCircuit(job.task_id, circuit.state as CircuitState)).map((job) => job.id);
  return {
    environment, checked_at: nowIso(), runtime, circuit_state: circuit.state,
    ok: !orphanLeases.length && !missingLeases.length && !duplicateWorkers.length && !expiredJobs.length && !forbiddenActive.length,
    active_jobs: activeJobs.length, active_resource_leases: resourceLeases.length,
    orphan_leases: orphanLeases.map(({ environment: _environment, ...lease }) => lease), missing_leases: missingLeases,
    duplicate_workers: duplicateWorkers, expired_jobs: expiredJobs, forbidden_active_jobs: forbiddenActive,
  };
}

export async function getEvolutionSnapshot(environment: EvolutionEnvironment) {
  const [circuit, runtime, openIncidents, unarchived, queued, active, deadLetter, oldestFeedback, metrics] = await Promise.all([
    getCircuit(environment), getRuntimeStateIn(db, environment),
    db.selectFrom('evolution_incidents').select(({ fn }) => fn.count<number>('id').as('count')).where('environment', '=', environment).where('status', '=', 'open').executeTakeFirstOrThrow(),
    db.selectFrom('proposals as p').leftJoin('feedback_archives as a', 'a.proposal_id', 'p.id').select(({ fn }) => fn.count<number>('p.id').as('count')).where('a.proposal_id', 'is', null).executeTakeFirstOrThrow(),
    db.selectFrom('evolution_jobs').select(({ fn }) => fn.count<number>('id').as('count')).where('environment', '=', environment).where('status', '=', 'queued').executeTakeFirstOrThrow(),
    db.selectFrom('evolution_jobs').select(({ fn }) => fn.count<number>('id').as('count')).where('environment', '=', environment).where('status', 'in', ['leased', 'running']).executeTakeFirstOrThrow(),
    db.selectFrom('evolution_jobs').select(({ fn }) => fn.count<number>('id').as('count')).where('environment', '=', environment).where('status', '=', 'dead-letter').executeTakeFirstOrThrow(),
    db.selectFrom('proposals as p').leftJoin('feedback_archives as a', 'a.proposal_id', 'p.id').select('p.created_at').where('a.proposal_id', 'is', null).orderBy('p.created_at', 'asc').executeTakeFirst(),
    db.selectFrom('evolution_metric_samples').select(['metric', 'value', 'unit', 'dimensions', 'observed_at']).where('environment', '=', environment)
      .orderBy('observed_at', 'desc').limit(500).execute(),
  ]);
  return {
    environment, checked_at: nowIso(), circuit, runtime, open_incidents: Number(openIncidents.count),
    feedback: { unarchived: Number(unarchived.count), oldest_unarchived_at: oldestFeedback?.created_at ?? null },
    jobs: { queued: Number(queued.count), active: Number(active.count), dead_letter: Number(deadLetter.count) }, metrics,
  };
}
