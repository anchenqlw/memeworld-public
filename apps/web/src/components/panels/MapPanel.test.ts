import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  browseList, emptyFilterText, filterLocations, formatVisitDate, INITIAL_MOOD, matchesMood, MOOD_OPTIONS,
  MAP_THEME_PACKS, mapThemeProgress, unexploredCaption, wishButtonLabel, wishErrorText,
  type Filter, type MoodFilter, type WishError,
} from './MapPanel';
import type { MapLocation } from '../../api/client';

// #074：氛围筛选（宁静/热闹/神秘，prop_7402efc4）。数据来源为服务端下发的 mood_tags，
// 前端只做派生过滤——地点夹具模拟 /world/map 下发形态，不硬编码真实地点清单。
function loc(id: string, moodTags: string[], opts: { region?: string; visited?: boolean } = {}): MapLocation {
  return {
    id, name: id, description: '', mood_tags: moodTags, min_attrs: {},
    map: { x: 50, y: 50 }, region_id: opts.region ?? 'region-heartlands', map_priority: 50,
    checkin: opts.visited ? { first_visit: '2026-07-20', visits: 1 } : null, heat: 0,
  };
}

const REGION = 'region-heartlands';
const LOCS: MapLocation[] = [
  loc('loc-lighthouse', ['宁静', '治愈'], { visited: true }),
  loc('loc-lookout', ['宁静', '神秘']),
  loc('loc-market', ['热闹', '勇敢'], { visited: true }),
  loc('loc-fair', ['怀旧', '热闹']),
  loc('loc-starlake', ['神秘', '探索']),
  loc('loc-elsewhere', ['宁静', '治愈'], { region: 'region-north-clouds' }),
];

describe('matchesMood（#074 氛围标签匹配）', () => {
  it('每档氛围映射一组 mood_tags 同义标签：主标签与同义标签都命中', () => {
    expect(matchesMood(['宁静', '治愈'], '宁静')).toBe(true);
    expect(matchesMood(['治愈', '怀旧'], '宁静')).toBe(true); // 同义标签「治愈」也算宁静
    expect(matchesMood(['欢快', '温柔'], '热闹')).toBe(true);
    expect(matchesMood(['探索', '刺激'], '神秘')).toBe(true);
  });

  it('不相干标签不命中', () => {
    expect(matchesMood(['怀旧', '温柔'], '宁静')).toBe(false);
    expect(matchesMood(['刺激', '勇敢'], '热闹')).toBe(false);
  });

  it('未选氛围（null）时恒命中；mood_tags 缺失时仅在未筛选下通过', () => {
    expect(matchesMood(['怀旧'], null)).toBe(true);
    expect(matchesMood(undefined, null)).toBe(true);
    expect(matchesMood(undefined, '宁静')).toBe(false);
  });
});

describe('filterLocations（#074 区域 × 已探索/未探索 × 氛围组合过滤）', () => {
  const ids = (filter: Filter, mood: MoodFilter) => filterLocations(LOCS, REGION, filter, mood).map((l) => l.id);

  it('每档氛围的过滤结果（验收 5）', () => {
    expect(ids('all', '宁静')).toEqual(['loc-lighthouse', 'loc-lookout']);
    expect(ids('all', '热闹')).toEqual(['loc-market', 'loc-fair']);
    expect(ids('all', '神秘')).toEqual(['loc-lookout', 'loc-starlake']);
  });

  it('只筛选当前区域内的地点，不跨区域', () => {
    expect(ids('all', '宁静')).not.toContain('loc-elsewhere');
  });

  it('氛围与「去过/未探索」可组合，不互相覆盖（验收 2）', () => {
    expect(ids('visited', '宁静')).toEqual(['loc-lighthouse']);
    expect(ids('unvisited', '宁静')).toEqual(['loc-lookout']);
    expect(ids('visited', '神秘')).toEqual([]);
    expect(ids('unvisited', '热闹')).toEqual(['loc-fair']);
  });

  it('清除氛围筛选（null）后回到仅按探索维度过滤', () => {
    expect(ids('all', null)).toHaveLength(5);
    expect(ids('visited', null)).toEqual(['loc-lighthouse', 'loc-market']);
  });

  it('筛选可产生空结果（交给空状态渲染，不是错误）', () => {
    const onlyLively = [loc('loc-a', ['热闹'])];
    expect(filterLocations(onlyLively, REGION, 'all', '神秘')).toEqual([]);
  });

  it('氛围选项完整覆盖 world/genes/locations.yaml 的全部 5 组 atmosphere 基因（PR #64 首轮验收：三档会让 [刺激,勇敢]/[勇敢,怀旧] 类地点对筛选完全不可见）', () => {
    expect(MOOD_OPTIONS.map((o) => o.value)).toEqual(['宁静', '热闹', '神秘', '怀旧', '冒险']);
    // 基因库 atmosphere 的 mood_tags 全集必须被某一档覆盖——漏一个就是筛选盲区
    const GENE_TAGS = ['宁静', '治愈', '热闹', '欢快', '神秘', '探索', '怀旧', '温柔', '冒险', '刺激', '勇敢'];
    const mapped = new Set(MOOD_OPTIONS.flatMap((o) => o.tags));
    expect(GENE_TAGS.filter((t) => !mapped.has(t))).toEqual([]);
  });

  it('线上真实地点样本无一落入盲区（望远驿站/星海渡口——首轮验收实测被三档漏掉）', () => {
    const REAL_SAMPLES: Array<[string, string[]]> = [
      ['loc-farview-station', ['刺激', '勇敢']],
      ['loc-starsea-ferry', ['勇敢', '怀旧']],
      ['loc-cloud-flower-hill', ['欢快', '治愈']],
      ['loc-starlake-shore', ['神秘', '探索']],
    ];
    for (const [id, tags] of REAL_SAMPLES) {
      const hit = MOOD_OPTIONS.some((o) => matchesMood(tags, o.value));
      expect(hit, `${id} 必须至少被一档氛围命中`).toBe(true);
    }
  });

  it('筛选态在面板关闭重开后重置（验收 2 固定为「重置」：初始态为不筛选）', () => {
    // mood 为组件本地 state，面板卸载即丢弃；重开时从 INITIAL_MOOD 起步
    expect(INITIAL_MOOD).toBeNull();
  });
});

// #074：停在世界地图选了氛围 → 跨区域列出候选（可发现性根因：不必逐区域翻找「安静的地方」）
describe('browseList（#074 浏览列表）', () => {
  const ids = (region: string | null, filter: Filter, mood: MoodFilter) => browseList(LOCS, region, filter, mood).map((l) => l.id);

  it('世界地图未选氛围：不列地点，保持「先进区域」的信息层级', () => {
    expect(ids(null, 'all', null)).toEqual([]);
    expect(ids(null, 'visited', null)).toEqual([]);
  });

  it('世界地图 + 氛围：跨区域列出全部命中地点', () => {
    expect(ids(null, 'all', '宁静').sort()).toEqual(['loc-elsewhere', 'loc-lighthouse', 'loc-lookout']);
  });

  it('世界地图 + 氛围 + 已探索/未探索仍可组合', () => {
    expect(ids(null, 'unvisited', '宁静').sort()).toEqual(['loc-elsewhere', 'loc-lookout']);
    expect(ids(null, 'visited', '宁静')).toEqual(['loc-lighthouse']);
  });

  it('进入区域后只列该区域，跨区域结果收回', () => {
    expect(ids(REGION, 'all', '宁静').sort()).toEqual(['loc-lighthouse', 'loc-lookout']);
  });

  it('结果按 map_priority 降序（沿用既有地点条排序）', () => {
    const ranked = [loc('loc-low', ['宁静']), { ...loc('loc-high', ['宁静']), map_priority: 90 }];
    expect(browseList(ranked, REGION, 'all', '宁静').map((l) => l.id)).toEqual(['loc-high', 'loc-low']);
  });
});

describe('emptyFilterText（#074 空结果态文案，验收 3）', () => {
  it('氛围筛空：点名所选氛围并引导换档', () => {
    expect(emptyFilterText(REGION, 'all', '神秘', [])).toBe('「神秘」氛围的角落还没被云绘到这片区域——试试别的氛围');
    expect(emptyFilterText(REGION, 'visited', '宁静', [])).toContain('宁静');
  });

  it('世界地图下跨区域筛空：措辞落到整个云图志而非某片区域', () => {
    expect(emptyFilterText(null, 'all', '热闹', [])).toBe('「热闹」氛围的角落还没被云绘到云图志——试试别的氛围');
  });

  it('无氛围筛选时按探索维度给文案，不误读为错误', () => {
    expect(emptyFilterText(REGION, 'visited', null, LOCS)).toBe('它还没在这片区域留下脚印——等它旅行归来再看看');
    expect(emptyFilterText(REGION, 'unvisited', null, LOCS)).toBe('这片区域已经被它走遍啦');
    expect(emptyFilterText(REGION, 'all', null, LOCS)).toBe('这片区域还在云雾里酝酿，暂时没有地点');
  });

  // PR #64 首轮验收 request-changes：归因错误——氛围单独有结果、叠加探索维度才空时，
  // 旧文案说「这片区域没有该氛围的角落」，与事实相反且把用户引向换氛围而非取消探索筛选。
  it('氛围有候选、叠「去过」才空：归因探索维度并引导取消该筛选，不谎称没有该氛围地点', () => {
    // loc-starlake[神秘,探索] 与 loc-lookout[宁静,神秘] 均未去过：神秘单独筛有 2 条，叠「去过」为空
    const text = emptyFilterText(REGION, 'visited', '神秘', LOCS);
    expect(filterLocations(LOCS, REGION, 'all', '神秘')).toHaveLength(2);
    expect(filterLocations(LOCS, REGION, 'visited', '神秘')).toHaveLength(0);
    expect(text).toBe('「神秘」氛围的地方它还没去过——取消「去过」筛选就能看到可以许愿的目的地');
    expect(text).not.toContain('还没被云绘');
    expect(text).not.toContain('试试别的氛围');
  });

  it('氛围有候选、叠「未探索」才空：同样归因探索维度', () => {
    // loc-market[热闹,勇敢] 已去过；loc-fair[怀旧,热闹] 未去过 → 用只含已访问热闹地点的样本
    const visitedOnly = [loc('loc-market', ['热闹', '勇敢'], { visited: true })];
    expect(emptyFilterText(REGION, 'unvisited', '热闹', visitedOnly))
      .toBe('「热闹」氛围的地方它都已经走遍啦——取消「未探索」筛选回顾一下');
  });

  it('氛围本身无候选时仍归因氛围（不被新分支吞掉）', () => {
    const noMysteryHere = [loc('loc-only-lively', ['热闹'])];
    expect(emptyFilterText(REGION, 'visited', '神秘', noMysteryHere))
      .toBe('「神秘」氛围的角落还没被云绘到这片区域——试试别的氛围');
  });
});

// #071 回归：许愿失败提示只属于触发它的那个地点，切换/关闭即清除（prop_8de60da8）。
describe('wishErrorText', () => {
  const farError: WishError = { locationId: 'loc-moon', message: '它还不敢去那么远的地方' };

  it('触发许愿的地点弹窗内展示错误', () => {
    expect(wishErrorText(farError, 'loc-moon')).toBe('它还不敢去那么远的地方');
  });

  it('许愿失败后切换到别的地点，错误不残留', () => {
    expect(wishErrorText(farError, 'loc-teahouse')).toBeNull();
  });

  it('关闭弹窗（无选中地点）不展示错误', () => {
    expect(wishErrorText(farError, null)).toBeNull();
  });

  it('无错误时恒为空', () => {
    expect(wishErrorText(null, 'loc-moon')).toBeNull();
  });
});

// #071 回归：未探索占位文案不再被误读为错误态「这里还没有猫」（prop_6b22cf04）。
describe('unexploredCaption', () => {
  it('已对该地点许愿：给出明确的成功确认', () => {
    expect(unexploredCaption(true, true)).toBe('薄雾笼罩——愿望已经许下，就等它第一次踏进这里');
  });

  it('可许愿但未许：把「没来过」与许愿引导连成一句', () => {
    expect(unexploredCaption(true, false)).toBe('薄雾笼罩——它还没来过这里，正好许个愿邀它去看看');
  });

  it('宿主未接入许愿：保持中性描述，不含引导', () => {
    expect(unexploredCaption(false, false)).toBe('薄雾笼罩——它还没来过这里');
  });
});

// #058 回归：地点列表最近到访日期格式化。
describe('formatVisitDate', () => {
  it('ISO 日期转中文月日', () => {
    expect(formatVisitDate('2026-07-20')).toBe('7月20日');
  });

  it('缺失或非法输入返回空串', () => {
    expect(formatVisitDate(undefined)).toBe('');
    expect(formatVisitDate('2026-7')).toBe('');
  });
});

describe('wishButtonLabel（#071b busy 挂死提示）', () => {
  it('busy 时给明确处理中文案（不再是不变的禁用态，弱网可感知）', () => {
    expect(wishButtonLabel(true, false)).toBe('正在告诉它…');
    expect(wishButtonLabel(true, true)).toBe('正在告诉它…'); // busy 优先于已许愿态
  });
  it('非 busy 时按是否已许愿给常规文案', () => {
    expect(wishButtonLabel(false, true)).toBe('已许愿 · 点击收回');
    expect(wishButtonLabel(false, false)).toBe('许个愿：下次让它去这里');
  });
});

describe('#113 月海拾光主题地图包', () => {
  const themedLocations = MAP_THEME_PACKS[0].locationIds.map((id) => loc(id, [], { region: 'region-lunar-starsea' }));

  it('只按三个不同地点的 checkin 推进 1/3 与 3/3，不受非主题地点干扰', () => {
    const none = mapThemeProgress(themedLocations)[0];
    expect(none).toMatchObject({ collected: 0, total: 3, completed: false, reachedMilestones: [], nextMilestone: { visits: 1, label: '初见月尘' } });

    const one = mapThemeProgress([{ ...themedLocations[0], checkin: { first_visit: '2026-08-26', visits: 8 } }, ...themedLocations.slice(1), loc('loc-unrelated', [], { visited: true })])[0];
    expect(one).toMatchObject({ collected: 1, completed: false, nextMilestone: { visits: 3, label: '拾完星光' } });
    expect(one.reachedMilestones).toEqual([{ visits: 1, label: '初见月尘' }]);

    const complete = mapThemeProgress(themedLocations.map((location) => ({ ...location, checkin: { first_visit: '2026-08-26', visits: 1 } })))[0];
    expect(complete).toMatchObject({ collected: 3, completed: true, nextMilestone: null });
    expect(complete.reachedMilestones.map((milestone) => milestone.visits)).toEqual([1, 3]);
  });

  it('把原创、地点印记、无勋章与无装扮锁成前端契约', () => {
    expect(MAP_THEME_PACKS).toHaveLength(1);
    expect(MAP_THEME_PACKS[0]).toMatchObject({
      id: 'theme-moonlit-keepsakes', rights: 'original', rewardKind: 'checkin-stamps',
      badgeReward: false, outfitReward: false,
    });
  });

  it('世界基因、三个既有地点与 Web 常量完全一致', () => {
    const gene = readFileSync(new URL('../../../../../world/genes/locations.yaml', import.meta.url), 'utf8');
    const theme = MAP_THEME_PACKS[0];
    for (const line of [
      `  - id: ${theme.id}`,
      `    name: ${theme.name}`,
      `    rights: ${theme.rights}`,
      `    location_ids: [${theme.locationIds.join(', ')}]`,
      ...theme.milestones.map((milestone) => `      - { visits: ${milestone.visits}, label: ${milestone.label} }`),
      `    collection: ${theme.rewardKind}`,
      '    badge_reward: none',
      '    outfit_reward: none',
    ]) expect(gene).toContain(line);

    for (const id of theme.locationIds) {
      const atlasLocation = readFileSync(new URL(`../../../../../world/atlas/locations/${id}.md`, import.meta.url), 'utf8');
      expect(atlasLocation).toContain(`id: ${id}`);
    }
  });

  it('直接锁定 MapPanel 生产计算、玩家可见 DOM 与移动端样式接线', () => {
    const source = readFileSync(new URL('./MapPanel.tsx', import.meta.url), 'utf8');
    const component = source.slice(source.indexOf('export function MapPanel('));
    const styles = readFileSync(new URL('../../styles/global.css', import.meta.url), 'utf8');
    expect(component).toContain('useMemo(() => mapThemeProgress(locations), [locations])');
    expect(component).toContain('aria-label="主题收集"');
    expect(component).toContain('data-testid={`theme-map-pack-${theme.id}`}');
    expect(component).toContain('{theme.collected} / {theme.total} 枚地点印记');
    expect(component).toContain('{milestone.visits}/{theme.locationIds.length} {milestone.label}');
    expect(styles).toContain(".map-theme-progress__milestones span[data-reached='true']");
    expect(styles).toMatch(/@media \(max-width: 720px\)[\s\S]*?\.map-theme-progress__summary/);
  });

  it('首期不在无 API 消费者的 server travelService 里留另一份死计算', () => {
    const server = readFileSync(new URL('../../../../../apps/server/src/services/travelService.ts', import.meta.url), 'utf8');
    expect(server).not.toMatch(/THEME_COLLECTIONS|evaluateThemeCollections|themeCollections/);
  });
});
