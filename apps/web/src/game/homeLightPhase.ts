export type HomeLightPhase = 'dawn' | 'day' | 'dusk' | 'night';

export const HOME_LIGHT_PHASES: readonly HomeLightPhase[] = ['dawn', 'day', 'dusk', 'night'];

export const HOME_BACKGROUND_URLS: Record<HomeLightPhase, string> = {
  dawn: '/assets/game/home/cloud-home-dawn-v2.png',
  day: '/assets/game/home/cloud-home-day-v2.png',
  dusk: '/assets/game/home/cloud-home-dusk-v2.png',
  night: '/assets/game/home/cloud-home-night-v2.png',
};

const PHASE_BOUNDARIES = [5, 8, 17, 20] as const;

/** 按浏览器本地时间选择猫舍光线，不依赖服务器时区。 */
export function homeLightPhaseAt(date: Date): HomeLightPhase {
  const hour = date.getHours();
  if (hour >= 5 && hour < 8) return 'dawn';
  if (hour >= 8 && hour < 17) return 'day';
  if (hour >= 17 && hour < 20) return 'dusk';
  return 'night';
}

export function nextHomeLightPhase(phase: HomeLightPhase): HomeLightPhase {
  const index = HOME_LIGHT_PHASES.indexOf(phase);
  return HOME_LIGHT_PHASES[(index + 1) % HOME_LIGHT_PHASES.length];
}

/** 距离下一个本地时段边界的毫秒数；用本地 setHours 保持夏令时语义。 */
export function millisecondsUntilNextHomeLightBoundary(date: Date): number {
  for (const hour of PHASE_BOUNDARIES) {
    const candidate = new Date(date);
    candidate.setHours(hour, 0, 0, 0);
    if (candidate.getTime() > date.getTime()) return candidate.getTime() - date.getTime();
  }

  const tomorrow = new Date(date);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(PHASE_BOUNDARIES[0], 0, 0, 0);
  return tomorrow.getTime() - date.getTime();
}

type HomeLightClockOptions = {
  onPhase: (phase: HomeLightPhase) => void;
  now?: () => Date;
  schedule?: (callback: () => void, delayMs: number) => number;
  cancel?: (timer: number) => void;
};

/**
 * 统一边界定时与外部唤醒刷新。visibility/focus/pageshow 只需调用 refresh，
 * 因而休眠期间错过定时器也会立即按新的本地时间校正。
 */
export function createHomeLightClock({
  onPhase,
  now = () => new Date(),
  schedule = (callback, delayMs) => window.setTimeout(callback, delayMs),
  cancel = (timer) => window.clearTimeout(timer),
}: HomeLightClockOptions): { refresh: () => void; stop: () => void } {
  let timer: number | undefined;

  const refresh = () => {
    const current = now();
    onPhase(homeLightPhaseAt(current));
    if (timer !== undefined) cancel(timer);
    timer = schedule(refresh, millisecondsUntilNextHomeLightBoundary(current) + 50);
  };

  refresh();
  return {
    refresh,
    stop: () => {
      if (timer !== undefined) cancel(timer);
      timer = undefined;
    },
  };
}
