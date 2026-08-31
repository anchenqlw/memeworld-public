import { v4 as uuid } from 'uuid';
import { config } from '../config.js';
import { QcaApiError, qcaFetch, type QcaCredential } from './qca.js';

export async function createTravelSession(
  credential: QcaCredential,
  params: {
    agentId: string;
    envId: string;
    memstoreId: string;
    serverUrl: string;
    catToken: string;
    title?: string;
  },
): Promise<string> {
  if (config.qcaMock) return `session_mock_${uuid().slice(0, 8)}`;

  const session = await qcaFetch(credential, 'POST', '/sessions', {
    agent: params.agentId,
    environment_id: params.envId,
    title: params.title || `meme-daily-travel-${params.agentId.slice(-8)}`,
    environment_variables: `SERVER_URL=${params.serverUrl};CAT_TOKEN=${params.catToken}`,
    resources: [{
      type: 'memory_store',
      memory_store_id: params.memstoreId,
      access: 'read_write',
      instructions: '你的长期记忆，按任务要求读写',
    }],
    metadata: { app: 'meme', role: 'travel' },
  });
  return session.id as string;
}

export async function getTravelSessionStatus(credential: QcaCredential, sessionId: string) {
  if (config.qcaMock) return { status: 'idle', archived_at: null as string | null };
  return await qcaFetch(credential, 'GET', `/sessions/${sessionId}`) as {
    status?: string;
    archived_at?: string | null;
  };
}

/** 复用已有 Session；仅在缺失/归档/404 时新建（需传入新 token 以注入环境变量） */
export async function ensureTravelSession(
  credential: QcaCredential,
  params: {
    agentId: string;
    envId: string;
    memstoreId: string;
    serverUrl: string;
    catToken: string;
    existingSessionId?: string | null;
    forceRecreate?: boolean;
  },
): Promise<string> {
  if (!params.forceRecreate && params.existingSessionId) {
    try {
      const session = await getTravelSessionStatus(credential, params.existingSessionId);
      if (!session.archived_at && session.status !== 'archived') {
        return params.existingSessionId;
      }
    } catch (error) {
      if (!(error instanceof QcaApiError && error.status === 404)) throw error;
    }
  }

  return createTravelSession(credential, params);
}

export async function sendTravelTaskEvent(
  credential: QcaCredential,
  sessionId: string,
  taskInstruction: string,
): Promise<void> {
  if (config.qcaMock) return;
  await qcaFetch(credential, 'POST', `/sessions/${sessionId}/events`, {
    events: [{ type: 'user.message', content: [{ type: 'text', text: taskInstruction }] }],
  });
}
