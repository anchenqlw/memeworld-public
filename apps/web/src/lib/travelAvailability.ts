import type { TravelAvailabilityStatus } from '../api/client';

export type TravelAvailabilityView = {
  status: TravelAvailabilityStatus;
  next_available_at: string | null;
};

export type TravelAvailabilityPresentation = {
  text: string;
  expired: boolean;
};

export type TravelAvailabilityRefreshDecision = {
  shouldRefresh: boolean;
  refreshedDeadline: string | null;
};

/**
 * #126：权威 deadline 到期后的唯一刷新判据。
 *
 * 纯函数同时锁定方向（只能 now >= deadline）和一次性语义（同一 deadline 只刷新一次）；
 * React effect 只负责推进时钟并执行这里返回的决定，不再自行复制状态机。
 */
export function decideTravelAvailabilityRefresh(input: {
  nowMs: number;
  nextAvailableAt: string;
  refreshedDeadline: string | null;
}): TravelAvailabilityRefreshDecision {
  const deadline = Date.parse(input.nextAvailableAt);
  if (!Number.isFinite(deadline) || input.nowMs < deadline || input.refreshedDeadline === input.nextAvailableAt) {
    return { shouldRefresh: false, refreshedDeadline: input.refreshedDeadline };
  }
  return { shouldRefresh: true, refreshedDeadline: input.nextAvailableAt };
}

export function remainingTravelTime(nextAvailableAt: string | null, nowMs = Date.now()): string | null {
  if (!nextAvailableAt) return null;
  const target = Date.parse(nextAvailableAt);
  if (!Number.isFinite(target)) return null;
  const minutes = Math.max(0, Math.ceil((target - nowMs) / 60_000));
  if (minutes === 0) return '已到可再次出发时间';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours && rest) return `还剩 ${hours} 小时 ${rest} 分钟`;
  if (hours) return `还剩 ${hours} 小时`;
  return `还剩 ${rest} 分钟`;
}

export function presentTravelAvailability(input: TravelAvailabilityView | null, nowMs = Date.now()): TravelAvailabilityPresentation {
  if (!input) return { text: '旅行时间暂时无法确认，请稍后刷新', expired: false };
  if (input.status === 'available') return { text: '今天还可以出发', expired: false };
  const target = input.next_available_at ? Date.parse(input.next_available_at) : Number.NaN;
  if (Number.isFinite(target) && nowMs >= target) {
    return { text: '已到可再次出发时间，正在刷新状态', expired: true };
  }
  const state = input.status === 'departed_today' ? '今天已出发' : '今天已完成';
  const remaining = remainingTravelTime(input.next_available_at, nowMs);
  return { text: `${state}，明天 00:00 后可再次出发${remaining ? ` · ${remaining}` : ''}`, expired: false };
}

export function travelAvailabilityText(input: TravelAvailabilityView | null, nowMs = Date.now()): string {
  return presentTravelAvailability(input, nowMs).text;
}
