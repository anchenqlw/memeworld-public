import { db } from '../db/index.js';
import { v4 as uuid } from 'uuid';

async function getTravelStats(catId: string) {
  const travels = await db.selectFrom('travels').select(['travel_date', 'location_id']).where('cat_id', '=', catId).orderBy('travel_date').execute();
  const count = travels.length;

  let consecutive = 0;
  if (travels.length > 0) {
    const dates = [...new Set(travels.map((t) => t.travel_date))].sort().reverse();
    consecutive = 1;
    for (let i = 1; i < dates.length; i++) {
      const prev = new Date(dates[i - 1] + 'T00:00:00+08:00');
      const curr = new Date(dates[i] + 'T00:00:00+08:00');
      const diff = (prev.getTime() - curr.getTime()) / 86400000;
      if (diff === 1) consecutive++;
      else break;
    }
  }

  const moodTags = new Set<string>();
  for (const t of travels) {
    const loc = await db.selectFrom('world_locations').select('mood_tags').where('id', '=', t.location_id).executeTakeFirst();
    if (loc) {
      for (const tag of JSON.parse(loc.mood_tags) as string[]) {
        if (['宁静', '热闹', '神秘', '治愈', '探索'].some((m) => tag.includes(m) || m.includes(tag))) {
          if (tag.includes('宁静') || tag.includes('治愈')) moodTags.add('宁静');
          if (tag.includes('热闹') || tag.includes('温柔')) moodTags.add('热闹');
          if (tag.includes('神秘') || tag.includes('探索')) moodTags.add('神秘');
        }
      }
    }
  }

  const cat = await db.selectFrom('cats').select(['attr_courage', 'attr_curiosity', 'attr_affinity', 'attr_insight'])
    .where('id', '=', catId).executeTakeFirstOrThrow();

  const maxAttr = Math.max(cat.attr_courage, cat.attr_curiosity, cat.attr_affinity, cat.attr_insight);

  return { count, consecutive, moodTags: moodTags.size, maxAttr };
}

async function isFirstArrival(locationId: string, catId: string): Promise<boolean> {
  const first = await db.selectFrom('travels').select('cat_id').where('location_id', '=', locationId)
    .orderBy('reported_at').limit(1).executeTakeFirst();
  return first?.cat_id === catId;
}

export async function evaluateBadges(catId: string, context: { locationId: string; travelId: string }) {
  const stats = await getTravelStats(catId);
  const rules: Array<{ id: string; check: () => boolean | Promise<boolean>; reason: string }> = [
    { id: 'badge-first-trip', check: () => stats.count >= 1, reason: `旅行 ${context.travelId}` },
    { id: 'badge-week-streak', check: () => stats.consecutive >= 7, reason: `连续 ${stats.consecutive} 天旅行` },
    { id: 'badge-mood-collector', check: () => stats.moodTags >= 3, reason: '到访三种氛围地点' },
    { id: 'badge-first-arrival', check: () => isFirstArrival(context.locationId, catId), reason: `首个到达 ${context.locationId}` },
    { id: 'badge-full-attr', check: () => stats.maxAttr >= 10, reason: `属性达到 ${stats.maxAttr}` },
  ];

  const earned: string[] = [];
  for (const r of rules) {
    if (await r.check()) {
      const res = await db.insertInto('cat_badges').values({ id: uuid(), cat_id: catId, badge_id: r.id, reason: r.reason })
        .onConflict((oc) => oc.columns(['cat_id', 'badge_id']).doNothing()).executeTakeFirst();
      if (Number(res.numInsertedOrUpdatedRows ?? 0) > 0) earned.push(r.id);
    }
  }
  return earned;
}

export async function listBadgesForCat(catId: string) {
  const catalog = await db.selectFrom('world_badges').select(['id', 'name', 'description']).execute();
  const earned = await db.selectFrom('cat_badges').select(['badge_id', 'earned_at', 'reason']).where('cat_id', '=', catId).execute();
  const earnedMap = new Map(earned.map((e) => [e.badge_id, e]));

  return catalog.map((b) => ({
    id: b.id,
    name: b.name,
    description: b.description,
    earned: earnedMap.has(b.id),
    earned_at: earnedMap.get(b.id)?.earned_at ?? null,
    reason: earnedMap.get(b.id)?.reason ?? null,
  }));
}
