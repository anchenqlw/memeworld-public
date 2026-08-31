import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';

export type EvolutionScope = 'feedback:read' | 'feedback:archive' | 'worker:triage' | 'control' | 'worker:development' | 'worker:review' | 'worker:orchestrator' | 'worker:release' | 'monitor' | 'alert' | 'owner:approve';

const scopeTokens: Record<EvolutionScope, () => string> = {
  'feedback:read': () => config.evolution.feedbackReadToken,
  'feedback:archive': () => config.evolution.feedbackWriteToken,
  'worker:triage': () => config.evolution.triageToken,
  control: () => config.evolution.controlToken,
  'worker:development': () => config.evolution.developmentToken,
  'worker:review': () => config.evolution.reviewToken,
  'worker:orchestrator': () => config.evolution.orchestratorToken,
  'worker:release': () => config.evolution.releaseToken,
  monitor: () => config.evolution.monitorToken,
  alert: () => config.evolution.alertToken,
  'owner:approve': () => config.evolution.ownerApprovalToken,
};

function equalToken(actual: string, expected: string) {
  if (!actual || !expected) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function hasEvolutionScope(req: FastifyRequest, scope: EvolutionScope) {
  if (!config.evolution.enabled) return false;
  const authorization = req.headers.authorization || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  return equalToken(token, scopeTokens[scope]());
}

export function requireEvolutionScope(req: FastifyRequest, reply: FastifyReply, scope: EvolutionScope) {
  if (!config.evolution.enabled) {
    reply.status(503).send({ error: { code: 'CONTROL_PLANE_DISABLED', message: '自进化控制面尚未启用' } });
    return false;
  }
  if (!hasEvolutionScope(req, scope)) {
    reply.status(403).send({ error: { code: 'FORBIDDEN', message: `缺少 ${scope} scope` } });
    return false;
  }
  return true;
}
