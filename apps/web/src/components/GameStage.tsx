import { useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type Badge,
  type CatProfile,
  type ChronicleEntry,
  type ContributionSummary,
  type MapLocation,
  type MapManifest,
  type PatStatus,
  type Proposal,
  type Travel,
  type WorldDigest,
} from '../api/client';
import { ATTR_GROWTH_HINT, ATTR_KEYS, ATTR_META, attrLevelLabel } from '../game/catOptions';
import { computeUnreadTravelCount } from '../game/journalUnread';
import {
  chatEntryLabel,
  dailyBriefStatusText,
  derivePresence,
  presenceDotColor,
  presenceStatusText,
} from '../lib/catPresence';
import {
  adventureCardCaption,
  atlasFocusHint,
  deriveAtlasFocus,
  type AtlasFocus,
} from '../lib/atlasFocus';
import { Sky } from './ui/Sky';
import { Icon, type IconName } from './ui/Icon';
import { CatAvatar } from './CatAvatar';
import { CatImage } from './CatImage';
import { ProfilePanel } from './panels/ProfilePanel';
import { MapPanel } from './panels/MapPanel';
import type { WishFlow } from './panels/wishFlow';
import { JournalPanel } from './panels/JournalPanel';
import { BadgesPanel } from './panels/BadgesPanel';
import { BagPanel } from './panels/BagPanel';
import { ChatPanel } from './panels/ChatPanel';
import { MailPanel } from './panels/MailPanel';
import { SettingsPanel } from './panels/SettingsPanel';
import { GrowthPanel } from './panels/GrowthPanel';
import { ChroniclePanel } from './panels/ChroniclePanel';
import { DOCK_ART } from '../game/assets';
import { deriveStageScene } from '../game/sceneBackground';
import {
  HOME_CLEANING_TIMING,
  INITIAL_HOME_CLEANING_STATE,
  advanceHomeCleaning,
  beginHomeCleaning,
  homeCleaningButtonLabel,
  homeCleaningFeedback,
} from '../game/homeCleaning';
import { QcaCreditsRecoveryCard } from './QcaCreditsRecoveryCard';
import { decideTravelAvailabilityRefresh, travelAvailabilityText } from '../lib/travelAvailability';

type PanelId = 'profile' | 'growth' | 'map' | 'journal' | 'badges' | 'bag' | 'chat' | 'chronicle' | 'mail' | 'settings' | null;

type Props = {
  user: { display_name: string };
  cat: CatProfile;
  patStatus: PatStatus;
  travels: Travel[];
  badges: Badge[];
  mapLocs: MapLocation[];
  mapManifest: MapManifest | null;
  worldDigest: WorldDigest | null;
  proposals: Proposal[];
  contribution: ContributionSummary;
  chronicle: ChronicleEntry[];
  devMode: boolean;
  refresh: () => void;
  onLogout: () => void;
  /** #071b：许愿状态 store 由 App 层常驻持有；本层只做权威对账并把它交给云图志（自己不创建、不销毁） */
  wishFlow: WishFlow;
};

const DOCK_ITEMS: Array<{ id: Exclude<PanelId, null | 'settings'>; icon: IconName; label: string }> = [
  { id: 'profile', icon: 'paw', label: '档案' },
  { id: 'growth', icon: 'sparkle', label: '成长' },
  { id: 'map', icon: 'map', label: '云图志' },
  { id: 'journal', icon: 'journal', label: '手账' },
  { id: 'badges', icon: 'medal', label: '勋章' },
  { id: 'bag', icon: 'bag', label: '行囊' },
  { id: 'chat', icon: 'chat', label: '撸猫' },
  { id: 'chronicle', icon: 'journal', label: '编年史' },
];

/** 流浪形态副标题（#056b）：有愿望 → 方向感；今日有新明信片 → 引导；否则云海漫游 */
export function wanderingCaption(wishLocationName: string | null, hasUnreadTravel: boolean): string {
  if (hasUnreadTravel) return '它从旅途寄回了新的明信片，点这里看看它去了哪';
  if (wishLocationName) return `它记着你的愿望，正往「${wishLocationName}」的方向流浪`;
  return '它在云海深处流浪，想它就去云图志找找它的足迹';
}

/** 主舞台：全屏场景 + HUD + 浮层面板，所有交互不离开本页 */
export function GameStage({ user, cat, patStatus, travels, badges, mapLocs, mapManifest, worldDigest, proposals, contribution, chronicle, devMode, refresh, onLogout, wishFlow }: Props) {
  const [panel, setPanel] = useState<PanelId>(null);
  // 首页气泡文案跟随进聊天窗（backlog #064）：只有从气泡点进去才带，从底部导航进不带
  const [chatEntryMessage, setChatEntryMessage] = useState<string | null>(null);
  // 今日云图志卡片 → 云图志直接定位该地点（backlog #065）；其他入口打开默认世界地图
  const [mapFocusLocationId, setMapFocusLocationId] = useState<string | null>(null);
  // #089：云图志定位的来源提示（顶部 headExtra 显示「为什么帮我定位到了这里」）。
  // 与 mapFocusLocationId 成对设置/清空，故收敛成一个 setter，避免两处状态漂移。
  const [mapFocusHint, setMapFocusHint] = useState<string | null>(null);
  // #116：云图志选中区域只是面板内的瞬时浏览态，不进 API/持久化。
  const [mapSceneRegionId, setMapSceneRegionId] = useState<string | null>(null);
  const [lastSeenTravelId, setLastSeenTravelId] = useState<string | null>(
    () => localStorage.getItem(`journal-seen:${cat.id}`)
  );
  const [lastSeenItemAt, setLastSeenItemAt] = useState<string | null>(
    () => localStorage.getItem(`bag-seen:${cat.id}`)
  );
  const [startingAdventure, setStartingAdventure] = useState(false);
  const [adventureError, setAdventureError] = useState('');
  const [availabilityClock, setAvailabilityClock] = useState(() => Date.now());
  const availabilityRefreshRef = useRef<string | null>(null);
  const [homeCleaning, setHomeCleaning] = useState(INITIAL_HOME_CLEANING_STATE);

  // backlog #120 BEGIN local home cleaning
  useEffect(() => {
    if (homeCleaning.phase === 'idle') return undefined;
    const event = homeCleaning.phase === 'cleaning' ? 'finish-cleaning' : 'reset';
    const delay = homeCleaning.phase === 'cleaning'
      ? HOME_CLEANING_TIMING.cleaningMs
      : HOME_CLEANING_TIMING.freshMs;
    const expectedRunId = homeCleaning.runId;
    const timer = window.setTimeout(() => {
      setHomeCleaning((current) => advanceHomeCleaning(current, event, expectedRunId));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [homeCleaning.phase, homeCleaning.runId]);

  const startHomeCleaning = () => {
    const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    setHomeCleaning((current) => beginHomeCleaning(current, prefersReducedMotion));
  };
  // backlog #120 END local home cleaning

  useEffect(() => {
    if (panel !== 'mail') return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(timer);
  }, [panel, refresh]);

  // #126：两个可见消费点共用同一时钟。到权威 deadline 只触发一次 refresh，
  // 等服务端返回新业务日状态；前端不自行把旧 digest 改写为 available。
  useEffect(() => {
    const nextAvailableAt = worldDigest?.next_available_at;
    if (!nextAvailableAt || worldDigest?.travel_status === 'available') {
      availabilityRefreshRef.current = null;
      return;
    }
    const tick = () => {
      const now = Date.now();
      setAvailabilityClock(now);
      const decision = decideTravelAvailabilityRefresh({
        nowMs: now,
        nextAvailableAt,
        refreshedDeadline: availabilityRefreshRef.current,
      });
      availabilityRefreshRef.current = decision.refreshedDeadline;
      if (decision.shouldRefresh) void refresh();
    };
    tick();
    const timer = window.setInterval(tick, 30_000);
    return () => window.clearInterval(timer);
  }, [worldDigest?.next_available_at, worldDigest?.travel_status, refresh]);

  // #071b：cat.travel_wish_location_id 是权威愿望态，对账入口从 MapPanel 上提到这里——
  // store 常驻 App 层，本层只要有猫就存活，于是云图志关着也照样把 refresh 后的服务端真相送进 store
  // （旧实现只在面板挂载期间才有对账机会）。busy 中的对账仍由 store 缓冲，语义不变。
  useEffect(() => {
    wishFlow.syncAuthoritative(cat.travel_wish_location_id ?? null);
  }, [wishFlow, cat.travel_wish_location_id]);

  const latestTravel = travels[0];
  const presencePhase = cat.adventure_presence?.phase ?? 'idle';
  // #088：「猫此刻在哪」的单一真相源。名牌副行/头像 tooltip/状态圆点 aria-label、圆点颜色、
  // 默认气泡、今日云图志状态行**全部**从这里派生，不再各写一条三元链（那正是流浪时四处
  // 都说「在家」的成因）。
  const presence = derivePresence({
    wandering_mode: cat.wandering_mode,
    status: cat.status,
    lifecycle_stage: cat.lifecycle_stage,
    presencePhase,
    can_start_adventure: cat.can_start_adventure,
  });
  // #056：许愿地点名（流浪文案用；许愿态本身走 wishFlow store）
  const wishLocationName = cat.travel_wish_location_id
    ? mapLocs.find((l) => l.id === cat.travel_wish_location_id)?.name ?? null
    : null;
  const earnedBadges = badges.filter((b) => b.earned).length;
  const visited = mapLocs.filter((l) => l.checkin).length;
  const creditsAlert = cat.image_generation_alert || cat.qca_health?.alert;
  const patNeedsAttention = patStatus.status === 'invalid' || patStatus.status === 'none';
  const unreadTravels = useMemo(
    () => computeUnreadTravelCount(travels, lastSeenTravelId),
    [travels, lastSeenTravelId]
  );
  const unreadItems = useMemo(
    () => (cat.items || []).filter((item) => !lastSeenItemAt || (item.acquired_at || '') > lastSeenItemAt).length,
    [cat.items, lastSeenItemAt]
  );

  // #089：两个「打开云图志」入口的 focus 目标。推导是纯函数，这里只做取数与接线。
  // 复用 #065 建立的 initialLocationId 机制，不新造第二套定位通道。
  const knownLocationIds = useMemo(() => mapLocs.map((l) => l.id), [mapLocs]);
  // #089 / ISSUES #85：`hasUnreadTravel` 与下方 `wanderingCaption` 的第二个实参**必须是同一个
  // 表达式**——副标题与点击落点同源，否则会出现「说的是旅行、开的是愿望」。
  const hasUnreadTravel = Boolean(latestTravel && unreadTravels > 0);
  const wanderingFocus = useMemo(() => deriveAtlasFocus({
    entry: 'wandering-card',
    wishLocationId: cat.travel_wish_location_id,
    hasUnreadTravel,
    latestTravelLocationId: latestTravel?.location_id ?? null,
    knownLocationIds,
  }), [cat.travel_wish_location_id, hasUnreadTravel, latestTravel?.location_id, knownLocationIds]);
  const adventureFocus = useMemo(() => deriveAtlasFocus({
    entry: 'adventure-card',
    hasTravelToday: Boolean(worldDigest?.has_travel_today),
    latestTravelLocationId: latestTravel?.location_id ?? null,
    currentDestinationLocationId: cat.adventure_presence?.destination?.location_id ?? null,
    knownLocationIds,
  }), [worldDigest?.has_travel_today, latestTravel?.location_id, cat.adventure_presence?.destination?.location_id, knownLocationIds]);
  const setMapFocus = (focus: AtlasFocus) => {
    setMapFocusLocationId(focus.kind === 'none' ? null : focus.locationId);
    setMapFocusHint(atlasFocusHint(focus));
  };
  const stageScene = useMemo(() => deriveStageScene({
    presence,
    mapOpen: panel === 'map',
    mapRegionId: mapSceneRegionId,
    destinationLocationId: cat.adventure_presence?.destination?.location_id ?? null,
    locations: mapLocs,
  }), [cat.adventure_presence?.destination?.location_id, mapLocs, mapSceneRegionId, panel, presence]);

  const personalizedLines = useMemo(() => {
    if (!latestTravel) return [];
    const lines = [
      ...(latestTravel.home_messages || []),
      latestTravel.postcard_question,
      latestTravel.memory_reference
        ? `我还记得你告诉我的「${latestTravel.memory_reference.replace(/[。！？].*$/u, '').slice(0, 42)}」。`
        : null,
      ...(latestTravel.postcard_content || '')
        .split(/(?<=[。！？])/u)
        .map((line) => line.trim())
        .filter((line) => line.length >= 6 && line.length <= 64)
        .slice(0, 1),
    ];
    return [...new Set(lines.filter((line): line is string => Boolean(line?.trim())).map((line) => line.trim()))].slice(0, 4);
  }, [latestTravel]);

  // 最新明信片提示语：作为猫的默认气泡
  // #088：这条气泡是**放大器**——点气泡进聊天时它被 setChatEntryMessage 送进聊天窗作为猫的
  // 开场白，是前端硬编码、不过 LLM，所以「我先在家歇着」这类文案只能在前端修，改 prompt 修不到。
  const defaultBubble = useMemo(() => {
    if (presence === 'adventure_running') return '我已经出发啦，等我寄明信片回来！';
    if (presence === 'adventure_failed') return '今天的探险不太顺利，我先在家歇会儿。';
    if (presence === 'wandering') {
      return wishLocationName
        ? `我正在外面流浪，往「${wishLocationName}」的方向走着呢。`
        : '我正在外面流浪，云海很大，我慢慢走。';
    }
    if (presence === 'recalled' || presence === 'broken') return '我先在家歇着，想我就来撸我。';
    if (presence === 'home_ready') return '准备好时，就让我去第一次探险吧！';
    if (presence === 'adventure_starting') return '我正在整理第一次探险的行囊！';
    if (!latestTravel) return '定时探险已开启，等我的第一张明信片！';
    if (unreadTravels > 0) return `我刚从「${latestTravel.location_name}」回来，明信片写好了！`;
    return personalizedLines[0] || `我正在慢慢长成更懂你的${cat.name}。`;
  }, [presence, cat.name, wishLocationName, latestTravel, unreadTravels, personalizedLines]);

  useEffect(() => {
    setLastSeenTravelId(localStorage.getItem(`journal-seen:${cat.id}`));
    setLastSeenItemAt(localStorage.getItem(`bag-seen:${cat.id}`));
  }, [cat.id]);

  useEffect(() => {
    if (!cat.travel_schedule_enabled && cat.appearance_status !== 'generating') return;
    const intervalMs = presencePhase === 'running' ? 15_000 : 60_000;
    const timer = setInterval(refresh, intervalMs);
    return () => clearInterval(timer);
  }, [cat.travel_schedule_enabled, cat.appearance_status, presencePhase, refresh]);

  const openJournal = () => {
    const latestId = travels[0]?.id;
    if (latestId) {
      localStorage.setItem(`journal-seen:${cat.id}`, latestId);
      setLastSeenTravelId(latestId);
    }
    setPanel('journal');
  };

  const openBag = () => {
    const latestAcquiredAt = (cat.items || [])
      .map((item) => item.acquired_at || '')
      .sort()
      .at(-1);
    if (latestAcquiredAt) {
      localStorage.setItem(`bag-seen:${cat.id}`, latestAcquiredAt);
      setLastSeenItemAt(latestAcquiredAt);
    }
    setPanel('bag');
  };

  const beginAdventure = async () => {
    setAdventureError('');
    setStartingAdventure(true);
    try {
      await api.startAdventure();
      await refresh();
    } catch (error) {
      setAdventureError(error instanceof Error ? error.message : '探险启动失败');
      await refresh();
    } finally {
      setStartingAdventure(false);
    }
  };

  const statusDot = presenceDotColor(presence);
  const statusText = presenceStatusText(presence);

  return (
    <Sky variant="home" scene={stageScene}>
      <div
        className={`home-cleaning-fx home-cleaning-fx--${homeCleaning.phase}`}
        data-home-cleaning-phase={homeCleaning.phase}
        aria-hidden="true"
      >
        <span className="home-cleaning-fx__sweep" />
        <span className="home-cleaning-fx__spark home-cleaning-fx__spark--one">✦</span>
        <span className="home-cleaning-fx__spark home-cleaning-fx__spark--two">✦</span>
        <span className="home-cleaning-fx__spark home-cleaning-fx__spark--three">✦</span>
      </div>
      {/* ---------- 顶部 HUD ---------- */}
      <div className="hud-top">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
          <button
            type="button"
            className="hud-nameplate"
            onClick={() => setPanel('profile')}
            title="查看猫咪档案"
            style={{ cursor: 'pointer' }}
          >
            <div className="hud-avatar" title={statusText}>
              <div className="hud-avatar__clip">
              {cat.current_image_url ? (
                <CatImage src={cat.current_image_url} alt="" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              ) : (
                <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="paw" size={26} color="var(--sky-deep)" strokeWidth={1.8} />
                </div>
              )}
              </div>
              <span className="hud-status-dot" style={{ background: statusDot }} aria-label={statusText} />
            </div>
            <div className="hud-nameplate__copy">
              <div className="hud-nameplate__name">{cat.name}</div>
              <div className="hud-nameplate__meta">{statusText}</div>
            </div>
          </button>

          {/* 天性面板 */}
          <div
            className="gs-panel"
            style={{ padding: '12px 16px', borderRadius: 16, width: 190, boxShadow: '0 8px 20px rgba(61,64,91,0.14)' }}
          >
            {ATTR_KEYS.map((k) => (
              <div
                key={k}
                className="attr-row"
                style={{ marginBottom: 7 }}
                title={`${ATTR_META[k].desc}｜${attrLevelLabel(cat.attrs[k])}（${cat.attrs[k]}/10）。${ATTR_GROWTH_HINT}`}
              >
                <Icon name={ATTR_META[k].icon} size={16} color="var(--warm-deep)" strokeWidth={2.2} />
                <span style={{ fontSize: '0.72rem', width: 28, fontWeight: 700 }}>{ATTR_META[k].label}</span>
                <div className="attr-track" style={{ height: 9 }}>
                  <div className="attr-fill" style={{ width: `${cat.attrs[k] * 10}%` }} />
                </div>
                <strong style={{ fontSize: '0.74rem', width: 34, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {cat.attrs[k]}<span style={{ fontWeight: 400, color: 'var(--ink-soft)', fontSize: '0.64rem' }}>/10</span>
                </strong>
              </div>
            ))}
            <p style={{ margin: '2px 0 0', fontSize: '0.62rem', color: 'var(--ink-soft)' }}>{ATTR_GROWTH_HINT}</p>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.68rem', color: 'var(--ink-soft)', marginTop: 8 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                <Icon name="pin" size={12} strokeWidth={2.2} /> {visited} 地
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                <Icon name="medal" size={12} strokeWidth={2.2} /> {earnedBadges} 章
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                <Icon name="journal" size={12} strokeWidth={2.2} /> {travels.length} 记
              </span>
            </div>
          </div>
        </div>

        <div className="hud-daily">
          <button type="button" className="gs-iconbtn" onClick={() => setPanel('settings')} aria-label="设置">
            <Icon name="gear" size={22} strokeWidth={2} />
          </button>
          {worldDigest && (
            <section className="gs-panel daily-brief" aria-label="今日云图志">
              <div className="daily-brief__head">
                <span>今日云图志</span>
                <span>{worldDigest.date.slice(5)}</span>
              </div>
              <div className="daily-brief__status">
                {worldDigest.travel_status === 'available'
                  ? dailyBriefStatusText(presence, worldDigest.has_travel_today)
                  : travelAvailabilityText({ status: worldDigest.travel_status, next_available_at: worldDigest.next_available_at }, availabilityClock)}
              </div>
              <div className="daily-event-list">
                {worldDigest.events.map((event) => (
                  <button
                    key={event.id}
                    type="button"
                    onClick={() => { setMapFocusLocationId(event.location_id); setPanel('map'); }}
                    title={event.description}
                  >
                    <Icon name="pin" size={12} color="var(--warm-deep)" strokeWidth={2.2} />
                    <span>{event.location_name}</span>
                    <strong>{event.name}</strong>
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>

      {/* ---------- 中央：猫 ---------- */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          paddingBottom: 60,
          zIndex: 10,
        }}
      >
        {patNeedsAttention && (
          <div
            role="alert"
            style={{
              maxWidth: 440,
              marginBottom: 12,
              padding: '10px 16px',
              borderRadius: 14,
              border: '2px solid rgba(224,123,57,0.35)',
              background: 'rgba(255, 253, 244, 0.97)',
              fontSize: '0.82rem',
              lineHeight: 1.6,
              textAlign: 'center',
            }}
          >
            <div>{patStatus.status === 'invalid' ? '云端契约已失效，小猫暂时无法继续使用云端能力。' : '小猫还没有绑定云端契约。'}</div>
            <button
              type="button"
              className="gs-btn gs-btn--ghost gs-btn--small"
              style={{ marginTop: 7 }}
              onClick={() => setPanel('settings')}
            >
              打开设置
            </button>
          </div>
        )}
        {creditsAlert && (
          <QcaCreditsRecoveryCard alert={creditsAlert} compact onRecovered={refresh} />
        )}
        {/* 气泡 */}
        <div style={{ minHeight: 56, display: 'flex', alignItems: 'flex-end', marginBottom: 6 }}>
          <button
            type="button"
            className="home-speech-button"
            key={defaultBubble}
            onClick={() => { setChatEntryMessage(defaultBubble); setPanel('chat'); }}
            aria-label={chatEntryLabel(presence, cat.name)}
            style={{
              background: 'rgba(255,253,244,0.95)',
              border: '2px solid var(--paper-edge)',
              borderRadius: 18,
              borderBottomLeftRadius: 4,
              padding: '9px 18px',
              fontSize: '0.88rem',
              maxWidth: 320,
              boxShadow: '0 6px 16px rgba(61,64,91,0.15)',
              animation: 'pop-in 0.25s cubic-bezier(0.34, 1.4, 0.64, 1)',
            }}
          >
            {defaultBubble}
          </button>
        </div>

        {presence === 'adventure_running' ? (
          <button
            type="button"
            className="home-away-card"
            onClick={() => { setMapFocus(adventureFocus); setPanel('map'); }}
          >
            <Icon name="compass" size={30} color="var(--warm-deep)" strokeWidth={2} />
            <strong>{cat.name} 正在云海里探险</strong>
            <span>{adventureCardCaption(adventureFocus)}</span>
          </button>
        ) : presence === 'wandering' ? (
          /* #056b 流浪形态：纯视觉状态——猫"不在家"，文案按愿望/今日旅行分档；点击进云图志 */
          <button
            type="button"
            className="home-away-card"
            onClick={() => { setMapFocus(wanderingFocus); setPanel('map'); }}
          >
            <Icon name="paw" size={30} color="var(--warm-deep)" strokeWidth={2} />
            <strong>{cat.name} 正在外面流浪</strong>
            <span>{wanderingCaption(wishLocationName, hasUnreadTravel)}</span>
          </button>
        ) : <button
          type="button"
          onClick={() => setPanel('chat')}
          className="home-cat-button"
          aria-label={chatEntryLabel(presence, cat.name)}
        >
          <CatAvatar immersive imageUrl={cat.current_image_url} status={cat.appearance_status} name={cat.name} size={Math.min(300, window.innerWidth * 0.55)} />
        </button>}

        <div className="cat-ground-mist" aria-hidden />

        {latestTravel && unreadTravels > 0 && (
          <button
            type="button"
            className="latest-result"
            onClick={openJournal}
          >
            <span className="latest-result__icon">
              <Icon name="mail" size={20} color="var(--warm-deep)" strokeWidth={2.2} />
            </span>
            <span className="latest-result__copy">
              <small>
                最新明信片 · {latestTravel.location_name}
                {latestTravel.event_name ? ` · ${latestTravel.event_name}` : ''}
              </small>
              <strong>{latestTravel.postcard_title || '旅行归来'}</strong>
              <span>{latestTravel.postcard_content || latestTravel.narrative}</span>
              {latestTravel.dropped_item && <em>带回了「{latestTravel.dropped_item.name}」</em>}
            </span>
            <Icon name="arrowRight" size={18} color="var(--ink-soft)" strokeWidth={2} />
          </button>
        )}
        {cat.can_start_adventure && (
          <button type="button" className="gs-btn gs-btn--big" style={{ marginTop: 12 }} onClick={beginAdventure} disabled={startingAdventure}>
            <Icon name="compass" size={18} strokeWidth={2.2} />
            {startingAdventure ? '正在准备探险…' : '让小猫去探险'}
          </button>
        )}
        {adventureError && <p style={{ color: 'var(--danger)', fontSize: '0.8rem', marginTop: 8 }}>{adventureError}</p>}
      </div>

      <div className="home-cleaning-control" data-testid="home-cleaning-control">
        <button
          type="button"
          className="home-cleaning-button"
          data-testid="home-cleaning-button"
          onClick={startHomeCleaning}
          disabled={homeCleaning.phase === 'cleaning'}
          aria-label="打扫猫舍"
        >
          <Icon name="sparkle" size={18} strokeWidth={2.2} />
          <span>{homeCleaningButtonLabel(homeCleaning.phase)}</span>
        </button>
        {homeCleaning.phase !== 'idle' && (
          <p
            className="home-cleaning-feedback"
            data-testid="home-cleaning-feedback"
            data-phase={homeCleaning.phase}
            role="status"
          >
            {homeCleaningFeedback(homeCleaning.phase)}
          </p>
        )}
      </div>

      <button type="button" className="creator-feedback-entry" onClick={() => setPanel('mail')} aria-label="告诉皮卡你的建议或问题">
        <img src="/assets/game/creator/pika-portrait.png" alt="" />
        <span>
          <strong>告诉皮卡</strong>
          <small>一起创造这个世界</small>
        </span>
        <em>采纳有奖励</em>
      </button>

      {/* ---------- 底部功能坞 ---------- */}
      <nav className="dock" aria-label="主要功能">
        {DOCK_ITEMS.map((d) => (
          <button
            key={d.id}
            type="button"
            className={`dock-btn ${panel === d.id ? 'active' : ''}`}
            aria-pressed={panel === d.id}
            onClick={() => {
              if (panel === d.id) return setPanel(null);
              if (d.id === 'journal') return openJournal();
              if (d.id === 'bag') return openBag();
              setPanel(d.id);
            }}
          >
            <span className="dock-icon">
              {DOCK_ART[d.id] ? (
                <img className="dock-art" src={DOCK_ART[d.id]} alt="" draggable={false} />
              ) : (
                <Icon name={d.icon} size={26} strokeWidth={1.9} color={panel === d.id ? 'var(--warm-deep)' : 'var(--ink)'} />
              )}
            </span>
            <span className="dock-label">{d.label}</span>
            {d.id === 'journal' && unreadTravels > 0 && <span className="dock-badge">{Math.min(unreadTravels, 99)}</span>}
            {d.id === 'bag' && unreadItems > 0 && <span className="dock-badge">{Math.min(unreadItems, 99)}</span>}
          </button>
        ))}
      </nav>

      {/* ---------- 浮层面板 ---------- */}
      {panel === 'profile' && (
        <ProfilePanel cat={cat} onChanged={refresh} onClose={() => setPanel(null)} onOpenSettings={() => setPanel('settings')} />
      )}
      {panel === 'growth' && <GrowthPanel onClose={() => setPanel(null)} />}
      {panel === 'map' && (
        <MapPanel
          locations={mapLocs}
          manifest={mapManifest}
          initialLocationId={mapFocusLocationId}
          focusHint={mapFocusHint}
          onSceneChange={setMapSceneRegionId}
          wishFlow={wishFlow}
          travelAvailability={worldDigest ? { status: worldDigest.travel_status, next_available_at: worldDigest.next_available_at } : null}
          availabilityNowMs={availabilityClock}
          onClose={() => { setMapFocusLocationId(null); setMapFocusHint(null); setPanel(null); }}
        />
      )}
      {panel === 'journal' && (
        <JournalPanel travels={travels} catName={cat.name} lifecycleStage={cat.lifecycle_stage} presence={presence} onClose={() => setPanel(null)} />
      )}
      {panel === 'badges' && <BadgesPanel badges={badges} onClose={() => setPanel(null)} />}
      {panel === 'bag' && <BagPanel cat={cat} onClose={() => setPanel(null)} />}
      {panel === 'chat' && (
        <ChatPanel
          cat={cat}
          entryMessage={chatEntryMessage}
          onClose={() => { setChatEntryMessage(null); setPanel(null); }}
        />
      )}
      {panel === 'chronicle' && <ChroniclePanel entries={chronicle} onClose={() => setPanel(null)} />}
      {panel === 'mail' && (
        <MailPanel
          proposals={proposals}
          contribution={contribution}
          cat={cat}
          panel={panel}
          lastUiError={adventureError || creditsAlert?.message}
          onSubmitted={refresh}
          onClose={() => setPanel(null)}
        />
      )}
      {panel === 'settings' && (
        <SettingsPanel
          cat={cat}
          patStatus={patStatus}
          userName={user.display_name}
          devMode={devMode}
          onChanged={refresh}
          onLogout={onLogout}
          onClose={() => {
            setPanel(null);
            void refresh();
          }}
        />
      )}
    </Sky>
  );
}
