import { describe, expect, it } from 'vitest';
import {
  PRODUCTION_VERIFIED_PUBLIC_NOTE,
  SHIPPED_VALIDATING_PUBLIC_NOTE,
  proposalPublicNote,
} from './proposalPublicNote.js';

describe('proposal public note trust boundary', () => {
  it.each([
    ['new', '收到'],
    ['exported', 'issue 档案'],
    ['triaged', '正在评估'],
    ['accepted', '被采纳'],
    ['partially-accepted', '一部分'],
    ['rejected', '暂不采纳'],
    ['in-progress', '开始制作'],
    ['shipped', '等待 production 观察验证'],
  ])('projects %s from a fixed server template', (status, expected) => {
    expect(proposalPublicNote(status)).toContain(expected);
  });

  it('fails unknown ordinary states closed to the review template', () => {
    expect(proposalPublicNote('verified')).toBe(proposalPublicNote('triaged'));
    expect(proposalPublicNote('future-state')).toBe(proposalPublicNote('triaged'));
  });

  it('selects verified copy only from the explicit trusted-event flag', () => {
    expect(proposalPublicNote('shipped')).toBe(SHIPPED_VALIDATING_PUBLIC_NOTE);
    expect(proposalPublicNote('shipped', true)).toBe(PRODUCTION_VERIFIED_PUBLIC_NOTE);
    expect(proposalPublicNote('accepted', true)).toBe(PRODUCTION_VERIFIED_PUBLIC_NOTE);
  });
});
