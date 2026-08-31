import { consumeSseStream } from './sse';

export const API_ORIGIN = (import.meta.env.VITE_API_ORIGIN || '').replace(/\/+$/, '');
export const apiUrl = (path: string) => `${API_ORIGIN}${path}`;
const API = apiUrl('/api/v1');

export class ApiError extends Error {
  code?: string;
  status: number;
  help_url?: string;
  next_available_at?: string;

  constructor(message: string, status: number, code?: string, helpUrl?: string, nextAvailableAt?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.help_url = helpUrl;
    this.next_available_at = nextAvailableAt;
  }
}

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers = new Headers(opts.headers);
  if (opts.body != null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(`${API}${path}`, {
    credentials: 'include',
    ...opts,
    headers,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: { message: res.statusText } }));
    throw new ApiError(err.error?.message || '请求失败', res.status, err.error?.code, err.error?.help_url, err.error?.next_available_at);
  }
  return res.json();
}

export const api = {
  me: () =>
    request<{ display_name: string; provider: 'mock' | 'google' | 'github'; email: string | null; avatar_url: string | null }>(
      '/auth/me'
    ),
  logout: () => request('/auth/logout', { method: 'POST' }),
  patStatus: () => request<PatStatus>('/pat/status'),
  savePat: (pat: string) => request<SavePatResult>('/pat', { method: 'PUT', body: JSON.stringify({ pat }) }),
  confirmPatReplacement: (replacementId: string) =>
    request<ConfirmPatReplacementResult>(`/pat/replacements/${replacementId}/confirm`, {
      method: 'POST',
      body: '{}',
    }),
  cancelPatReplacement: (replacementId: string) =>
    request<{ ok: true }>(`/pat/replacements/${replacementId}`, { method: 'DELETE' }),
  catArchives: () => request<{ archives: CatArchive[] }>('/cat-archives'),
  catArchive: (archiveId: string) => request<CatArchive>(`/cat-archives/${archiveId}`),
  qcaModels: () => request<{ models: QcaModelOption[] }>('/qca/models'),
  recheckQcaCredits: () => request<QcaCreditsRecoveryResult>('/qca/credits/recheck', { method: 'POST', body: '{}' }),
  getCat: () => request<CatProfile>('/cats/me'),
  createCat: (body: CreateCatBody) => request<CatProfile>('/cats', { method: 'POST', body: JSON.stringify(body) }),
  regenerateAppearance: (model?: string, customDescription?: string) =>
    request<{ ok: boolean; appearance_id: string; status: string }>('/cats/me/appearance/regenerate', {
      method: 'POST', body: JSON.stringify({ model, custom_description: customDescription }),
    }),
  cancelAppearance: () => request<{ ok: true; canceled: boolean; session_canceled: boolean }>('/cats/me/appearance/cancel', {
    method: 'POST', body: '{}',
  }),
  updateDraftAppearance: (appearance: Appearance) => request<CatProfile>('/cats/me/appearance', {
    method: 'PATCH', body: JSON.stringify({ appearance }),
  }),
  confirmAppearance: (appearanceId: string) =>
    request<CatProfile>('/cats/me/appearance/confirm', {
      method: 'POST', body: JSON.stringify({ appearance_id: appearanceId }),
    }),
  // #077：形象确认后的「重画申诉」——申请重画 / 确认替换主形象 / 保留原形象
  requestAppearanceRepaint: (customDescription?: string) =>
    request<{ ok: true; appearance_id: string; status: 'pending'; repaint: AppearanceRepaintState }>('/cats/me/appearance/repaint', {
      method: 'POST', body: JSON.stringify({ custom_description: customDescription }),
    }),
  confirmAppearanceRepaint: (appearanceId: string) =>
    request<CatProfile>('/cats/me/appearance/repaint/confirm', {
      method: 'POST', body: JSON.stringify({ appearance_id: appearanceId }),
    }),
  discardAppearanceRepaint: () =>
    request<CatProfile>('/cats/me/appearance/repaint', { method: 'DELETE' }),
  startAdventure: () => request<CatProfile>('/cats/me/adventure/start', { method: 'POST', body: '{}' }),
  repairAdventure: () => request<CatProfile>('/cats/me/adventure/repair', { method: 'POST', body: '{}' }),
  // #071 返工三：接受 AbortSignal——中止 pending 许愿请求，切断「旧请求迟到 resolve 覆盖
  // 后续状态」的客户端竞态（pr-61-506ba73.md）。#071b 后该 abort 只发生在会话结束（logout/401），
  // 关闭云图志不再 abort：旧请求必须真正 settle 才释放 store 的 busy 锁。
  setTravelWish: (locationId: string, opts?: { signal?: AbortSignal }) => request<{ location_id: string; name: string }>('/cats/me/travel-wish', {
    method: 'POST', body: JSON.stringify({ location_id: locationId }), signal: opts?.signal,
  }),
  clearTravelWish: (opts?: { signal?: AbortSignal }) => request<{ ok: boolean }>('/cats/me/travel-wish', { method: 'DELETE', signal: opts?.signal }),
  setWanderingMode: (enabled: boolean) => request<{ wandering_mode: boolean }>('/cats/me/wandering', {
    method: 'PATCH', body: JSON.stringify({ enabled }),
  }),
  onboardingAnswers: () => request<{ answers: OnboardingAnswer[] }>('/cats/me/onboarding-answers'),
  saveOnboardingAnswers: (answers: OnboardingAnswerInput[]) => request<{ answers: OnboardingAnswer[] }>('/cats/me/onboarding-answers', {
    method: 'PUT', body: JSON.stringify({ answers }),
  }),
  patPostcard: (id: string) => request(`/postcards/${id}/pat`, { method: 'POST', body: '{}' }),
  replyPostcard: (id: string, body: { choice_id?: string; content?: string }) => request(`/postcards/${id}/reply`, { method: 'PUT', body: JSON.stringify(body) }),
  cherishPostcard: (id: string) => request(`/postcards/${id}/cherish`, { method: 'PUT', body: '{}' }),
  repairPostcardPhoto: (id: string) => request<{ ok: true; enqueued: number; status: string }>(`/postcards/${id}/photo/repair`, { method: 'POST', body: '{}' }),
  memories: () => request<{ memories: VisibleMemory[] }>('/cats/me/memories'),
  deleteMemory: (questionId: string) => request(`/cats/me/onboarding-answers/${encodeURIComponent(questionId)}`, { method: 'DELETE' }),
  bond: () => request<BondState>('/cats/me/bond'),
  weeklyRecap: () => request<WeeklyRecap>('/cats/me/weekly-recap'),
  returnMessage: () => request<ReturnMessage>('/cats/me/return-message'),
  growthCards: () => request<{ cards: GrowthCard[] }>('/growth-cards'),
  growthTags: () => request<GrowthTagSummary>('/cats/me/growth-tags'),
  createGrowthCard: (body: GrowthCardInput) => request<GrowthCard>('/growth-cards', { method: 'POST', body: JSON.stringify(body) }),
  updateGrowthCard: (id: string, body: Partial<GrowthCardInput>) => request<GrowthCard>(`/growth-cards/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteGrowthCard: (id: string) => request<{ ok: true; memory_revoked: boolean }>(`/growth-cards/${id}`, { method: 'DELETE' }),
  retryGrowthCardSync: (id: string) => request<GrowthCard>(`/growth-cards/${id}/retry-sync`, { method: 'POST', body: '{}' }),
  updateCat: (body: { name?: string; personality?: string }) =>
    request<CatProfile>('/cats/me', { method: 'PATCH', body: JSON.stringify(body) }),
  // #084：建猫后更换模型（设置面板入口）；服务端只重建画师资源
  changeCatModel: (model: string) =>
    request<CatProfile>('/cats/me/model', { method: 'PATCH', body: JSON.stringify({ model }) }),
  recallCat: () => request('/cats/me/recall', { method: 'POST' }),
  releaseCat: () => request('/cats/me/release', { method: 'POST' }),
  travels: (params?: { page?: number; location_id?: string }) => {
    const q = new URLSearchParams();
    if (params?.page) q.set('page', String(params.page));
    if (params?.location_id) q.set('location_id', params.location_id);
    return request<{ travels: Travel[] }>(`/cats/me/travels?${q}`);
  },
  badges: () => request<{ badges: Badge[] }>('/cats/me/badges'),
  outfit: (body: { head?: string | null; neck?: string | null; back?: string | null }) =>
    request<CatProfile>('/cats/me/outfit', { method: 'PATCH', body: JSON.stringify(body) }),
  worldMap: () => request<{ locations: MapLocation[]; manifest: MapManifest }>('/world/map'),
  worldChronicle: () => request<{ entries: ChronicleEntry[] }>('/world/chronicle'),
  worldDigest: () => request<WorldDigest>('/world/digest'),
  simulateTravel: () => request('/internal/dev/simulate-travel', { method: 'POST', body: '{}' }),
  regenerateGrowthPhoto: () => request<{ ok: true; travel_id: string; status: 'pending' }>(
    '/internal/dev/regenerate-growth-photo', { method: 'POST', body: '{}' },
  ),
  proposals: () => request<{ proposals: Proposal[]; contribution: ContributionSummary }>('/proposals/mine'),
  createProposal: (type: 'feature' | 'bug', content: string, clientContext?: unknown) =>
    request('/proposals', { method: 'POST', body: JSON.stringify({ type, content, client_context: clientContext }) }),
  chatHistory: () => request<{ messages: ChatHistoryMessage[] }>('/cats/me/chat/history?limit=100'),
  enqueueChat: (message: string, mode: 'queue' | 'interrupt' = 'queue') => request<{ turn: ChatTurn }>(
    '/cats/me/chat',
    { method: 'POST', body: JSON.stringify({ message, mode, async: true }) },
  ),
  chatTurn: (id: string) => request<ChatTurn>(`/cats/me/chat/turns/${id}`),
  chat: async (
    message: string,
    onDelta: (text: string) => void,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<void> => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort('timeout'), options.timeoutMs ?? 45_000);
    const abort = () => controller.abort(options.signal?.reason || 'canceled');
    options.signal?.addEventListener('abort', abort, { once: true });
    let completed = false;
    try {
      const res = await fetch(`${API}/cats/me/chat`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: { message: '对话失败' } }));
        throw new ApiError(err.error?.message || '对话失败', res.status, err.error?.code, err.error?.help_url);
      }
      if (!res.body) throw new ApiError('没有收到小猫的回复，请重试', 502, 'EMPTY_CHAT_STREAM');
      await consumeSseStream(res.body, (event) => {
        if (event.type === 'delta' && event.text) onDelta(event.text);
        if (event.type === 'error') throw new ApiError(event.message || '对话失败', 502, event.code, event.help_url);
        if (event.type === 'done') completed = true;
      });
      if (!completed) throw new ApiError('小猫的回复中断了，请重试', 502, 'INCOMPLETE_CHAT_STREAM');
    } catch (error) {
      if (controller.signal.aborted) {
        const timedOut = controller.signal.reason === 'timeout';
        throw new ApiError(timedOut ? '小猫暂时没有回应，请稍后重试' : '已停止等待小猫回复', timedOut ? 504 : 499, timedOut ? 'CHAT_TIMEOUT' : 'CHAT_CANCELED');
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
    }
  },
};

export type ChatHistoryMessage = {
  id: string;
  role: 'user' | 'cat';
  text: string;
  created_at: string;
  turn_id?: string;
  turn_status?: ChatTurnStatus;
  queue_position?: number;
};

export type ChatTurnStatus = 'queued' | 'processing' | 'cancel_requested' | 'completed' | 'canceled' | 'failed';
export type ChatTurn = {
  id: string;
  status: ChatTurnStatus;
  queue_position?: number;
  reply?: string;
  error?: { code: string; message: string };
};

export type PatStatus = {
  status: 'valid' | 'invalid' | 'none' | string;
  pat_hint?: string | null;
  last_verified_at?: string | null;
  qca_site?: string | null;
};

export type SavePatResult =
  | { status: 'valid'; hint: string; resources_preserved?: boolean }
  | { status: 'pending'; requires_confirmation: true; replacement_id: string; warning: string };

export type ConfirmPatReplacementResult = {
  ok: true;
  archived: boolean;
  archive_id?: string;
  orphan_risk?: boolean;
};

export type CatArchive = {
  id: string;
  source_cat_id: string;
  name: string;
  reason: string;
  orphan_risk: number | boolean;
  created_at: string;
  snapshot: CatArchiveSnapshot;
};

export type CatArchiveSnapshot = {
  cat: {
    id: string;
    name: string;
    personality?: string;
    current_image_url?: string | null;
    created_at?: string;
  };
  travels: Array<{
    id: string;
    travel_date: string;
    location_id: string;
    narrative: string;
    mood?: string | null;
    reported_at?: string;
  }>;
  postcards: Array<{
    id: string;
    travel_id: string;
    title: string;
    content: string;
    image_url?: string | null;
  }>;
  items: Array<{ id: string; item_id: string; acquired_at?: string }>;
  badges: Array<{ id: string; badge_id: string; earned_at?: string }>;
  appearances: Array<{ id: string; image_url?: string | null; selection_status?: string; created_at?: string }>;
  interactions?: Array<{ id: string; turns?: number; date?: string }>;
};

export type CreateCatBody = {
  name: string;
  personality: string;
  model: string;
  attrs?: { courage: number; curiosity: number; affinity: number; insight: number };
  appearance?: Appearance;
  custom_description?: string;
};

export type QcaModelOption = {
  id: string;
  display_name: string;
  price_factor: number | null;
  efforts: string[];
  default_effort: string | null;
};

export type Appearance = { baseColor: string; pattern: string; eyes: string; breed?: string };

export type AdventurePresencePhase = 'idle' | 'running' | 'failed';

export type AdventurePresence = {
  phase: AdventurePresencePhase;
  checked_at?: string;
  session_status?: string;
  destination?: {
    location_id: string;
    name: string;
    selected_at: string;
  };
};

export type CatProfile = {
  id: string;
  name: string;
  personality: string;
  attrs: { courage: number; curiosity: number; affinity: number; insight: number };
  appearance: Appearance;
  current_image_url?: string | null;
  appearance_status?: 'pending' | 'generating' | 'ready' | 'placeholder' | 'failed' | 'canceled';
  lifecycle_stage?: 'appearance' | 'world' | 'adventure_starting' | 'scheduled' | 'recalled';
  selected_birth_appearance_id?: string | null;
  appearance_confirmed_at?: string | null;
  adventure_started_at?: string | null;
  travel_schedule_enabled?: boolean;
  can_start_adventure?: boolean;
  wandering_mode?: boolean;
  travel_wish_location_id?: string | null;
  appearance_history?: AppearanceImage[];
  appearance_candidates?: AppearanceImage[];
  appearance_repaint?: AppearanceRepaintState;
  outfit: { head: string | null; neck: string | null; back: string | null };
  status: string;
  qca_health?: { status: string; alert?: QcaUserAlert };
  qca_diagnosis?: QcaDiagnosis;
  adventure_presence?: AdventurePresence;
  image_generation_alert?: QcaUserAlert;
  image_generation_error?: { code: 'IMAGE_SESSION_TIMEOUT' | 'IMAGE_GENERATION_FAILED' | 'IMAGE_JOB_CANCELED'; message: string };
  qca?: { model?: string | null };
  /** #084：换模型接口回包时标记画师资源是否真的被重建（同一模型重复提交为 false） */
  model_changed?: boolean;
  items?: Array<{ item_id: string; name: string; kind: 'wearable' | 'toy' | 'souvenir' | 'consumable'; slot: string; asset_key?: string | null; description?: string; acquired_at?: string; source_location_name?: string | null; source_travel_date?: string | null }>;
  created_at?: string;
  message?: string;
};

export type QcaUserAlert = {
  code: 'QCA_CREDITS_UNAVAILABLE';
  message: string;
  help_url: string;
  source: 'image' | 'travel' | 'chat';
};

/**
 * #077：形象重画申诉状态（服务端下发）。
 * eligible 只有形象确认后（lifecycle_stage 非 appearance）才为 true——入口可见性由它决定；
 * pending_candidate 有值时表示新图已画好、等用户明确决定替换还是保留原图（#024 不静默换猫）。
 */
export type AppearanceRepaintState = {
  eligible: boolean;
  used: number;
  limit: number;
  remaining: number;
  image_job_active: boolean;
  pending_candidate: { id: string; image_url: string; created_at: string } | null;
  credits_notice: string;
};

// #072：「需要照看」诊断（服务端脱敏后下发：只有固定文案，无凭据/错误栈）
export type QcaDiagnosisAction = {
  id: 'check_pat' | 'check_credits' | 'repair';
  label: string;
  href?: string;
};

export type QcaDiagnosis = {
  summary: string;
  causes: string[];
  actions: QcaDiagnosisAction[];
  checked_at: string | null;
};

export type QcaCreditsRecoveryResult = {
  ok: true;
  status: 'restored';
  requeued: number;
  checked_at: string;
  message: string;
};

export type GrowthCardType = 'book' | 'skill' | 'interest' | 'life';
export type GrowthCardVisibility = 'private' | 'encounter' | 'public';
export type GrowthCardInput = {
  type: GrowthCardType;
  title: string;
  summary: string;
  source_url?: string | null;
  tags: string[];
  visibility: GrowthCardVisibility;
};
export type GrowthCard = GrowthCardInput & {
  id: string;
  user_id: string;
  cat_id: string;
  sync_status: 'pending' | 'synced' | 'failed';
  sync_error?: string | null;
  created_at: string;
  updated_at: string;
};
export type GrowthTagSummary = {
  source_count: number;
  tags: Array<{ name: string; source_count: number; types: GrowthCardType[] }>;
};

export type AppearanceImage = {
  id: string;
  kind: string;
  image_url: string;
  selection_status: string;
  created_at: string;
};

export type Travel = {
  id: string;
  travel_date: string;
  location_id: string;
  location_name: string;
  event_name?: string;
  narrative: string;
  mood: string;
  postcard_title?: string;
  postcard_content?: string;
  postcard_id?: string;
  postcard_question?: string;
  home_messages?: string[];
  reading_source?: {
    source_type: 'growth_card' | 'world_book';
    source_id: string;
    title: string;
  } | null;
  photo_status?: 'pending' | 'generating' | 'ready' | 'failed';
  cherished_at?: string | null;
  memory_reference?: string | null;
  encounter_summary?: string | null;
  encounter_photo?: boolean;
  /** 该次旅行生成的猫咪照片 */
  image_url?: string | null;
  dropped_item?: { id: string; name: string | null; slot: string | null } | null;
};

export type OnboardingAnswerInput = { question_id: string; choice_id?: string; answer_text?: string; skipped?: boolean };
export type OnboardingAnswer = OnboardingAnswerInput & { id: string; memory_digest?: string; sync_status: string };
export type VisibleMemory = { id: string; question_id: string; answer_text: string | null; choice_id: string | null; memory_digest: string; sync_status: string; source: 'onboarding'; updated_at: string };
export type BondState = { stage: string; label: string; reason: string; unlocks: string[]; story: { arc_id: string | null; step: number; total: number; message: string } };
export type WeeklyRecap = { title: string; message: string; travels: Array<{ id: string; travel_date: string; mood: string | null; location_name: string | null; title: string | null }> };
export type ReturnMessage = { message: string; unfinished: string | null };

export type Badge = {
  id: string;
  name: string;
  description: string;
  earned: boolean;
  earned_at?: string;
};

export type MapLocation = {
  id: string;
  name: string;
  description: string;
  mood_tags: string[];
  min_attrs: Record<string, number>;
  map: { x: number; y: number };
  region_id: string;
  map_priority: number;
  checkin: { first_visit: string; last_visit?: string; visits: number; last_title?: string | null } | null;
  heat: number;
};

export type MapManifest = {
  basemap_version: string;
  min_zoom: number;
  max_zoom: number;
  regions: Array<{
    id: string;
    name: string;
    center: { x: number; y: number };
    bounds: { x: number; y: number; width: number; height: number };
    mood: string;
  }>;
};

export type WorldDigest = {
  date: string;
  events: Array<{
    id: string;
    location_id: string;
    location_name: string;
    name: string;
    description: string;
    attr_bonus: Record<string, number>;
  }>;
  has_travel_today: boolean;
  travel_status: TravelAvailabilityStatus;
  next_available_at: string | null;
  lifecycle_stage: string;
  travel_schedule_enabled: boolean;
};

export type TravelAvailabilityStatus = 'available' | 'departed_today' | 'completed_today';

export type Proposal = {
  id: string;
  type: string;
  content: string;
  context?: Record<string, unknown> | null;
  status: string;
  public_status: 'received' | 'under-review' | 'accepted' | 'partially-accepted' | 'in-progress' | 'validating' | 'verified' | 'not-planned';
  production_verified_at?: string | null;
  production_evidence_ref?: string | null;
  backlog_ref?: string | null;
  public_note?: string | null;
  reporter_cat_name?: string | null;
  events: ProposalEvent[];
  contribution_points: number;
  reward_status: string;
  accepted_at?: string | null;
  shipped_at?: string | null;
  created_at: string;
};

export type ProposalEvent = {
  id: string;
  proposal_id: string;
  actor_type: string;
  actor_name: string;
  from_status?: string | null;
  to_status: string;
  event_kind?: string;
  visibility?: string;
  evidence_ref?: string | null;
  public_note?: string | null;
  created_at: string;
};

export type ChronicleEntry = {
  id: string;
  date: string;
  title: string;
  summary: string;
  change_type: string;
  source_kind: 'seed' | 'owner' | 'proposal' | string;
  proposal_id?: string | null;
  contributor_cat_name?: string | null;
  history_file: string;
};

export type ContributionSummary = {
  points: number;
  accepted: number;
  shipped: number;
  pending_rewards: number;
};
