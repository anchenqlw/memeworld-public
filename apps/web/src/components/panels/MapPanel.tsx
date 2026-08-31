import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { api, type MapLocation, type MapManifest, type Travel } from '../../api/client';
import type { WishError, WishFlow } from './wishFlow';
import { Icon } from '../ui/Icon';
import { Overlay } from '../ui/Overlay';
import { ImageLightbox } from '../ui/Lightbox';
import { PostcardCard } from '../ui/Postcard';
import { assetUrl, REGION_MAP_IMAGES } from '../../game/assets';
import { travelAvailabilityText, type TravelAvailabilityView } from '../../lib/travelAvailability';

type Props = {
  locations: MapLocation[];
  manifest: MapManifest | null;
  onClose: () => void;
  /** 从今日云图志卡片进入时直接定位到该地点（backlog #065）；找不到时退化为世界地图 */
  initialLocationId?: string | null;
  /** #089：本次定位的来源（「来自你的愿望」/「来自今日旅行」），让用户知道为什么落在这里。null = 不显示 */
  focusHint?: string | null;
  /** 把用户正在浏览的区域上提给主舞台；null 表示世界地图。 */
  onSceneChange?: (regionId: string | null) => void;
  /**
   * #071b：许愿状态 store（#056a 许愿 + #071 竞态修复）由 App 层常驻持有，本面板**只订阅不拥有**——
   * 卸载时只解除订阅并解除选中语境，不 dispose；愿望态/busy/error 全部读 store。
   * store.wishId === undefined 表示宿主未接入许愿功能（不渲染许愿入口）。
   */
  wishFlow: WishFlow;
  /** 服务端 world/digest 的权威当日状态；面板只格式化，不自行推断。 */
  travelAvailability: TravelAvailabilityView | null;
  availabilityNowMs: number;
};
export type Filter = 'all' | 'visited' | 'unvisited';
type RegionMapLocation = MapLocation & { region_map?: { x: number; y: number } };

export const MAP_THEME_PACKS = [{
  id: 'theme-moonlit-keepsakes',
  name: '月海拾光',
  locationIds: ['loc-moon-silent-sea', 'loc-starsea-ferry', 'loc-moonstep-corridor'],
  milestones: [{ visits: 1, label: '初见月尘' }, { visits: 3, label: '拾完星光' }],
  rights: 'original' as const,
  rewardKind: 'checkin-stamps' as const,
  badgeReward: false as const,
  outfitReward: false as const,
}];

/** #113：主题进度只消费地图 API 已有的 checkin 事实；同一地点重复旅行不会重复计数。 */
export function mapThemeProgress(locations: MapLocation[]) {
  return MAP_THEME_PACKS.map((theme) => {
    const collected = theme.locationIds.filter((id) => locations.some((location) => location.id === id && location.checkin));
    return {
      ...theme,
      collected: collected.length,
      total: theme.locationIds.length,
      completed: collected.length === theme.locationIds.length,
      reachedMilestones: theme.milestones.filter((milestone) => collected.length >= milestone.visits),
      nextMilestone: theme.milestones.find((milestone) => collected.length < milestone.visits) ?? null,
    };
  });
}

/** #074：氛围五档（prop_7402efc4）。每档对应 world/genes/locations.yaml 的 atmosphere 基因
 * mood_tags 同义组——只映射标签语义，不硬编码地点清单；地点是否命中完全由服务端下发的
 * mood_tags 决定（新地点落库即自动进入筛选）。
 *
 * 覆盖完整性是硬要求（PR #64 首轮验收发现）：backlog 原文举例三档（宁静/热闹/神秘），但基因库有
 * 5 组 atmosphere；只映射三档会让「望远驿站[刺激,勇敢]」「星海渡口[勇敢,怀旧]」等地点对筛选入口
 * 完全不可见——本条目根因恰恰是可发现性，新入口反而造成盲区就是自相矛盾。故按基因库全量映射。
 *
 * 交叉命中是正确语义，不是缺陷：「云花坡[欢快,治愈]」同时进「宁静」与「热闹」两档——它确实同时
 * 具备治愈与欢快气质。单选互斥约束的是「用户一次只按一种心情找」，不是「每个地点只属一档」。 */
export type Mood = '宁静' | '热闹' | '神秘' | '怀旧' | '冒险';
export type MoodFilter = Mood | null;
export const MOOD_OPTIONS: Array<{ value: Mood; tags: string[] }> = [
  { value: '宁静', tags: ['宁静', '治愈'] },
  { value: '热闹', tags: ['热闹', '欢快'] },
  { value: '神秘', tags: ['神秘', '探索'] },
  { value: '怀旧', tags: ['怀旧', '温柔'] },
  { value: '冒险', tags: ['冒险', '刺激', '勇敢'] },
];
/** #074：氛围筛选初始态为「不筛」；面板关闭重开即回到该值（组件本地 state，验收 2 选「重置」并在测试中固定） */
export const INITIAL_MOOD: MoodFilter = null;

export function matchesMood(moodTags: string[] | undefined, mood: MoodFilter): boolean {
  if (!mood) return true;
  const option = MOOD_OPTIONS.find((o) => o.value === mood);
  return !!option && (moodTags ?? []).some((tag) => option.tags.includes(tag));
}

/** #074：云图志地点浏览的派生过滤——区域 × 已探索/未探索 × 氛围三个维度可组合，互不覆盖 */
export function filterLocations(locations: MapLocation[], regionId: string | null, filter: Filter, mood: MoodFilter): MapLocation[] {
  return locations.filter((loc) => {
    if (regionId && loc.region_id !== regionId) return false;
    if (filter === 'visited' && !loc.checkin) return false;
    if (filter === 'unvisited' && loc.checkin) return false;
    return matchesMood(loc.mood_tags, mood);
  });
}

/** #074：浏览列表 = 进了区域看该区域，停在世界地图且选了氛围时跨区域列出候选（可发现性是本条目的根因）。
 * 世界地图未选氛围时不列地点，保持原有「先进区域再看地点」的信息层级。 */
export function browseList(locations: MapLocation[], regionId: string | null, filter: Filter, mood: MoodFilter): MapLocation[] {
  if (!regionId && !mood) return [];
  return [...filterLocations(locations, regionId, filter, mood)].sort((a, b) => b.map_priority - a.map_priority);
}

/** #074：筛选结果为空时的可读空状态（验收 3）——不能是空白列表，也不能被误读为错误。
 *
 * 归因必须准确（PR #64 首轮验收发现）：不能因为「选了氛围」就一律归因氛围。若氛围单独筛有结果、
 * 叠加探索维度后才空，真正的收窄来源是探索维度，此时提示「换个氛围」会把用户引向错误操作
 * （实测：星湖绿境+宁静=1 条，叠「去过」后空，旧文案却说这片区域没有宁静角落，与事实相反）。
 * 故先用「只去掉探索维度」重算：仍空 → 氛围确实无候选；不空 → 归因探索维度。 */
export function emptyFilterText(
  regionId: string | null,
  filter: Filter,
  mood: MoodFilter,
  locations: MapLocation[] = [],
): string {
  const where = regionId ? '这片区域' : '云图志';
  // 探索维度是否为收窄的真正来源：去掉它之后还有没有候选
  const moodOnlyHits = mood && filter !== 'all'
    ? filterLocations(locations, regionId, 'all', mood).length
    : 0;
  if (mood && moodOnlyHits > 0) {
    return filter === 'visited'
      ? `「${mood}」氛围的地方它还没去过——取消「去过」筛选就能看到可以许愿的目的地`
      : `「${mood}」氛围的地方它都已经走遍啦——取消「未探索」筛选回顾一下`;
  }
  if (mood) return `「${mood}」氛围的角落还没被云绘到${where}——试试别的氛围`;
  if (filter === 'visited') return '它还没在这片区域留下脚印——等它旅行归来再看看';
  if (filter === 'unvisited') return '这片区域已经被它走遍啦';
  return '这片区域还在云雾里酝酿，暂时没有地点';
}

const FALLBACK_MANIFEST: MapManifest = {
  basemap_version: 'world-v1', min_zoom: 1, max_zoom: 1,
  regions: [{ id: 'region-heartlands', name: '云猫世界', center: { x: 50, y: 50 }, bounds: { x: 0, y: 0, width: 100, height: 100 }, mood: '等待探索' }],
};

/** '2026-07-20' → '7月20日'（backlog #058：地点列表最近到访日期） */
export function formatVisitDate(date?: string): string {
  if (!date || date.length < 10) return '';
  return `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
}

/** #071：许愿失败提示只属于触发它的那个地点——切到别的地点弹窗不得残留（prop_8de60da8） */
export type { WishError } from './wishFlow';
export function wishErrorText(error: WishError | null, selectedId: string | null): string | null {
  return error && selectedId && error.locationId === selectedId ? error.message : null;
}

/** #071：未探索地点占位文案——避免被误读为错误态「这里还没有猫」（prop_6b22cf04） */
export function unexploredCaption(wishEnabled: boolean, wished: boolean): string {
  if (wished) return '薄雾笼罩——愿望已经许下，就等它第一次踏进这里';
  if (wishEnabled) return '薄雾笼罩——它还没来过这里，正好许个愿邀它去看看';
  return '薄雾笼罩——它还没来过这里';
}

/** #071b 首轮验收第 3 项：许愿按钮文案。busy（含弱网请求挂起、store 常驻会话级）时给明确「处理中」，
 * 避免用户把禁用态误读为卡死。抽纯函数以便无 DOM 环境下单测。 */
export function wishButtonLabel(busy: boolean, wished: boolean): string {
  if (busy) return '正在告诉它…';
  return wished ? '已许愿 · 点击收回' : '许个愿：下次让它去这里';
}

export function MapPanel({ locations, manifest, onClose, initialLocationId, focusHint, onSceneChange, wishFlow, travelAvailability, availabilityNowMs }: Props) {
  const config = manifest || FALLBACK_MANIFEST;
  // 初始定位（backlog #065）：带 initialLocationId 进入时直接进区域并选中该地点
  const initialLoc = initialLocationId ? locations.find((l) => l.id === initialLocationId) || null : null;
  const [selected, setSelected] = useState<MapLocation | null>(initialLoc);
  const [selectedRegion, setSelectedRegion] = useState<string | null>(initialLoc?.region_id || null);
  const [filter, setFilter] = useState<Filter>('all');
  // #074：氛围筛选（宁静/热闹/神秘）。单选：mood 三档互斥，再点一次取消；面板重开重置（INITIAL_MOOD）
  const [mood, setMood] = useState<MoodFilter>(INITIAL_MOOD);
  const [memories, setMemories] = useState<Travel[]>([]);
  const [loadingMem, setLoadingMem] = useState(false);
  const [zoomImage, setZoomImage] = useState<{ src: string; caption: string } | null>(null);
  // #056a 许愿 + #071 竞态修复 + #071b：状态生命周期在 App 层常驻的 wishFlow store 里，本面板只订阅。
  const { wishId, busy: wishBusy, error: wishError } = useSyncExternalStore(wishFlow.subscribe, wishFlow.getState);

  // #071b（evolution/reviews/pr-61-b82a2ab.md）：本面板卸载不再 dispose store——旧许愿请求必须
  // 真正 settle 才释放 busy 锁，否则「关闭云图志→立刻重开→对另一地点许愿」又会出现跨实例双请求，
  // 服务端 last-write-wins 可停在被 abort 的旧愿望上而 UI 显示新愿望（第四轮复核的确定失配终态）。
  // 卸载只做「解除选中语境」：epoch +1 使 pending 请求的失败写回失效（等价于关闭地点弹窗），
  // 并清掉不再属于任何弹窗的错误——重开面板不会复现旧提示。store 的销毁归 App 的会话边界。
  useEffect(() => () => { wishFlow.selectionChanged(null); }, [wishFlow]);
  useEffect(() => { onSceneChange?.(selectedRegion); }, [onSceneChange, selectedRegion]);
  useEffect(() => () => { onSceneChange?.(null); }, [onSceneChange]);
  const visited = locations.filter((l) => l.checkin).length;
  const themeProgress = useMemo(() => mapThemeProgress(locations), [locations]);
  const worldMap = assetUrl('mapBg');
  const region = config.regions.find((r) => r.id === selectedRegion) || null;
  const regionMapImage = selectedRegion ? REGION_MAP_IMAGES[selectedRegion] : null;
  const filtered = useMemo(
    () => filterLocations(locations, selectedRegion, filter, mood),
    [locations, selectedRegion, filter, mood],
  );
  // #074：浏览列表——区域内按区域，停在世界地图选了氛围则跨区域列出（「今天想去个安静的地方」直达）
  const browse = useMemo(
    () => browseList(locations, selectedRegion, filter, mood),
    [locations, selectedRegion, filter, mood],
  );
  const browsing = Boolean(selectedRegion || mood);
  useEffect(() => {
    if (!selected?.checkin) { setMemories([]); return; }
    setLoadingMem(true);
    api.travels({ location_id: selected.id }).then((r) => setMemories(r.travels)).finally(() => setLoadingMem(false));
  }, [selected]);

  // #071：关闭弹窗或切换地点即丢弃旧的许愿错误，并让 pending 请求的失败写回失效（验收 2：
  // 提示只在触发它的地点弹窗内存活——含「pending 时切走、请求随后 reject」的竞态时序）
  useEffect(() => {
    wishFlow.selectionChanged(selected?.id ?? null);
  }, [wishFlow, selected]);

  const enterRegion = (regionId: string) => { setSelectedRegion(regionId); setSelected(null); };
  const showWorld = () => { setSelectedRegion(null); setSelected(null); };

  // #056a：许愿/撤销。天性不足时服务端 400，文案原样展示（"它还不敢去那么远的地方"）。
  const toggleWish = (loc: MapLocation) => wishFlow.toggle(loc);

  return (
    <Overlay title="云图志" icon="map" onClose={onClose} wide headExtra={<span className="map-progress">{focusHint && <span className="map-focus-hint">{focusHint}</span>}<Icon name="pin" size={15} color="var(--grass-deep)" strokeWidth={2.2} />已打卡 {visited} / {locations.length}</span>}>
      <p className="map-travel-availability" data-travel-status={travelAvailability?.status ?? 'unknown'} role="status">
        {travelAvailabilityText(travelAvailability, availabilityNowMs)}
      </p>
      <div className="map-toolbar">
        <button type="button" className={!selectedRegion ? 'active' : ''} onClick={showWorld}>世界地图</button>
        {config.regions.map((r) => <button type="button" key={r.id} className={selectedRegion === r.id ? 'active' : ''} onClick={() => enterRegion(r.id)}>{r.name}</button>)}
        {browsing && <><span className="map-toolbar__spacer" />{(['all', 'visited', 'unvisited'] as Filter[]).map((value) => <button type="button" key={value} className={filter === value ? 'active' : ''} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === 'all' ? '全部' : value === 'visited' ? '去过' : '未探索'}</button>)}</>}
      </div>
      {/* #074：氛围筛选 chip（prop_7402efc4）——与「去过/未探索」可组合；单选，再点一下取消；
          停在世界地图时选氛围即跨区域列出候选（「今天想去个安静的地方」不必逐区域翻） */}
      <div className="map-toolbar map-toolbar--mood" role="group" aria-label="按氛围筛选">
        <span className="map-mood-label">氛围</span>
        {MOOD_OPTIONS.map(({ value }) => (
          <button type="button" key={value} className={mood === value ? 'active' : ''} aria-pressed={mood === value} onClick={() => setMood(mood === value ? null : value)}>{value}</button>
        ))}
        {mood && <button type="button" className="map-mood-clear" onClick={() => setMood(null)}>清除筛选</button>}
      </div>
      <section className="map-theme-collection" aria-label="主题收集">
        {themeProgress.map((theme) => (
          <article
            key={theme.id}
            className={`map-theme-progress ${theme.completed ? 'map-theme-progress--complete' : ''}`}
            data-testid={`theme-map-pack-${theme.id}`}
          >
            <div className="map-theme-progress__summary">
              <span className="map-theme-progress__mark"><Icon name="moon" size={17} /></span>
              <strong>{theme.name}</strong>
              <span>{theme.collected} / {theme.total} 枚地点印记</span>
            </div>
            <div className="map-theme-progress__milestones" aria-label={`${theme.name}里程碑`}>
              {theme.milestones.map((milestone) => (
                <span key={milestone.visits} data-reached={theme.collected >= milestone.visits ? 'true' : 'false'}>
                  {milestone.visits}/{theme.locationIds.length} {milestone.label}
                </span>
              ))}
            </div>
          </article>
        ))}
      </section>
      {region && <div className="map-region-heading"><button type="button" onClick={showWorld}><Icon name="arrowLeft" size={15} />返回世界地图</button><div><strong>{region.name}</strong><span>{region.mood} · {filtered.length} 个地点</span></div></div>}
      <div className="map-viewport">
        <div className={`map-stage map-stage--layered ${region ? 'map-stage--region' : 'map-stage--world'}`} style={{ backgroundImage: `url(${regionMapImage || worldMap || ''})` }}>
          {!selectedRegion ? config.regions.map((r) => {
            const regionLocs = locations.filter((loc) => loc.region_id === r.id);
            const regionVisited = regionLocs.filter((loc) => loc.checkin).length;
            if (!regionLocs.length) return null;
            // #074：选了氛围时，没有命中地点的区域淡出——世界地图一眼看出该往哪片走
            const moodMiss = Boolean(mood) && !regionLocs.some((loc) => matchesMood(loc.mood_tags, mood));
            return <button key={r.id} type="button" className={`map-region ${moodMiss ? 'map-region--dim' : ''}`} style={{ left: `${r.center.x}%`, top: `${r.center.y}%` }} onClick={() => enterRegion(r.id)}><span>{regionVisited}/{regionLocs.length}</span><strong>{r.name}</strong><small>{r.mood}</small></button>;
          }) : filtered.map((loc) => {
            const done = !!loc.checkin;
            const pin = (loc as RegionMapLocation).region_map || loc.map;
            return <button key={loc.id} type="button" className={`map-pin ${selected?.id === loc.id ? 'selected' : ''}`} style={{ left: `${pin.x}%`, top: `${pin.y}%` }} onClick={() => setSelected(loc)} title={loc.name}>
              <span className="map-pin-bubble" style={{ background: done ? 'linear-gradient(180deg,#bcd97e,#7ea94a)' : 'linear-gradient(180deg,rgba(255,255,255,.96),rgba(210,220,228,.94))' }}><Icon name={done ? 'paw' : 'cloud'} size={22} color={done ? '#fff' : 'var(--ink-soft)'} strokeWidth={2} filled={done} /></span><span className="map-pin-label visible">{loc.name}</span>
            </button>;
          })}
        </div>
      </div>
      {browsing && (browse.length ? <div className="map-location-strip" aria-label="地点列表">{browse.map((loc) => (
        <button type="button" key={loc.id} className={selected?.id === loc.id ? 'active' : ''} onClick={() => setSelected(loc)}>
          <Icon name={loc.checkin ? 'paw' : 'cloud'} size={14} />
          <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', lineHeight: 1.3 }}>
            {loc.name}
            {/* #074：世界地图下的跨区域氛围结果标出所属区域，方便直接进那片区域 */}
            {!selectedRegion && (
              <small style={{ fontSize: '0.64rem', color: 'var(--ink-soft)', fontWeight: 400 }}>
                {config.regions.find((r) => r.id === loc.region_id)?.name || ''}
              </small>
            )}
            {/* backlog #058：去过的地点不点开即见最近到访日期与那次的故事标题 */}
            {selectedRegion && loc.checkin && (
              <small style={{ fontSize: '0.64rem', color: 'var(--ink-soft)', fontWeight: 400, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {formatVisitDate(loc.checkin.last_visit || loc.checkin.first_visit)}
                {loc.checkin.last_title ? ` · ${loc.checkin.last_title}` : ''}
              </small>
            )}
          </span>
        </button>
      ))}</div> : (
        /* #074 验收 3：筛选空结果给可读空状态，不留空白列表 */
        <div className="map-empty" role="status">
          <Icon name="cloud" size={22} color="var(--ink-soft)" />
          <span>{emptyFilterText(selectedRegion, filter, mood, locations)}</span>
        </div>
      ))}
      {selected && <div className="map-popup-backdrop" onClick={() => setSelected(null)}><div className="gs-panel map-popup" onClick={(e) => e.stopPropagation()}>
        <div className="overlay-head"><div className="overlay-title"><Icon name="pin" size={20} color="var(--warm-deep)" strokeWidth={2.2} />{selected.name}<span className={selected.checkin ? 'map-visit map-visit--done' : 'map-visit'}>{selected.checkin ? `去过 ${selected.checkin.visits} 次` : '未探索'}</span></div>{selected.heat > 0 && <span className="map-heat"><Icon name="heart" size={13} color="var(--warm-deep)" filled /> {selected.heat} 只猫来过</span>}<button type="button" className="gs-iconbtn" onClick={() => setSelected(null)} aria-label="关闭地点"><Icon name="close" size={16} /></button></div>
        <div className="overlay-body"><p className="map-description">{selected.description.slice(0, 180)}</p>
          {/* #056a：许愿下次旅行来这里（store.wishId !== undefined 即宿主已接入；一次性，命中后自动消失）。
              #071b：busy 读的是 App 层常驻 store——关闭重开面板时旧请求若仍在途，按钮仍是禁用态。 */}
          {wishId !== undefined && (
            <div style={{ margin: '0 0 12px' }}>
              <button
                type="button"
                className={`gs-btn gs-btn--small ${wishId === selected.id ? '' : 'gs-btn--ghost'}`}
                disabled={wishBusy}
                onClick={() => void toggleWish(selected)}
              >
                <Icon name="star" size={14} strokeWidth={2.2} filled={wishId === selected.id} />
                {wishButtonLabel(wishBusy, wishId === selected.id)}
              </button>
              {/* #071b 首轮验收第 3 项：busy 锁作用域从「面板生命周期」放大到「会话生命周期」，
                  弱网下请求挂起时按钮会持续禁用；给出明确的处理中文案，避免用户误以为按钮卡死。
                  （请求无客户端超时是 store 层设计——「旧请求真正 settle 前不发新请求」的定义，
                  加超时需另开条目权衡，见 backlog #071b 交付后续。） */}
              {wishBusy && (
                <p style={{ margin: '6px 0 0', fontSize: '0.74rem', color: 'var(--ink-soft)' }}>
                  正在把心愿递给它，网络慢的时候会多等一会儿……
                </p>
              )}
              {wishId === selected.id && (
                <p style={{ margin: '6px 0 0', fontSize: '0.74rem', color: 'var(--ink-soft)' }}>
                  它下次出门会优先往这里走——不过猫毕竟是猫，也可能被别处吸引。
                </p>
              )}
              {wishErrorText(wishError, selected.id) && (
                <p role="alert" style={{ margin: '6px 0 0', fontSize: '0.74rem', color: 'var(--warm-deep)' }}>{wishErrorText(wishError, selected.id)}</p>
              )}
            </div>
          )}
          {!selected.checkin ? <div className="asset-placeholder"><Icon name="cloud" size={30} color="var(--ink-soft)" />{unexploredCaption(wishId !== undefined, wishId === selected.id)}</div> : loadingMem ? <div className="map-loading"><div className="gs-spinner" /></div> : <div className="map-memories">{memories.map((t) => <PostcardCard key={t.id} travel={t} compact onZoomImage={(src, caption) => setZoomImage({ src, caption })} />)}</div>}</div>
      </div></div>}
      {zoomImage && <ImageLightbox src={zoomImage.src} caption={zoomImage.caption} onClose={() => setZoomImage(null)} />}
    </Overlay>
  );
}
