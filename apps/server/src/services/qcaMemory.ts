import { config } from '../config.js';
import { QcaApiError, qcaFetch, type QcaCredential } from './qca.js';

/** 凭证文件路径（Memory Store 备份；主路径为 Session environment_variables） */
const SESSION_ENV_PATH = 'session.env';

export function travelSessionEnvPath() {
  return `/data/.qoder/awareness/${SESSION_ENV_PATH}`;
}

function renderSessionEnv(serverUrl: string, catToken: string) {
  return `SERVER_URL=${serverUrl}\nCAT_TOKEN=${catToken}\n`;
}

function renderBootstrapProfile(params: {
  catName: string;
  personality: string;
  ownerNickname: string;
  attrs: { courage: number; curiosity: number; affinity: number; insight: number };
}) {
  return `# ${params.catName}

- 主人：${params.ownerNickname}
- 性格：${params.personality}
- 出生天性（总分 20）：勇气 ${params.attrs.courage} / 好奇 ${params.attrs.curiosity} / 亲和 ${params.attrs.affinity} / 洞察 ${params.attrs.insight}

> 由 Me&Me 在首次探险前写入；后续旅行请在此基础上续写 journal 与 impressions。
`;
}

type MemoryListItem = { id: string; path: string };

async function listMemoryEntries(credential: QcaCredential, memstoreId: string, pathPrefix?: string) {
  const query = pathPrefix
    ? `?limit=100&path_prefix=${encodeURIComponent(pathPrefix)}`
    : '?limit=100';
  const list = await qcaFetch(credential, 'GET', `/memory_stores/${memstoreId}/memories${query}`) as {
    data?: MemoryListItem[];
  };
  return list.data ?? [];
}

export async function findMemoryByPath(credential: QcaCredential, memstoreId: string, entryPath: string) {
  const prefix = entryPath.includes('/') ? `${entryPath.split('/')[0]}/` : undefined;
  const entries = await listMemoryEntries(credential, memstoreId, prefix);
  return entries.find((entry) => entry.path === entryPath);
}

export async function upsertMemoryEntry(
  credential: QcaCredential,
  memstoreId: string,
  entryPath: string,
  content: string,
) {
  const existing = await findMemoryByPath(credential, memstoreId, entryPath);
  if (existing) {
    await qcaFetch(credential, 'POST', `/memory_stores/${memstoreId}/memories/${existing.id}`, { content });
    return existing.id;
  }
  const created = await qcaFetch(credential, 'POST', `/memory_stores/${memstoreId}/memories`, { path: entryPath, content }) as {
    id?: string;
  };
  return created.id;
}

export async function deleteMemoryEntry(credential: QcaCredential, memstoreId: string, entryPath: string) {
  const existing = await findMemoryByPath(credential, memstoreId, entryPath);
  if (existing?.id) await qcaFetch(credential, 'DELETE', `/memory_stores/${memstoreId}/memories/${existing.id}`);
}

async function ensureMemoryEntry(
  credential: QcaCredential,
  memstoreId: string,
  entryPath: string,
  content: string,
) {
  const existing = await findMemoryByPath(credential, memstoreId, entryPath);
  if (existing) return;
  await qcaFetch(credential, 'POST', `/memory_stores/${memstoreId}/memories`, { path: entryPath, content });
}

async function assertMemoryReadable(credential: QcaCredential, memstoreId: string, entryPath: string) {
  const entry = await findMemoryByPath(credential, memstoreId, entryPath);
  if (!entry?.id) {
    throw new QcaApiError(`Memory Store 写入后找不到 ${entryPath}`, 'QCA_API_ERROR');
  }
  const full = await qcaFetch(credential, 'GET', `/memory_stores/${memstoreId}/memories/${entry.id}`) as {
    content?: string;
  };
  if (!full.content?.includes('SERVER_URL=') || !full.content.includes('CAT_TOKEN=')) {
    throw new QcaApiError(`Memory Store ${entryPath} 内容不完整`, 'QCA_API_ERROR');
  }
}

/** 在每次 run 前写入 API 凭证与首旅记忆，避免 Agent 在 Bash 里读不到 Deployment 环境变量 */
export async function bootstrapTravelMemory(
  credential: QcaCredential,
  memstoreId: string,
  params: {
    serverUrl: string;
    catToken: string;
    catName: string;
    personality: string;
    ownerNickname: string;
    attrs: { courage: number; curiosity: number; affinity: number; insight: number };
  },
) {
  if (config.qcaMock) return;
  await upsertMemoryEntry(
    credential,
    memstoreId,
    SESSION_ENV_PATH,
    renderSessionEnv(params.serverUrl, params.catToken),
  );
  await assertMemoryReadable(credential, memstoreId, SESSION_ENV_PATH);
  await ensureMemoryEntry(credential, memstoreId, 'profile.md', renderBootstrapProfile(params));
  await ensureMemoryEntry(credential, memstoreId, 'impressions.md', '# 世界印象\n\n（待第一次旅行后填写）\n');
}
