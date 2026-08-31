import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { hasEvolutionScope, requireEvolutionScope } from '../lib/evolutionAuth.js';
import {
  archiveFeedbackClaim,
  authorizeAndEnqueueWorkItem,
  claimEvolutionJob,
  claimFeedback,
  completeEvolutionJob,
  createOwnerApproval,
  describeWorkItemScope,
  enqueueEvolutionJob,
  failEvolutionJob,
  failFeedbackClaim,
  getCircuit,
  getEvolutionRuntimeState,
  getEvolutionSnapshot,
  getStandingPolicyDescriptor,
  heartbeatEvolutionJob,
  heartbeatFeedbackClaim,
  reconcileEvolutionControlPlane,
  reconcileFeedback,
  recordMetricSample,
  revokeOwnerApproval,
  transitionCircuit,
  updateEvolutionRuntimeState,
  upsertEvolutionWorkItem,
  upsertFeedbackCluster,
  upsertIncident,
  upsertIncidentAndFreeze,
  type CircuitState,
  type EvolutionEnvironment,
  type JobPayload,
} from '../services/evolutionControlPlane.js';

function environment(value: unknown): EvolutionEnvironment {
  if (value !== 'staging' && value !== 'production') {
    throw Object.assign(new Error('environment 必须是 staging 或 production'), { code: 'INVALID_ENVIRONMENT' });
  }
  if ((config.nodeEnv === 'staging' || config.nodeEnv === 'production') && value !== config.nodeEnv) {
    throw Object.assign(new Error(`部署环境 ${config.nodeEnv} 不允许操作 ${value} 控制面`), { code: 'ENVIRONMENT_BINDING_MISMATCH', status: 409 });
  }
  return value;
}

function respondError(reply: FastifyReply, error: unknown) {
  const typed = error as { status?: number; code?: string; message?: string };
  return reply.status(typed.status ?? 400).send({
    error: { code: typed.code ?? 'CONTROL_PLANE_ERROR', message: typed.message ?? '控制面请求失败' },
  });
}

function hasAnyScope(req: FastifyRequest, reply: FastifyReply, scopes: Parameters<typeof hasEvolutionScope>[1][]) {
  if (scopes.some((scope) => hasEvolutionScope(req, scope))) return true;
  reply.status(403).send({ error: { code: 'FORBIDDEN', message: '缺少所需 scoped identity' } });
  return false;
}

function requireWorker(req: FastifyRequest, reply: FastifyReply) {
  if (hasEvolutionScope(req, 'worker:triage')) return { taskIds: ['evolution.daily-triage'] };
  if (hasEvolutionScope(req, 'worker:development')) return { taskIds: ['evolution.issue-implementation'] };
  if (hasEvolutionScope(req, 'worker:review')) return { taskIds: ['evolution.pr-assurance'] };
  if (hasEvolutionScope(req, 'worker:orchestrator')) return {
    taskIds: ['evolution.control-plane-audit', 'evolution.evidence-writer', 'evolution.weekly-delivery-review'],
  };
  if (hasEvolutionScope(req, 'worker:release')) return { taskIds: ['ops.deploy'] };
  if (hasEvolutionScope(req, 'monitor')) return { taskIds: ['ops.health-check', 'ops.synthetic-e2e', 'ops.capacity-product-review'] };
  if (hasEvolutionScope(req, 'alert')) return { taskIds: ['ops.alert-response'] };
  reply.status(403).send({ error: { code: 'FORBIDDEN', message: '缺少独立 worker identity' } });
  return null;
}

export function registerEvolutionRoutes(app: FastifyInstance) {
  app.get('/api/v1/internal/evolution/v2/feedback/claim', async (req, reply) => {
    if (!requireEvolutionScope(req, reply, 'feedback:read')) return;
    try {
      const query = req.query as { environment?: string; lease_owner?: string; limit?: string; lease_seconds?: string };
      if (!query.lease_owner?.trim()) return reply.status(400).send({ error: { code: 'LEASE_OWNER_REQUIRED' } });
      return await claimFeedback(environment(query.environment), query.lease_owner, Number(query.limit || 50), Number(query.lease_seconds || 1200));
    } catch (error) { return respondError(reply, error); }
  });

  app.post('/api/v1/internal/evolution/v2/feedback/:id/heartbeat', async (req, reply) => {
    if (!requireEvolutionScope(req, reply, 'feedback:read')) return;
    try {
      const body = req.body as { environment?: string; lease_owner?: string; lease_epoch?: number; lease_seconds?: number };
      if (!body.lease_owner || !Number.isInteger(body.lease_epoch)) return reply.status(400).send({ error: { code: 'LEASE_FENCE_REQUIRED' } });
      return await heartbeatFeedbackClaim(environment(body.environment), (req.params as { id: string }).id,
        body.lease_owner, body.lease_epoch!, body.lease_seconds);
    } catch (error) { return respondError(reply, error); }
  });

  app.post('/api/v1/internal/evolution/v2/feedback/:id/fail', async (req, reply) => {
    if (!requireEvolutionScope(req, reply, 'feedback:archive')) return;
    try {
      const body = req.body as { environment?: string; lease_owner?: string; lease_epoch?: number; error_code?: string; retryable?: boolean };
      if (!body.lease_owner || !Number.isInteger(body.lease_epoch) || !body.error_code) {
        return reply.status(400).send({ error: { code: 'INVALID_FAILURE' } });
      }
      return await failFeedbackClaim(environment(body.environment), (req.params as { id: string }).id,
        body.lease_owner, body.lease_epoch!, body.error_code, body.retryable === true);
    } catch (error) { return respondError(reply, error); }
  });

  app.post('/api/v1/internal/evolution/v2/feedback/archive', async (req, reply) => {
    if (!requireEvolutionScope(req, reply, 'feedback:archive')) return;
    try {
      const body = req.body as {
        environment?: string; claim_id?: string; lease_owner?: string; lease_epoch?: number;
        artifacts?: Array<{ proposal_id: string; event_id: string; archive_commit_sha: string; idempotency_key: string; sanitized_ref: string; sanitized_sha256: string }>;
      };
      if (!body.claim_id || !body.lease_owner || !Number.isInteger(body.lease_epoch)) {
        return reply.status(400).send({ error: { code: 'LEASE_FENCE_REQUIRED' } });
      }
      return await archiveFeedbackClaim(environment(body.environment), body.claim_id, body.lease_owner,
        body.lease_epoch!, body.artifacts ?? []);
    } catch (error) { return respondError(reply, error); }
  });

  app.get('/api/v1/internal/evolution/v2/feedback/reconcile', async (req, reply) => {
    if (!hasAnyScope(req, reply, ['feedback:read', 'monitor', 'control', 'worker:orchestrator'])) return;
    try { return await reconcileFeedback(environment((req.query as { environment?: string }).environment)); }
    catch (error) { return respondError(reply, error); }
  });

  app.post('/api/v1/internal/evolution/v2/jobs', async (req, reply) => {
    if (!requireEvolutionScope(req, reply, 'control')) return;
    try {
      const body = req.body as Parameters<typeof enqueueEvolutionJob>[0];
      return await enqueueEvolutionJob({ ...body, environment: environment(body.environment) });
    } catch (error) { return respondError(reply, error); }
  });

  app.post('/api/v1/internal/evolution/v2/work-item-scope', async (req, reply) => {
    if (!hasAnyScope(req, reply, ['control', 'owner:approve'])) return;
    try {
      const body = req.body as { subject?: string; payload?: JobPayload };
      return describeWorkItemScope(String(body.subject ?? ''), body.payload ?? {});
    } catch (error) { return respondError(reply, error); }
  });

  app.post('/api/v1/internal/evolution/v2/work-items/authorize', async (req, reply) => {
    if (!requireEvolutionScope(req, reply, 'owner:approve')) return;
    try {
      const body = req.body as Parameters<typeof authorizeAndEnqueueWorkItem>[0];
      return await authorizeAndEnqueueWorkItem({ ...body, environment: environment(body.environment) });
    } catch (error) { return respondError(reply, error); }
  });

  app.post('/api/v1/internal/evolution/v2/clusters', async (req, reply) => {
    if (!requireEvolutionScope(req, reply, 'worker:triage')) return;
    try {
      const body = req.body as Parameters<typeof upsertFeedbackCluster>[0];
      return await upsertFeedbackCluster({ ...body, environment: environment(body.environment) });
    } catch (error) { return respondError(reply, error); }
  });

  app.post('/api/v1/internal/evolution/v2/work-items', async (req, reply) => {
    if (!requireEvolutionScope(req, reply, 'worker:triage')) return;
    try {
      const body = req.body as Parameters<typeof upsertEvolutionWorkItem>[0];
      return await upsertEvolutionWorkItem({ ...body, environment: environment(body.environment) });
    } catch (error) { return respondError(reply, error); }
  });

  app.get('/api/v1/internal/evolution/v2/standing-policy', async (req, reply) => {
    if (!hasAnyScope(req, reply, ['control', 'owner:approve'])) return;
    try {
      const query = req.query as { version?: string; environment?: string };
      return getStandingPolicyDescriptor(String(query.version ?? ''), environment(query.environment));
    } catch (error) { return respondError(reply, error); }
  });

  app.post('/api/v1/internal/evolution/v2/jobs/claim', async (req, reply) => {
    const worker = requireWorker(req, reply);
    if (!worker) return;
    try {
      const body = req.body as { environment?: string; lease_owner?: string; task_ids?: string[]; lease_seconds?: number };
      if (!body.lease_owner || !body.task_ids?.length || body.task_ids.some((taskId) => !worker.taskIds.includes(taskId))) {
        return reply.status(400).send({ error: { code: 'INVALID_CLAIM', message: 'worker 只能领取本角色任务' } });
      }
      return { job: await claimEvolutionJob(environment(body.environment), body.lease_owner, body.task_ids, body.lease_seconds) };
    } catch (error) { return respondError(reply, error); }
  });

  app.post('/api/v1/internal/evolution/v2/jobs/:id/heartbeat', async (req, reply) => {
    const worker = requireWorker(req, reply);
    if (!worker) return;
    try {
      const body = req.body as { lease_owner?: string; lease_epoch?: number; lease_seconds?: number; budget_used?: number };
      if (!body.lease_owner || !Number.isInteger(body.lease_epoch)) return reply.status(400).send({ error: { code: 'LEASE_FENCE_REQUIRED' } });
      return await heartbeatEvolutionJob((req.params as { id: string }).id, body.lease_owner, body.lease_epoch!, worker.taskIds, body.lease_seconds, body.budget_used);
    } catch (error) { return respondError(reply, error); }
  });

  app.post('/api/v1/internal/evolution/v2/jobs/:id/complete', async (req, reply) => {
    const worker = requireWorker(req, reply);
    if (!worker) return;
    try {
      const body = req.body as { lease_owner?: string; lease_epoch?: number; result?: unknown };
      if (!body.lease_owner || !Number.isInteger(body.lease_epoch)) return reply.status(400).send({ error: { code: 'LEASE_FENCE_REQUIRED' } });
      return await completeEvolutionJob((req.params as { id: string }).id, body.lease_owner, body.lease_epoch!, worker.taskIds, body.result);
    } catch (error) { return respondError(reply, error); }
  });

  app.post('/api/v1/internal/evolution/v2/jobs/:id/fail', async (req, reply) => {
    const worker = requireWorker(req, reply);
    if (!worker) return;
    try {
      const body = req.body as { lease_owner?: string; lease_epoch?: number; error_code?: string; retryable?: boolean; detail?: unknown };
      if (!body.lease_owner || !Number.isInteger(body.lease_epoch) || !body.error_code) return reply.status(400).send({ error: { code: 'INVALID_FAILURE' } });
      return await failEvolutionJob((req.params as { id: string }).id, body.lease_owner, body.lease_epoch!, worker.taskIds, body.error_code, body.retryable === true, body.detail);
    } catch (error) { return respondError(reply, error); }
  });

  app.post('/api/v1/internal/evolution/v2/approvals', async (req, reply) => {
    if (!requireEvolutionScope(req, reply, 'owner:approve')) return;
    try {
      const body = req.body as Parameters<typeof createOwnerApproval>[0] & { actor?: string };
      return await createOwnerApproval({
        action: body.action, subject: body.subject, scope_hash: body.scope_hash,
        environment: environment(body.environment), expires_at: body.expires_at,
      });
    } catch (error) { return respondError(reply, error); }
  });

  app.post('/api/v1/internal/evolution/v2/approvals/:id/revoke', async (req, reply) => {
    if (!requireEvolutionScope(req, reply, 'owner:approve')) return;
    try {
      const body = req.body as { reason?: string };
      return await revokeOwnerApproval((req.params as { id: string }).id, String(body.reason ?? ''));
    } catch (error) { return respondError(reply, error); }
  });

  app.get('/api/v1/internal/evolution/v2/runtime', async (req, reply) => {
    if (!hasAnyScope(req, reply, ['monitor', 'control', 'owner:approve', 'worker:orchestrator'])) return;
    try { return await getEvolutionRuntimeState(environment((req.query as { environment?: string }).environment)); }
    catch (error) { return respondError(reply, error); }
  });

  app.put('/api/v1/internal/evolution/v2/runtime', async (req, reply) => {
    if (!requireEvolutionScope(req, reply, 'owner:approve')) return;
    try {
      const body = req.body as Parameters<typeof updateEvolutionRuntimeState>[0];
      return await updateEvolutionRuntimeState({ ...body, environment: environment(body.environment) });
    } catch (error) { return respondError(reply, error); }
  });

  app.get('/api/v1/internal/evolution/v2/circuit', async (req, reply) => {
    if (!hasAnyScope(req, reply, ['monitor', 'alert', 'control', 'owner:approve', 'worker:orchestrator'])) return;
    try { return await getCircuit(environment((req.query as { environment?: string }).environment)); }
    catch (error) { return respondError(reply, error); }
  });

  app.post('/api/v1/internal/evolution/v2/circuit/transition', async (req, reply) => {
    const actor = hasEvolutionScope(req, 'owner:approve') ? 'owner' : hasEvolutionScope(req, 'alert') ? 'alert' : hasEvolutionScope(req, 'monitor') ? 'monitor' : null;
    if (!actor) return reply.status(403).send({ error: { code: 'FORBIDDEN', message: '缺少 circuit scope' } });
    try {
      const body = req.body as { environment?: string; to?: CircuitState; reason?: string; evidence_ref?: string };
      if (!body.to || !body.reason) return reply.status(400).send({ error: { code: 'INVALID_TRANSITION' } });
      return await transitionCircuit(environment(body.environment), body.to, actor, body.reason, body.evidence_ref);
    } catch (error) { return respondError(reply, error); }
  });

  app.post('/api/v1/internal/evolution/v2/incidents', async (req, reply) => {
    if (!requireEvolutionScope(req, reply, 'alert')) return;
    try {
      const body = req.body as Parameters<typeof upsertIncident>[0];
      return await upsertIncident({ ...body, environment: environment(body.environment) });
    } catch (error) { return respondError(reply, error); }
  });

  app.post('/api/v1/internal/evolution/v2/incidents/freeze', async (req, reply) => {
    if (!requireEvolutionScope(req, reply, 'alert')) return;
    try {
      const body = req.body as Parameters<typeof upsertIncidentAndFreeze>[0];
      return await upsertIncidentAndFreeze({ ...body, environment: environment(body.environment) });
    } catch (error) { return respondError(reply, error); }
  });

  app.post('/api/v1/internal/evolution/v2/metrics', async (req, reply) => {
    if (!requireEvolutionScope(req, reply, 'monitor')) return;
    try {
      const body = req.body as Parameters<typeof recordMetricSample>[0];
      return await recordMetricSample({ ...body, environment: environment(body.environment) });
    } catch (error) { return respondError(reply, error); }
  });

  app.get('/api/v1/internal/evolution/v2/snapshot', async (req, reply) => {
    if (!hasAnyScope(req, reply, ['monitor', 'alert', 'control', 'worker:orchestrator'])) return;
    try { return await getEvolutionSnapshot(environment((req.query as { environment?: string }).environment)); }
    catch (error) { return respondError(reply, error); }
  });

  app.get('/api/v1/internal/evolution/v2/reconcile', async (req, reply) => {
    if (!hasAnyScope(req, reply, ['monitor', 'control', 'worker:orchestrator'])) return;
    try { return await reconcileEvolutionControlPlane(environment((req.query as { environment?: string }).environment)); }
    catch (error) { return respondError(reply, error); }
  });
}
