import { config } from '../config.js';
import { qcaAsciiSlug } from '../lib/qcaNaming.js';
import { qcaFetch, type QcaCredential } from './qca.js';
import { forwardFetch } from './qcaForward.js';
import { bootstrapTravelMemory } from './qcaMemory.js';

export type ForwardRegistryResourceType = 'memory_store' | 'environment' | 'file' | 'vault';

type MemoryStoreRow = {
  id: string;
  name?: string;
  metadata?: Record<string, string>;
};

const MEME_MANAGED_BY = 'meme-server';

function metadataString(meta: Record<string, unknown> | undefined, key: string) {
  const value = meta?.[key];
  return typeof value === 'string' ? value : undefined;
}

/** Forward Resources Registry 只读列举（POST 注册当前平台返回 405，登记通过 metadata + Template resources 关联） */
export async function listForwardRegistryResources(
  credential: QcaCredential,
  type: ForwardRegistryResourceType,
) {
  if (config.qcaMock) return [];
  const page = await forwardFetch(
    credential,
    'GET',
    `/resources?type=${encodeURIComponent(type)}&limit=100`,
  ) as { data?: Array<{ id?: string; type?: string; memory_store_id?: string }> };
  return page.data ?? [];
}

async function listCloudMemoryStores(credential: QcaCredential) {
  if (config.qcaMock) return [] as MemoryStoreRow[];
  const page = await qcaFetch(credential, 'GET', '/memory_stores?limit=100') as {
    data?: MemoryStoreRow[];
  };
  return page.data ?? [];
}

/** Identity 在 Forward Session 中实际挂载的记忆库（通常为 managed_by=forward-service 的 System Default Memory） */
export async function resolveIdentityForwardMemoryStore(
  credential: QcaCredential,
  identityId: string,
) {
  if (config.qcaMock) return null;
  const stores = await listCloudMemoryStores(credential);
  const forwardManaged = stores.find((store) =>
    metadataString(store.metadata, 'forward_identity_id') === identityId
    && metadataString(store.metadata, 'managed_by') === 'forward-service',
  );
  if (forwardManaged) return forwardManaged.id;

  const memeOwned = stores.find((store) =>
    metadataString(store.metadata, 'forward_identity_id') === identityId
    && metadataString(store.metadata, 'managed_by') === MEME_MANAGED_BY,
  );
  return memeOwned?.id ?? null;
}

async function findMemstoreByCatId(credential: QcaCredential, catId: string) {
  const stores = await listCloudMemoryStores(credential);
  return stores.find((store) => metadataString(store.metadata, 'cat_id') === catId)?.id ?? null;
}

async function assertMemstoreReadable(credential: QcaCredential, memstoreId: string) {
  await qcaFetch(credential, 'GET', `/memory_stores/${memstoreId}`);
}

async function tagMemstoreForForward(
  credential: QcaCredential,
  memstoreId: string,
  params: { catId: string; identityId: string; catName: string },
) {
  if (config.qcaMock) return;
  await qcaFetch(credential, 'POST', `/memory_stores/${memstoreId}`, {
    metadata: {
      app: 'meme',
      cat_id: params.catId,
      forward_identity_id: params.identityId,
      managed_by: MEME_MANAGED_BY,
      logical_name: `meme-cat-memory-${qcaAsciiSlug(params.catName)}`,
    },
  }).catch(() => undefined);
}

/** 尽力将 Memory Store 挂到 Forward Template（平台忽略未知字段时不报错） */
export async function linkMemoryStoreToForwardTemplate(
  credential: QcaCredential,
  templateId: string,
  memstoreId: string,
) {
  if (config.qcaMock) return;
  await forwardFetch(credential, 'POST', `/templates/${templateId}`, {
    resources: [{
      type: 'memory_store',
      memory_store_id: memstoreId,
      access: 'read_write',
      instructions: 'Me&Me 小猫长期记忆：profile、journal、impressions、session.env',
    }],
  }).catch(() => undefined);
}

export async function ensureIdentityMemoryStore(
  credential: QcaCredential,
  params: {
    catId: string;
    catName: string;
    identityId: string;
    existingMemstoreId?: string | null;
    travelTemplateId?: string | null;
  },
): Promise<string> {
  if (config.qcaMock) return params.existingMemstoreId || `memstore_mock_${params.catId.slice(0, 8)}`;

  if (params.existingMemstoreId) {
    try {
      await assertMemstoreReadable(credential, params.existingMemstoreId);
      await tagMemstoreForForward(credential, params.existingMemstoreId, params);
      if (params.travelTemplateId) {
        await linkMemoryStoreToForwardTemplate(credential, params.travelTemplateId, params.existingMemstoreId);
      }
      return params.existingMemstoreId;
    } catch {
      /* fall through */
    }
  }

  const byCat = await findMemstoreByCatId(credential, params.catId);
  if (byCat) {
    await tagMemstoreForForward(credential, byCat, params);
    if (params.travelTemplateId) await linkMemoryStoreToForwardTemplate(credential, params.travelTemplateId, byCat);
    return byCat;
  }

  const forwardMounted = await resolveIdentityForwardMemoryStore(credential, params.identityId);
  if (forwardMounted) {
    await tagMemstoreForForward(credential, forwardMounted, params);
    if (params.travelTemplateId) {
      await linkMemoryStoreToForwardTemplate(credential, params.travelTemplateId, forwardMounted);
    }
    return forwardMounted;
  }

  const slug = params.catId.slice(0, 8);
  const created = await qcaFetch(credential, 'POST', '/memory_stores', {
    name: `meme-cat-memory-${slug}`,
    description: `Me&Me 小猫「${params.catName}」的长期记忆`,
    metadata: {
      app: 'meme',
      cat_id: params.catId,
      forward_identity_id: params.identityId,
      managed_by: MEME_MANAGED_BY,
    },
  }) as { id?: string };
  const memstoreId = created.id;
  if (!memstoreId) throw new Error('创建 Memory Store 失败');

  await tagMemstoreForForward(credential, memstoreId, params);
  if (params.travelTemplateId) {
    await linkMemoryStoreToForwardTemplate(credential, params.travelTemplateId, memstoreId);
  }
  return memstoreId;
}

/** 写入凭证与首旅记忆：canonical store + Identity 实际挂载 store（若不同则双写） */
export async function bootstrapForwardTravelMemory(
  credential: QcaCredential,
  params: {
    memstoreId: string;
    identityId: string;
    serverUrl: string;
    catToken: string;
    catName: string;
    personality: string;
    ownerNickname: string;
    attrs: { courage: number; curiosity: number; affinity: number; insight: number };
  },
) {
  if (config.qcaMock) return params.memstoreId;

  const targets = new Set<string>([params.memstoreId]);
  const mounted = await resolveIdentityForwardMemoryStore(credential, params.identityId);
  if (mounted) targets.add(mounted);

  for (const storeId of targets) {
    await bootstrapTravelMemory(credential, storeId, params);
  }
  return mounted ?? params.memstoreId;
}

/** Schedule run 创建 Session 后，Forward 可能才 provision System Default Memory；回写 canonical id */
export async function syncIdentityMemoryStoreAfterRun(
  credential: QcaCredential,
  params: {
    catId: string;
    catName: string;
    identityId: string;
    memstoreId: string;
    travelTemplateId?: string | null;
    bootstrap: {
      serverUrl: string;
      catToken: string;
      personality: string;
      ownerNickname: string;
      attrs: { courage: number; curiosity: number; affinity: number; insight: number };
    };
  },
) {
  if (config.qcaMock) return params.memstoreId;

  const mounted = await resolveIdentityForwardMemoryStore(credential, params.identityId);
  if (!mounted) return params.memstoreId;

  await tagMemstoreForForward(credential, mounted, {
    catId: params.catId,
    identityId: params.identityId,
    catName: params.catName,
  });
  if (params.travelTemplateId) {
    await linkMemoryStoreToForwardTemplate(credential, params.travelTemplateId, mounted);
  }
  await bootstrapForwardTravelMemory(credential, {
    memstoreId: mounted,
    identityId: params.identityId,
    catName: params.catName,
    ...params.bootstrap,
  });
  return mounted;
}
