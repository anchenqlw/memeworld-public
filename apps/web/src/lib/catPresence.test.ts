import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  chatEntryLabel,
  dailyBriefStatusText,
  journalEmptyText,
  settingsTravelText,
  derivePresence,
  presenceDotColor,
  presenceIsAway,
  presenceStatusText,
  type PresenceInput,
  type PresenceSemantic,
} from './catPresence';

const ALL_SEMANTICS: readonly PresenceSemantic[] = [
  'adventure_failed', 'adventure_running', 'adventure_starting', 'wandering',
  'recalled', 'broken', 'home_ready', 'home_idle',
];

// backlog #088：`wandering_mode` × 四条既有状态轴的交叉矩阵。
// 修复前，statusText / statusDot / defaultBubble / 今日云图志状态行是四条各自独立的三元链，
// 且都以「在家」兜底——用户看到舞台说「正在外面流浪」、左上角说「在家等你」、问猫也说在家。

const home: PresenceInput = {
  wandering_mode: false,
  status: 'active',
  lifecycle_stage: 'ready',
  presencePhase: 'idle',
  can_start_adventure: false,
};

describe('derivePresence：四种真实可达的流浪组合（backlog #088「可达性证明」）', () => {
  // setWanderingMode 的唯一前置条件是 status='active'——不看 lifecycle_stage、不看
  // travel_schedule_enabled，所以下面每一种都真实可达，不是构造出来的边界。

  it('① 一只从没出发过的新猫直接开流浪：不得再说「在家等你」', () => {
    // 这是旧实现最刺眼的一格：can_start_adventure 是旧 statusText 的**第一个**判断，
    // 于是舞台说「正在外面流浪」+ 左上角说「在家等你」+ 同屏还渲染「让小猫去探险」大按钮。
    const s = derivePresence({ ...home, wandering_mode: true, can_start_adventure: true });
    expect(s).toBe('wandering');
    expect(presenceStatusText(s)).not.toContain('在家');
    expect(presenceIsAway(s)).toBe(true);
  });

  it('② 已开定时旅行的常态猫开流浪（最常见路径，旧实现落兜底）', () => {
    const s = derivePresence({ ...home, wandering_mode: true });
    expect(s).toBe('wandering');
    expect(presenceStatusText(s)).not.toContain('在家');
  });

  it('③ 先开流浪再召回：recallCat 不清 wandering_mode，故「已召回 + 流浪中」可持久化', () => {
    // 待 Owner 口径 2：现状按「流浪优先」呈现（猫确实不在家）。若产品判定召回应连带清
    // wandering_mode，那是服务端状态机修复，本函数顺序不变。
    const s = derivePresence({ ...home, wandering_mode: true, status: 'recalled' });
    expect(s).toBe('wandering');
    expect(presenceStatusText(s)).not.toContain('在家');
  });

  it('④ 流浪 ∩ 探险中：探险中优先（沿用主舞台既有行为，口径 1）', () => {
    const s = derivePresence({ ...home, wandering_mode: true, presencePhase: 'running' });
    expect(s).toBe('adventure_running');
    expect(presenceIsAway(s)).toBe(true);
  });
});

describe('derivePresence：非流浪路径保持旧行为（回归保护）', () => {
  const cases: Array<[string, PresenceInput, string]> = [
    ['探险受阻优先于一切', { ...home, presencePhase: 'failed', can_start_adventure: true }, 'adventure_failed'],
    ['探险中', { ...home, presencePhase: 'running' }, 'adventure_running'],
    ['准备出发', { ...home, lifecycle_stage: 'adventure_starting' }, 'adventure_starting'],
    ['已召回', { ...home, status: 'recalled' }, 'recalled'],
    ['需要照看', { ...home, status: 'broken' }, 'broken'],
    ['在家且可开启探险', { ...home, can_start_adventure: true }, 'home_ready'],
    ['在家等你（兜底）', home, 'home_idle'],
  ];
  for (const [name, input, expected] of cases) {
    it(name, () => expect(derivePresence(input)).toBe(expected));
  }

  it('探险受阻压过流浪（失败态最高优先，用户需要看到它）', () => {
    expect(derivePresence({ ...home, wandering_mode: true, presencePhase: 'failed' })).toBe('adventure_failed');
  });

  it('wandering_mode 为 null/undefined 时视为未开启', () => {
    expect(derivePresence({ ...home, wandering_mode: null })).toBe('home_idle');
    expect(derivePresence({ ...home, wandering_mode: undefined })).toBe('home_idle');
  });
});

describe('presenceStatusText / presenceDotColor：三个出口同源，且流浪与在家可区分', () => {
  it('流浪时名牌副行/tooltip/aria-label 都不含「在家」语义', () => {
    const s = derivePresence({ ...home, wandering_mode: true });
    // 同一个值喂三个出口，这里断言的就是那一个值（验收标准 3）
    expect(presenceStatusText(s)).toBe('在外流浪');
  });

  it('流浪圆点颜色与「在家」蓝不同（验收标准 3 后半）', () => {
    const wandering = presenceDotColor(derivePresence({ ...home, wandering_mode: true }));
    const homeIdle = presenceDotColor(derivePresence(home));
    const homeReady = presenceDotColor(derivePresence({ ...home, can_start_adventure: true }));
    expect(wandering).not.toBe(homeIdle);
    expect(wandering).not.toBe(homeReady);
  });

  it('每个 semantic 都有文案与颜色（穷尽性，新增 semantic 忘配会判红）', () => {
    for (const s of ALL_SEMANTICS) {
      expect(presenceStatusText(s)).toBeTruthy();
      expect(presenceDotColor(s)).toBeTruthy();
    }
  });

  it('presenceIsAway 只对「在外」两态为真', () => {
    expect(presenceIsAway('wandering')).toBe(true);
    expect(presenceIsAway('adventure_running')).toBe(true);
    expect(presenceIsAway('home_idle')).toBe(false);
    expect(presenceIsAway('recalled')).toBe(false);
    expect(presenceIsAway('adventure_starting')).toBe(false);
  });
});

describe('presenceDotColor：圆点颜色必须两两互异（PR #72 首轮验收暴露的真缺陷）', () => {
  // 首版把 wandering 写成 var(--warm-deep)、adventure_failed 写成字面 '#e07b39'，
  // 而 global.css 里 --warm-deep 就是 #e07b39——**字符串不同、颜色相同**。
  // 结果「在外流浪」（常态）与「探险受阻」（需注意的错误态）在屏幕上无法区分，
  // 而原验收标准只要求「与在家蓝可区分」，所以静态断言与浏览器走查都放过了它
  // （codex 首轮实测流浪为 rgb(224,123,57)，正是失败橙）。
  // 本用例把 var() 解析回 hex 再比，是这一类缺陷的结构性防线。
  const css = fs.readFileSync(
    path.join(import.meta.dirname, '../styles/global.css'),
    'utf8',
  );
  const rootBlock = css.slice(css.indexOf(':root'), css.indexOf('}', css.indexOf(':root')));
  const vars = new Map<string, string>();
  for (const m of rootBlock.matchAll(/(--[a-z-]+)\s*:\s*([^;]+);/g)) {
    vars.set(m[1], m[2].trim());
  }

  function resolve(value: string): string {
    const m = /^var\((--[a-z-]+)\)$/.exec(value);
    if (!m) return value.toLowerCase();
    const hex = vars.get(m[1]);
    // var 拼错或 token 被删 → 大声失败，而不是静默退化成一个不存在的颜色
    expect(hex, `global.css :root 里找不到 ${m[1]}`).toBeTruthy();
    return String(hex).toLowerCase();
  }

  it('global.css 的 :root 被成功解析（否则下面的断言等于没做）', () => {
    expect(vars.size).toBeGreaterThan(8);
    expect(vars.get('--sky-deep')).toBe('#5fa8d3');
  });

  it('每个 semantic 的颜色都能解析成具体值（不留悬空 var）', () => {
    for (const s of ALL_SEMANTICS) {
      expect(resolve(presenceDotColor(s))).toMatch(/^#[0-9a-f]{3,8}$|^rgb/);
    }
  });

  it('需要互相区分的六态颜色两两互异', () => {
    // home_ready / home_idle 共用「在家蓝」是有意的（都在家），故不参与互异断言。
    const distinct = [
      'adventure_failed', 'adventure_running', 'adventure_starting',
      'wandering', 'recalled', 'broken',
    ] as const;
    const seen = new Map<string, string>();
    for (const s of distinct) {
      const hex = resolve(presenceDotColor(s));
      const clash = seen.get(hex);
      expect(clash, `${s} 与 ${clash} 同色（${hex}）——两个不同处境的状态点在屏幕上无法区分`).toBeUndefined();
      seen.set(hex, s);
    }
    expect(seen.size).toBe(distinct.length);
  });

  it('流浪必须同时区别于「在家蓝」与「探险受阻橙」', () => {
    const wanderingHex = resolve(presenceDotColor('wandering'));
    expect(wanderingHex).not.toBe(resolve(presenceDotColor('home_idle')));
    expect(wanderingHex).not.toBe(resolve(presenceDotColor('adventure_failed')));
  });
});

describe('dailyBriefStatusText：今日云图志状态行也要感知流浪（口径 3）', () => {
  it('流浪且今天未回报 → 说流浪，不再说「今晚会从这些见闻中选择」', () => {
    const s = derivePresence({ ...home, wandering_mode: true });
    expect(dailyBriefStatusText(s, false)).toBe('小猫正在外面流浪');
  });

  it('今天已回报优先（旅行事实压过在哪）', () => {
    const s = derivePresence({ ...home, wandering_mode: true });
    expect(dailyBriefStatusText(s, true)).toBe('今天的旅行已经寄回');
  });

  it('非流浪路径保持旧文案', () => {
    expect(dailyBriefStatusText(derivePresence({ ...home, presencePhase: 'running' }), false)).toBe('小猫正在探险');
    expect(dailyBriefStatusText(derivePresence({ ...home, can_start_adventure: true }), false)).toBe('等待你开启第一次探险');
    expect(dailyBriefStatusText(derivePresence(home), false)).toBe('今晚会从这些见闻中选择');
  });
});

// #088 交付时未覆盖的两个次要出口 + #056b 验收标准 8 的欠账（Owner 2026-08-06 决策 6：补上欠账）
describe('journalEmptyText：手账空态不再与主舞台各说各话（#088 表第 6 行）', () => {
  it('流浪且无明信片 → 说流浪，不再说「正在第一次探险」', () => {
    const s = derivePresence({ ...home, wandering_mode: true });
    const t = journalEmptyText(s, 'Anan');
    expect(t).toContain('正在外面流浪');
    expect(t).not.toContain('第一次探险');
  });

  it('lifecycleStage=world 优先（还没入世，谈不上在哪）', () => {
    const s = derivePresence({ ...home, wandering_mode: true });
    expect(journalEmptyText(s, 'Anan', 'world')).toContain('还没有出发');
  });

  it('探险受阻 / 已召回各有自己的说法', () => {
    expect(journalEmptyText(derivePresence({ ...home, presencePhase: 'failed' }), 'Anan')).toContain('不太顺利');
    expect(journalEmptyText(derivePresence({ ...home, status: 'recalled' }), 'Anan')).toContain('召回');
  });

  it('常态兜底仍是「第一次探险」（不改既有行为）', () => {
    expect(journalEmptyText(derivePresence(home), 'Anan')).toContain('第一次探险');
  });
});

describe('settingsTravelText：设置「出行」那一行（#088 表第 7 行）', () => {
  it('流浪时说在外流浪，**同时**说清旅行节奏不变', () => {
    // #056b 的核心约束是流浪不改旅行节奏（app.test.ts 有断言守着），
    // 所以文案不能让用户以为开流浪会停掉旅行。
    const t = settingsTravelText(derivePresence({ ...home, wandering_mode: true }), true);
    expect(t).toContain('在外面流浪');
    expect(t).toContain('节奏不变');
  });

  it('召回时优先说已召回（active=false 压过一切）', () => {
    const t = settingsTravelText(derivePresence({ ...home, wandering_mode: true }), false);
    expect(t).toContain('已被召回');
  });

  it('常态与探险中各有说法', () => {
    expect(settingsTravelText(derivePresence(home), true)).toContain('自由旅行');
    expect(settingsTravelText(derivePresence({ ...home, presencePhase: 'running' }), true)).toContain('云海里探险');
  });
});

describe('chatEntryLabel：#056b 验收标准 8 的欠账——在外时不该说得像在旁边', () => {
  it('流浪 / 探险中 → 隔空呼唤', () => {
    expect(chatEntryLabel(derivePresence({ ...home, wandering_mode: true }), 'Anan')).toBe('隔空呼唤 Anan');
    expect(chatEntryLabel(derivePresence({ ...home, presencePhase: 'running' }), 'Anan')).toBe('隔空呼唤 Anan');
  });

  it('在家 → 保持既有「继续聊天」', () => {
    expect(chatEntryLabel(derivePresence(home), 'Anan')).toBe('和 Anan 继续聊天');
    expect(chatEntryLabel(derivePresence({ ...home, status: 'recalled' }), 'Anan')).toBe('和 Anan 继续聊天');
  });
});
