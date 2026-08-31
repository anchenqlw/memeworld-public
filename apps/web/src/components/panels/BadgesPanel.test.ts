import { describe, expect, it } from 'vitest';
import type { Badge } from '../../api/client';
import { badgeCaption } from './BadgesPanel';

function badge(overrides: Partial<Badge>): Badge {
  return {
    id: 'badge-first-trip', name: '初次远行', description: '完成第一次旅行',
    earned: false, ...overrides,
  };
}

describe('badgeCaption', () => {
  it('未获得的勋章以「如何点亮」引导语显示获得方式', () => {
    expect(badgeCaption(badge({ earned: false }))).toEqual({
      how: '如何点亮：完成第一次旅行',
      earnedAt: null,
    });
  });

  it('已获得的勋章同时保留获得方式与日期', () => {
    expect(badgeCaption(badge({ earned: true, earned_at: '2026-07-15T08:00:00Z' }))).toEqual({
      how: '完成第一次旅行',
      earnedAt: '2026-07-15 获得',
    });
  });

  it('已获得但缺日期时退回「已获得」而不丢获得方式', () => {
    expect(badgeCaption(badge({ earned: true }))).toEqual({
      how: '完成第一次旅行',
      earnedAt: '已获得',
    });
  });
});
