import { v4 as uuid } from 'uuid';
import { db } from '../db/index.js';

type TravelForEncounter = { id: string; cat_id: string; travel_date: string; location_id: string };

export const ENCOUNTER_FREQUENCY = { recentTravels: 7, maxEncounters: 2 } as const;

export function isEncounterFrequencyAvailable(recentTravelEncounterFlags: readonly boolean[]) {
  return recentTravelEncounterFlags.slice(0, ENCOUNTER_FREQUENCY.recentTravels - 1)
    .filter(Boolean).length < ENCOUNTER_FREQUENCY.maxEncounters;
}

const ENCOUNTER_MOMENTS = [
  ['你在路边先听见一阵轻轻的脚步声，和另一只旅行猫安静地交换了一个点头。',
    '你经过路口时发现另一只旅行猫也停了一下，你们隔着刚好的距离互相点了点头。'],
  ['你在风吹过路牌时遇见另一只旅行猫，你们一前一后望了望远处，又各自继续赶路。',
    '你在风吹过路牌时看见另一只旅行猫也在辨认方向，你们默契地让出半步，分享了片刻风景。'],
  ['你在一小片暖光旁歇脚，恰好和另一只旅行猫隔着落叶坐了一会儿，临走轻轻摆了摆尾巴。',
    '你在一小片暖光旁停下，另一只旅行猫也来歇脚；你们没有靠得太近，只一起听了会儿风声。'],
] as const;

export function encounterSummaries(encounterCount: number) {
  return ENCOUNTER_MOMENTS[Math.max(0, encounterCount) % ENCOUNTER_MOMENTS.length];
}

export function summariesForPair(encounterCount: number, currentIsLeft: boolean) {
  const [left, right] = encounterSummaries(encounterCount);
  return currentIsLeft
    ? { currentSummary: left, candidateSummary: right }
    : { currentSummary: right, candidateSummary: left };
}

function matchKey(leftCatId: string, rightCatId: string, date: string, locationId: string) {
  return [date, locationId, ...[leftCatId, rightCatId].sort()].join(':');
}

function isUniqueConflict(error: unknown) {
  const typed = error as { code?: string; message?: string };
  return typed.code === '23505'
    || typed.code === 'SQLITE_CONSTRAINT_UNIQUE'
    || typed.code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
    || Boolean(typed.message?.includes('UNIQUE constraint failed'));
}

/** 旅行落账后尽力创建匿名猫遇；并发由唯一约束裁决，不回滚旅行。 */
export async function settleAnonymousEncounter(travel: TravelForEncounter) {
  const currentCat = await db.selectFrom('cats').select(['id', 'meet_enabled', 'status'])
    .where('id', '=', travel.cat_id).executeTakeFirst();
  if (!currentCat || !currentCat.meet_enabled || currentCat.status !== 'active') return null;

  const recentTravels = await db.selectFrom('travels as t')
    .leftJoin('encounter_receipts as er', 'er.travel_id', 't.id')
    .select(['t.id', 'er.id as encounter_receipt_id'])
    .where('t.cat_id', '=', travel.cat_id).where('t.id', '!=', travel.id)
    .orderBy('t.travel_date', 'desc').orderBy('t.reported_at', 'desc')
    .limit(ENCOUNTER_FREQUENCY.recentTravels - 1).execute();
  if (!isEncounterFrequencyAvailable(recentTravels.map((row) => Boolean(row.encounter_receipt_id)))) return null;

  const candidates = await db.selectFrom('travels as t')
    .innerJoin('cats as c', 'c.id', 't.cat_id')
    .leftJoin('encounter_receipts as er', (join) => join
      .onRef('er.cat_id', '=', 't.cat_id').on('er.encounter_date', '=', travel.travel_date))
    .select(['t.id', 't.cat_id', 't.travel_date', 't.location_id'])
    .where('t.location_id', '=', travel.location_id)
    .where('t.travel_date', '=', travel.travel_date)
    .where('t.cat_id', '!=', travel.cat_id)
    .where('c.meet_enabled', '=', 1)
    .where('c.status', '=', 'active')
    .where('er.id', 'is', null)
    .orderBy('t.reported_at', 'desc').orderBy('t.id', 'asc').execute();

  for (const candidate of candidates) {
    const candidateRecentTravels = await db.selectFrom('travels as t')
      .leftJoin('encounter_receipts as er', 'er.travel_id', 't.id')
      .select(['t.id', 'er.id as encounter_receipt_id'])
      .where('t.cat_id', '=', candidate.cat_id).where('t.id', '!=', candidate.id)
      .orderBy('t.travel_date', 'desc').orderBy('t.reported_at', 'desc')
      .limit(ENCOUNTER_FREQUENCY.recentTravels - 1).execute();
    if (!isEncounterFrequencyAvailable(candidateRecentTravels.map((row) => Boolean(row.encounter_receipt_id)))) continue;

    const encounterId = uuid();
    const [leftCatId] = [travel.cat_id, candidate.cat_id].sort();
    const currentIsLeft = travel.cat_id === leftCatId;
    const relationship = await db.selectFrom('cat_relationships').select('encounter_count')
      .where('cat_id', '=', travel.cat_id).where('other_cat_id', '=', candidate.cat_id).executeTakeFirst();
    const { currentSummary, candidateSummary } = summariesForPair(
      relationship?.encounter_count || 0,
      currentIsLeft,
    );
    try {
      await db.transaction().execute(async (trx) => {
        await trx.insertInto('encounters').values({
          id: encounterId,
          match_key: matchKey(travel.cat_id, candidate.cat_id, travel.travel_date, travel.location_id),
          encounter_date: travel.travel_date, location_id: travel.location_id,
          kind: 'anonymous_passing', status: 'settled',
        }).execute();
        await trx.insertInto('encounter_actions').values({
          id: uuid(), encounter_id: encounterId, actor_cat_id: null,
          action_type: 'anonymous_pass', payload: JSON.stringify({ visibility: 'anonymous' }),
        }).execute();
        await trx.insertInto('encounter_receipts').values([
          { id: uuid(), encounter_id: encounterId, cat_id: travel.cat_id, travel_id: travel.id,
            encounter_date: travel.travel_date, perspective: 'arriving', summary: currentSummary },
          { id: uuid(), encounter_id: encounterId, cat_id: candidate.cat_id, travel_id: candidate.id,
            encounter_date: travel.travel_date, perspective: 'waiting', summary: candidateSummary },
        ]).execute();
        await trx.updateTable('travels').set({ encounter_summary: currentSummary }).where('id', '=', travel.id).execute();
        await trx.updateTable('travels').set({ encounter_summary: candidateSummary }).where('id', '=', candidate.id).execute();
        const updatedAt = new Date().toISOString();
        await trx.updateTable('postcards').set({ photo_status: 'generating' })
          .where('travel_id', 'in', [travel.id, candidate.id]).execute();
        await trx.updateTable('image_jobs').set({
          status: 'canceled', finished_at: updatedAt, last_error: 'SupersededByEncounterPhoto',
          custom_description: null, updated_at: updatedAt,
        }).where('travel_id', '=', candidate.id).where('kind', '=', 'growth').where('status', '=', 'pending').execute();
        await trx.insertInto('cat_relationships').values([
          { cat_id: travel.cat_id, other_cat_id: candidate.cat_id, encounter_count: 1,
            last_encounter_id: encounterId, last_encounter_date: travel.travel_date, status: 'stranger', updated_at: updatedAt },
          { cat_id: candidate.cat_id, other_cat_id: travel.cat_id, encounter_count: 1,
            last_encounter_id: encounterId, last_encounter_date: travel.travel_date, status: 'stranger', updated_at: updatedAt },
        ]).onConflict((conflict) => conflict.columns(['cat_id', 'other_cat_id']).doUpdateSet((eb) => ({
          encounter_count: eb('cat_relationships.encounter_count', '+', 1),
          last_encounter_id: encounterId, last_encounter_date: travel.travel_date, updated_at: updatedAt,
        }))).execute();
      });
      return { encounterId };
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
    }
  }
  return null;
}

export async function listEncounterReceipts(catId: string, page = 1) {
  const limit = 20;
  return db.selectFrom('encounter_receipts as er')
    .innerJoin('encounters as e', 'e.id', 'er.encounter_id')
    .leftJoin('world_locations as wl', 'wl.id', 'e.location_id')
    .select(['er.id', 'er.encounter_id', 'er.encounter_date', 'er.perspective', 'er.summary', 'er.photo_appearance_id',
      'e.kind', 'e.status', 'e.photo_status', 'e.location_id', 'wl.name as location_name', 'er.created_at'])
    .where('er.cat_id', '=', catId)
    .orderBy('er.encounter_date', 'desc').orderBy('er.created_at', 'desc')
    .limit(limit).offset((Math.max(1, page) - 1) * limit).execute()
    .then((rows) => rows.map((row) => ({
      ...row,
      photo_url: row.photo_appearance_id ? `/api/v1/cat-images/${row.photo_appearance_id}` : null,
    })));
}

export async function setMeetEnabled(userId: string, enabled: boolean) {
  const cat = await db.selectFrom('cats').select('id').where('user_id', '=', userId)
    .where('status', '=', 'active').executeTakeFirst();
  if (!cat) throw Object.assign(new Error('没有猫'), { code: 'NO_CAT' });
  await db.updateTable('cats').set({ meet_enabled: enabled ? 1 : 0, updated_at: new Date().toISOString() })
    .where('id', '=', cat.id).execute();
  return { meet_enabled: enabled };
}
