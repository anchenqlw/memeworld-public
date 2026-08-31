/**
 * 猫此刻在哪 —— 单一真相源（backlog #088）。
 *
 * 为什么需要它：`wandering_mode` 是与既有四条状态轴（`status` / `lifecycle_stage` /
 * `presencePhase` / `can_start_adventure`）**完全解耦的第五条正交轴**，而在此之前只有主舞台
 * 卡片读它，另外四个展示出口各写一条独立的三元链、且**都以「在家」兜底**。结果是用户看到
 * 舞台说「正在外面流浪」、左上角名牌说「在家等你」、进聊天问它也说在家（`prop_dc4945a1`）。
 *
 * 规矩：任何展示「猫在哪」的出口都必须消费本模块，不允许再自己写平行的状态判断链。
 */

/** 猫此刻的处境。顺序无关，判定优先级见 derivePresence。 */
export type PresenceSemantic =
  | 'adventure_failed'    // 探险受阻
  | 'adventure_running'   // 探险中（在外）
  | 'adventure_starting'  // 准备出发
  | 'wandering'           // 流浪中（在外）
  | 'recalled'            // 已召回，在家休息
  | 'broken'              // 需要照看
  | 'home_ready'          // 在家，且可开启探险
  | 'home_idle';          // 在家等你

export type PresenceInput = {
  wandering_mode?: boolean | null;
  status?: string | null;
  lifecycle_stage?: string | null;
  presencePhase?: string | null;
  can_start_adventure?: boolean | null;
};

/**
 * 判定优先级（backlog #088 待确认口径 1 的落地点）：
 *   adventure_failed → adventure_running → adventure_starting → wandering
 *   → recalled → broken → home_ready → home_idle
 *
 * 「探险中压过流浪」沿用主舞台既有行为（GameStage 的 `presencePhase === 'running'` 分支
 * 本来就在流浪分支之前）。若产品要改为流浪优先，**只调这一个函数里的顺序**，四个消费端不动。
 *
 * ⚠️ `can_start_adventure` 必须排在最后：它在旧 `statusText` 里是**第一个**判断，这正是
 * 「一只从没出发过的新猫开了流浪、HUD 仍说『在家等你』」的直接原因（`setWanderingMode` 的
 * 唯一前置条件是 `status='active'`，不看 `lifecycle_stage`，所以该组合真实可达）。
 */
export function derivePresence(input: PresenceInput): PresenceSemantic {
  const phase = input.presencePhase ?? 'idle';
  if (phase === 'failed') return 'adventure_failed';
  if (phase === 'running') return 'adventure_running';
  if (input.lifecycle_stage === 'adventure_starting') return 'adventure_starting';
  if (input.wandering_mode === true) return 'wandering';
  if (input.status === 'recalled') return 'recalled';
  if (input.status === 'broken') return 'broken';
  if (input.can_start_adventure === true) return 'home_ready';
  return 'home_idle';
}

/** 猫是否不在家。流浪与探险中都算「在外」——气泡与今日云图志状态行据此不说「在家」。 */
export function presenceIsAway(semantic: PresenceSemantic): boolean {
  return semantic === 'adventure_running' || semantic === 'wandering';
}

/**
 * 旅行手账空状态。#088 交付时这一行未覆盖（backlog 那张表的第 6 行），于是流浪中且尚无明信片时
 * 手账说「正在第一次探险」，与主舞台的「正在外面流浪」各说各话——不是「在家」，但仍是两个不同的
 * 当前位置叙述（codex 首轮验收实测记录）。
 */
export function journalEmptyText(semantic: PresenceSemantic, catName: string, lifecycleStage?: string): string {
  if (lifecycleStage === 'world') return `${catName} 还没有出发\n回到世界里，可以邀请它去探险`;
  if (semantic === 'wandering') return `${catName} 正在外面流浪\n它会把路上看见的写成明信片寄回来`;
  if (semantic === 'adventure_failed') return `${catName} 今天的探险不太顺利\n明信片要等下一次了`;
  if (semantic === 'recalled') return `${catName} 已经被你召回\n想它了随时放它出门`;
  return `${catName} 正在第一次探险\n第一张明信片正在寄来的途中…`;
}

/**
 * 设置面板「出行」那一行。#088 交付时未覆盖（表第 7 行）：它只读 `cat.status`，于是流浪中时
 * 上方仍写「正在自由旅行」，而同一面板下方的流浪开关自己又写「流浪模式开着」——两句语义相邻却
 * 不同源（codex 首轮验收实测记录）。
 *
 * 注意：流浪**不改变旅行节奏**（`#056b` 的核心约束，`app.test.ts` 有断言守着），所以文案要同时
 * 说清「在外流浪」与「每天照样出门」，不能让用户以为开流浪会停掉旅行。
 */
export function settingsTravelText(semantic: PresenceSemantic, active: boolean): string {
  if (!active) return '已被召回，暂停一切旅行。想它了随时放它出门';
  if (semantic === 'wandering') return '正在外面流浪——旅行节奏不变，每天照样出门给你写明信片';
  if (semantic === 'adventure_running') return '正在云海里探险——回来就给你写明信片';
  return '正在自由旅行——每天出门一次，回来给你写明信片';
}

/**
 * 撸猫入口的 aria-label。`#056b` 验收标准 8 的欠账：流浪时仍说「和 X 继续聊天」，
 * 像它就在旁边一样。改为按处境措辞（「隔空呼唤」）。
 */
export function chatEntryLabel(semantic: PresenceSemantic, catName: string): string {
  return presenceIsAway(semantic) ? `隔空呼唤 ${catName}` : `和 ${catName} 继续聊天`;
}

const STATUS_TEXT: Record<PresenceSemantic, string> = {
  adventure_failed: '探险受阻',
  adventure_running: '探险中',
  adventure_starting: '准备出发',
  wandering: '在外流浪',
  recalled: '在家休息',
  broken: '需要照看',
  home_ready: '在家等你',
  home_idle: '在家等你',
};

/** 名牌副行 / 头像 tooltip / 状态圆点 aria-label 共用同一句，三者不得再各自派生。 */
export function presenceStatusText(semantic: PresenceSemantic): string {
  return STATUS_TEXT[semantic];
}

// 圆点颜色。**全部用 CSS 变量表达**，不写字面 hex——这不是风格偏好，是防一类真实缺陷：
// 本文件第一版给 wandering 写了 `var(--warm-deep)`，而 adventure_failed 写的是字面 `#e07b39`，
// 二者**是同一个颜色**（`global.css: --warm-deep: #e07b39`）。字符串不同、颜色相同，于是
// 「在外流浪」与「探险受阻」在屏幕上无法区分——一个常态和一个需要用户注意的错误态同色。
// 原始验收标准只要求「与在家蓝可区分」，所以静态测试与浏览器验收都放过了它（PR #72 首轮
// codex 报告实测流浪为 rgb(224,123,57)，正是失败橙）。现在改为：一律 var()，并由
// catPresence.test.ts 解析 global.css 的 :root 把 var 还原成 hex 后断言两两互异。
const DOT_COLOR: Record<PresenceSemantic, string> = {
  adventure_failed: 'var(--warm-deep)',
  adventure_running: 'var(--grass-deep)',
  // 准备出发时猫还在家，沿用旧行为的「在家」蓝（旧链在此落 `cat.status === 'active'` 分支）。
  adventure_starting: 'var(--sky-deep)',
  // 流浪：既有 token 里唯一与「在家蓝／失败橙／探险绿／照看红／召回褐」都明确可分的一档。
  wandering: 'var(--gold)',
  recalled: 'var(--sand-deep)',
  broken: 'var(--danger)',
  home_ready: 'var(--sky-deep)',
  home_idle: 'var(--sky-deep)',
};

export function presenceDotColor(semantic: PresenceSemantic): string {
  return DOT_COLOR[semantic];
}

/**
 * 今日云图志状态行。
 *
 * 注：本行原先只看 `has_travel_today` / `presencePhase` / `can_start_adventure`，流浪时落到
 * 「今晚会从这些见闻中选择」这类「在家」口径。所需字段 `cat.wandering_mode` 前端本来就有，
 * **不需要动 `getWorldDigest` 的返回契约**。
 */
export function dailyBriefStatusText(semantic: PresenceSemantic, hasTravelToday: boolean): string {
  if (hasTravelToday) return '今天的旅行已经寄回';
  if (semantic === 'adventure_running') return '小猫正在探险';
  if (semantic === 'wandering') return '小猫正在外面流浪';
  if (semantic === 'home_ready') return '等待你开启第一次探险';
  return '今晚会从这些见闻中选择';
}
