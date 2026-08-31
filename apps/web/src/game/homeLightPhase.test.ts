import { describe, expect, it } from 'vitest';
import {
  HOME_BACKGROUND_URLS,
  createHomeLightClock,
  homeLightPhaseAt,
  millisecondsUntilNextHomeLightBoundary,
  nextHomeLightPhase,
} from './homeLightPhase';

function localDate(hour: number, minute = 0, second = 0): Date {
  return new Date(2026, 6, 16, hour, minute, second, 0);
}

describe('homeLightPhaseAt', () => {
  it.each([
    [4, 59, 'night'],
    [5, 0, 'dawn'],
    [7, 59, 'dawn'],
    [8, 0, 'day'],
    [16, 59, 'day'],
    [17, 0, 'dusk'],
    [19, 59, 'dusk'],
    [20, 0, 'night'],
    [23, 59, 'night'],
    [0, 0, 'night'],
  ] as const)('maps %i:%i to %s', (hour, minute, phase) => {
    expect(homeLightPhaseAt(localDate(hour, minute))).toBe(phase);
  });

  it('uses four independent versioned background URLs', () => {
    expect(new Set(Object.values(HOME_BACKGROUND_URLS)).size).toBe(4);
    expect(Object.values(HOME_BACKGROUND_URLS).every((url) => /-v\d+\.png$/.test(url))).toBe(true);
  });
});

describe('home light scheduling', () => {
  it('cycles through the four phases across midnight', () => {
    expect(nextHomeLightPhase('dawn')).toBe('day');
    expect(nextHomeLightPhase('day')).toBe('dusk');
    expect(nextHomeLightPhase('dusk')).toBe('night');
    expect(nextHomeLightPhase('night')).toBe('dawn');
  });

  it('schedules the next same-day boundary', () => {
    expect(millisecondsUntilNextHomeLightBoundary(localDate(7, 30))).toBe(30 * 60 * 1000);
    expect(millisecondsUntilNextHomeLightBoundary(localDate(17, 0))).toBe(3 * 60 * 60 * 1000);
  });

  it('schedules next-day dawn after the final boundary', () => {
    expect(millisecondsUntilNextHomeLightBoundary(localDate(23, 30))).toBe(5.5 * 60 * 60 * 1000);
  });

  it('recomputes immediately after a visibility-style refresh', () => {
    let current = localDate(12);
    let scheduled: (() => void) | undefined;
    const phases: string[] = [];
    const cancelled: number[] = [];
    let nextTimer = 0;
    const clock = createHomeLightClock({
      now: () => current,
      onPhase: (phase) => phases.push(phase),
      schedule: (callback) => {
        scheduled = callback;
        nextTimer += 1;
        return nextTimer;
      },
      cancel: (timer) => cancelled.push(timer),
    });

    expect(phases).toEqual(['day']);
    expect(scheduled).toBeTypeOf('function');

    current = localDate(22);
    clock.refresh();
    expect(phases).toEqual(['day', 'night']);
    expect(cancelled).toEqual([1]);

    clock.stop();
    expect(cancelled).toEqual([1, 2]);
  });
});
