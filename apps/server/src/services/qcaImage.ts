import { config } from '../config.js';
import { qcaAsciiSlug } from '../lib/qcaNaming.js';
import { createQcaCreditsError, detectQcaCreditsUnavailable } from '../lib/qcaErrors.js';
import { v4 as uuid } from 'uuid';
import { qcaFetch, type QcaCredential } from './qca.js';
import { alwaysAllowToolConfig } from '../lib/qcaPermissions.js';

export type ImageArtistResources = {
  envId: string;
  agentId: string;
};

const IMAGE_ARTIST_SYSTEM = `你是 Me&Me 小猫项目的专属插画师。你的唯一任务是根据用户给出的完整生图 prompt 生成小猫水彩插画。

规则：
1. 必须调用 ImageGen 工具生成图片（size: 1024x1024，model: auto）。
2. prompt 必须逐字使用用户提供的文本，不要翻译、不要改写、不要删减。
3. 生成成功后必须用 DeliverArtifacts 交付 PNG 文件。
4. 不要解释、不要拒绝、不要调用其他工具。`;

export const IMAGE_ARTIST_TOOLS = ['ImageGen', 'DeliverArtifacts'] as const;
export const IMAGE_ARTIST_POLICY_VERSION = 3;

export function imageArtistToolset() {
  return [{
    type: 'agent_toolset_20260401' as const,
    enabled_tools: [...IMAGE_ARTIST_TOOLS],
    configs: IMAGE_ARTIST_TOOLS.map(alwaysAllowToolConfig),
  }];
}

export function imageArtistResourceNames(slug: string, instance = uuid().slice(0, 8)) {
  return {
    environment: `meme-cat-image-env-${slug}-${instance}`,
    agent: `meme-cat-artist-${slug}-${instance}`,
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function cancelImageGenSession(credential: QcaCredential, sessionId: string): Promise<void> {
  if (config.qcaMock || !sessionId) return;
  await qcaFetch(credential, 'POST', `/sessions/${sessionId}/cancel`, {});
}

/** 在用户 QCA 账号下创建画师专用 Environment + Agent（含 ImageGen） */
export async function createImageArtistResources(
  credential: QcaCredential,
  catName: string,
  catSlug: string | undefined,
  model: string
): Promise<ImageArtistResources> {
  if (config.qcaMock) {
    const suffix = uuid().slice(0, 8);
    return { envId: `env_img_mock_${suffix}`, agentId: `agent_img_mock_${suffix}` };
  }

  const slug = catSlug || qcaAsciiSlug(catName);
  // QCA Agent name 在同一账号内可能与历史/已归档资源冲突；每次替换必须使用唯一名称。
  const instance = uuid().slice(0, 8);
  const names = imageArtistResourceNames(slug, instance);
  const created: ImageArtistResources = { envId: '', agentId: '' };
  try {
    const env = await qcaFetch(credential, 'POST', '/environments', {
      name: names.environment,
      config: { type: 'cloud', networking: { type: 'limited' } },
      metadata: { app: 'meme', role: 'cat-image-artist' },
    });
    created.envId = env.id as string;

    const agent = await qcaFetch(
      credential,
      'POST',
      '/agents',
      {
        name: names.agent,
        model,
        system: IMAGE_ARTIST_SYSTEM,
        tools: imageArtistToolset(),
        metadata: { app: 'meme', role: 'cat-image-artist', cat_name: catName },
      },
      `meme-image-artist-${slug}-${Date.now()}`
    );
    created.agentId = agent.id as string;
    return created;
  } catch (error) {
    await archiveImageArtistResources(credential, created);
    throw error;
  }
}

export async function archiveImageArtistResources(credential: QcaCredential, ids: ImageArtistResources): Promise<void> {
  if (config.qcaMock) return;
  for (const [id, base] of [
    [ids.agentId, '/agents'],
    [ids.envId, '/environments'],
  ] as const) {
    if (!id) continue;
    try {
      await qcaFetch(credential, 'POST', `${base}/${id}/archive`, {});
    } catch {
      /* best effort */
    }
  }
}

type SessionEvent = Record<string, unknown>;

function extractFileIds(value: unknown, ids = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/file_[0-9a-z_-]{6,}/gi)) ids.add(match[0]);
  } else if (Array.isArray(value)) {
    for (const item of value) extractFileIds(item, ids);
  } else if (value && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) extractFileIds(nested, ids);
  }
  return ids;
}

function eventDiagnostic(event: SessionEvent) {
  const text = JSON.stringify(event).replace(/pt-[A-Za-z0-9_-]+/g, 'pt-***');
  return text.slice(0, 500);
}

/** 通过画师 Agent Session 调用 ImageGen，返回交付的 file_id */
export async function runImageGenSession(
  credential: QcaCredential,
  params: {
    envId: string; agentId: string; prompt: string; fileName: string; catName: string; kind: 'birth' | 'growth' | 'encounter';
    onSessionCreated?: (sessionId: string) => Promise<void>;
    isCancelled?: () => Promise<boolean>;
  }
): Promise<string> {
  if (config.qcaMock) {
    return `file_mock_${uuid().slice(0, 8)}`;
  }

  const sess = await qcaFetch(credential, 'POST', '/sessions', {
    agent: { id: params.agentId, type: 'agent' },
    environment_id: params.envId,
    title: `meme-cat-${params.kind}-${params.catName}`,
    metadata: { app: 'meme', kind: params.kind },
  });
  const sessionId = sess.id as string;
  await params.onSessionCreated?.(sessionId);
  if (await params.isCancelled?.()) {
    await cancelImageGenSession(credential, sessionId);
    throw Object.assign(new Error('用户已取消绘制'), { code: 'IMAGE_JOB_CANCELED' });
  }

  const imageLabel = params.kind === 'birth' ? '出生形象' : params.kind === 'encounter' ? '猫遇合照' : '成长形象';
  const msg = `请调用 ImageGen 为${params.catName}生成${imageLabel}水彩插画。

ImageGen 参数：
- name: ${params.fileName}
- size: 1024x1024
- model: auto
- prompt（必须逐字使用，禁止改写）：
${params.prompt}

生成成功后用 DeliverArtifacts 交付 PNG。`;

  await qcaFetch(credential, 'POST', `/sessions/${sessionId}/events`, {
    events: [{ type: 'user.message', content: [{ type: 'text', text: msg }] }],
  });

  let lastId: string | undefined;
  let deliveredFileId: string | null = null;
  let failureDetail = '';

  const deadline = Date.now() + config.imageWorker.sessionTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(4000);
    if (await params.isCancelled?.()) {
      await cancelImageGenSession(credential, sessionId);
      throw Object.assign(new Error('用户已取消绘制'), { code: 'IMAGE_JOB_CANCELED' });
    }
    const qs = lastId ? `?after_id=${lastId}&limit=50` : '?limit=50';
    const page = (await qcaFetch(credential, 'GET', `/sessions/${sessionId}/events${qs}`)) as {
      data?: SessionEvent[];
    };
    const events = page.data || [];

    for (const ev of events) {
      if (typeof ev.id === 'string') lastId = ev.id;

      const fileIds = [...extractFileIds(ev)];
      if (fileIds.length > 0) deliveredFileId = fileIds[fileIds.length - 1];

      if (typeof ev.type === 'string' && /error|failed/i.test(ev.type)) {
        failureDetail = eventDiagnostic(ev);
        if (detectQcaCreditsUnavailable(failureDetail, { source: 'image', imageGen: true })) {
          throw createQcaCreditsError({ source: 'image', imageGen: true }, failureDetail);
        }
      }
    }

    const status = (await qcaFetch(credential, 'GET', `/sessions/${sessionId}`)).status as string;
    if (/failed|error|cancelled/i.test(status)) {
      throw new Error(`QCA ImageGen Session ${status}${failureDetail ? `: ${failureDetail}` : ''}`);
    }
    if (status === 'idle' || status === 'terminated') break;
  }

  if (!deliveredFileId && Date.now() >= deadline) {
    try { await cancelImageGenSession(credential, sessionId); } catch { /* best effort */ }
    throw Object.assign(new Error('云端画师绘制超时'), { code: 'IMAGE_SESSION_TIMEOUT' });
  }

  if (!deliveredFileId) {
    // 回退：从最近 session 关联 files 里找
    const files = (await qcaFetch(credential, 'GET', '/files?limit=10')) as {
      data?: Array<{ id: string; scope?: { id?: string }; filename?: string }>;
    };
    const hit = (files.data || []).find(
      (f) => f.scope?.id === sessionId || f.filename?.includes(params.fileName)
    );
    if (hit) deliveredFileId = hit.id;
  }

  if (!deliveredFileId) {
    if (failureDetail && detectQcaCreditsUnavailable(failureDetail, { source: 'image', imageGen: true })) {
      throw createQcaCreditsError({ source: 'image', imageGen: true }, failureDetail);
    }
    throw new Error(`QCA ImageGen Session 未交付图片文件${failureDetail ? `: ${failureDetail}` : ''}`);
  }
  return deliveredFileId;
}

/** 从 QCA Files API 下载 PNG 二进制 */
export async function downloadQcaFile(credential: QcaCredential, fileId: string): Promise<Buffer> {
  if (config.qcaMock) {
    return Buffer.alloc(0);
  }
  let meta: { url?: string } | null = null;
  for (const endpoint of [`/files/${fileId}/content`, `/files/${fileId}/download`]) {
    try {
      meta = (await qcaFetch(credential, 'GET', endpoint)) as { url?: string };
      if (meta.url) break;
    } catch {
      /* try next */
    }
  }
  if (!meta?.url) throw new Error(`QCA file ${fileId} 无下载 URL`);
  const res = await fetch(meta.url);
  if (!res.ok) throw new Error(`下载 QCA 文件失败: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
