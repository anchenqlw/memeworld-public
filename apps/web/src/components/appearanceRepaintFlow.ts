import type { AppearanceRepaintState, CatProfile } from '../api/client';

/**
 * #077 形象重画申诉的展示分支与动作序列（框架无关）。
 *
 * 抽成模块的原因：仓库没有 DOM 测试环境（apps/web 无 jsdom / testing-library），
 * 入口可见性与「确认才替换」这两条验收语义必须能被测试直接驱动，
 * 不能藏在组件的 useState 里。组件只负责渲染这里算出的 view/state。
 */

export type RepaintView =
  | { mode: 'request'; state: AppearanceRepaintState; blockedReason: string | null }
  | { mode: 'decide'; state: AppearanceRepaintState; candidate: NonNullable<AppearanceRepaintState['pending_candidate']> }
  | { mode: 'exhausted'; state: AppearanceRepaintState };

/**
 * 决定重画卡的展示分支。返回 null = 不渲染入口。
 * eligible 由服务端按 lifecycle_stage 判定：形象未确认时建猫向导里本来就能重画，
 * 不需要（也不该出现）这条申诉路径。
 */
export function appearanceRepaintViewFor(
  cat: Pick<CatProfile, 'appearance_repaint'>,
): RepaintView | null {
  const state = cat.appearance_repaint;
  // eligible=false（形象未确认）或服务端未下发该字段（旧版本响应）→ 不给入口
  if (!state?.eligible) return null;
  // 已画好、等用户决定的新形象优先——必须先替换或保留，才能再申请下一张
  if (state.pending_candidate) return { mode: 'decide', state, candidate: state.pending_candidate };
  if (state.remaining <= 0) return { mode: 'exhausted', state };
  return {
    mode: 'request',
    state,
    blockedReason: state.image_job_active ? '云端画师正在画上一张，画好了再来申请重画。' : null,
  };
}

export type RepaintFlowState = {
  /** 'confirming' = 已点「换成这一张」、等二次确认；替换请求只在 confirmReplace 时才发出 */
  stage: 'idle' | 'confirming';
  busy: boolean;
  notice: string;
  error: string;
};

export type RepaintFlowApi = {
  request: (customDescription?: string) => Promise<unknown>;
  confirm: (appearanceId: string) => Promise<unknown>;
  discard: () => Promise<unknown>;
};

/**
 * 重画申诉的动作序列。
 *
 * 不静默换猫（#024）由两点保证：
 * 1. request() 只排队生成候选，永不写主形象（服务端同样如此）；
 * 2. 替换必须走 askReplace() → confirmReplace()：单击只进入二次确认态，
 *    真正的替换请求只在用户第二次点击时发出；discard() 是同等地位的另一条出口。
 */
export function createRepaintFlow(api: RepaintFlowApi, onChanged?: () => void) {
  let state: RepaintFlowState = { stage: 'idle', busy: false, notice: '', error: '' };
  const listeners = new Set<() => void>();
  const setState = (patch: Partial<RepaintFlowState>) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };

  const run = async (action: () => Promise<unknown>, successNotice: string) => {
    if (state.busy) return;
    setState({ busy: true, notice: '', error: '' });
    try {
      await action();
      setState({ busy: false, stage: 'idle', notice: successNotice });
      onChanged?.();
    } catch (e) {
      setState({ busy: false, error: e instanceof Error ? e.message : '这次没有成功，请稍后再试' });
    }
  };

  return {
    getState: () => state,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    /** 进入二次确认态——此刻不发任何请求，主形象不变 */
    askReplace() {
      if (state.busy) return;
      setState({ stage: 'confirming', notice: '', error: '' });
    },
    cancelReplace() {
      if (state.busy) return;
      setState({ stage: 'idle' });
    },
    request(customDescription?: string) {
      return run(() => api.request(customDescription), '重画请求已发出，云端画师开始画了，画好会在这里等你确认。');
    },
    /** 用户明确确认后才替换主形象 */
    confirmReplace(appearanceId: string) {
      return run(() => api.confirm(appearanceId), '已经换成新的形象啦。');
    },
    /** 放弃这张新图，保留原来的它 */
    discard() {
      return run(() => api.discard(), '还是原来的它，形象没有改动。');
    },
  };
}
