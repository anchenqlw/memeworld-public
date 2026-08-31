import { db } from '../db/index.js';
import { v4 as uuid } from 'uuid';
import crypto from 'node:crypto';
import { shanghaiDate, daysDiff, nextShanghaiMidnightIso } from '../lib/date.js';
import { evaluateBadges } from './badgeService.js';
import { rollItemDrop } from './itemService.js';
import { notifyUser } from '../channels/index.js';
import { enqueueImageJob } from './imageJobService.js';
import { publicImageUrl } from './catImageService.js';
import { settleAnonymousEncounter } from './encounterService.js';
import { config } from '../config.js';
import {
  normalizeReadingSourceRef,
  resolveReadingSource,
  type ReadingSourceRef,
} from './readingSourceService.js';

export type TravelReport = {
  travel_date?: string;
  /** Agent 偶发误用 date，服务端兼容 */
  date?: string;
  location_id: string;
  event_id?: string;
  narrative: string;
  mood?: string;
  attr_delta?: Record<string, number>;
  postcard?: {
    title: string;
    content?: string;
    body?: string;
    question?: string;
    home_messages?: unknown;
    reading_source?: unknown;
  };
  memory_digest?: string;
};

export type DestinationSelectionVerdict =
  | { accepted: true; reason: 'accepted' | 'idempotent' }
  | { accepted: false; reason: 'travel_completed' | 'invalid_candidate' | 'already_selected' };

export type TravelWriteTestHooks = {
  /** 仅供 PostgreSQL 竞争回归在发起 cats 行锁前留同步点；生产调用不传。 */
  beforeCatLock?: () => void | Promise<void>;
  /** 仅供 PostgreSQL 竞争回归在真正取得 cats 行锁后留同步点；生产调用不传。 */
  afterCatLock?: () => void | Promise<void>;
  /** 仅供日界回归注入时钟；生产调用不传。 */
  now?: () => Date;
};

export const TRAVEL_LIMIT_PER_SHANGHAI_DAY = 1;

/**
 * 旅行次数按上海自然日刷新，不叠加小时级冷却。抽成纯函数是为了锁住 00:00 边界；
 * 写入端仍由 travels 的每日唯一事实和 cats 行锁保证，并发请求不能借边界提示绕过幂等。
 */
export function travelDayWindow(now = new Date()) {
  const date = shanghaiDate(now);
  const nextDate = new Date(`${date}T00:00:00+08:00`);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  return {
    date,
    limit: TRAVEL_LIMIT_PER_SHANGHAI_DAY,
    next_refresh_at: nextDate.toISOString(),
  };
}

export type TravelAvailability = {
  status: 'available' | 'departed_today' | 'completed_today';
  next_available_at: string | null;
};

export function travelAvailability(input: {
  now: Date;
  hasTravelToday: boolean;
  lastTravelDispatchedOn?: string | null;
}): TravelAvailability {
  const today = shanghaiDate(input.now);
  if (input.hasTravelToday) {
    return { status: 'completed_today', next_available_at: nextShanghaiMidnightIso(input.now) };
  }
  if (input.lastTravelDispatchedOn === today) {
    return { status: 'departed_today', next_available_at: nextShanghaiMidnightIso(input.now) };
  }
  return { status: 'available', next_available_at: null };
}

function duplicateTravelError(travelId: string, now: Date) {
  return Object.assign(new Error('今天已完成旅行，明天 00:00 后可再次出发'), {
    code: 'DUPLICATE',
    travelId,
    next_available_at: nextShanghaiMidnightIso(now),
  });
}

/** #099：猫的中途自报不受信任；只接受服务端今日候选集中的首次选择。 */
export function validateDestinationSelection(input: {
  locationId: unknown;
  eligibleLocationIds: readonly string[];
  hasTravelToday: boolean;
  selectedOn?: string | null;
  selectedLocationId?: string | null;
  today: string;
}): DestinationSelectionVerdict {
  if (input.hasTravelToday) return { accepted: false, reason: 'travel_completed' };
  if (typeof input.locationId !== 'string' || !input.eligibleLocationIds.includes(input.locationId)) {
    return { accepted: false, reason: 'invalid_candidate' };
  }
  if (input.selectedOn === input.today) {
    return input.selectedLocationId === input.locationId
      ? { accepted: true, reason: 'idempotent' }
      : { accepted: false, reason: 'already_selected' };
  }
  return { accepted: true, reason: 'accepted' };
}

function normalizeTravelReport(raw: TravelReport): TravelReport {
  let homeMessages: string[] | undefined;
  if (raw.postcard?.home_messages !== undefined) {
    if (!Array.isArray(raw.postcard.home_messages)) {
      throw Object.assign(new Error('postcard.home_messages 格式不正确'), { code: 'INVALID_POSTCARD' });
    }
    homeMessages = [...new Set(raw.postcard.home_messages.map((line) => {
      if (typeof line !== 'string' || line.trim().length < 1 || line.trim().length > 80) {
        throw Object.assign(new Error('每条 home_message 需为 1~80 字'), { code: 'INVALID_POSTCARD' });
      }
      return line.trim();
    }))];
    if (homeMessages.length > 4) {
      throw Object.assign(new Error('postcard.home_messages 最多 4 条'), { code: 'INVALID_POSTCARD' });
    }
  }
  const postcard = raw.postcard
    ? {
      title: raw.postcard.title,
      content: raw.postcard.content ?? raw.postcard.body,
      question: raw.postcard.question,
      home_messages: homeMessages,
      reading_source: normalizeReadingSourceRef(raw.postcard.reading_source),
    }
    : undefined;
  if (postcard && !postcard.content) {
    throw Object.assign(new Error('postcard.content 不能为空'), { code: 'INVALID_POSTCARD' });
  }
  return {
    ...raw,
    travel_date: raw.travel_date ?? raw.date,
    postcard: postcard as TravelReport['postcard'],
  };
}

export function pickDailyEvents<T extends { id: string; location_id: string }>(
  events: T[],
  date: string,
  limit = 3,
): T[] {
  const byLocation = new Map<string, T[]>();
  for (const event of events) {
    const group = byLocation.get(event.location_id) || [];
    group.push(event);
    byLocation.set(event.location_id, group);
  }
  const score = (value: string) => crypto.createHash('sha256').update(`${date}:${value}`).digest('hex');
  return [...byLocation.entries()]
    .sort(([left], [right]) => score(left).localeCompare(score(right)))
    .slice(0, limit)
    .map(([, group]) => [...group].sort((left, right) => score(left.id).localeCompare(score(right.id)))[0]);
}

async function getDailyEventRows(date: string) {
  const events = await db.selectFrom('world_events as we')
    .innerJoin('world_locations as wl', 'wl.id', 'we.location_id')
    .select([
      'we.id',
      'we.location_id',
      'we.name',
      'we.description',
      'we.attr_bonus',
      'wl.name as location_name',
    ])
    .where('wl.status', '=', 'active')
    .execute();
  return pickDailyEvents(events, date);
}

function formatDailyEvent(event: Awaited<ReturnType<typeof getDailyEventRows>>[number]) {
  return {
    id: event.id,
    location_id: event.location_id,
    location_name: event.location_name,
    name: event.name,
    description: event.description,
    attr_bonus: JSON.parse(event.attr_bonus),
  };
}

export type WorldDaySnapshot = Readonly<{ now: Date; date: string }>;

export function createWorldDaySnapshot(now = new Date()): WorldDaySnapshot {
  const instant = new Date(now.getTime());
  return Object.freeze({ now: instant, date: shanghaiDate(instant) });
}

function resolveWorldDaySnapshot(input: Date | WorldDaySnapshot = new Date()): WorldDaySnapshot {
  return input instanceof Date ? createWorldDaySnapshot(input) : input;
}

export async function reportTravel(catId: string, reportInput: TravelReport, testHooks: TravelWriteTestHooks = {}) {
  const report = normalizeTravelReport(reportInput);
  const now = testHooks.now?.() ?? new Date();
  const today = travelDayWindow(now).date;
  if (report.travel_date && Math.abs(daysDiff(report.travel_date, today)) > 1) {
    throw Object.assign(new Error('travel_date 与服务端日期偏差超过 1 天'), { code: 'INVALID_DATE' });
  }

  const loc = await db.selectFrom('world_locations').select('id').where('id', '=', report.location_id).where('status', '=', 'active').executeTakeFirst();
  if (!loc) throw Object.assign(new Error('地点不存在'), { code: 'INVALID_LOCATION' });

  if (report.event_id) {
    const evt = await db.selectFrom('world_events').select('id').where('id', '=', report.event_id).where('location_id', '=', report.location_id).executeTakeFirst();
    if (!evt) throw Object.assign(new Error('事件不存在'), { code: 'INVALID_EVENT' });
  }

  const delta = report.attr_delta || {};
  for (const [, v] of Object.entries(delta)) {
    if (typeof v !== 'number' || v < 0 || v > 1) {
      throw Object.assign(new Error('attr_delta 每维最多 +1'), { code: 'INVALID_DELTA' });
    }
  }

  const travelId = uuid();
  const postcardId = report.postcard?.content ? uuid() : null;
  const [priorVisit, ownerMemory] = await Promise.all([
    db.selectFrom('travels').select('id').where('cat_id', '=', catId).where('location_id', '=', report.location_id).executeTakeFirst(),
    db.selectFrom('cat_onboarding_answers').select('memory_digest').where('cat_id', '=', catId)
      .where('answer_type', '!=', 'skipped').orderBy('updated_at', 'desc').executeTakeFirst(),
  ]);
  const memoryReference = priorVisit && ownerMemory?.memory_digest ? ownerMemory.memory_digest : null;
  try {
    await db.transaction().execute(async (trx) => {
      // #099：destination 与最终 report 必须先竞争同一 cats 行锁，再读写 travels/目的地。
      // PostgreSQL 的 READ COMMITTED 每条语句拿新快照；拿到行锁后的 travel 查询因此能看到
      // 前一位提交者。SQLite 不支持 FOR UPDATE，本地单连接事务只做功能回归，不能替代 PG T。
      await testHooks.beforeCatLock?.();
      let catQuery = trx.selectFrom('cats')
        .select(['attr_courage', 'attr_curiosity', 'attr_affinity', 'attr_insight'])
        .where('id', '=', catId);
      if (config.dbDialect === 'postgres') catQuery = catQuery.forUpdate();
      const cat = await catQuery.executeTakeFirstOrThrow();
      await testHooks.afterCatLock?.();

      const existing = await trx.selectFrom('travels').select('id')
        .where('cat_id', '=', catId).where('travel_date', '=', today).executeTakeFirst();
      if (existing) {
        throw duplicateTravelError(existing.id, now);
      }

      let readingSource: Awaited<ReturnType<typeof resolveReadingSource>> = null;
      const requestedReadingSource = report.postcard?.reading_source as ReadingSourceRef | null | undefined;
      if (requestedReadingSource) {
        readingSource = await resolveReadingSource(catId, trx, { lockActiveBooks: true });
        if (!readingSource
          || readingSource.source_type !== requestedReadingSource.source_type
          || readingSource.source_id !== requestedReadingSource.source_id) {
          throw Object.assign(new Error('阅读来源已撤回、不是本次候选或不在阅读旅行窗口'), {
            code: 'INVALID_READING_SOURCE',
          });
        }
      }

      await trx.insertInto('travels').values({
        id: travelId, cat_id: catId, travel_date: today, location_id: report.location_id,
        event_id: report.event_id || null, narrative: report.narrative, mood: report.mood || null,
        attr_delta: JSON.stringify(delta), memory_digest: report.memory_digest || null,
        memory_reference: memoryReference, encounter_summary: null,
      }).execute();

      if (report.postcard?.content) {
        await trx.insertInto('postcards').values({
          id: postcardId!, travel_id: travelId, title: report.postcard.title, content: report.postcard.content,
          question: report.postcard.question || null,
          home_messages: report.postcard.home_messages ? JSON.stringify(report.postcard.home_messages) : null,
          reading_source_type: readingSource?.source_type || null,
          reading_source_id: readingSource?.source_id || null,
          reading_source_title: readingSource?.title || null,
          photo_status: 'pending',
        }).execute();
      }

      // #099：最终旅行账本永远覆盖中途意图；即使最终地点不同，也不留下陈旧目的地。
      await trx.updateTable('cats').set({
        current_destination_location_id: null,
        current_destination_selected_on: null,
        current_destination_selected_at: null,
      }).where('id', '=', catId).execute();

      const updates: Record<string, number> = {
        attr_courage: cat.attr_courage,
        attr_curiosity: cat.attr_curiosity,
        attr_affinity: cat.attr_affinity,
        attr_insight: cat.attr_insight,
      };
      const map: Record<string, keyof typeof updates> = {
        courage: 'attr_courage',
        curiosity: 'attr_curiosity',
        affinity: 'attr_affinity',
        insight: 'attr_insight',
      };
      for (const [k, v] of Object.entries(delta)) {
        const col = map[k];
        if (col && v) updates[col] = Math.min(10, updates[col] + v);
      }
      await trx.updateTable('cats').set({
        attr_courage: updates.attr_courage, attr_curiosity: updates.attr_curiosity,
        attr_affinity: updates.attr_affinity, attr_insight: updates.attr_insight,
        updated_at: new Date().toISOString(),
      }).where('id', '=', catId).execute();

      // #056：许愿是一次性的——本次旅行命中愿望地点即清除；未命中保留到命中为止。
      await trx.updateTable('cats').set({ travel_wish_location_id: null })
        .where('id', '=', catId)
        .where('travel_wish_location_id', '=', report.location_id)
        .execute();
    });
  } catch (error) {
    const duplicate = await db.selectFrom('travels').select('id').where('cat_id', '=', catId).where('travel_date', '=', today).executeTakeFirst();
    if (duplicate) throw duplicateTravelError(duplicate.id, now);
    throw error;
  }

  const droppedItemId = await rollItemDrop(report.event_id, catId, travelId);
  const itemDropped = droppedItemId
    ? await db.selectFrom('world_items').select(['id', 'name', 'slot', 'description']).where('id', '=', droppedItemId).executeTakeFirst()
    : null;
  const badges = await evaluateBadges(catId, { locationId: report.location_id, travelId });
  const encounter = await settleAnonymousEncounter({
    id: travelId, cat_id: catId, travel_date: today, location_id: report.location_id,
  });

  const catRow = await db.selectFrom('cats').select(['user_id', 'name']).where('id', '=', catId).executeTakeFirstOrThrow();
  notifyUser(catRow.user_id, {
    type: 'travel_complete',
    title: `${catRow.name} 旅行归来`,
    body: report.postcard?.title || '完成了一次旅行',
    data: { travel_id: travelId },
  }).catch(() => {});

  await enqueueImageJob('growth', catId, travelId);

  await clearAdventurePresenceFailure(catId);

  return { travelId, postcardId, badges, itemDropped, encounter };
}

/**
 * 猫在持久 Travel Session 中选定目的地后的中途上报。
 * 第一份有效选择是当日中途事实；重复同值幂等，不允许不同值来回闪烁；最终 reportTravel 清空。
 */
export async function reportCurrentDestination(
  catId: string,
  locationId: unknown,
  testHooks: TravelWriteTestHooks = {},
) {
  const now = testHooks.now?.() ?? new Date();
  const today = shanghaiDate(now);
  const world = await getWorldToday(catId, now);
  const eligibleLocationIds = world.locations
    .filter((location) => Object.entries(location.min_attrs).every(([key, minimum]) => {
      const value = world.cat.attrs[key as keyof typeof world.cat.attrs];
      return typeof value === 'number' && value >= Number(minimum);
    }))
    .map((location) => location.id);
  return await db.transaction().execute(async (trx) => {
    // 与 reportTravel 同一线性化协议：先锁 cats 行，再检查最终 travels，最后才裁决/写目的地。
    // 同值幂等也必须走过此锁与 travel 查询，不能基于锁外旧快照提前返回。
    await testHooks.beforeCatLock?.();
    let catQuery = trx.selectFrom('cats').select([
      'current_destination_location_id',
      'current_destination_selected_on',
    ]).where('id', '=', catId);
    if (config.dbDialect === 'postgres') catQuery = catQuery.forUpdate();
    const current = await catQuery.executeTakeFirstOrThrow();
    await testHooks.afterCatLock?.();
    const travel = await trx.selectFrom('travels').select('id')
      .where('cat_id', '=', catId).where('travel_date', '=', today).executeTakeFirst();

    const verdict = validateDestinationSelection({
      locationId,
      eligibleLocationIds,
      hasTravelToday: Boolean(travel),
      selectedOn: current.current_destination_selected_on,
      selectedLocationId: current.current_destination_location_id,
      today,
    });
    if (!verdict.accepted) {
      if (verdict.reason === 'travel_completed') return {
        ...verdict,
        message: '今天已完成旅行，明天 00:00 后可再次出发',
        next_available_at: nextShanghaiMidnightIso(now),
      };
      const message = verdict.reason === 'already_selected'
        ? '今天的目的地已经选定，最终地点以旅行回报为准'
        : '目的地不在今天可去的地点中';
      throw Object.assign(new Error(message), {
        code: verdict.reason === 'already_selected' ? 'DESTINATION_ALREADY_SELECTED' : 'INVALID_DESTINATION',
      });
    }
    const location = world.locations.find((entry) => entry.id === locationId)!;
    if (verdict.reason === 'idempotent') {
      return { ...verdict, location_id: location.id, name: location.name };
    }

    const selectedAt = new Date().toISOString();
    await trx.updateTable('cats').set({
      current_destination_location_id: location.id,
      current_destination_selected_on: today,
      current_destination_selected_at: selectedAt,
      updated_at: selectedAt,
    }).where('id', '=', catId).execute();
    return {
      accepted: true as const,
      reason: 'accepted' as const,
      location_id: location.id,
      name: location.name,
      selected_at: selectedAt,
    };
  });
}

async function clearAdventurePresenceFailure(catId: string) {
  const row = await db.selectFrom('cats').select('qca_health_cache').where('id', '=', catId).executeTakeFirst();
  if (!row?.qca_health_cache) return;
  try {
    const health = JSON.parse(row.qca_health_cache) as {
      adventure_presence?: { phase?: string; checked_at?: string };
    };
    if (health.adventure_presence?.phase !== 'failed') return;
    health.adventure_presence = { phase: 'idle', checked_at: new Date().toISOString() };
    await db.updateTable('cats').set({
      qca_health_cache: JSON.stringify(health),
      qca_health_checked_at: new Date().toISOString(),
    }).where('id', '=', catId).execute();
  } catch {
    /* ignore malformed cache */
  }
}

// ── #056 许愿目的地 + 流浪模式 ──

const ATTR_COLUMNS = { courage: 'attr_courage', curiosity: 'attr_curiosity', affinity: 'attr_affinity', insight: 'attr_insight' } as const;

/** 设置下次旅行的许愿地点。未去过的地点允许许愿，但天性不满足 min_attrs 时拒绝（猫的性格边界高于主人意志）。 */
export async function setTravelWish(userId: string, locationId: string) {
  const cat = await db.selectFrom('cats')
    .select(['id', 'attr_courage', 'attr_curiosity', 'attr_affinity', 'attr_insight'])
    .where('user_id', '=', userId).where('status', '=', 'active').executeTakeFirst();
  if (!cat) throw Object.assign(new Error('还没有猫'), { code: 'NO_CAT' });

  const location = await db.selectFrom('world_locations').select(['id', 'name', 'min_attrs'])
    .where('id', '=', locationId).where('status', '=', 'active').executeTakeFirst();
  if (!location) throw Object.assign(new Error('这个地点还没有出现在云图志上'), { code: 'INVALID_LOCATION' });

  const minAttrs = JSON.parse(location.min_attrs) as Record<string, number>;
  for (const [attr, min] of Object.entries(minAttrs)) {
    const col = ATTR_COLUMNS[attr as keyof typeof ATTR_COLUMNS];
    if (col && cat[col] < min) {
      throw Object.assign(new Error(`它还不敢去那么远的地方——等它的${attr === 'courage' ? '勇气' : attr === 'curiosity' ? '好奇' : attr === 'affinity' ? '亲和' : '洞察'}再长一长吧`), { code: 'ATTRS_NOT_ENOUGH' });
    }
  }

  await db.updateTable('cats').set({ travel_wish_location_id: location.id, updated_at: new Date().toISOString() })
    .where('id', '=', cat.id).execute();
  return { location_id: location.id, name: location.name };
}

export async function clearTravelWish(userId: string) {
  const cat = await db.selectFrom('cats').select('id').where('user_id', '=', userId).where('status', '=', 'active').executeTakeFirst();
  if (!cat) throw Object.assign(new Error('还没有猫'), { code: 'NO_CAT' });
  await db.updateTable('cats').set({ travel_wish_location_id: null, updated_at: new Date().toISOString() })
    .where('id', '=', cat.id).execute();
  return { ok: true };
}

/** 流浪模式（#056b）：纯视觉状态开关，不改变任何旅行调度语义。 */
export async function setWanderingMode(userId: string, enabled: boolean) {
  const cat = await db.selectFrom('cats').select('id').where('user_id', '=', userId).where('status', '=', 'active').executeTakeFirst();
  if (!cat) throw Object.assign(new Error('还没有猫'), { code: 'NO_CAT' });
  await db.updateTable('cats').set({ wandering_mode: enabled ? 1 : 0, updated_at: new Date().toISOString() })
    .where('id', '=', cat.id).execute();
  return { wandering_mode: enabled };
}

export async function getWorldToday(catId: string, input: Date | WorldDaySnapshot = new Date()) {
  const { date: today } = resolveWorldDaySnapshot(input);
  const cat = await db.selectFrom('cats').select(['name', 'attr_courage', 'attr_curiosity', 'attr_affinity', 'attr_insight', 'travel_wish_location_id'])
    .where('id', '=', catId).executeTakeFirstOrThrow();

  const recent = await db.selectFrom('travels').select('location_id').where('cat_id', '=', catId).orderBy('travel_date', 'desc').limit(5).execute();

  const lastTravel = await db.selectFrom('travels').select('memory_digest').where('cat_id', '=', catId).orderBy('travel_date', 'desc').limit(1).executeTakeFirst();

  const locations = await db.selectFrom('world_locations').select(['id', 'name', 'description', 'mood_tags', 'min_attrs']).where('status', '=', 'active').execute();

  const [events, readingSource] = await Promise.all([
    getDailyEventRows(today),
    resolveReadingSource(catId, db),
  ]);

  // #056：主人许愿注入猫的今日世界——只作为优先提示，min_attrs 门槛仍然生效（设置时已校验，但天性可能回落，取当前快照再验一次）。
  const wishLocation = cat.travel_wish_location_id
    ? locations.find((l) => l.id === cat.travel_wish_location_id) || null
    : null;

  return {
    date: today,
    cat: {
      name: cat.name,
      attrs: {
        courage: cat.attr_courage,
        curiosity: cat.attr_curiosity,
        affinity: cat.attr_affinity,
        insight: cat.attr_insight,
      },
      recent_locations: recent.map((r) => r.location_id),
      memory_digest: lastTravel?.memory_digest || null,
    },
    owner_wish: wishLocation ? { location_id: wishLocation.id, name: wishLocation.name } : null,
    reading_source: readingSource,
    locations: locations.map((l) => ({
      id: l.id,
      name: l.name,
      description: l.description,
      mood_tags: JSON.parse(l.mood_tags),
      min_attrs: JSON.parse(l.min_attrs),
    })),
    events: events.map(formatDailyEvent),
  };
}

export async function getWorldDigest(userId: string, input: Date | WorldDaySnapshot = new Date()) {
  const { date, now } = resolveWorldDaySnapshot(input);
  const cat = await db.selectFrom('cats')
    .select(['id', 'lifecycle_stage', 'travel_schedule_enabled', 'last_travel_dispatched_on'])
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (!cat) return null;
  const [events, travel] = await Promise.all([
    getDailyEventRows(date),
    db.selectFrom('travels').select('id').where('cat_id', '=', cat.id).where('travel_date', '=', date).executeTakeFirst(),
  ]);
  const availability = travelAvailability({
    now,
    hasTravelToday: Boolean(travel),
    lastTravelDispatchedOn: cat.last_travel_dispatched_on,
  });
  return {
    date,
    events: events.map(formatDailyEvent),
    has_travel_today: Boolean(travel),
    travel_status: availability.status,
    next_available_at: availability.next_available_at,
    lifecycle_stage: cat.lifecycle_stage,
    travel_schedule_enabled: Boolean(cat.travel_schedule_enabled),
  };
}

export async function listTravels(catId: string, opts: { page?: number; locationId?: string }) {
  const page = opts.page || 1;
  const limit = 20;
  const offset = (page - 1) * limit;

  let query = db.selectFrom('travels as t').leftJoin('postcards as p', 'p.travel_id', 't.id')
    .leftJoin('world_locations as wl', 'wl.id', 't.location_id').leftJoin('world_events as we', 'we.id', 't.event_id')
    .leftJoin('encounter_receipts as er', 'er.travel_id', 't.id')
    .leftJoin('cat_items as ci', 'ci.source', 't.id')
    .leftJoin('world_items as wi', 'wi.id', 'ci.item_id')
    .selectAll('t').select([
      'p.id as postcard_id', 'p.title as postcard_title', 'p.content as postcard_content', 'p.question as postcard_question',
      'p.home_messages',
      'p.reading_source_type', 'p.reading_source_id', 'p.reading_source_title',
      'p.photo_status', 'p.cherished_at', 'wl.name as location_name', 'we.name as event_name',
      'er.id as encounter_receipt_id', 'er.photo_appearance_id as encounter_photo_appearance_id',
      'ci.item_id as dropped_item_id', 'wi.name as dropped_item_name', 'wi.slot as dropped_item_slot',
    ])
    .where('t.cat_id', '=', catId);
  if (opts.locationId) {
    query = query.where('t.location_id', '=', opts.locationId);
  }
  const rows = await query.orderBy('t.travel_date', 'desc').limit(limit).offset(offset).execute();
  const travelIds = rows.map((row) => row.id);
  const appearances = travelIds.length > 0
    ? await db.selectFrom('cat_appearances').select(['id', 'travel_id', 'object_key', 'image_url', 'created_at'])
        .where('kind', '=', 'growth').where('travel_id', 'in', travelIds)
        .orderBy('created_at', 'desc').orderBy('id', 'desc').execute()
    : [];
  const latestAppearanceByTravel = new Map<string, typeof appearances[number]>();
  const appearanceById = new Map(appearances.map((appearance) => [appearance.id, appearance]));
  for (const appearance of appearances) {
    if (appearance.travel_id && !latestAppearanceByTravel.has(appearance.travel_id)) {
      latestAppearanceByTravel.set(appearance.travel_id, appearance);
    }
  }
  return rows.map((row) => {
    const encounterAppearance = row.encounter_photo_appearance_id
      ? appearanceById.get(row.encounter_photo_appearance_id)
      : undefined;
    const appearance = row.encounter_receipt_id ? encounterAppearance : latestAppearanceByTravel.get(row.id);
    const {
      dropped_item_id,
      dropped_item_name,
      dropped_item_slot,
      home_messages,
      encounter_receipt_id,
      encounter_photo_appearance_id,
      reading_source_type,
      reading_source_id,
      reading_source_title,
      ...travel
    } = row as typeof row & {
      dropped_item_id: string | null;
      dropped_item_name: string | null;
      dropped_item_slot: string | null;
    };
    return {
      ...travel,
      home_messages: (() => {
        if (!home_messages) return [];
        try {
          const parsed = JSON.parse(home_messages) as unknown;
          return Array.isArray(parsed) ? parsed.filter((line): line is string => typeof line === 'string') : [];
        } catch { return []; }
      })(),
      reading_source: reading_source_type && reading_source_id && reading_source_title
        ? { source_type: reading_source_type, source_id: reading_source_id, title: reading_source_title }
        : null,
      image_url: appearance?.object_key
        ? publicImageUrl(appearance)
        : appearance?.image_url || null,
      encounter_photo: Boolean(encounter_photo_appearance_id && encounterAppearance),
      dropped_item: dropped_item_id
        ? { id: dropped_item_id, name: dropped_item_name, slot: dropped_item_slot }
        : null,
    };
  });
}
