/**
 * #071 许愿状态生命周期（框架无关 store）。
 *
 * 从 MapPanel 组件内联 state 抽出的原因：验收（evolution/reviews/pr-61-7246ba1.md）指出
 * pending 竞态——在 A 地点许愿、请求未返回时切到 B 或关闭弹窗，A 的请求随后 reject 才写入错误，
 * 此后 selected 不再变化、组件里的清理 effect 不会再执行，返回 A 时旧错误复现（违反验收标准 2）。
 * 修复靠「选中纪元（epoch）」：每次选中地点变化（含关闭弹窗）纪元 +1；toggle 发起时记下纪元，
 * 失败写回前校验纪元未变——用户一旦离开当时的语境，过期失败静默丢弃。
 * 抽成 store 也让这段异步 state 生命周期可以被测试直接驱动（仓库无 DOM 测试环境，无法挂载组件）。
 *
 * 返工二（evolution/reviews/pr-61-af0de67.md 阻塞发现）：store 之前只在创建时读一次
 * wishLocationId，父级 refresh 带来的权威愿望态永远进不来——关闭整个云图志（卸载 store 连同
 * busy 锁）再立刻重开，可对 B 再发请求；若旧 A 请求后成功，服务端最终愿望是 A 而新面板显示 B。
 * 修复靠 syncAuthoritative：父级 prop 变化即对账（prop 是权威）。本实例 busy（乐观更新
 * pending 中）时不立即覆盖而是缓冲，settle 后应用——区分「乐观态 pending 中」与「已落定」。
 * busy 锁刻意不上提为跨实例单例：模块级锁会跨面板/测试泄漏状态，而跨实例双请求的残余危害
 * （服务端 last-write-wins）恰好由本对账消化——旧实例 onChanged→父级 refresh→prop 变化→
 * 活动 store 收敛到服务端真相。
 *
 * 返工三（evolution/reviews/pr-61-506ba73.md 阻塞发现）：对账层有理论下限——HTTP 响应顺序
 * ≠服务端写入顺序，「自身成功→丢弃缓冲」在对手请求更晚落库、自己只是响应迟到时会留下
 * UI≠服务端的确定终态，且相同 prop 不会再触发 effect。修复在源头切断：toggle 内起
 * AbortController，dispose() 中止本实例 pending 请求——「旧实例迟到 resolve 覆盖新实例状态」
 * 失去物理可能。AbortError 静默：不写错误、不触发 onChanged。dispose 只中止当前 pending、
 * 不永久失效 store（StrictMode 模拟卸载重挂后可复用）。
 * syncAuthoritative 保留但职责收窄：只处理正常的父级权威对账（如另一设备/旧数据刷新），
 * 不再承担跨实例乱序竞态。
 *
 * #071b（evolution/reviews/pr-61-b82a2ab.md 第四轮阻塞发现的收口）：上面三层都建立在
 * 「store 随 MapPanel 组件生死」的前提上，而 abort 只让客户端停止观察响应、拦不住已到服务端的写。
 * 故仍有可达失配：旧 A 请求被 abort → 重开面板对 B 许愿成功并 refresh → 被 abort 的 A 才在服务端
 * 落库（last-write-wins=A）→ 终态 {server:A, UI:B}，且空闲态没有下一次 refresh 的时限保证。
 * 本条目按复核给出的方向修：**store 的创建/持有位置上提到 App 层常驻单例**（apps/web/src/App.tsx），
 * MapPanel 只订阅不拥有（卸载只解除订阅 + selectionChanged(null) 解除选中语境，不再 dispose）。
 * 于是「同标签页写入串行化」由本 store 的 busy 锁在同一逻辑实例上自动强制：旧请求真正 settle
 * 前 toggle 直接返回，跨实例双请求（也就是失配的唯一来源）失去物理可能。
 * store 内部三层职责（AbortController + epoch + syncAuthoritative）语义完全不变——只换宿主。
 * dispose() 的调用时机随之收窄为**用户会话结束**（logout / 401 掉线），不再由面板开关触发；
 * 跨标签页/多设备的总序仍需服务端 revision（属 protected_paths，超出本条目范围），
 * 由权威对账（GameStage 的 cat.travel_wish_location_id → syncAuthoritative）收敛。
 * 自觉代价（不是疏漏）：请求挂死时 busy 锁会一直握着，许愿按钮持续禁用到 fetch 自身 reject
 * 或会话结束——这正是「旧请求真正 settle 前不许发起新请求」的定义。要加超时/取消入口就得改
 * store 逻辑（本条目明确只换宿主），需另开条目权衡「可取消」与「不可失配」。
 */

export type WishError = { locationId: string; message: string };

export type WishFlowState = {
  /** 当前愿望地点；null=无愿望；undefined=宿主未接入许愿功能 */
  wishId: string | null | undefined;
  busy: boolean;
  error: WishError | null;
};

export type WishApi = {
  set: (locationId: string, opts?: { signal?: AbortSignal }) => Promise<unknown>;
  clear: (opts?: { signal?: AbortSignal }) => Promise<unknown>;
};

export function createWishFlow(
  initialWishId: string | null | undefined,
  api: WishApi,
  onChanged?: () => void,
) {
  let state: WishFlowState = { wishId: initialWishId, busy: false, error: null };
  // 选中纪元：selectionChanged 每次 +1。pending 请求以发起时的纪元为准，纪元变过则失败不写回。
  let epoch = 0;
  // 返工二：本实例 busy 期间收到的父级权威愿望态先缓冲，settle 后按「自身请求是否成功」决定取舍。
  let bufferedAuthoritative: { wishId: string | null | undefined } | null = null;
  // 返工三：当前 pending 请求的 AbortController；dispose（组件卸载）时中止，切断跨实例竞态源头。
  let controller: AbortController | null = null;
  const listeners = new Set<() => void>();
  const setState = (patch: Partial<WishFlowState>) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };
  // AbortError 判定：fetch 被 abort 时 reject DOMException(name='AbortError')（DOMException 是 Error 子类）；
  // 兜底再看 signal.aborted，防某些实现抛出非标准错误对象。
  const isAbortError = (e: unknown): boolean => e instanceof Error && e.name === 'AbortError';

  return {
    getState: () => state,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    /**
     * 返工三：中止本实例的 pending 许愿请求。被中止的请求静默结束：不写错误、不触发
     * onChanged、不应用缓冲——迟到 resolve 从此不可能覆盖后续状态。
     * 不永久失效 store：React StrictMode 会模拟卸载重挂，同一实例须可继续使用。
     * #071b：调用时机从「MapPanel unmount」上收到「用户会话结束」（App.logout / 401 掉线）——
     * 面板开关期间 store 常驻，pending 请求必须真正 settle 才释放 busy 锁（写入串行化的根据）。
     */
    dispose() {
      controller?.abort();
      controller = null;
    },
    /**
     * 返工二：接收权威愿望态（GameStage 从 refresh 后的 cat.travel_wish_location_id 下发）。
     * 空闲时直接对账覆盖乐观态；本实例请求 pending 中则缓冲，settle 时——
     * 自身成功 → 丢弃缓冲（自己的结果是更新的服务端真相，且 onChanged 会带来更新的 prop）；
     * 自身失败 → 应用缓冲（自己没改到服务端，缓冲值是当前最可信状态）。
     * 返工三后职责收窄为正常权威对账；跨实例乱序竞态已由 dispose/abort 在源头切断。
     * #071b：语义不变，只是对账入口从 MapPanel 上移到 GameStage——store 常驻后，云图志关着
     * 也照样对账（旧实现只在面板挂载期间才有对账机会）。
     */
    syncAuthoritative(wishId: string | null | undefined) {
      if (state.busy) { bufferedAuthoritative = { wishId }; return; }
      if (state.wishId !== wishId) setState({ wishId });
    },
    /** 选中地点变化（selectedId=null 表示关闭弹窗）：清掉不属于新地点的错误，并使 pending 请求的错误写回失效（验收 2） */
    selectionChanged(selectedId: string | null) {
      epoch += 1;
      if (state.error && state.error.locationId !== selectedId) setState({ error: null });
    },
    /** #056a：许愿/撤销。天性不足时服务端 400，文案原样展示（「它还不敢去那么远的地方」）。 */
    async toggle(loc: { id: string; name: string }) {
      // #071b：这把 busy 锁就是「同标签页写入串行化」——store 常驻 App 层后，关闭/重开云图志
      // 不再销毁它，旧请求真正 settle 前第二次 toggle 在此直接返回，跨实例双请求交错失去可能。
      if (state.busy) return;
      const epochAtStart = epoch;
      const own = new AbortController();
      controller = own;
      let succeeded = false;
      let aborted = false;
      setState({ busy: true, error: null });
      try {
        if (state.wishId === loc.id) {
          await api.clear({ signal: own.signal });
          setState({ wishId: null });
        } else {
          await api.set(loc.id, { signal: own.signal });
          // 成功不做纪元守卫：服务端已记录愿望，本地乐观态必须跟上，否则 UI 与服务端不一致。
          setState({ wishId: loc.id });
        }
        succeeded = true;
        onChanged?.();
      } catch (e) {
        if (isAbortError(e) || own.signal.aborted) {
          // 返工三：被 dispose 中止的请求静默结束——不写错误、不触发 onChanged（pr-61-506ba73.md）。
          // #071b 后 dispose 只在会话结束时调用。
          aborted = true;
        } else if (epoch === epochAtStart) {
          // #071 竞态修复：pending 期间切换过地点/关闭过弹窗（纪元已变）→ 过期失败静默丢弃，
          // 否则旧错误会在 selected 不再变化后残留，返回原地点时复现。
          setState({ error: { locationId: loc.id, message: e instanceof Error ? e.message : '许愿没有送达，请再试一次' } });
        }
      } finally {
        if (controller === own) controller = null;
        const buffered = bufferedAuthoritative;
        bufferedAuthoritative = null;
        if (buffered && !succeeded && !aborted && state.wishId !== buffered.wishId) {
          setState({ busy: false, wishId: buffered.wishId });
        } else {
          setState({ busy: false });
        }
      }
    },
  };
}

export type WishFlow = ReturnType<typeof createWishFlow>;
