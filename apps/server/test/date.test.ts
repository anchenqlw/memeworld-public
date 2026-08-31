import { describe, expect, it } from 'vitest';
import { compareDbTimestamps, dbTimestampMs, nextShanghaiMidnightIso, shanghaiDate, shanghaiDateFromDbText } from '../src/lib/date.js';

describe('database timestamp compatibility', () => {
  it('maps UTC ISO and legacy +08 text to the same Shanghai business date', () => {
    expect(shanghaiDateFromDbText('2026-08-08T16:01:00.000Z')).toBe('2026-08-09');
    expect(shanghaiDateFromDbText('2026-08-09 00:01:00.000+08')).toBe('2026-08-09');
    expect(shanghaiDateFromDbText('2026-08-08T15:59:59.999Z')).toBe('2026-08-08');
    expect(shanghaiDateFromDbText('2026-08-09T00:00:00.000Z')).toBe('2026-08-09');
  });

  it('treats SQLite CURRENT_TIMESTAMP text as UTC and sorts mixed legacy instants chronologically', () => {
    expect(new Date(dbTimestampMs('2026-08-08 16:00:00')).toISOString()).toBe('2026-08-08T16:00:00.000Z');
    expect(compareDbTimestamps('2026-08-09 00:00:00.100+08', '2026-08-08T16:00:00.200Z')).toBeLessThan(0);
  });
});

describe('Shanghai travel day boundary (#126)', () => {
  it('returns the next Shanghai midnight as a UTC instant on both sides of the boundary', () => {
    const before = new Date('2026-08-26T15:59:59.999Z');
    const after = new Date('2026-08-26T16:00:00.000Z');
    expect(shanghaiDate(before)).toBe('2026-08-26');
    expect(nextShanghaiMidnightIso(before)).toBe('2026-08-26T16:00:00.000Z');
    expect(shanghaiDate(after)).toBe('2026-08-27');
    expect(nextShanghaiMidnightIso(after)).toBe('2026-08-27T16:00:00.000Z');
  });

  it('does not inherit a DST-observing host offset', () => {
    expect(nextShanghaiMidnightIso(new Date('2026-03-08T07:30:00.000Z')))
      .toBe('2026-03-08T16:00:00.000Z');
  });
});
