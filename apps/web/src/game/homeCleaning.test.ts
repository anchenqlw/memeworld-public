import { describe, expect, it } from 'vitest';
import {
  INITIAL_HOME_CLEANING_STATE,
  advanceHomeCleaning,
  beginHomeCleaning,
  homeCleaningButtonLabel,
  homeCleaningFeedback,
} from './homeCleaning';

describe('home cleaning local state', () => {
  it('normal motion follows cleaning → fresh → idle and increments run id', () => {
    const cleaning = beginHomeCleaning(INITIAL_HOME_CLEANING_STATE, false);
    expect(cleaning).toEqual({ phase: 'cleaning', runId: 1 });
    const fresh = advanceHomeCleaning(cleaning, 'finish-cleaning', 1);
    expect(fresh).toEqual({ phase: 'fresh', runId: 1 });
    expect(advanceHomeCleaning(fresh, 'reset', 1)).toEqual({ phase: 'idle', runId: 1 });
  });

  it('reduced motion skips the animated cleaning phase but keeps completion feedback', () => {
    const state = beginHomeCleaning(INITIAL_HOME_CLEANING_STATE, true);
    expect(state).toEqual({ phase: 'fresh', runId: 1 });
    if (state.phase === 'idle') throw new Error('reduced motion must keep completion feedback');
    expect(homeCleaningFeedback(state.phase)).toContain('亮晶晶');
  });

  it('stale timers from a previous run cannot reset a newer interaction', () => {
    const first = beginHomeCleaning(INITIAL_HOME_CLEANING_STATE, false);
    const second = beginHomeCleaning(first, false);
    expect(advanceHomeCleaning(second, 'finish-cleaning', first.runId)).toBe(second);
    expect(advanceHomeCleaning(second, 'reset', first.runId)).toBe(second);
  });

  it('out-of-order events are no-ops and labels match each visible phase', () => {
    expect(advanceHomeCleaning(INITIAL_HOME_CLEANING_STATE, 'reset', 0)).toBe(INITIAL_HOME_CLEANING_STATE);
    expect(homeCleaningButtonLabel('idle')).toBe('打扫猫舍');
    expect(homeCleaningButtonLabel('cleaning')).toBe('正在打扫…');
    expect(homeCleaningButtonLabel('fresh')).toBe('猫舍亮晶晶');
  });
});
