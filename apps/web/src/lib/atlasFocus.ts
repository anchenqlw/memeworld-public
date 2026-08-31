/**
 * 云图志入口的 focus 目标推导（backlog #089，方案 A）。
 *
 * 问题：主舞台两个卡片承诺「点这里看看今日目的地」/「去云图志找找它的足迹」，`onClick` 却是
 * 裸 `setPanel('map')`——打开的是世界层默认地图，而世界层不渲染地点 pin、列表也直接返回空
 * （`browseList` 在无区域无氛围时返回 `[]`），所以用户什么都定位不到（`prop_bcbe2724`）。
 *
 * #089 交付时服务端还没有「今日目的地」事实，故方案 A 只能撤掉无法兑现的承诺。
 * #099 新增服务端校验的中途上报后，本模块仍保留原安全退化：只有 location id 位于当前地图
 * 数据且服务端已投影时才定位；猫未上报、地点下线或最终旅行已回报时都不会猜。
 */

export type AtlasFocus =
  /** 主人愿望地点：服务端只当优先提示注入，Agent 可不采纳，故理由必须说清是「愿望」 */
  | { kind: 'wish'; locationId: string; reason: '主人愿望' }
  /** 今日已回报的旅行地点：这才是确定的「今天去了哪」 */
  | { kind: 'latest-travel'; locationId: string; reason: '今日旅行' }
  /** #099：猫已选择且经服务端今日候选集校验的中途目的地 */
  | { kind: 'current-destination'; locationId: string; reason: '今日目的地' }
  | { kind: 'none'; reason: null };

const NONE: AtlasFocus = { kind: 'none', reason: null };

export type AtlasFocusInput = {
  entry: 'wandering-card' | 'adventure-card';
  wishLocationId?: string | null;
  hasTravelToday?: boolean;
  /**
   * 流浪卡片专用：今日有未读明信片。
   * **必须与 `wanderingCaption`（`GameStage`）的档位判断同源**——两处都传
   * `Boolean(latestTravel && unreadTravels > 0)`。理由见下方优先级注释。
   */
  hasUnreadTravel?: boolean;
  latestTravelLocationId?: string | null;
  currentDestinationLocationId?: string | null;
  /** 用于「地点 id 查不到 → 退化」这一分支：id 不在当前地图数据里时定位会落空 */
  knownLocationIds: readonly string[];
};

export function deriveAtlasFocus(input: AtlasFocusInput): AtlasFocus {
  const known = (id: string | null | undefined): id is string => Boolean(id) && input.knownLocationIds.includes(id as string);

  if (input.entry === 'wandering-card') {
    // 优先级必须与 `wanderingCaption` **逐档对齐**：未读明信片 > 有愿望 > 都没有。
    // 这不是可选的对齐，而是本 backlog 的目标本身：可见承诺与实际落点必须同源。
    //
    // 首版这里只看愿望，于是「流浪 + 有愿望 + 今日明信片未读」时副标题说
    // 「它从旅途寄回了新的明信片，点这里看看它去了哪」、点击却定位到愿望地点并提示
    // 「来自你的愿望」——**说的是旅行、开的是愿望**，正是 #089 要消灭的那类缺陷。
    // 由 codex 独立浏览器验收在 exact `5c99b5c` 上双视口实测复现，登记为 ISSUES #85。
    if (input.hasUnreadTravel) {
      // 已经承诺「看看它去了哪」，就只能落在旅行地点；地点 id 解析不出时**退化为不定位**，
      // 绝不回退到愿望——那会再次制造同一种错配。
      return known(input.latestTravelLocationId)
        ? { kind: 'latest-travel', locationId: input.latestTravelLocationId, reason: '今日旅行' }
        : NONE;
    }
    // 数据已在手（`cat.travel_wish_location_id`），文案也已承诺方向——这条是零成本兑现。
    return known(input.wishLocationId)
      ? { kind: 'wish', locationId: input.wishLocationId, reason: '主人愿望' }
      : NONE;
  }

  // 探险中卡片：今天已回报 → 定位当日旅行地点（确定事实）。
  if (input.hasTravelToday && known(input.latestTravelLocationId)) {
    return { kind: 'latest-travel', locationId: input.latestTravelLocationId, reason: '今日旅行' };
  }
  // #099：最终旅行优先；尚未回报时只消费服务端校验过的中途目的地。
  if (known(input.currentDestinationLocationId)) {
    return { kind: 'current-destination', locationId: input.currentDestinationLocationId, reason: '今日目的地' };
  }
  // 猫未上报/地点已下线 → 保持方案 A 的安全退化，不定位、不承诺。
  return NONE;
}

/** 探险中卡片副标题：`none` 时不得再承诺「今日目的地」——那是本 backlog 的核心兑现点。 */
export function adventureCardCaption(focus: AtlasFocus): string {
  if (focus.kind === 'latest-travel') return '今天的明信片已经寄回，点这里看看它去了哪';
  if (focus.kind === 'current-destination') return '它已经选好落脚处，点这里看看今日目的地';
  return '猫窝替它看着家，它选好落脚处就会写信回来';
}

/** 云图志顶部来源提示（验收标准 3）：让用户知道「为什么帮我定位到了这里」。 */
export function atlasFocusHint(focus: AtlasFocus): string | null {
  if (focus.kind === 'wish') return '来自你的愿望';
  if (focus.kind === 'latest-travel') return '来自今日旅行';
  if (focus.kind === 'current-destination') return '来自小猫刚刚选定的目的地';
  return null;
}
