import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('uuid', () => ({ v4: vi.fn(() => 'encounter-test-id') }));
const dbMock = vi.hoisted(() => ({ selectFrom: vi.fn(), transaction: vi.fn() }));
vi.mock('../db/index.js', () => ({ db: dbMock }));

import { ENCOUNTER_FREQUENCY, encounterSummaries, isEncounterFrequencyAvailable, settleAnonymousEncounter, summariesForPair } from './encounterService.js';

function queryResult(result: unknown) {
  const query = {
    select: vi.fn(), where: vi.fn(), leftJoin: vi.fn(), innerJoin: vi.fn(),
    orderBy: vi.fn(), limit: vi.fn(),
    execute: vi.fn(async () => result),
    executeTakeFirst: vi.fn(async () => result),
  };
  for (const method of ['select', 'where', 'leftJoin', 'innerJoin', 'orderBy', 'limit'] as const) {
    query[method].mockReturnValue(query);
  }
  return query;
}

function mockSelections(selections: Array<{ table: string; result: unknown }>) {
  dbMock.selectFrom.mockImplementation((table: string) => {
    const next = selections.shift();
    expect(table).toBe(next?.table);
    return queryResult(next?.result);
  });
}

function recordingTransaction() {
  const inserted: Array<{ table: string; values: unknown }> = [];
  const writeChain = () => {
    const chain = { set: vi.fn(), where: vi.fn(), onConflict: vi.fn(), execute: vi.fn(async () => undefined) };
    chain.set.mockReturnValue(chain);
    chain.where.mockReturnValue(chain);
    chain.onConflict.mockReturnValue(chain);
    return chain;
  };
  const trx = {
    insertInto: vi.fn((table: string) => ({
      values: vi.fn((values: unknown) => {
        inserted.push({ table, values });
        return writeChain();
      }),
    })),
    updateTable: vi.fn(() => writeChain()),
  };
  dbMock.transaction.mockReturnValue({ execute: async (callback: (transaction: typeof trx) => Promise<void>) => callback(trx) });
  return inserted;
}

describe('encounter frequency and postcard variety (#114)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('caps encounters at two within the current seven-travel window', () => {
    expect(ENCOUNTER_FREQUENCY).toEqual({ recentTravels: 7, maxEncounters: 2 });
    expect(isEncounterFrequencyAvailable([true, false, true, false, false, false])).toBe(false);
    expect(isEncounterFrequencyAvailable([false, true, false, false, false, false])).toBe(true);
  });

  it('ignores encounter history outside the rolling window', () => {
    expect(isEncounterFrequencyAvailable([false, false, false, false, false, false, true, true])).toBe(true);
  });

  it('rotates repeated encounter moments without names or owner data', () => {
    const first = encounterSummaries(0);
    const second = encounterSummaries(1);
    const third = encounterSummaries(2);
    expect(new Set([first.join('|'), second.join('|'), third.join('|')]).size).toBe(3);
    expect(encounterSummaries(3)).toEqual(first);
    expect(summariesForPair(1, true)).toEqual({ currentSummary: second[0], candidateSummary: second[1] });
    expect(summariesForPair(1, false)).toEqual({ currentSummary: second[1], candidateSummary: second[0] });
    for (const summary of [...first, ...second, ...third]) {
      expect(summary).not.toMatch(/主人|猫名|聊天|卡片/);
    }
  });

  it('keeps the owner exit switch ahead of matching and prompt variation', async () => {
    const query = {
      select: vi.fn(), where: vi.fn(),
      executeTakeFirst: vi.fn(async () => ({ id: 'cat-off', meet_enabled: 0, status: 'active' })),
    };
    query.select.mockReturnValue(query);
    query.where.mockReturnValue(query);
    dbMock.selectFrom.mockReturnValue(query);

    await expect(settleAnonymousEncounter({
      id: 'travel-off', cat_id: 'cat-off', travel_date: '2026-08-26', location_id: 'cloud-road',
    })).resolves.toBeNull();
    expect(dbMock.selectFrom).toHaveBeenCalledTimes(1);
  });

  it('stops before candidate matching when the current cat reached the rolling limit', async () => {
    mockSelections([
      { table: 'cats', result: { id: 'cat-current', meet_enabled: 1, status: 'active' } },
      { table: 'travels as t', result: [
        { id: 'old-1', encounter_receipt_id: 'receipt-1' },
        { id: 'old-2', encounter_receipt_id: null },
        { id: 'old-3', encounter_receipt_id: 'receipt-2' },
      ] },
    ]);

    await expect(settleAnonymousEncounter({
      id: 'travel-current', cat_id: 'cat-current', travel_date: '2026-08-26', location_id: 'cloud-road',
    })).resolves.toBeNull();

    expect(dbMock.selectFrom).toHaveBeenCalledTimes(2);
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });

  it('skips a capped candidate and continues to the next eligible cat', async () => {
    mockSelections([
      { table: 'cats', result: { id: 'cat-current', meet_enabled: 1, status: 'active' } },
      { table: 'travels as t', result: [] },
      { table: 'travels as t', result: [
        { id: 'travel-capped', cat_id: 'cat-capped', travel_date: '2026-08-26', location_id: 'cloud-road' },
        { id: 'travel-eligible', cat_id: 'cat-eligible', travel_date: '2026-08-26', location_id: 'cloud-road' },
      ] },
      { table: 'travels as t', result: [
        { id: 'candidate-old-1', encounter_receipt_id: 'receipt-1' },
        { id: 'candidate-old-2', encounter_receipt_id: 'receipt-2' },
      ] },
      { table: 'travels as t', result: [] },
      { table: 'cat_relationships', result: { encounter_count: 0 } },
    ]);
    const inserted = recordingTransaction();

    await expect(settleAnonymousEncounter({
      id: 'travel-current', cat_id: 'cat-current', travel_date: '2026-08-26', location_id: 'cloud-road',
    })).resolves.toEqual({ encounterId: 'encounter-test-id' });

    expect(dbMock.selectFrom).toHaveBeenCalledTimes(6);
    expect(inserted.find((write) => write.table === 'encounter_receipts')?.values).toEqual([
      expect.objectContaining({ cat_id: 'cat-current', travel_id: 'travel-current' }),
      expect.objectContaining({ cat_id: 'cat-eligible', travel_id: 'travel-eligible' }),
    ]);
  });

  it('uses the persisted relationship count for receipt summary rotation', async () => {
    mockSelections([
      { table: 'cats', result: { id: 'cat-b', meet_enabled: 1, status: 'active' } },
      { table: 'travels as t', result: [] },
      { table: 'travels as t', result: [{
        id: 'travel-candidate', cat_id: 'cat-a', travel_date: '2026-08-26', location_id: 'cloud-road',
      }] },
      { table: 'travels as t', result: [] },
      { table: 'cat_relationships', result: { encounter_count: 2 } },
    ]);
    const inserted = recordingTransaction();

    await expect(settleAnonymousEncounter({
      id: 'travel-current', cat_id: 'cat-b', travel_date: '2026-08-26', location_id: 'cloud-road',
    })).resolves.toEqual({ encounterId: 'encounter-test-id' });

    const receiptWrite = inserted.find((write) => write.table === 'encounter_receipts');
    expect(receiptWrite?.values).toEqual([
      expect.objectContaining({ cat_id: 'cat-b', summary: encounterSummaries(2)[1] }),
      expect.objectContaining({ cat_id: 'cat-a', summary: encounterSummaries(2)[0] }),
    ]);
  });
});
