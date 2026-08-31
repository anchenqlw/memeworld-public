export type HomeCleaningPhase = 'idle' | 'cleaning' | 'fresh';

export type HomeCleaningState = {
  phase: HomeCleaningPhase;
  runId: number;
};

export type HomeCleaningEvent = 'finish-cleaning' | 'reset';

export const HOME_CLEANING_TIMING = Object.freeze({
  cleaningMs: 720,
  freshMs: 2_800,
});

export const INITIAL_HOME_CLEANING_STATE: HomeCleaningState = Object.freeze({
  phase: 'idle',
  runId: 0,
});

export function beginHomeCleaning(
  state: HomeCleaningState,
  prefersReducedMotion: boolean,
): HomeCleaningState {
  return {
    phase: prefersReducedMotion ? 'fresh' : 'cleaning',
    runId: state.runId + 1,
  };
}

export function advanceHomeCleaning(
  state: HomeCleaningState,
  event: HomeCleaningEvent,
  expectedRunId: number,
): HomeCleaningState {
  if (state.runId !== expectedRunId) return state;
  if (event === 'finish-cleaning' && state.phase === 'cleaning') {
    return { ...state, phase: 'fresh' };
  }
  if (event === 'reset' && state.phase === 'fresh') {
    return { ...state, phase: 'idle' };
  }
  return state;
}

export function homeCleaningButtonLabel(phase: HomeCleaningPhase): string {
  if (phase === 'cleaning') return '正在打扫…';
  if (phase === 'fresh') return '猫舍亮晶晶';
  return '打扫猫舍';
}

export function homeCleaningFeedback(phase: Exclude<HomeCleaningPhase, 'idle'>): string {
  return phase === 'cleaning'
    ? '轻轻扫去云絮和灰尘…'
    : '打扫好啦，猫舍变得亮晶晶。';
}
