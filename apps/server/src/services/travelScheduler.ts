import type { FastifyBaseLogger } from 'fastify';
import { config, isTravelSchedulerEnabled } from '../config.js';
import { db } from '../db/index.js';
import { shanghaiDate } from '../lib/date.js';
import { getPatForUser, runTravelTaskForCatId } from './catService.js';
import { qcaFetch } from './qca.js';

let timer: ReturnType<typeof setTimeout> | null = null;
let active = false;

async function shouldTriggerTonight(credential: Awaited<ReturnType<typeof getPatForUser>>, deploymentId: string) {
  if (!credential) return false;
  try {
    const deployment = await qcaFetch(credential, 'GET', `/deployments/${deploymentId}`) as {
      schedule?: { upcoming_runs_at?: string[] };
    };
    const nextRun = deployment.schedule?.upcoming_runs_at?.[0];
    if (!nextRun) return false;
    const runAt = new Date(nextRun).getTime();
    const now = Date.now();
    return now >= runAt - 60_000 && now <= runAt + 20 * 60_000;
  } catch {
    return false;
  }
}

async function tick(log: FastifyBaseLogger) {
  if (config.qcaMock) return;
  const today = shanghaiDate();
  const cats = await db.selectFrom('cats').select(['id', 'user_id', 'qca_deployment_id', 'qca_forward_schedule_id', 'last_travel_dispatched_on'])
    .where('travel_schedule_enabled', '=', 1)
    .where('qca_forward_schedule_id', 'is', null)
    .where('qca_deployment_id', 'is not', null)
    .execute();

  for (const cat of cats) {
    try {
      if (cat.last_travel_dispatched_on === today) continue;
      const hasTravel = await db.selectFrom('travels').select('id')
        .where('cat_id', '=', cat.id).where('travel_date', '=', today).executeTakeFirst();
      if (hasTravel) continue;

      const pat = await getPatForUser(cat.user_id);
      if (!pat || !cat.qca_deployment_id) continue;
      if (!(await shouldTriggerTonight(pat, cat.qca_deployment_id))) continue;

      await runTravelTaskForCatId(cat.id, { rotateToken: false });
      log.info({ catId: cat.id }, 'scheduled travel task dispatched to persistent session');
    } catch (error) {
      log.warn({ catId: cat.id, err: error instanceof Error ? error.message : 'unknown' }, 'scheduled travel dispatch failed');
    }
  }
}

function schedule(log: FastifyBaseLogger, delay = config.travelScheduler.pollIntervalMs) {
  if (!active) return;
  timer = setTimeout(() => {
    void tick(log)
      .catch((error) => log.error({ err: error }, 'travel scheduler tick failed'))
      .finally(() => schedule(log));
  }, delay);
}

export function startTravelScheduler(log: FastifyBaseLogger) {
  if (!isTravelSchedulerEnabled() || active) return;
  active = true;
  schedule(log, 0);
}

export function stopTravelScheduler() {
  active = false;
  if (timer) clearTimeout(timer);
  timer = null;
}
