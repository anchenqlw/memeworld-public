import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  ApiError,
  apiUrl,
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
} from './api/client';
import { loadBootstrap } from './api/bootstrap';
import { Sky } from './components/ui/Sky';
import { EnvBadge } from './components/ui/EnvBadge';
import { TitleScreen } from './components/TitleScreen';
import { Onboarding } from './components/Onboarding';
import { GameStage } from './components/GameStage';
import { createWishFlow, type WishFlow } from './components/panels/wishFlow';

/**
 * 单页游戏入口，按玩家进度切换三个场景（无 Tab、无路由跳转）：
 *   标题屏（未登录） → 新手引导（无猫：契约 + 捏猫 + 召唤） → 主舞台（有猫）
 */
export default function App() {
  const [booted, setBooted] = useState(false);
  const [user, setUser] = useState<{ display_name: string } | null>(null);
  const [patOk, setPatOk] = useState(false);
  const [patStatus, setPatStatus] = useState<PatStatus>({ status: 'none', pat_hint: null, last_verified_at: null });
  const [cat, setCat] = useState<CatProfile | null>(null);
  const [travels, setTravels] = useState<Travel[]>([]);
  const [badges, setBadges] = useState<Badge[]>([]);
  const [mapLocs, setMapLocs] = useState<MapLocation[]>([]);
  const [mapManifest, setMapManifest] = useState<MapManifest | null>(null);
  const [worldDigest, setWorldDigest] = useState<WorldDigest | null>(null);
  const [chronicle, setChronicle] = useState<ChronicleEntry[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [contribution, setContribution] = useState<ContributionSummary>({ points: 0, accepted: 0, shipped: 0, pending_rewards: 0 });
  const [devMode, setDevMode] = useState(false);
  const [appEnv, setAppEnv] = useState<string | null>(import.meta.env.VITE_APP_ENV || null);
  const [authMode, setAuthMode] = useState<'mock' | 'oauth'>('oauth');
  const [loadNotice, setLoadNotice] = useState<string | null>(null);
  // OAuth 回调失败：服务端 302 回 /?auth_error=<code>（backlog #055）。读一次即从地址栏清除，避免刷新后残留。
  const [authError, setAuthError] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('auth_error');
    if (code) {
      params.delete('auth_error');
      const rest = params.toString();
      window.history.replaceState(null, '', `${window.location.pathname}${rest ? `?${rest}` : ''}`);
    }
    return code;
  });

  // #071b：许愿状态 store 上提到 App 层常驻单例（backlog #071b / evolution/reviews/pr-61-b82a2ab.md）。
  // 原来 store 挂在 MapPanel 的 useRef 上，关闭云图志即销毁、重开即新建——busy 锁随之消失，
  // 「旧请求真正 settle 前不许发起新请求」的不变量在跨实例场景失效，可留下「服务端愿望 A、UI 显示 B」
  // 的确定失配终态。上提到这里后同一逻辑实例在整个会话内常驻，写入串行化由 store 的 busy 锁自动强制。
  // 初值给 undefined（宿主未接入许愿）——真正的权威值由 GameStage 的 syncAuthoritative 下发。
  const wishFlowRef = useRef<WishFlow | null>(null);
  const refreshRef = useRef<() => unknown>(() => undefined);

  const refresh = useCallback(async () => {
    try {
      const result = await loadBootstrap();
      setUser(result.me);
      const warnings: string[] = [];
      if (result.pat.status === 'fulfilled') {
        setPatStatus(result.pat.value);
        setPatOk(result.pat.value.status === 'valid');
      } else {
        warnings.push('契约状态暂时无法刷新');
      }
      setCat(result.cat);
      if (!result.cat) setWorldDigest(null);
      if (result.extras) {
        const { extras } = result;
        if (extras.travels.status === 'fulfilled') setTravels(extras.travels.value.travels); else warnings.push('手账');
        if (extras.badges.status === 'fulfilled') setBadges(extras.badges.value.badges); else warnings.push('勋章');
        if (extras.map.status === 'fulfilled') {
          setMapLocs(extras.map.value.locations);
          setMapManifest(extras.map.value.manifest);
        } else warnings.push('云图志');
        if (extras.digest.status === 'fulfilled') setWorldDigest(extras.digest.value); else warnings.push('今日世界');
        if (extras.proposals.status === 'fulfilled') {
          setProposals(extras.proposals.value.proposals);
          setContribution(extras.proposals.value.contribution);
        } else warnings.push('反馈记录');
        if (extras.chronicle.status === 'fulfilled') setChronicle(extras.chronicle.value.entries); else warnings.push('世界编年史');
      }
      setLoadNotice(warnings.length ? `${warnings.join('、')}暂时没刷新，已保留其他内容。` : null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        // 会话结束（掉线）：连同许愿 store 的 pending 请求一起中止——dispose 的时机只在会话边界（#071b）
        wishFlowRef.current?.dispose();
        setUser(null);
        setCat(null);
        setLoadNotice(null);
      } else {
        setLoadNotice(error instanceof Error ? `${error.message}，请稍后重试。` : '云上猫舍暂时连接不上，请稍后重试。');
      }
    } finally {
      setBooted(true);
    }
  }, []);

  // onChanged → refresh：许愿落库后拉一次权威态（refresh 身份稳定，仍走 ref 以免 store 抓到旧闭包）
  refreshRef.current = refresh;
  if (!wishFlowRef.current) {
    wishFlowRef.current = createWishFlow(
      undefined,
      { set: (id, opts) => api.setTravelWish(id, opts), clear: (opts) => api.clearTravelWish(opts) },
      () => { void refreshRef.current(); },
    );
  }
  const wishFlow = wishFlowRef.current;

  useEffect(() => {
    refresh();
    fetch(apiUrl('/healthz'))
      .then((r) => r.json())
      .then((h) => {
        setDevMode(!!h.qca_mock || h.env === 'staging');
        setAuthMode(h.auth_mode === 'mock' ? 'mock' : 'oauth');
        if (typeof h.env === 'string') setAppEnv(h.env);
      })
      .catch(() => {});
  }, [refresh]);

  // 旅行后形象生成中 → 轮询等新图
  // #077：重画申诉排队/绘制中（appearance_repaint.image_job_active）也轮询——
  // 否则刚点下重画的用户要手动刷新才看到画好的候选图。job 结束后该标记转 false，轮询自然停止。
  useEffect(() => {
    const repaintPending = Boolean(cat?.appearance_repaint?.image_job_active);
    if (cat?.appearance_status !== 'generating' && !repaintPending) return;
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [cat?.appearance_status, cat?.appearance_repaint?.image_job_active, refresh]);

  const login = (provider: 'google' | 'github', fresh = false) => {
    setAuthError(null);
    const path = authMode === 'mock' ? '/api/v1/auth/login' : `/api/v1/auth/${provider}/login`;
    window.location.href = `${apiUrl(path)}?next=/${fresh ? '&fresh=1' : ''}`;
  };

  const logout = async () => {
    // #071b：用户会话结束才是 dispose 的时机——中止残留的许愿请求，避免它在下一段会话里落地。
    // 不清空 store 的 wishId：重新登录会整页跳转（login 走 window.location），
    // 同一实例若被复用，GameStage 的 syncAuthoritative 会用新会话的权威值覆盖。
    wishFlow.dispose();
    await api.logout();
    setUser(null);
    setCat(null);
  };

  if (!booted) {
    return (
      <>
        {appEnv && <EnvBadge env={appEnv} />}
        <Sky>
          <div className="app-loading" role="status" aria-live="polite">
            <div className="gs-spinner" aria-hidden="true" />
            <strong>正在唤醒你的云上猫舍…</strong>
            <span>小猫正在整理今天的见闻，请稍候</span>
          </div>
        </Sky>
      </>
    );
  }

  if (!user)
    if (loadNotice) {
      return (
        <Sky>
          <div className="app-loading" role="alert">
            <strong>猫舍暂时连接不上</strong>
            <span>{loadNotice}</span>
            <button className="gs-btn" onClick={() => void refresh()}>重新连接</button>
          </div>
        </Sky>
      );
    }

  if (!user)
    return (
      <>
        {appEnv && <EnvBadge env={appEnv} />}
        <TitleScreen
          onGoogleLogin={() => login('google')}
          onGitHubLogin={() => login('github')}
          onStartFresh={() => login('google', true)}
          devMode={devMode}
          authError={authError}
        />
      </>
    );

  if (!cat || cat.lifecycle_stage === 'appearance') {
    return (
      <>
        {appEnv && <EnvBadge env={appEnv} />}
        <Onboarding patOk={patOk} existingCat={cat} onDone={refresh} />
      </>
    );
  }

  return (
    <>
      {appEnv && <EnvBadge env={appEnv} />}
      {loadNotice && (
        <div role="status" style={{ position: 'fixed', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 1000, maxWidth: 'calc(100vw - 32px)', padding: '8px 12px', borderRadius: 16, background: 'rgba(255,250,235,.96)', color: 'var(--ink)', boxShadow: '0 4px 18px rgba(80,60,30,.18)', fontSize: '.82rem' }}>
          {loadNotice} <button type="button" onClick={() => void refresh()} style={{ border: 0, background: 'transparent', color: 'var(--warm-deep)', fontWeight: 700, cursor: 'pointer' }}>重试</button>
        </div>
      )}
      <GameStage
      user={user}
      cat={cat}
      patStatus={patStatus}
      travels={travels}
      badges={badges}
      mapLocs={mapLocs}
      mapManifest={mapManifest}
      worldDigest={worldDigest}
      proposals={proposals}
      contribution={contribution}
      chronicle={chronicle}
      devMode={devMode}
      refresh={refresh}
      onLogout={logout}
      wishFlow={wishFlow}
    />
    </>
  );
}
