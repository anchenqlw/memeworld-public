import { describe, expect, it } from 'vitest';
import {
  decideTravelAvailabilityRefresh,
  presentTravelAvailability,
  remainingTravelTime,
  travelAvailabilityText,
} from './travelAvailability';

describe('travel availability copy (#126)', () => {
  it('fails closed when the authoritative digest is unavailable', () => {
    expect(travelAvailabilityText(null)).toBe('旅行时间暂时无法确认，请稍后刷新');
  });

  it('distinguishes authoritative departed/completed state and shows the remaining time', () => {
    const now = Date.parse('2026-08-26T12:30:00.000Z');
    expect(travelAvailabilityText({ status: 'departed_today', next_available_at: '2026-08-26T16:00:00.000Z' }, now))
      .toBe('今天已出发，明天 00:00 后可再次出发 · 还剩 3 小时 30 分钟');
    expect(travelAvailabilityText({ status: 'completed_today', next_available_at: '2026-08-26T16:00:00.000Z' }, now))
      .toContain('今天已完成');
  });

  it('handles minute rounding, elapsed boundaries and malformed timestamps without inventing a cooldown', () => {
    const next = '2026-08-26T16:00:00.000Z';
    expect(remainingTravelTime(next, Date.parse('2026-08-26T15:59:00.001Z'))).toBe('还剩 1 分钟');
    expect(remainingTravelTime(next, Date.parse(next))).toBe('已到可再次出发时间');
    expect(travelAvailabilityText({ status: 'completed_today', next_available_at: 'bad' }))
      .toBe('今天已完成，明天 00:00 后可再次出发');
  });

  it('switches to one non-contradictory refresh decision as the authoritative deadline expires', () => {
    const availability = { status: 'completed_today' as const, next_available_at: '2026-08-26T16:00:00.000Z' };
    expect(presentTravelAvailability(availability, Date.parse('2026-08-26T15:59:59.999Z'))).toMatchObject({
      expired: false,
      text: expect.stringContaining('明天 00:00 后'),
    });
    const expired = presentTravelAvailability(availability, Date.parse('2026-08-26T16:00:00.000Z'));
    expect(expired).toEqual({ text: '已到可再次出发时间，正在刷新状态', expired: true });
    expect(expired.text).not.toContain('今天');
    expect(expired.text).not.toContain('明天');
  });

  it('refreshes exactly once per authoritative deadline as time advances', () => {
    const firstDeadline = '2026-08-26T16:00:00.000Z';
    const before = decideTravelAvailabilityRefresh({
      nowMs: Date.parse('2026-08-26T15:59:59.999Z'),
      nextAvailableAt: firstDeadline,
      refreshedDeadline: null,
    });
    expect(before).toEqual({ shouldRefresh: false, refreshedDeadline: null });

    const firstExpiry = decideTravelAvailabilityRefresh({
      nowMs: Date.parse(firstDeadline),
      nextAvailableAt: firstDeadline,
      refreshedDeadline: before.refreshedDeadline,
    });
    expect(firstExpiry).toEqual({ shouldRefresh: true, refreshedDeadline: firstDeadline });

    expect(decideTravelAvailabilityRefresh({
      nowMs: Date.parse('2026-08-26T16:30:00.000Z'),
      nextAvailableAt: firstDeadline,
      refreshedDeadline: firstExpiry.refreshedDeadline,
    })).toEqual({ shouldRefresh: false, refreshedDeadline: firstDeadline });

    const nextDeadline = '2026-08-27T16:00:00.000Z';
    expect(decideTravelAvailabilityRefresh({
      nowMs: Date.parse(nextDeadline),
      nextAvailableAt: nextDeadline,
      refreshedDeadline: firstExpiry.refreshedDeadline,
    })).toEqual({ shouldRefresh: true, refreshedDeadline: nextDeadline });
  });

  it('fails closed on a malformed deadline without consuming the prior refresh marker', () => {
    expect(decideTravelAvailabilityRefresh({
      nowMs: Date.now(),
      nextAvailableAt: 'bad',
      refreshedDeadline: '2026-08-26T16:00:00.000Z',
    })).toEqual({
      shouldRefresh: false,
      refreshedDeadline: '2026-08-26T16:00:00.000Z',
    });
  });
});
