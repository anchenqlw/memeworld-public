import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import { decryptPat, encryptPat, patHint } from '../lib/crypto.js';
import { publicImageUrl } from './catImageService.js';
import {
  archiveResources,
  canAccessQcaResources,
  pauseDeployment,
  type QcaCredential,
} from './qca.js';
import { archiveImageArtistResources } from './qcaImage.js';
import { getCatByUserId, savePat } from './catService.js';
import { canAccessForwardTravelResources, archiveForwardTravelResources } from './qcaForwardService.js';

const REPLACEMENT_TTL_MS = 24 * 60 * 60 * 1000;

function catResourceIds(cat: Awaited<ReturnType<typeof getCatByUserId>>) {
  if (!cat) return [];
  return [
    cat.qca_env_id, cat.qca_agent_id, cat.qca_memstore_id, cat.qca_deployment_id,
    cat.qca_image_env_id, cat.qca_image_agent_id,
    cat.qca_forward_schedule_id, cat.qca_forward_identity_id, cat.qca_forward_travel_template_id,
  ].filter(Boolean);
}

async function getStoredCredential(userId: string) {
  const row = await db.selectFrom('pat_credentials').select(['encrypted_pat', 'qca_site', 'status'])
    .where('user_id', '=', userId).executeTakeFirst();
  if (!row) return null;
  return {
    credential: {
      pat: decryptPat(row.encrypted_pat),
      site: row.qca_site as QcaCredential['site'],
      userId,
    },
    status: row.status,
  };
}

export async function requestPatReplacement(userId: string, credential: QcaCredential) {
  const stored = await getStoredCredential(userId);
  const current = stored?.credential;
  const hint = patHint(credential.pat);
  if (!current) {
    await savePat(userId, credential, hint);
    return { status: 'valid', hint, site: credential.site };
  }

  const cat = await getCatByUserId(userId);
  const resourceIds = catResourceIds(cat);
  if (!cat || resourceIds.length === 0) {
    await db.transaction().execute(async (trx) => {
      const now = new Date().toISOString();
      await trx.updateTable('pat_credentials').set({
        encrypted_pat: encryptPat(credential.pat), pat_hint: hint, qca_site: credential.site,
        status: 'valid', last_verified_at: now, updated_at: now,
      }).where('user_id', '=', userId).execute();
      if (cat) {
        await trx.updateTable('cats').set({
          qca_env_id: null, qca_agent_id: null, qca_memstore_id: null, qca_deployment_id: null,
          qca_image_env_id: null, qca_image_agent_id: null, qca_chat_session_id: null,
          qca_travel_session_id: null, qca_travel_session_token_hash: null,
          qca_forward_travel_template_id: null, qca_forward_chat_template_id: null,
          qca_forward_identity_id: null, qca_forward_schedule_id: null,
          qca_forward_travel_session_id: null, qca_forward_travel_session_token_hash: null,
          qca_forward_im_channel_id: null,
          last_travel_dispatched_on: null, travel_schedule_enabled: 0, adventure_started_at: null,
          qca_health_cache: JSON.stringify({ status: 'not_started' }), qca_health_checked_at: now, updated_at: now,
        }).where('id', '=', cat.id).execute();
      }
      await trx.deleteFrom('pat_replacement_requests').where('user_id', '=', userId).execute();
    });
    return { status: 'valid', hint, site: credential.site };
  }

  if (current.site === credential.site) {
    const buildAccessible = await canAccessQcaResources(credential, {
      envId: cat!.qca_env_id, agentId: cat!.qca_agent_id, memstoreId: cat!.qca_memstore_id,
      deploymentId: cat!.qca_deployment_id, imageEnvId: cat!.qca_image_env_id, imageAgentId: cat!.qca_image_agent_id,
    });
    const forwardAccessible = cat!.qca_forward_identity_id
      ? await canAccessForwardTravelResources(credential, {
          catId: cat!.id,
          identityId: cat!.qca_forward_identity_id,
          scheduleId: cat!.qca_forward_schedule_id,
          travelTemplateId: cat!.qca_forward_travel_template_id,
          envId: cat!.qca_env_id,
          memstoreId: cat!.qca_memstore_id,
        })
      : true;
    if (buildAccessible && forwardAccessible) {
      await savePat(userId, credential, hint);
      await db.deleteFrom('pat_replacement_requests').where('user_id', '=', userId).execute();
      return { status: 'valid', hint, site: credential.site, resources_preserved: true };
    }
  }

  const now = new Date();
  const replacementId = randomUUID();
  const classification = current.site !== credential.site ? 'cross_site' : 'resources_inaccessible';
  await db.insertInto('pat_replacement_requests').values({
    id: replacementId,
    user_id: userId,
    encrypted_new_pat: encryptPat(credential.pat),
    pat_hint: hint,
    qca_site: credential.site,
    classification,
    status: 'pending',
    expires_at: new Date(now.getTime() + REPLACEMENT_TTL_MS).toISOString(),
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  }).onConflict((oc) => oc.column('user_id').doUpdateSet({
    id: replacementId,
    encrypted_new_pat: encryptPat(credential.pat),
    pat_hint: hint,
    qca_site: credential.site,
    classification,
    status: 'pending',
    expires_at: new Date(now.getTime() + REPLACEMENT_TTL_MS).toISOString(),
    updated_at: now.toISOString(),
  })).execute();
  return {
    status: 'pending',
    requires_confirmation: true,
    replacement_id: replacementId,
    warning: '确认后将归档当前小猫及其完整记录，并使用新 PAT 重新开始。',
  };
}

async function buildSnapshot(catId: string) {
  const [cat, travels, items, badges, appearances, interactions] = await Promise.all([
    db.selectFrom('cats').selectAll().where('id', '=', catId).executeTakeFirstOrThrow(),
    db.selectFrom('travels').selectAll().where('cat_id', '=', catId).orderBy('reported_at').execute(),
    db.selectFrom('cat_items').selectAll().where('cat_id', '=', catId).execute(),
    db.selectFrom('cat_badges').selectAll().where('cat_id', '=', catId).execute(),
    db.selectFrom('cat_appearances').selectAll().where('cat_id', '=', catId).orderBy('created_at').execute(),
    db.selectFrom('interactions').selectAll().where('cat_id', '=', catId).orderBy('date').execute(),
  ]);
  const travelIds = travels.map((travel) => travel.id);
  const postcards = travelIds.length
    ? await db.selectFrom('postcards').selectAll().where('travel_id', 'in', travelIds).execute()
    : [];
  return { cat, travels, postcards, items, badges, appearances, interactions };
}

export async function confirmPatReplacement(userId: string, replacementId: string) {
  const request = await db.selectFrom('pat_replacement_requests').selectAll()
    .where('id', '=', replacementId).where('user_id', '=', userId).where('status', '=', 'pending').executeTakeFirst();
  if (!request) throw Object.assign(new Error('更换请求不存在'), { code: 'REPLACEMENT_NOT_FOUND' });
  if (new Date(request.expires_at).getTime() <= Date.now()) {
    await db.deleteFrom('pat_replacement_requests').where('id', '=', request.id).execute();
    throw Object.assign(new Error('更换请求已过期'), { code: 'REPLACEMENT_EXPIRED' });
  }
  const cat = await getCatByUserId(userId);
  if (!cat) {
    await savePat(userId, {
      pat: decryptPat(request.encrypted_new_pat), site: request.qca_site as QcaCredential['site'],
    }, request.pat_hint);
    await db.deleteFrom('pat_replacement_requests').where('id', '=', request.id).execute();
    return { ok: true, archived: false };
  }
  const activeJob = await db.selectFrom('image_jobs').select('id').where('cat_id', '=', cat.id)
    .where('status', 'in', ['pending', 'running']).executeTakeFirst();
  if (activeJob) throw Object.assign(new Error('仍有图片任务正在运行，请稍后再确认'), { code: 'IMAGE_JOB_ACTIVE' });

  const snapshot = await buildSnapshot(cat.id);
  const stored = await getStoredCredential(userId);
  const current = stored?.credential;
  const orphanRisk = catResourceIds(cat).length > 0 && (!current || stored?.status !== 'valid');

  const archiveId = randomUUID();
  const now = new Date().toISOString();
  await db.transaction().execute(async (trx) => {
    await trx.insertInto('cat_archives').values({
      id: archiveId, user_id: userId, source_cat_id: cat.id, name: cat.name,
      snapshot: JSON.stringify(snapshot), reason: request.classification, orphan_risk: orphanRisk ? 1 : 0,
    }).execute();
    await trx.deleteFrom('cats').where('id', '=', cat.id).execute();
    await trx.updateTable('pat_credentials').set({
      encrypted_pat: request.encrypted_new_pat, pat_hint: request.pat_hint, qca_site: request.qca_site,
      status: 'valid', last_verified_at: now, updated_at: now,
    }).where('user_id', '=', userId).execute();
    await trx.deleteFrom('pat_replacement_requests').where('id', '=', request.id).execute();
  });

  if (current && stored?.status === 'valid') {
    setImmediate(async () => {
      let cleanupFailed = false;
      try {
        const accessible = await canAccessQcaResources(current, {
          envId: cat.qca_env_id, agentId: cat.qca_agent_id, memstoreId: cat.qca_memstore_id,
          deploymentId: cat.qca_deployment_id, imageEnvId: cat.qca_image_env_id, imageAgentId: cat.qca_image_agent_id,
        });
        cleanupFailed = !accessible;
        if (accessible && cat.qca_deployment_id) await pauseDeployment(current, cat.qca_deployment_id);
        if (accessible) {
          await archiveResources(current, {
            envId: cat.qca_env_id || '', agentId: cat.qca_agent_id || '',
            memstoreId: cat.qca_memstore_id || '', deploymentId: cat.qca_deployment_id || '',
          });
          await archiveImageArtistResources(current, {
            envId: cat.qca_image_env_id || '', agentId: cat.qca_image_agent_id || '',
          });
        }
        if (cat.qca_forward_schedule_id || cat.qca_forward_identity_id) {
          try {
            await archiveForwardTravelResources(current, {
              envId: cat.qca_env_id || undefined,
              memstoreId: cat.qca_memstore_id || undefined,
              travelTemplateId: cat.qca_forward_travel_template_id || undefined,
              identityId: cat.qca_forward_identity_id || undefined,
              scheduleId: cat.qca_forward_schedule_id || undefined,
            });
          } catch {
            cleanupFailed = true;
          }
        }
      } catch {
        cleanupFailed = true;
      }
      if (cleanupFailed) {
        await db.updateTable('cat_archives').set({ orphan_risk: 1 }).where('id', '=', archiveId).execute().catch(() => {});
      }
    });
  }
  return { ok: true, archived: true, archive_id: archiveId, orphan_risk: orphanRisk };
}

export async function cancelPatReplacement(userId: string, replacementId: string) {
  const result = await db.deleteFrom('pat_replacement_requests').where('id', '=', replacementId)
    .where('user_id', '=', userId).executeTakeFirst();
  if (Number(result.numDeletedRows || 0) === 0) {
    throw Object.assign(new Error('更换请求不存在'), { code: 'REPLACEMENT_NOT_FOUND' });
  }
  return { ok: true };
}

async function resolveArchive(row: { snapshot: string } & Record<string, unknown>) {
  const snapshot = JSON.parse(row.snapshot) as {
    cat?: Record<string, unknown>;
    appearances?: Array<Record<string, unknown> & { object_key?: string | null }>;
  };
  if (snapshot.cat) {
    snapshot.cat = Object.fromEntries(Object.entries(snapshot.cat).filter(([key]) =>
      key !== 'cat_token_hash' && !key.startsWith('qca_')
    ));
  }
  if (snapshot.appearances) {
    snapshot.appearances = snapshot.appearances.map((appearance) => ({
      ...appearance,
      image_url: appearance.id && appearance.object_key
        ? publicImageUrl({ id: String(appearance.id), object_key: appearance.object_key, image_url: String(appearance.image_url || '') })
        : appearance.image_url,
    }));
  }
  return { ...row, snapshot };
}

export async function listCatArchives(userId: string) {
  const rows = await db.selectFrom('cat_archives').selectAll().where('user_id', '=', userId)
    .orderBy('created_at', 'desc').execute();
  return Promise.all(rows.map(resolveArchive));
}

export async function getCatArchive(userId: string, archiveId: string) {
  const row = await db.selectFrom('cat_archives').selectAll().where('id', '=', archiveId)
    .where('user_id', '=', userId).executeTakeFirst();
  return row ? resolveArchive(row) : null;
}
