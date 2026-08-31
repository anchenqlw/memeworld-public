import { describe, expect, it } from 'vitest';
import {
  adventureCardCaption,
  atlasFocusHint,
  deriveAtlasFocus,
  type AtlasFocusInput,
} from './atlasFocus';

// backlog #089 验收标准 4 点名的五个分支：有愿望 / 无愿望 / 今日已回报 / 未回报 / 地点 id 查不到。
const KNOWN = ['loc-starlake-shore', 'loc-cat-paw-teahouse'] as const;

const wandering = (over: Partial<AtlasFocusInput> = {}): AtlasFocusInput => ({
  entry: 'wandering-card',
  knownLocationIds: KNOWN,
  ...over,
});
const adventure = (over: Partial<AtlasFocusInput> = {}): AtlasFocusInput => ({
  entry: 'adventure-card',
  knownLocationIds: KNOWN,
  ...over,
});

describe('deriveAtlasFocus：流浪卡片（数据已在手，文案已承诺方向——零成本兑现）', () => {
  it('① 有愿望 → 定位愿望地点，理由说清是「愿望」而非「目的地」', () => {
    const f = deriveAtlasFocus(wandering({ wishLocationId: 'loc-starlake-shore' }));
    expect(f).toEqual({ kind: 'wish', locationId: 'loc-starlake-shore', reason: '主人愿望' });
    expect(atlasFocusHint(f)).toBe('来自你的愿望');
  });

  it('② 无愿望 → 不定位（退化为默认地图）', () => {
    const f = deriveAtlasFocus(wandering({ wishLocationId: null }));
    expect(f.kind).toBe('none');
    expect(atlasFocusHint(f)).toBeNull();
  });

  it('⑤ 愿望地点 id 不在当前地图数据里 → 退化，不留下定位不到的空提示', () => {
    // 真实可达：地点被下线/改 id、或前端地图数据比猫记录旧。
    const f = deriveAtlasFocus(wandering({ wishLocationId: 'loc-deleted-somewhere' }));
    expect(f.kind).toBe('none');
  });
});

describe('deriveAtlasFocus：流浪卡片的档位必须与 wanderingCaption 同源（ISSUES #85）', () => {
  // codex 独立浏览器验收在 exact 5c99b5c 上实测复现：愿望=猫掌茶屋、今日旅行=云端灯塔、
  // 明信片未读时，副标题说「它从旅途寄回了新的明信片，点这里看看它去了哪」，点击却定位到
  // 愿望地点并提示「来自你的愿望」——说的是旅行、开的是愿望。
  // wanderingCaption 的档位是「未读明信片 > 有愿望 > 都没有」，focus 必须逐档对齐。
  it('未读明信片 + 有愿望 → 落旅行地点（不是愿望），提示「来自今日旅行」', () => {
    const f = deriveAtlasFocus(wandering({
      wishLocationId: 'loc-cat-paw-teahouse',      // 猫掌茶屋
      hasUnreadTravel: true,
      latestTravelLocationId: 'loc-starlake-shore', // 当日旅行
    }));
    expect(f).toEqual({ kind: 'latest-travel', locationId: 'loc-starlake-shore', reason: '今日旅行' });
    expect(atlasFocusHint(f)).toBe('来自今日旅行');
  });

  it('未读明信片 + 无愿望 → 同样落旅行地点', () => {
    const f = deriveAtlasFocus(wandering({ hasUnreadTravel: true, latestTravelLocationId: 'loc-starlake-shore' }));
    expect(f.kind).toBe('latest-travel');
  });

  it('无未读明信片 + 有愿望 → 落愿望（原有行为不回退）', () => {
    const f = deriveAtlasFocus(wandering({
      wishLocationId: 'loc-cat-paw-teahouse',
      hasUnreadTravel: false,
      latestTravelLocationId: 'loc-starlake-shore',
    }));
    expect(f).toEqual({ kind: 'wish', locationId: 'loc-cat-paw-teahouse', reason: '主人愿望' });
  });

  it('承诺了看旅行但旅行地点 id 查不到 → 退化为不定位，**不得回退到愿望**', () => {
    // 回退到愿望会再次制造同一种错配（副标题说旅行、落点是愿望）。
    const f = deriveAtlasFocus(wandering({
      wishLocationId: 'loc-cat-paw-teahouse',
      hasUnreadTravel: true,
      latestTravelLocationId: 'loc-gone',
    }));
    expect(f.kind).toBe('none');
  });
});

describe('deriveAtlasFocus：探险中卡片（#099 服务端今日目的地事实）', () => {
  it('③ 今日已回报 → 定位当日旅行地点（这才是确定事实）', () => {
    const f = deriveAtlasFocus(adventure({ hasTravelToday: true, latestTravelLocationId: 'loc-cat-paw-teahouse' }));
    expect(f).toEqual({ kind: 'latest-travel', locationId: 'loc-cat-paw-teahouse', reason: '今日旅行' });
    expect(atlasFocusHint(f)).toBe('来自今日旅行');
  });

  it('④ 未回报但有服务端已校验目的地 → 定位今日目的地', () => {
    const f = deriveAtlasFocus(adventure({
      hasTravelToday: false,
      currentDestinationLocationId: 'loc-starlake-shore',
    }));
    expect(f).toEqual({ kind: 'current-destination', locationId: 'loc-starlake-shore', reason: '今日目的地' });
    expect(atlasFocusHint(f)).toBe('来自小猫刚刚选定的目的地');
    expect(adventureCardCaption(f)).toContain('今日目的地');
  });

  it('猫未上报 → 保持方案 A：不定位且不承诺目的地', () => {
    const f = deriveAtlasFocus(adventure({ hasTravelToday: false, latestTravelLocationId: 'loc-starlake-shore' }));
    expect(f.kind).toBe('none');
    expect(adventureCardCaption(f)).not.toContain('目的地');
  });

  it('⑤ 已回报但 location_id 查不到 → 退化', () => {
    const f = deriveAtlasFocus(adventure({ hasTravelToday: true, latestTravelLocationId: 'loc-gone' }));
    expect(f.kind).toBe('none');
  });

  it('探险中卡片不吃愿望：愿望不是它去的地方，混用会制造新的假承诺', () => {
    const f = deriveAtlasFocus(adventure({ hasTravelToday: false, wishLocationId: 'loc-starlake-shore' }));
    expect(f.kind).toBe('none');
  });

  it('最终旅行覆盖中途上报，不会继续定位旧目的地', () => {
    const f = deriveAtlasFocus(adventure({
      hasTravelToday: true,
      latestTravelLocationId: 'loc-cat-paw-teahouse',
      currentDestinationLocationId: 'loc-starlake-shore',
    }));
    expect(f).toEqual({ kind: 'latest-travel', locationId: 'loc-cat-paw-teahouse', reason: '今日旅行' });
  });

  it('服务端目的地不在当前地图数据时安全退化', () => {
    const f = deriveAtlasFocus(adventure({ currentDestinationLocationId: 'loc-retired' }));
    expect(f.kind).toBe('none');
  });
});

describe('adventureCardCaption：不再承诺兑现不了的「今日目的地」（本 backlog 的核心兑现点）', () => {
  it('未回报时文案不含「今日目的地」', () => {
    const caption = adventureCardCaption(deriveAtlasFocus(adventure({ hasTravelToday: false })));
    expect(caption).not.toContain('今日目的地');
    expect(caption).not.toContain('目的地');
  });

  it('已回报时引导去看它去了哪', () => {
    const caption = adventureCardCaption(deriveAtlasFocus(adventure({
      hasTravelToday: true, latestTravelLocationId: 'loc-starlake-shore',
    })));
    expect(caption).toContain('明信片');
  });
});
