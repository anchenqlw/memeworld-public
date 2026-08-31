import { db } from '../db/index.js';
import { v4 as uuid } from 'uuid';
import crypto from 'node:crypto';

export async function rollItemDrop(eventId: string | null | undefined, catId: string, travelId: string): Promise<string | null> {
  if (!eventId) return null;
  const evt = await db.selectFrom('world_events').select('event_gene').where('id', '=', eventId).executeTakeFirst();
  if (!evt?.event_gene) return null;

  const items = await db.selectFrom('world_items').select(['id', 'drop_chance']).where('drop_gene', '=', evt.event_gene).execute();

  for (const item of items) {
    const seed = crypto.createHash('sha256').update(`${catId}:${travelId}:${item.id}`).digest();
    const roll = seed[0] / 255;
    if (roll < item.drop_chance) {
      const result = await db.insertInto('cat_items').values({ id: uuid(), cat_id: catId, item_id: item.id, source: travelId })
        .onConflict((oc) => oc.columns(['cat_id', 'item_id']).doNothing()).executeTakeFirst();
      if (Number(result.numInsertedOrUpdatedRows ?? 0) > 0) {
        return item.id;
      }
    }
  }
  return null;
}

export async function listCatItems(catId: string) {
  // source = 掉落该物品的 travelId（backlog #063：行囊展示获得来源地点/日期）；
  // 早期数据或非旅行来源可能无对应 travel，left join 容忍缺失。
  return db.selectFrom('cat_items as ci').innerJoin('world_items as wi', 'wi.id', 'ci.item_id')
    .leftJoin('travels as t', 't.id', 'ci.source')
    .leftJoin('world_locations as wl', 'wl.id', 't.location_id')
    .select([
      'ci.item_id', 'ci.acquired_at', 'wi.name', 'wi.kind', 'wi.slot', 'wi.asset_key', 'wi.description',
      'wl.name as source_location_name', 't.travel_date as source_travel_date',
    ])
    .where('ci.cat_id', '=', catId).execute();
}
