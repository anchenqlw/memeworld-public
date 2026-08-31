import { describe, expect, it } from 'vitest';
import { containsDeadlinePromise, proposalNextStep, PROPOSAL_REVIEW_CADENCE } from './proposalProgress';

describe('proposal public next step', () => {
  it('keeps exported proposals under review and historical shipped proposals in validation', () => {
    expect(proposalNextStep('under-review')).toContain('评估');
    expect(proposalNextStep('validating')).toContain('production 观察通过');
    expect(proposalNextStep('validating')).not.toContain('已经上线');
  });

  it('retains the partial scope and only calls verified proposals online', () => {
    expect(proposalNextStep('partially-accepted')).toContain('部分');
    expect(proposalNextStep('verified')).toContain('已上线');
  });

  it('falls back safely instead of inventing a delivery promise', () => {
    expect(proposalNextStep('legacy-unknown')).toBe(proposalNextStep('under-review'));
  });
});

describe('deadline and SLA copy guard', () => {
  it('accepts the production cadence and every production next-step string', () => {
    expect(containsDeadlinePromise(PROPOSAL_REVIEW_CADENCE)).toBe(false);
    for (const status of ['received', 'under-review', 'accepted', 'partially-accepted', 'in-progress', 'validating', 'verified', 'not-planned']) {
      expect(containsDeadlinePromise(proposalNextStep(status))).toBe(false);
    }
  });

  it.each(['三天后回复', '一周内上线', '24小时完成', '明天会处理', '最迟本周上线', '保证按时完成'])(
    'rejects the deadline mutant %s',
    (copy) => expect(containsDeadlinePromise(copy)).toBe(true),
  );
});
