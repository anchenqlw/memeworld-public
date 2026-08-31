import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createWishFlow, type WishApi } from './wishFlow';
import { wishErrorText } from './MapPanel';

/**
 * #071 验收回归（evolution/reviews/pr-61-7246ba1.md 阻塞发现 1）：
 * pending 竞态——在 A 许愿、请求未返回时切到 B 或关闭弹窗，A 的请求随后 reject，
 * 旧实现会把 { locationId: A } 写回 state；因 selected 不再变化、清理 effect 不再执行，
 * 返回 A 时旧错误复现。本文件直接驱动 wishFlow（MapPanel 的许愿状态生命周期）复现该时序。
 * 仓库无 DOM 测试环境（jsdom/happy-dom 不在依赖内，package.json 属 protected_paths），
 * 故将状态生命周期抽为 store 后在此做组件级行为等价的生命周期回归。
 */

type Deferred = { resolve: (value?: unknown) => void; reject: (reason?: unknown) => void };

function deferredApi(): { api: WishApi; setCalls: Deferred[]; clearCalls: Deferred[] } {
  const setCalls: Deferred[] = [];
  const clearCalls: Deferred[] = [];
  return {
    setCalls,
    clearCalls,
    api: {
      set: () => new Promise((resolve, reject) => { setCalls.push({ resolve, reject }); }),
      clear: () => new Promise((resolve, reject) => { clearCalls.push({ resolve, reject }); }),
    },
  };
}

const flush = () => new Promise((resolve) => { setTimeout(resolve, 0); });

describe('wishFlow：pending 竞态（验收标准 2 的异步时序）', () => {
  it('A 许愿 pending 时切到 B，请求随后 reject：返回 A 不复现旧错误', async () => {
    const { api, setCalls } = deferredApi();
    const flow = createWishFlow(null, api);
    flow.selectionChanged('loc-moon'); // 打开 A 弹窗

    const pending = flow.toggle({ id: 'loc-moon', name: '月海星原' });
    expect(flow.getState().busy).toBe(true);

    flow.selectionChanged('loc-teahouse'); // pending 期间切到 B（此刻尚无错误，旧清理逻辑在此看到 null 不动作）
    setCalls[0].reject(new Error('它还不敢去那么远的地方')); // A 的请求这才失败
    await pending;

    expect(flow.getState().error).toBeNull(); // 过期失败被丢弃，而非写回 { locationId: A }
    expect(flow.getState().busy).toBe(false);

    flow.selectionChanged('loc-moon'); // 返回 A
    expect(flow.getState().error).toBeNull();
    expect(wishErrorText(flow.getState().error, 'loc-moon')).toBeNull(); // A 弹窗内不展示旧错误
  });

  it('A 许愿 pending 时关闭弹窗，请求随后 reject：重新打开 A 不复现旧错误', async () => {
    const { api, setCalls } = deferredApi();
    const flow = createWishFlow(null, api);
    flow.selectionChanged('loc-moon');

    const pending = flow.toggle({ id: 'loc-moon', name: '月海星原' });
    flow.selectionChanged(null); // 关闭弹窗
    setCalls[0].reject(new Error('它还不敢去那么远的地方'));
    await pending;

    expect(flow.getState().error).toBeNull();
    flow.selectionChanged('loc-moon');
    expect(flow.getState().error).toBeNull();
  });

  it('pending 时切到 B 又切回 A、随后 reject：同样不写回旧错误', async () => {
    const { api, setCalls } = deferredApi();
    const flow = createWishFlow(null, api);
    flow.selectionChanged('loc-moon');

    const pending = flow.toggle({ id: 'loc-moon', name: '月海星原' });
    flow.selectionChanged('loc-teahouse');
    flow.selectionChanged('loc-moon'); // 返回 A（用户已离开当时的许愿语境）
    setCalls[0].reject(new Error('它还不敢去那么远的地方'));
    await pending;

    expect(flow.getState().error).toBeNull();
  });

  it('未切换地点时失败正常展示（修复不误伤同地点的失败提示）', async () => {
    const { api, setCalls } = deferredApi();
    const flow = createWishFlow(null, api);
    flow.selectionChanged('loc-moon');

    const pending = flow.toggle({ id: 'loc-moon', name: '月海星原' });
    setCalls[0].reject(new Error('它还不敢去那么远的地方'));
    await pending;

    expect(flow.getState().error).toEqual({ locationId: 'loc-moon', message: '它还不敢去那么远的地方' });
    expect(wishErrorText(flow.getState().error, 'loc-moon')).toBe('它还不敢去那么远的地方');
  });
});

describe('wishFlow：顺序态清除与独立校验（验收标准 1/2）', () => {
  it('错误已落 state 后切到 B：立即清除；对 B 重新许愿走独立请求', async () => {
    const { api, setCalls } = deferredApi();
    const flow = createWishFlow(null, api);
    flow.selectionChanged('loc-moon');

    const first = flow.toggle({ id: 'loc-moon', name: '月海星原' });
    setCalls[0].reject(new Error('它还不敢去那么远的地方'));
    await first;
    expect(flow.getState().error?.locationId).toBe('loc-moon');

    flow.selectionChanged('loc-teahouse'); // 切到 B：立即清除
    expect(flow.getState().error).toBeNull();

    const second = flow.toggle({ id: 'loc-teahouse', name: '山腰茶馆' });
    expect(setCalls.length).toBe(2); // B 的许愿是独立 API 调用
    setCalls[1].resolve();
    await second;
    expect(flow.getState().wishId).toBe('loc-teahouse');
    expect(flow.getState().error).toBeNull();
  });

  it('关闭弹窗清除已存在的错误', async () => {
    const { api, setCalls } = deferredApi();
    const flow = createWishFlow(null, api);
    flow.selectionChanged('loc-moon');
    const pending = flow.toggle({ id: 'loc-moon', name: '月海星原' });
    setCalls[0].reject(new Error('它还不敢去那么远的地方'));
    await pending;
    expect(flow.getState().error).not.toBeNull();

    flow.selectionChanged(null);
    expect(flow.getState().error).toBeNull();
  });
});

describe('wishFlow：成功路径与并发保护', () => {
  it('许愿成功更新乐观态并回调 onChanged；即使 pending 期间切换过地点，成功仍落地（与服务端一致）', async () => {
    const { api, setCalls } = deferredApi();
    let changed = 0;
    const flow = createWishFlow(null, api, () => { changed += 1; });
    flow.selectionChanged('loc-moon');
    const pending = flow.toggle({ id: 'loc-moon', name: '月海星原' });
    flow.selectionChanged('loc-teahouse'); // 成功不做纪元守卫：服务端已记录愿望
    setCalls[0].resolve();
    await pending;
    expect(flow.getState().wishId).toBe('loc-moon');
    expect(changed).toBe(1);
  });

  it('撤销愿望成功后 wishId 归零', async () => {
    const { api, clearCalls } = deferredApi();
    const flow = createWishFlow('loc-moon', api);
    flow.selectionChanged('loc-moon');
    const pending = flow.toggle({ id: 'loc-moon', name: '月海星原' });
    clearCalls[0].resolve();
    await pending;
    expect(flow.getState().wishId).toBeNull();
  });

  it('busy 期间重复 toggle 不发起第二个请求', async () => {
    const { api, setCalls } = deferredApi();
    const flow = createWishFlow(null, api);
    flow.selectionChanged('loc-moon');
    const first = flow.toggle({ id: 'loc-moon', name: '月海星原' });
    void flow.toggle({ id: 'loc-moon', name: '月海星原' });
    expect(setCalls.length).toBe(1);
    setCalls[0].resolve();
    await first;
    await flush();
    expect(setCalls.length).toBe(1);
  });

  it('subscribe/unsubscribe：退订后不再收到通知', async () => {
    const { api, setCalls } = deferredApi();
    const flow = createWishFlow(null, api);
    let notified = 0;
    const unsubscribe = flow.subscribe(() => { notified += 1; });
    const pending = flow.toggle({ id: 'loc-moon', name: '月海星原' });
    expect(notified).toBeGreaterThan(0);
    unsubscribe();
    const before = notified;
    setCalls[0].resolve();
    await pending;
    expect(notified).toBe(before);
  });
});

/**
 * #071 返工二回归（evolution/reviews/pr-61-af0de67.md 阻塞发现 1）：
 * 关闭整个云图志会卸载 MapPanel 连同 store（busy 锁一起销毁）；立刻重开得到新 store。
 * 返工三后（pr-61-506ba73.md）：跨实例竞态由 dispose/abort 在源头切断，
 * syncAuthoritative 职责收窄为正常的父级权威对账——本块覆盖对账语义与「dispose 即中止」。
 * #071b 后 store 上提到 App 层常驻，dispose 的调用时机变成会话结束（logout/401），
 * 本块因此改读作「store 级保证」：dispose 后旧 pending 不再回写、权威对账语义不变（都未改动）；
 * 「关闭/重开面板」这条路径的新语义（不 dispose、busy 锁跨面板保持）见文件末尾的 #071b 块。
 */
describe('wishFlow：dispose 中止与权威状态对账（返工二/三，store 级保证）', () => {
  type SetCall = { locationId: string; aborted: boolean; resolve: () => void; reject: (e: Error) => void };

  function world(initialServer: string | null = null) {
    let server: string | null = initialServer;
    let parentWish: string | null = initialServer;
    let activeFlow: ReturnType<typeof createWishFlow> | null = null;
    const setCalls: SetCall[] = [];
    const api: WishApi = {
      set: (locationId, opts) => new Promise<void>((res, rej) => {
        const call: SetCall = {
          locationId,
          aborted: false,
          resolve: () => { if (!call.aborted) { server = locationId; res(); } }, // abort 在途：请求被取消，不落库不响应
          reject: (e: Error) => { if (!call.aborted) rej(e); },
        };
        opts?.signal?.addEventListener('abort', () => {
          call.aborted = true;
          rej(new DOMException('The operation was aborted.', 'AbortError'));
        });
        setCalls.push(call);
      }),
      clear: () => new Promise<void>((res) => { server = null; res(); }),
    };
    // onChanged → GameStage refresh()：读服务端最新值 → prop 变化 → 活动实例的 sync effect
    const onChanged = () => { parentWish = server; activeFlow?.syncAuthoritative(parentWish); };
    return {
      api, setCalls, onChanged,
      getServer: () => server,
      getParentWish: () => parentWish,
      mount() { // 模拟 MapPanel 挂载：createWishFlow(当前 prop) + mount effect 的一次 syncAuthoritative
        const flow = createWishFlow(parentWish, api, onChanged);
        activeFlow = flow;
        flow.syncAuthoritative(parentWish);
        return flow;
      },
      unmount(flow: ReturnType<typeof createWishFlow>) { // 会话结束（#071b 前是 MapPanel unmount）：dispose 中止 pending 请求
        flow.dispose();
        if (activeFlow === flow) activeFlow = null;
      },
    };
  }

  it('dispose 即 abort：被中止实例的 pending 请求不再落库，双请求不再可能交错', async () => {
    const w = world();
    const flowA = w.mount();
    flowA.selectionChanged('loc-moon');
    const pendingA = flowA.toggle({ id: 'loc-moon', name: '月海星原' }); // A 请求 pending

    w.unmount(flowA); // 会话结束：dispose 中止 A 的请求
    await pendingA;
    expect(flowA.getState().error).toBeNull(); // abort 静默，不写错误
    expect(flowA.getState().busy).toBe(false);

    const flowB = w.mount(); // 新会话/新实例
    flowB.selectionChanged('loc-teahouse');
    const pendingB = flowB.toggle({ id: 'loc-teahouse', name: '山腰茶馆' });
    w.setCalls[1].resolve();
    await pendingB;

    w.setCalls[0].resolve(); // A 的「迟到响应」：已被 abort，不落库、不影响客户端
    expect(w.getServer()).toBe('loc-teahouse');
    expect(w.getParentWish()).toBe('loc-teahouse');
    expect(flowB.getState().wishId).toBe('loc-teahouse'); // UI 与服务端一致
  });

  it('空闲时收到父级权威更新：直接对账覆盖', () => {
    const w = world('loc-moon');
    const flow = w.mount();
    expect(flow.getState().wishId).toBe('loc-moon');
    flow.syncAuthoritative(null); // 外部（如另一设备/旧数据刷新）清除了愿望，refresh 带来 null
    expect(flow.getState().wishId).toBeNull();
  });

  it('busy 中收到权威更新且自身请求失败：settle 后应用缓冲值（自己没改到服务端）', async () => {
    const w = world();
    const flow = w.mount();
    flow.selectionChanged('loc-teahouse');
    const pending = flow.toggle({ id: 'loc-teahouse', name: '山腰茶馆' });
    flow.syncAuthoritative('loc-moon'); // 外部权威值在 B pending 中到达
    expect(flow.getState().wishId).toBeNull(); // busy 中不打断乐观流程，先缓冲
    w.setCalls[0].reject(new Error('它还不敢去那么远的地方'));
    await pending;
    expect(flow.getState().wishId).toBe('loc-moon'); // 自身失败 → 缓冲的权威值生效
    expect(flow.getState().error?.locationId).toBe('loc-teahouse'); // B 的失败提示不受影响
  });

  it('busy 中收到权威更新但自身请求成功：丢弃缓冲，保留自己的乐观结果（更新的服务端真相）', async () => {
    const w = world();
    const flow = w.mount();
    flow.selectionChanged('loc-teahouse');
    const pending = flow.toggle({ id: 'loc-teahouse', name: '山腰茶馆' });
    flow.syncAuthoritative('loc-moon'); // 过期的权威值在 pending 中到达
    w.setCalls[0].resolve(); // 自己的请求成功：服务端此刻已是 B
    await pending;
    expect(flow.getState().wishId).toBe('loc-teahouse'); // 不被过期缓冲覆盖
    expect(w.getServer()).toBe('loc-teahouse');
  });
});

/**
 * #071 返工三回归（evolution/reviews/pr-61-506ba73.md 阻塞发现）：
 * HTTP 响应顺序≠服务端写入顺序，「自身成功→丢弃缓冲」对并发请求不成立；且 App.refresh 是
 * 异步无序的，prop 值不变时 React effect 不重跑——靠事后对账有理论下限。修复在源头：
 * dispose() abort pending 请求（#071b 后该调用点是 App 的会话边界，见文件末尾块）。
 * 本 harness 按 codex 的批评点保留四个真实边界：
 *   1. 服务端落库（writeServer）与 HTTP 响应到达（deliver）是两个独立事件，顺序可倒挂；
 *   2. refresh 是异步的（queueMicrotask 模拟 void refresh()→loadBootstrap）；
 *   3. React effect 依赖相等语义：prop 值不变不重跑（refresh 里显式比较）；
 *   4. abort 只保证客户端不再观察响应/不触发 onChanged（服务端可能已处理——第四轮据此判 request-changes，
 *      #071b 用「常驻 store 的 busy 锁串行化同标签页写入」关闭）。
 */
describe('wishFlow：dispose/abort 在源头切断乱序竞态（返工三）', () => {
  type Wire = {
    locationId: string;
    aborted: boolean;
    /** 服务端落库（独立于响应；abort 不必然阻止——请求可能已达服务端） */
    writeServer: () => void;
    /** HTTP 响应到达客户端；abort 后 no-op（客户端已不再观察） */
    deliver: () => void;
    fail: (e: Error) => void;
  };

  function transport() {
    let server: string | null = null;
    let parentWish: string | null = null;
    let onChangedCount = 0;
    let activeFlow: ReturnType<typeof createWishFlow> | null = null;
    const wires: Wire[] = [];
    const api: WishApi = {
      set: (locationId, opts) => new Promise<void>((res, rej) => {
        const wire: Wire = {
          locationId,
          aborted: false,
          writeServer: () => { server = locationId; },
          deliver: () => { if (!wire.aborted) res(); },
          fail: (e) => { if (!wire.aborted) rej(e); },
        };
        opts?.signal?.addEventListener('abort', () => {
          wire.aborted = true;
          rej(new DOMException('The operation was aborted.', 'AbortError'));
        });
        wires.push(wire);
      }),
      clear: () => Promise.resolve(),
    };
    // 真实链路：onChanged → void refresh()（异步）→ 新 cat 对象 → MapPanel effect 仅在
    // wishLocationId 值变化时重跑（React 依赖相等性）。
    const onChanged = () => {
      onChangedCount += 1;
      queueMicrotask(() => {
        const next = server;
        const changed = next !== parentWish;
        parentWish = next;
        if (changed) activeFlow?.syncAuthoritative(next); // 值不变 → effect 不重跑
      });
    };
    return {
      wires,
      getServer: () => server,
      getParentWish: () => parentWish,
      getOnChangedCount: () => onChangedCount,
      mount() {
        const flow = createWishFlow(parentWish, api, onChanged);
        activeFlow = flow;
        flow.syncAuthoritative(parentWish);
        return flow;
      },
      unmount(flow: ReturnType<typeof createWishFlow>) {
        flow.dispose();
        if (activeFlow === flow) activeFlow = null;
      },
    };
  }

  const drainMicrotasks = () => new Promise((resolve) => { setTimeout(resolve, 0); });

  it('请求发出→组件 unmount→abort：迟到响应不可达，无状态写入、不触发 onChanged', async () => {
    const t = transport();
    const flow = t.mount();
    flow.selectionChanged('loc-moon');
    const pending = flow.toggle({ id: 'loc-moon', name: '月海星原' });

    t.unmount(flow); // abort：请求在途被取消（本例未达服务端）
    await pending;
    t.wires[0].deliver(); // 响应「本应回来」：已 abort，无效
    await drainMicrotasks();

    expect(flow.getState().wishId).toBeNull(); // UI 不受迟到响应影响
    expect(flow.getState().busy).toBe(false);
    expect(flow.getState().error).toBeNull();
    expect(t.getOnChangedCount()).toBe(0); // 不触发 onChanged → 不会污染父级
    expect(t.getServer()).toBeNull();
  });

  it('abort 分支静默不写 error（对照：同一选中语境下普通失败会写）', async () => {
    const t = transport();
    const flow = t.mount();
    flow.selectionChanged('loc-moon');

    const first = flow.toggle({ id: 'loc-moon', name: '月海星原' });
    t.wires[0].fail(new Error('它还不敢去那么远的地方'));
    await first;
    expect(flow.getState().error?.message).toBe('它还不敢去那么远的地方'); // 普通失败：epoch 未变，写错误

    const second = flow.toggle({ id: 'loc-moon', name: '月海星原' }); // 重试（发起时清掉旧错误）
    t.unmount(flow); // epoch 同样未变，但这次是 abort
    await second;
    expect(flow.getState().error).toBeNull(); // AbortError 静默，不进「写错误」路径
  });

  it('codex 阻塞时序（A 先落库 B 后落库、B 响应先回、异步 refresh、prop 相等性）：abort 后不再产生 UI≠服务端', async () => {
    const t = transport();
    // 旧实例对 B（teahouse）发起请求
    const flowOld = t.mount();
    flowOld.selectionChanged('loc-teahouse');
    const pendingOld = flowOld.toggle({ id: 'loc-teahouse', name: '山腰茶馆' });

    t.unmount(flowOld); // 关闭整个云图志：abort（但请求已达服务端——残余窗口，见 wire.writeServer）
    await pendingOld;

    // 重开，活动实例对 A（moon）发起请求
    const flowNew = t.mount();
    flowNew.selectionChanged('loc-moon');
    const pendingNew = flowNew.toggle({ id: 'loc-moon', name: '月海星原' });

    t.wires[1].writeServer(); // 服务端先写 A
    t.wires[0].writeServer(); // 服务端后写 B（last-write-wins 真相=B）——abort 没拦住服务端处理
    t.wires[0].deliver();     // B 的响应先回：已 abort → 客户端不观察、旧实例 onChanged 不触发
    await drainMicrotasks();  // （修复前这里会经旧实例 onChanged 把 prop=B 缓冲进活动 store）
    expect(t.getParentWish()).toBeNull(); // 旧实例已死，prop 未被污染为 B

    t.wires[1].deliver(); // A 的响应最后到达 → 活动实例成功 → 乐观态 A → 自身 onChanged
    await pendingNew;
    await drainMicrotasks(); // 自身 refresh 读到服务端真相 B；prop null→B 变化 → effect 重跑 → 对账

    expect(t.getServer()).toBe('loc-teahouse');
    expect(t.getParentWish()).toBe('loc-teahouse');
    expect(flowNew.getState().wishId).toBe('loc-teahouse'); // 活动 UI 收敛到服务端 last-write-wins，无失配终态
    expect(flowNew.getState().busy).toBe(false);
  });
});

/**
 * #071b 回归（evolution/reviews/pr-61-b82a2ab.md 第四轮阻塞发现）：
 * 前三轮都建立在「store 随 MapPanel 组件生死」的前提上，而 abort 只让客户端停止观察响应，
 * 拦不住已经到达服务端的写。复核记录的可达序列：
 *   1. 旧实例对 A 发请求；
 *   2. 关闭整个云图志 → 旧实现 cleanup 调 dispose()，busy 锁随 store 一起消失；
 *   3. 立刻重开得到新 store（busy=false）→ 对 B 许愿成功 → onChanged→refresh，父级 prop 与 UI 都成 B；
 *   4. 被 abort 的 A 之后才在服务端落库，last-write-wins 真相变回 A；
 *   5. 确定终态 {server:'A', parentProp:'B', activeWish:'B'}——UI 显示 B、下次旅行读到 A，
 *      且空闲态没有下一次 refresh 的时限保证。
 * 修法（复核给出的方向）：把 store 的创建/持有位置上提到不随 MapPanel 卸载的宿主（App 层常驻单例），
 * 让同标签页写入串行化——旧请求真正 settle 前不允许发起新请求。于是第 3 步的第二个请求根本发不出去，
 * 「跨实例双请求」这个失配的唯一来源被物理消掉。store 内部三层职责一行未改。
 *
 * 本 harness 按新接线建模宿主（仓库无 DOM 测试环境，沿用框架无关的 store 驱动）：
 *   - createWishFlow 只在 appMount() 调一次 → 对应 App.tsx 的 wishFlowRef 惰性单例；
 *   - 权威对账在 GameStage 层（stageSync）——只要有猫就存活，与云图志开关无关；
 *   - openPanel/closePanel = MapPanel 挂载/卸载：只订阅/退订 + selectionChanged，绝不 dispose；
 *   - logout() 才 dispose（会话边界是唯一 dispose 时机）。
 * 第四轮认可的四个真实边界全部保留：落库(writeServer)与响应(deliver)分离、refresh 异步、
 * prop 相等则 effect 不重跑、abort 拦不住服务端已处理的写。
 */
describe('wishFlow：App 层常驻单例 + 面板只订阅不拥有（#071b）', () => {
  type Wire = {
    locationId: string;
    aborted: boolean;
    /** 服务端落库（独立于响应；abort 不必然阻止） */
    writeServer: () => void;
    /** HTTP 响应到达客户端；abort 后 no-op */
    deliver: () => void;
    fail: (e: Error) => void;
  };

  function app(mode: 'app-level' | 'legacy-panel-level' = 'app-level') {
    let server: string | null = null;
    // GameStage 手里的 cat.travel_wish_location_id（App.refresh 后下发的权威 prop）
    let stageWish: string | null = null;
    let refreshCount = 0;
    let created = 0;
    let flow: ReturnType<typeof createWishFlow> | null = null;
    const wires: Wire[] = [];
    const api: WishApi = {
      set: (locationId, opts) => new Promise<void>((res, rej) => {
        const wire: Wire = {
          locationId,
          aborted: false,
          writeServer: () => { server = locationId; },
          deliver: () => { if (!wire.aborted) res(); },
          fail: (e) => { if (!wire.aborted) rej(e); },
        };
        opts?.signal?.addEventListener('abort', () => {
          wire.aborted = true;
          rej(new DOMException('The operation was aborted.', 'AbortError'));
        });
        wires.push(wire);
      }),
      clear: () => new Promise<void>((res) => { server = null; res(); }),
    };
    // onChanged → App.refresh()（异步）→ 新 cat → GameStage 的 sync effect 仅在值变化时重跑
    const onChanged = () => {
      refreshCount += 1;
      queueMicrotask(() => {
        const next = server;
        const changed = next !== stageWish;
        stageWish = next;
        if (changed) flow?.syncAuthoritative(next);
      });
    };
    const host = {
      wires,
      getServer: () => server,
      getStageWish: () => stageWish,
      getRefreshCount: () => refreshCount,
      /** store 被创建过几次——常驻单例的直接证据 */
      getCreated: () => created,
      flow: () => flow!,
      /** App 挂载：创建单例（初值 undefined，App 不知道 cat）+ GameStage 挂载 effect 下发权威值 */
      appMount() {
        if (!flow) {
          flow = createWishFlow(undefined, api, onChanged);
          created += 1;
          flow.syncAuthoritative(stageWish);
        }
        return flow;
      },
      /** GameStage 的权威对账 effect：cat.travel_wish_location_id 变化即下发（与面板开关无关） */
      stageSync(wishId: string | null) {
        const changed = wishId !== stageWish;
        stageWish = wishId;
        if (changed) flow?.syncAuthoritative(wishId);
      },
      /** 旧接线对照（#071b 前）：store 是 MapPanel 的 useRef——每次打开面板新建、关闭即 dispose */
      panelStore() {
        flow = createWishFlow(stageWish, api, onChanged); // 旧实现拿 prop 作初值
        created += 1;
        flow.syncAuthoritative(stageWish); // MapPanel 的对账 effect（只在挂载期间存在）
        return flow;
      },
      /** 打开云图志 = MapPanel 挂载：订阅 + selectionChanged(初始选中)，不创建 store */
      openPanel(initialLocationId: string | null = null) {
        const store = mode === 'legacy-panel-level' ? host.panelStore() : host.appMount();
        let notified = 0;
        const unsubscribe = store.subscribe(() => { notified += 1; });
        store.selectionChanged(initialLocationId);
        return {
          getNotified: () => notified,
          /** 面板渲染读到的状态（useSyncExternalStore） */
          view: () => store.getState(),
          select: (id: string | null) => store.selectionChanged(id),
          toggle: (id: string) => store.toggle({ id, name: id }),
          /** MapPanel unmount cleanup：退订 + 解除选中语境；不 dispose、不销毁 store */
          close: () => {
            unsubscribe();
            if (mode === 'legacy-panel-level') { // 旧 cleanup：dispose 并丢弃整个 store（busy 锁随之消失）
              store.dispose();
              if (flow === store) flow = null;
            } else {
              store.selectionChanged(null);
            }
          },
        };
      },
      /** 用户会话结束（App.logout / 401）：唯一的 dispose 时机 */
      logout() { flow?.dispose(); },
    };
    return host;
  }

  const drainMicrotasks = () => new Promise((resolve) => { setTimeout(resolve, 0); });

  it('App 创建单例时 wishId=undefined（App 不知道 cat），GameStage 对账后才成为权威值', () => {
    const { api } = deferredApi();
    const flow = createWishFlow(undefined, api); // App.tsx: createWishFlow(undefined, …)
    expect(flow.getState().wishId).toBeUndefined(); // 许愿入口暂不渲染（宿主未接入语义不变）
    flow.syncAuthoritative(null); // GameStage 挂载 effect：cat.travel_wish_location_id ?? null
    expect(flow.getState().wishId).toBeNull();
    flow.syncAuthoritative('loc-moon');
    expect(flow.getState().wishId).toBe('loc-moon');
  });

  /**
   * 对照组（旧接线复现，#071b 前的 MapPanel useRef store）：证明上面那条 4 步时序在旧接线下
   * 确实产生复核记录的失配终态——即 store 的持有位置是唯一变量，不是断言写法的巧合。
   */
  it('对照：store 挂在面板上（旧接线）时同一 4 步时序确定复现 {server:A, prop:B, UI:B} 失配', async () => {
    const host = app('legacy-panel-level');
    const panelA = host.openPanel();
    panelA.select('loc-moon');
    const pendingA = panelA.toggle('loc-moon'); // 1. 旧实例对 A 发请求

    panelA.close(); // 2. 关闭云图志：dispose → abort，busy 锁随 store 一起消失
    await pendingA;
    expect(host.wires[0].aborted).toBe(true);

    const panelB = host.openPanel(); // 3. 立刻重开：新 store，busy=false
    expect(host.getCreated()).toBe(2); // 旧接线每次开面板都新建 store
    panelB.select('loc-teahouse');
    const pendingB = panelB.toggle('loc-teahouse');
    expect(host.wires).toHaveLength(2); // 拦不住第二个请求：跨实例双请求成立
    host.wires[1].writeServer();
    host.wires[1].deliver();
    await pendingB;
    await drainMicrotasks(); // 活动实例成功 → refresh → 父级 prop 与 UI 都成 B

    host.wires[0].writeServer(); // 4. 被 abort 的旧 A 这才在服务端落库（last-write-wins=A）
    host.wires[0].deliver();     // 迟到响应对客户端无效：没有 onChanged、没有对账
    await drainMicrotasks();

    // 5. 复核记录的确定失配终态
    expect(host.getServer()).toBe('loc-moon');
    expect(host.getStageWish()).toBe('loc-teahouse');
    expect(panelB.view().wishId).toBe('loc-teahouse');
  });

  it('验收 1 的 4 步时序：关闭云图志→立刻重开→对不同地点许愿→旧请求后落库，不再可达 UI≠服务端', async () => {
    const host = app();
    // 1. 对 A（月海星原）发请求
    const panelA = host.openPanel();
    panelA.select('loc-moon');
    const pendingA = panelA.toggle('loc-moon');
    expect(host.wires).toHaveLength(1);
    expect(host.flow().getState().busy).toBe(true);

    // 2. 关闭整个云图志：只退订 + 解除选中语境。旧实现在此 dispose，busy 锁随 store 消失
    panelA.close();
    expect(host.wires[0].aborted).toBe(false); // 请求没有被中止——busy 锁仍握在常驻 store 上
    expect(host.flow().getState().busy).toBe(true);

    // 3. 立刻重开：同一个 store（不重建），并对不同地点 B 许愿
    const panelB = host.openPanel();
    expect(host.getCreated()).toBe(1); // 常驻单例：面板开关不创建第二个 store
    expect(panelB.view().busy).toBe(true); // 重开后的按钮仍是禁用态（disabled={wishBusy}）
    panelB.select('loc-teahouse');
    await panelB.toggle('loc-teahouse');
    expect(host.wires).toHaveLength(1); // busy 锁挡住：B 的服务端写从未发生
    expect(panelB.view().wishId).not.toBe('loc-teahouse'); // UI 也没有对 B 做乐观更新

    // 4. 旧 A 请求这才在服务端落库，响应随后到达（第四轮序列里正是这一步产生失配）
    host.wires[0].writeServer();
    host.wires[0].deliver();
    await pendingA;
    await drainMicrotasks(); // onChanged → 异步 refresh → GameStage 对账

    // 5. 终态一致：复核记录的 {server:'A', parentProp:'B', activeWish:'B'} 已不可达
    expect(host.getServer()).toBe('loc-moon');
    expect(host.getStageWish()).toBe('loc-moon');
    expect(panelB.view().wishId).toBe('loc-moon');
    expect(panelB.view().busy).toBe(false);
    expect(panelB.view().error).toBeNull();
  });

  it('验收 3/5 busy 锁：同一常驻实例上 pending 未 settle 时第二次 toggle 被阻塞，settle 后才放行', async () => {
    const host = app();
    const panel = host.openPanel();
    panel.select('loc-moon');
    const pending = panel.toggle('loc-moon');

    // 未 settle：同地点重复点、切到别的地点再点，都发不出请求（写入串行化）
    await panel.toggle('loc-moon');
    panel.select('loc-teahouse');
    await panel.toggle('loc-teahouse');
    expect(host.wires).toHaveLength(1);
    expect(host.flow().getState().busy).toBe(true);

    host.wires[0].writeServer();
    host.wires[0].deliver();
    await pending;
    await drainMicrotasks();
    expect(panel.view().busy).toBe(false);
    expect(panel.view().wishId).toBe('loc-moon');

    // settle 之后放行：这才产生第二个服务端写，且终态与服务端一致
    const second = panel.toggle('loc-teahouse');
    expect(host.wires).toHaveLength(2);
    host.wires[1].writeServer();
    host.wires[1].deliver();
    await second;
    await drainMicrotasks();
    expect(host.getServer()).toBe('loc-teahouse');
    expect(host.getStageWish()).toBe('loc-teahouse');
    expect(panel.view().wishId).toBe('loc-teahouse');
  });

  it('反复关开云图志都不重建 store：在途请求始终只有一个，跨实例双请求失去物理可能', async () => {
    const host = app();
    const first = host.openPanel();
    first.select('loc-moon');
    const pending = first.toggle('loc-moon');
    first.close();

    for (const id of ['loc-teahouse', 'loc-starlake', 'loc-lookout']) {
      const panel = host.openPanel();
      panel.select(id);
      await panel.toggle(id); // 每次都被同一把 busy 锁挡住
      panel.close();
    }
    expect(host.getCreated()).toBe(1);
    expect(host.wires).toHaveLength(1);
    expect(host.wires[0].locationId).toBe('loc-moon');

    host.wires[0].writeServer();
    host.wires[0].deliver();
    await pending;
    await drainMicrotasks();
    expect(host.getServer()).toBe('loc-moon');
    expect(host.flow().getState().wishId).toBe('loc-moon'); // 常驻 store 与服务端一致
  });

  it('面板卸载只解除订阅：旧订阅者不再收通知，愿望态/busy 保留在常驻实例上', async () => {
    const host = app();
    const panel = host.openPanel();
    panel.select('loc-moon');
    const pending = panel.toggle('loc-moon');
    const notifiedAtClose = panel.getNotified();
    expect(notifiedAtClose).toBeGreaterThan(0);

    panel.close(); // 退订
    host.wires[0].writeServer();
    host.wires[0].deliver();
    await pending;
    await drainMicrotasks();

    expect(panel.getNotified()).toBe(notifiedAtClose); // 退订后不再收到任何通知
    expect(host.flow().getState().wishId).toBe('loc-moon'); // 状态活在 store 上，不随面板消失
    expect(host.flow().getState().busy).toBe(false);
    const reopened = host.openPanel();
    expect(reopened.view().wishId).toBe('loc-moon'); // 重开即读到常驻愿望态
  });

  it('关闭面板后旧请求才失败：epoch 语义不变——失败静默丢弃，重开不复现旧错误（验收 4）', async () => {
    const host = app();
    const panel = host.openPanel();
    panel.select('loc-moon');
    const pending = panel.toggle('loc-moon');

    panel.close(); // selectionChanged(null)：epoch +1，pending 的失败写回失效
    host.wires[0].fail(new Error('它还不敢去那么远的地方'));
    await pending;
    expect(host.flow().getState().error).toBeNull();
    expect(host.flow().getState().busy).toBe(false);

    const reopened = host.openPanel();
    reopened.select('loc-moon');
    expect(reopened.view().error).toBeNull();
    expect(wishErrorText(reopened.view().error, 'loc-moon')).toBeNull();
  });

  it('面板开着时的失败仍照常展示（串行化没有吞掉正常错误提示）', async () => {
    const host = app();
    const panel = host.openPanel();
    panel.select('loc-moon');
    const pending = panel.toggle('loc-moon');
    host.wires[0].fail(new Error('它还不敢去那么远的地方'));
    await pending;
    expect(wishErrorText(panel.view().error, 'loc-moon')).toBe('它还不敢去那么远的地方');
    expect(panel.view().busy).toBe(false); // 失败也释放锁：下一次 toggle 不被永久挡住
    void panel.toggle('loc-moon'); // 重试请求真的发出去了（不等它 settle）
    expect(host.wires).toHaveLength(2);
    expect(panel.view().busy).toBe(true);
  });

  it('云图志关着时的权威更新照样进 store（对账入口在 GameStage，不依赖面板挂载）', () => {
    const host = app();
    const panel = host.openPanel();
    panel.close();

    host.stageSync('loc-moon'); // 另一设备/下一次 refresh 带来的权威愿望
    expect(host.flow().getState().wishId).toBe('loc-moon');

    const reopened = host.openPanel();
    expect(reopened.view().wishId).toBe('loc-moon');
    host.stageSync(null); // 权威侧清空（旅行命中愿望后消失）
    expect(reopened.view().wishId).toBeNull();
  });

  it('dispose 只发生在会话结束（logout）：关面板不 abort，logout 才中止在途请求且静默', async () => {
    const host = app();
    const panel = host.openPanel();
    panel.select('loc-moon');
    const pending = panel.toggle('loc-moon');

    panel.close();
    expect(host.wires[0].aborted).toBe(false); // 关面板不 abort（#071b 的核心改动）

    host.logout(); // App.logout / 401：会话边界
    await pending;
    expect(host.wires[0].aborted).toBe(true);
    expect(host.flow().getState().busy).toBe(false); // abort 释放锁
    expect(host.flow().getState().error).toBeNull(); // AbortError 静默
    expect(host.getRefreshCount()).toBe(0); // 不触发 onChanged
    expect(host.getServer()).toBeNull();
  });
});

/**
 * #071b 接线守卫：上面的 harness 只能驱动 store，证明不了「组件确实按新接线连的」——
 * 而本条目的全部价值恰恰在接线（store 归谁创建、谁 dispose）。仓库无 DOM 测试环境
 * （jsdom/happy-dom 不在依赖内，package.json 属 protected_paths，无法挂载组件断言 effect），
 * 故对三个宿主文件做源码级断言：这是能让「把 store 挪回 MapPanel / 在面板卸载时 dispose」
 * 确定性变红的最轻手段。
 */
describe('wishFlow：宿主接线守卫（#071b）', () => {
  const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');
  const app = read('../../App.tsx');
  const gameStage = read('../GameStage.tsx');
  const mapPanel = read('./MapPanel.tsx');

  it('store 由 App 层创建并常驻（验收 2）', () => {
    expect(app).toContain('useRef<WishFlow | null>(null)');
    expect(app).toContain('wishFlow={wishFlow}');
    // 首轮验收空洞①：仅查 createWishFlow( 存在挡不住「删掉惰性判断→每 render 新建（比原缺陷更糟）」。
    // 断言 createWishFlow 必须被 `if (!wishFlowRef.current)` 惰性单例守卫包裹——删掉它即判红。
    expect(app).toMatch(/if\s*\(\s*!\s*wishFlowRef\.current\s*\)\s*\{[\s\S]{0,200}?createWishFlow\(/);
  });

  it('MapPanel 只订阅不拥有：不创建 store、不 dispose（验收 2）', () => {
    expect(mapPanel).not.toContain('createWishFlow');
    expect(mapPanel).not.toMatch(/\.dispose\(/);
    expect(mapPanel).toContain('useSyncExternalStore(wishFlow.subscribe, wishFlow.getState)');
    expect(mapPanel).toContain('wishFlow.selectionChanged(null)'); // 卸载只解除选中语境
  });

  // 二轮验收 finding 1：wishButtonLabel 有纯函数单测但「调用点」无守卫——
  // 把 JSX 改回旧内联三元 + 删掉 busy 提示块，纯函数测试仍全绿，等于首轮同款「守卫空洞」会悄悄复活。
  // 断言 busy 文案真接进渲染：调用点存在 + busy 提示块存在，二者被改回/删除即判红。
  it('busy 反馈真接进渲染：wishButtonLabel 调用点 + busy 提示块（验收 2 二轮）', () => {
    expect(mapPanel).toMatch(/\{wishButtonLabel\(wishBusy, wishId === selected\.id\)\}/);
    expect(mapPanel).toMatch(/\{wishBusy && \(/);
  });

  it('dispose 只在会话边界：App 的 logout 与 401 分支（验收 2/3）', () => {
    expect(app).toMatch(/error\.status === 401[\s\S]{0,240}?dispose\(\)/);
    expect(app).toMatch(/const logout = async[\s\S]{0,400}?wishFlow\.dispose\(\)/);
  });

  it('权威对账在 GameStage 的 useEffect、无面板门（云图志关着也对账，验收 4）', () => {
    expect(gameStage).toContain('wishFlow.syncAuthoritative(cat.travel_wish_location_id ?? null)');
    // 首轮验收空洞②：仅查字符串存在挡不住「搬进 render body / 加 if(panel==='map') 门」两种回退。
    // 断言 syncAuthoritative 必须在 useEffect 内、依赖数组精确为 [wishFlow, cat.travel_wish_location_id]——
    // 搬出 useEffect（每 render 调用）或改依赖即判红。
    expect(gameStage).toMatch(
      /useEffect\(\(\)\s*=>\s*\{\s*wishFlow\.syncAuthoritative\(cat\.travel_wish_location_id \?\? null\);\s*\}\s*,\s*\[wishFlow, cat\.travel_wish_location_id\]\)/,
    );
    // 对账不得被面板开关门控（本条目立论：云图志关着也对账）
    expect(gameStage).not.toMatch(/panel\s*===\s*['"]map['"][\s\S]{0,80}?syncAuthoritative/);
  });
});
