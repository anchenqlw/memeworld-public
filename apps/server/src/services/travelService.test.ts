import { describe, expect, it } from 'vitest';
import { travelDayWindow, TRAVEL_LIMIT_PER_SHANGHAI_DAY } from './travelService.js';

describe('#126 travel daily window', () => {
  it('allows exactly one ledger entry per Shanghai calendar day', () => {
    expect(TRAVEL_LIMIT_PER_SHANGHAI_DAY).toBe(1);
    expect(travelDayWindow(new Date('2026-08-30T15:59:59.999Z'))).toEqual({
      date: '2026-08-30',
      limit: 1,
      next_refresh_at: '2026-08-30T16:00:00.000Z',
    });
  });

  it('refreshes at Shanghai 00:00 with no additional cooldown', () => {
    expect(travelDayWindow(new Date('2026-08-30T16:00:00.000Z'))).toEqual({
      date: '2026-08-31',
      limit: 1,
      next_refresh_at: '2026-08-31T16:00:00.000Z',
    });
  });

  it('keeps the same next refresh instant throughout one Shanghai day', () => {
    expect(travelDayWindow(new Date('2026-08-30T00:00:00.000Z')).next_refresh_at)
      .toBe('2026-08-30T16:00:00.000Z');
    expect(travelDayWindow(new Date('2026-08-30T15:59:59.999Z')).next_refresh_at)
      .toBe('2026-08-30T16:00:00.000Z');
  });
});
