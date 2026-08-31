import { describe, expect, it } from 'vitest';
import { contributionCounterClass } from './MailPanel';

describe('contributionCounterClass', () => {
  it('uses the neutral modifier when points are zero', () => {
    expect(contributionCounterClass(0)).toBe('trait-chip contribution-counter contribution-counter--zero');
  });

  it('keeps the reward emphasis when points are positive', () => {
    expect(contributionCounterClass(1)).toBe('trait-chip contribution-counter');
    expect(contributionCounterClass(50)).toBe('trait-chip contribution-counter');
  });
});
