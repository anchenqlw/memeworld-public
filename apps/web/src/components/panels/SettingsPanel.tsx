import { useEffect, useState } from 'react';
import {
  api,
  ApiError,
  apiUrl,
  type CatArchive,
  type CatProfile,
  type PatStatus,
  type QcaModelOption,
  type SavePatResult,
} from '../../api/client';
import { Icon } from '../ui/Icon';
import { Overlay } from '../ui/Overlay';
import { CatImage } from '../CatImage';
import { CareDiagnosisCard, careDiagnosisFor } from '../CareDiagnosisCard';

import { derivePresence, settingsTravelText } from '../../lib/catPresence';

type Props = {
  cat: CatProfile;
  patStatus: PatStatus;
  userName: string;
  devMode: boolean;
  onChanged: () => void;
  onLogout: () => void;
  onClose: () => void;
};

/** 设置：账号、猫的出行状态、开发工具 */
export function SettingsPanel({ cat, patStatus, userName, devMode, onChanged, onLogout, onClose }: Props) {
  const [busy, setBusy] = useState(false);
  const [devNotice, setDevNotice] = useState('');
  const active = cat.status === 'active';
  // #072：status=broken 时设置面板也给出诊断与修复入口（PAT 区就在下方，无需跳转）
  const careDiagnosis = careDiagnosisFor(cat);

  const toggleTravel = async () => {
    setBusy(true);
    try {
      if (active) await api.recallCat();
      else await api.releaseCat();
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  // #056b：流浪模式——纯视觉状态开关，不改变旅行调度
  const toggleWandering = async () => {
    setBusy(true);
    try {
      await api.setWanderingMode(!cat.wandering_mode);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const simulate = async () => {
    setBusy(true);
    try {
      await api.simulateTravel();
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const regenerateGrowthPhoto = async () => {
    setBusy(true);
    setDevNotice('');
    try {
      await api.regenerateGrowthPhoto();
      setDevNotice('已开始重画最近一次旅行照片，可到手账查看生成进度。');
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  // dev：一键退出当前账号并以全新账号进入，直达建猫流程
  const restartAsNew = async () => {
    setBusy(true);
    try {
      await api.logout();
    } finally {
      window.location.href = `${apiUrl('/api/v1/auth/login')}?fresh=1&next=/`;
    }
  };

  return (
    <Overlay title="设置" icon="gear" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {careDiagnosis && <CareDiagnosisCard diagnosis={careDiagnosis} onChanged={onChanged} />}

        <section style={{ background: '#fff', border: '2px solid var(--paper-edge)', borderRadius: 14, padding: '14px 18px' }}>
          <h3 style={{ fontSize: '0.95rem', marginBottom: 10 }}>账号</h3>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: '0.9rem' }}>{userName}</span>
            <button type="button" className="gs-btn gs-btn--ghost gs-btn--small" onClick={onLogout}>
              <Icon name="logout" size={16} strokeWidth={2.2} />
              退出登录
            </button>
          </div>
        </section>

        <section style={{ background: '#fff', border: '2px solid var(--paper-edge)', borderRadius: 14, padding: '14px 18px' }}>
          <h3 style={{ fontSize: '0.95rem', marginBottom: 10 }}>{cat.name} 的出行</h3>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--ink-soft)', lineHeight: 1.6 }}>
              {settingsTravelText(derivePresence({
                wandering_mode: cat.wandering_mode,
                status: cat.status,
                lifecycle_stage: cat.lifecycle_stage,
                presencePhase: cat.adventure_presence?.phase ?? 'idle',
                can_start_adventure: cat.can_start_adventure,
              }), active)}
            </p>
            <button
              type="button"
              className={`gs-btn gs-btn--small ${active ? 'gs-btn--ghost' : 'gs-btn--green'}`}
              onClick={toggleTravel}
              disabled={busy}
              style={{ flexShrink: 0 }}
            >
              <Icon name={active ? 'moon' : 'sun'} size={16} strokeWidth={2.2} />
              {active ? '召回' : '放出'}
            </button>
          </div>
          <p style={{ margin: '10px 0 0', fontSize: '0.72rem', color: 'var(--ink-soft)', display: 'flex', alignItems: 'center', gap: 5 }}>
            <Icon name="lock" size={13} strokeWidth={2} />
            云端契约状态：{cat.qca_health?.status === 'healthy' ? '一切正常' : cat.qca_health?.status === 'broken' ? '需要照看——原因和修复办法见上方「需要照看」卡片' : '检查中…'}
          </p>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 12, paddingTop: 12, borderTop: '1.5px dashed var(--paper-edge)' }}>
            <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--ink-soft)', lineHeight: 1.6 }}>
              {cat.wandering_mode
                ? '流浪模式开着——它不守在猫窝，正在云海里游荡（旅行节奏不变）'
                : '流浪模式：让它离开猫窝去外面游荡，首页会看到它在外流浪的样子'}
            </p>
            <button
              type="button"
              className={`gs-btn gs-btn--small ${cat.wandering_mode ? 'gs-btn--ghost' : ''}`}
              onClick={toggleWandering}
              disabled={busy}
              style={{ flexShrink: 0 }}
            >
              <Icon name="paw" size={16} strokeWidth={2.2} />
              {cat.wandering_mode ? '唤它回窝' : '放它流浪'}
            </button>
          </div>
        </section>

        <PatSection cat={cat} initialStatus={patStatus} onChanged={onChanged} />

        <ModelSection cat={cat} onChanged={onChanged} />

        <ArchivesSection />

        {devMode && (
          <section style={{ background: '#f4f8fb', border: '2px dashed rgba(95,168,211,0.5)', borderRadius: 14, padding: '14px 18px' }}>
            <h3 style={{ fontSize: '0.95rem', marginBottom: 10 }}>开发者工具</h3>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="gs-btn gs-btn--ghost gs-btn--small" onClick={simulate} disabled={busy}>
                <Icon name="refresh" size={16} strokeWidth={2.2} />
                模拟一次旅行
              </button>
              <button type="button" className="gs-btn gs-btn--ghost gs-btn--small" onClick={regenerateGrowthPhoto} disabled={busy}>
                <Icon name="album" size={16} strokeWidth={2.2} />
                重画最近旅行照片
              </button>
              <button type="button" className="gs-btn gs-btn--ghost gs-btn--small" onClick={restartAsNew} disabled={busy}>
                <Icon name="plus" size={16} strokeWidth={2.2} />
                以新账号重走建猫流程
              </button>
            </div>
            <p style={{ margin: '8px 0 0', fontSize: '0.72rem', color: 'var(--ink-soft)' }}>
              重走建猫：退出当前账号并创建全新访客账号，直接进入建猫向导（当前账号和猫都保留，可随时切回）
            </p>
            {devNotice && <p role="status" style={{ margin: '8px 0 0', fontSize: '0.76rem', color: 'var(--green-deep)' }}>{devNotice}</p>}
          </section>
        )}
      </div>
    </Overlay>
  );
}

/** Qoder 契约（PAT）管理：查看状态 + 更换 Token */
function PatSection({ cat, initialStatus, onChanged }: {
  cat: CatProfile;
  initialStatus: PatStatus;
  onChanged: () => void;
}) {
  const [status, setStatus] = useState<PatStatus>(initialStatus);
  const [editing, setEditing] = useState(false);
  const [pat, setPat] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [savedTip, setSavedTip] = useState(false);
  const [pending, setPending] = useState<Extract<SavePatResult, { status: 'pending' }> | null>(null);

  const imageBusy = cat.appearance_status === 'pending' || cat.appearance_status === 'generating';
  const load = () => api.patStatus().then(setStatus).catch(() => {});
  useEffect(() => { load(); }, []);
  useEffect(() => { setStatus(initialStatus); }, [initialStatus]);

  const save = async () => {
    setError('');
    setSaving(true);
    try {
      const result = await api.savePat(pat.trim());
      setPat('');
      if (result.status === 'pending') {
        setPending(result);
        return;
      }
      setEditing(false);
      setSavedTip(true);
      setTimeout(() => setSavedTip(false), 3000);
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : '校验失败，请检查 Token');
    } finally {
      setSaving(false);
    }
  };

  const confirm = async () => {
    if (!pending) return;
    setError('');
    setSaving(true);
    try {
      await api.confirmPatReplacement(pending.replacement_id);
      setPending(null);
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : '确认更换失败，请稍后重试');
    } finally {
      setSaving(false);
    }
  };

  const cancelPending = async () => {
    if (!pending) return;
    setError('');
    setSaving(true);
    try {
      await api.cancelPatReplacement(pending.replacement_id);
      setPending(null);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : '取消更换失败，请稍后重试');
    } finally {
      setSaving(false);
    }
  };

  const valid = status?.status === 'valid';
  const invalid = status?.status === 'invalid';

  return (
    <section style={{ background: '#fff', border: '2px solid var(--paper-edge)', borderRadius: 14, padding: '14px 18px' }}>
      <h3 style={{ fontSize: '0.95rem', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
        Qoder 契约（PAT）
        <span
          style={{
            fontSize: '0.66rem', fontWeight: 700, padding: '2px 10px', borderRadius: 999,
            color: valid ? '#4e6e2c' : '#8c4a52',
            background: valid ? '#f2f8e4' : '#fbe9eb',
          }}
        >
          {valid ? '生效中' : status?.status === 'none' ? '未绑定' : '已失效'}
        </span>
      </h3>
      {pending ? (
        <div style={{ background: '#fff8ef', border: '2px solid rgba(224,123,57,0.3)', borderRadius: 12, padding: 14 }}>
          <strong style={{ color: 'var(--warm-deep)', fontSize: '0.88rem' }}>确认归档现在的小猫并重新开始？</strong>
          <p style={{ margin: '8px 0', fontSize: '0.8rem', lineHeight: 1.65, color: 'var(--ink-soft)' }}>
            现在的小猫会结束旅程；旅行、图片、物品和勋章会完整保留为只读档案。新契约生效后需要重新创建小猫。
          </p>
          <p style={{ margin: '0 0 10px', fontSize: '0.76rem', color: 'var(--ink-soft)' }}>{pending.warning}</p>
          {error && <p style={{ color: 'var(--danger)', fontSize: '0.78rem', margin: '0 0 8px' }}>{error}</p>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button type="button" className="gs-btn gs-btn--ghost gs-btn--small" onClick={cancelPending} disabled={saving}>
              保留现在的小猫
            </button>
            <button type="button" className="gs-btn gs-btn--small" onClick={confirm} disabled={saving || imageBusy}>
              {saving ? '处理中…' : '确认归档并重新开始'}
            </button>
          </div>
          {imageBusy && <p style={{ margin: '8px 0 0', fontSize: '0.72rem', color: 'var(--ink-soft)' }}>图片任务完成后才能确认更换。</p>}
        </div>
      ) : !editing ? (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--ink-soft)', lineHeight: 1.6 }}>
              {valid
                ? <>当前 Token：<code style={{ background: '#f4f2ea', padding: '1px 8px', borderRadius: 6 }}>{status?.pat_hint || '••••'}</code>{savedTip && <span style={{ color: 'var(--grass-deep)', marginLeft: 8 }}>已更新</span>}</>
                : invalid ? '当前契约已失效，小猫暂时无法使用云端能力，请重新绑定。' : '小猫需要你的 Qoder PAT 才能探险，请绑定。'}
            </p>
            <button
              type="button"
              className="gs-btn gs-btn--ghost gs-btn--small"
              style={{ flexShrink: 0 }}
              onClick={() => setEditing(true)}
              disabled={imageBusy}
              title={imageBusy ? '请等待当前图片任务结束' : undefined}
            >
              <Icon name="lock" size={15} strokeWidth={2.2} />
              {valid ? '更换' : '绑定'}
            </button>
          </div>
          {(status?.last_verified_at || status?.qca_site) && (
            <p style={{ margin: '8px 0 0', fontSize: '0.72rem', color: 'var(--ink-soft)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              {status?.last_verified_at && <span>上次校验：{formatArchiveDate(status.last_verified_at)}</span>}
              {status?.qca_site && <span>站点：{formatQcaSite(status.qca_site)}</span>}
            </p>
          )}
          {valid && (
            <p style={{ margin: '8px 0 0', fontSize: '0.72rem', color: 'var(--ink-soft)', display: 'flex', alignItems: 'flex-start', gap: 5 }}>
              <Icon name="lock" size={13} strokeWidth={2} />
              <span>更换契约会结束现在小猫的旅程：旅行、图片、物品和勋章会保留为只读档案，新契约生效后需要重新创建小猫。</span>
            </p>
          )}
        </div>
      ) : (
        <div>
          <input
            className="gs-input"
            type="password"
            value={pat}
            onChange={(e) => setPat(e.target.value)}
            placeholder="粘贴新的 PAT（pt-…）"
            onKeyDown={(e) => e.key === 'Enter' && pat.trim().length >= 8 && save()}
          />
          {error && <p style={{ color: 'var(--danger)', fontSize: '0.78rem', margin: '6px 0 0' }}>{error}</p>}
          <p style={{ fontSize: '0.72rem', color: 'var(--ink-soft)', margin: '8px 0 10px', display: 'flex', alignItems: 'center', gap: 5 }}>
            <Icon name="lock" size={13} strokeWidth={2} />
            Token 只传给服务端加密保存；如需结束当前小猫，会再次请你确认
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="gs-btn gs-btn--ghost gs-btn--small" onClick={() => { setEditing(false); setPat(''); setError(''); }}>
              取消
            </button>
            <button type="button" className="gs-btn gs-btn--small" onClick={save} disabled={saving || pat.trim().length < 8}>
              {saving ? '校验中…' : '保存'}
            </button>
          </div>
        </div>
      )}
      {imageBusy && !editing && !pending && (
        <p style={{ margin: '8px 0 0', fontSize: '0.72rem', color: 'var(--ink-soft)' }}>图片任务进行中，完成后即可更换契约。</p>
      )}
    </section>
  );
}

/** #084：当前 model 与「更换模型」入口的展示判定（纯函数，仓库无 DOM 测试环境） */
export type ModelChangeView = {
  currentId: string | null;
  currentLabel: string;
  options: QcaModelOption[];
  /** 当前 model 不在账号可用列表里（Credits 耗尽只剩 Lite、或模型下架）——必须提示更换 */
  unavailable: boolean;
  /** 有图片在生成时不能换：旧画师会被归档，服务端同样以 409 IMAGE_JOB_ACTIVE 拒绝 */
  blockedByImageJob: boolean;
  canChange: boolean;
  hint: string;
};

export function modelChangeViewFor(
  cat: Pick<CatProfile, 'qca' | 'appearance_status'>,
  models: QcaModelOption[],
): ModelChangeView {
  const currentId = cat.qca?.model || null;
  const known = models.find((model) => model.id === currentId);
  const blockedByImageJob = cat.appearance_status === 'pending' || cat.appearance_status === 'generating';
  const unavailable = Boolean(currentId) && models.length > 0 && !known;
  return {
    currentId,
    currentLabel: known?.display_name || currentId || '未选择',
    options: models,
    unavailable,
    blockedByImageJob,
    canChange: models.length > 0 && !blockedByImageJob,
    hint: blockedByImageJob
      ? '图片任务进行中，画完就能换模型。'
      : unavailable
        ? '当前模型在你的 Qoder 账号里已经用不了了，请换一个，否则生图和聊天都会失败。'
        : '换模型会为它重新准备一位云端画师（旧的归档，已画好的图片都保留）；聊天和旅行不受影响。',
  };
}

/** 换成功后的提示语；服务端 model_changed=false 表示提交的就是当前模型，没有重建画师 */
export function modelChangeNoticeFor(label: string, changed: boolean | undefined) {
  return changed
    ? `已经换成 ${label}，并为它重新准备了一位云端画师。`
    : `${label} 就是当前的模型，没有变化。`;
}

/** 小猫模型（model）：查看当前模型 + 更换（建猫向导之外唯一入口，#084） */
function ModelSection({ cat, onChanged }: { cat: CatProfile; onChanged: () => void }) {
  const [models, setModels] = useState<QcaModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [choice, setChoice] = useState(cat.qca?.model || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const view = modelChangeViewFor(cat, models);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.qcaModels()
      .then(({ models: available }) => {
        if (!alive) return;
        setModels(available);
        setLoadError('');
      })
      .catch((e) => { if (alive) setLoadError(e instanceof Error ? e.message : '模型列表加载失败'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  useEffect(() => { setChoice(cat.qca?.model || ''); }, [cat.qca?.model]);

  const change = async () => {
    setError('');
    setNotice('');
    setSaving(true);
    try {
      const updated = await api.changeCatModel(choice);
      const label = models.find((model) => model.id === updated.qca?.model)?.display_name || updated.qca?.model || choice;
      setNotice(modelChangeNoticeFor(label, updated.model_changed));
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : '更换模型失败，请稍后再试');
      // MODEL_CHANGE_CONFLICT（#084 三轮验收）：另一次更换先完成，实况已变——
      // 文案让用户「刷新看当前模型」，故这里必须真的刷新一次，否则界面停在旧态、提示与行为矛盾。
      if (e instanceof ApiError && e.code === 'MODEL_CHANGE_CONFLICT') onChanged();
    } finally {
      setSaving(false);
    }
  };

  return (
    <section style={{ background: '#fff', border: '2px solid var(--paper-edge)', borderRadius: 14, padding: '14px 18px' }}>
      <h3 style={{ fontSize: '0.95rem', marginBottom: 10 }}>{cat.name} 的模型</h3>
      <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--ink-soft)', lineHeight: 1.6 }}>
        当前模型：<strong style={{ color: view.unavailable ? 'var(--danger)' : 'inherit' }}>{view.currentLabel}</strong>
        {view.unavailable && <span style={{ color: 'var(--danger)' }}>（已不可用）</span>}
      </p>
      {loading && <p style={{ margin: '8px 0 0', fontSize: '0.78rem', color: 'var(--ink-soft)' }}>正在读取可用模型…</p>}
      {loadError && <p style={{ margin: '8px 0 0', fontSize: '0.78rem', color: 'var(--danger)' }}>{loadError}</p>}
      {view.options.length > 0 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
          <select
            className="gs-input"
            aria-label="选择小猫模型"
            value={choice}
            onChange={(event) => setChoice(event.target.value)}
            disabled={saving || !view.canChange}
            style={{ maxWidth: 260 }}
          >
            {!view.currentId && <option value="">请选择模型</option>}
            {view.unavailable && view.currentId && <option value={view.currentId}>{view.currentId}（已不可用）</option>}
            {view.options.map((model) => (
              <option key={model.id} value={model.id}>
                {model.display_name}
                {model.price_factor == null ? '' : ` · 价格倍率 ${model.price_factor}×`}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="gs-btn gs-btn--small"
            onClick={change}
            disabled={saving || !view.canChange || !choice || choice === view.currentId}
            title={view.blockedByImageJob ? '请等待当前图片任务结束' : undefined}
          >
            <Icon name="refresh" size={15} strokeWidth={2.2} />
            {saving ? '更换中…' : '更换模型'}
          </button>
        </div>
      )}
      <p style={{ margin: '8px 0 0', fontSize: '0.72rem', color: view.unavailable ? 'var(--danger)' : 'var(--ink-soft)', lineHeight: 1.6 }}>
        {view.hint}
      </p>
      {error && <p role="alert" style={{ margin: '8px 0 0', fontSize: '0.78rem', color: 'var(--danger)' }}>{error}</p>}
      {notice && <p role="status" style={{ margin: '8px 0 0', fontSize: '0.78rem', color: 'var(--grass-deep)' }}>{notice}</p>}
    </section>
  );
}

function ArchivesSection() {
  const [open, setOpen] = useState(false);
  const [archives, setArchives] = useState<CatArchive[]>([]);
  const [selected, setSelected] = useState<CatArchive | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const loadArchives = async () => {
    setOpen(true);
    if (archives.length > 0) return;
    setLoading(true);
    setError('');
    try {
      const result = await api.catArchives();
      setArchives(result.archives);
    } catch (e) {
      setError(e instanceof Error ? e.message : '档案加载失败');
    } finally {
      setLoading(false);
    }
  };

  const openArchive = async (archive: CatArchive) => {
    setLoading(true);
    setError('');
    try {
      setSelected(await api.catArchive(archive.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : '档案详情加载失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section style={{ background: '#fff', border: '2px solid var(--paper-edge)', borderRadius: 14, padding: '14px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <h3 style={{ fontSize: '0.95rem', marginBottom: 4 }}>旧小猫档案</h3>
          <p style={{ margin: 0, fontSize: '0.76rem', color: 'var(--ink-soft)' }}>曾经的小猫与旅行记录会只读保存在这里。</p>
        </div>
        <button
          type="button"
          className="gs-btn gs-btn--ghost gs-btn--small"
          onClick={() => open ? setOpen(false) : loadArchives()}
        >
          {open ? '收起' : '查看'}
        </button>
      </div>
      {open && (
        <div style={{ marginTop: 12 }}>
          {loading && <p style={{ color: 'var(--ink-soft)', fontSize: '0.8rem' }}>正在翻找档案…</p>}
          {error && <p style={{ color: 'var(--danger)', fontSize: '0.78rem' }}>{error}</p>}
          {!loading && archives.length === 0 && !error && <p style={{ color: 'var(--ink-soft)', fontSize: '0.8rem' }}>还没有旧小猫档案。</p>}
          {!selected && archives.map((archive) => (
            <button
              key={archive.id}
              type="button"
              onClick={() => openArchive(archive)}
              style={{
                width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                textAlign: 'left', padding: '10px 12px', marginTop: 8, border: '2px solid var(--paper-edge)',
                borderRadius: 12, background: '#fffdf4',
              }}
            >
              <strong>{archive.name}</strong>
              <span style={{ fontSize: '0.74rem', color: 'var(--ink-soft)' }}>{formatArchiveDate(archive.created_at)}</span>
            </button>
          ))}
          {selected && <ArchiveDetail archive={selected} onBack={() => setSelected(null)} />}
        </div>
      )}
    </section>
  );
}

function ArchiveDetail({ archive, onBack }: { archive: CatArchive; onBack: () => void }) {
  const { snapshot } = archive;
  const images = snapshot.appearances.filter((appearance) => appearance.image_url);
  return (
    <div style={{ borderTop: '2px dashed var(--paper-edge)', paddingTop: 12 }}>
      <button type="button" className="gs-btn gs-btn--ghost gs-btn--small" onClick={onBack}>返回列表</button>
      <h4 style={{ fontSize: '1.05rem', marginTop: 12 }}>{archive.name}</h4>
      <p style={{ margin: '5px 0 10px', fontSize: '0.74rem', color: 'var(--ink-soft)' }}>归档于 {formatArchiveDate(archive.created_at)} · 只读</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: '0.78rem' }}>
        <span>旅行 {snapshot.travels.length} 次</span>
        <span>图片 {images.length} 张</span>
        <span>物品 {snapshot.items.length} 件</span>
        <span>勋章 {snapshot.badges.length} 枚</span>
      </div>
      {images.length > 0 && (
        <div style={{ display: 'flex', gap: 8, overflowX: 'auto', marginTop: 12, paddingBottom: 4 }}>
          {images.map((image) => (
            <CatImage
              key={image.id}
              src={image.image_url!}
              alt={`${archive.name} 的旧照片`}
              style={{ width: 92, height: 92, flex: '0 0 auto', objectFit: 'cover', borderRadius: 12, border: '2px solid var(--paper-edge)' }}
            />
          ))}
        </div>
      )}
      {snapshot.travels.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <strong style={{ fontSize: '0.82rem' }}>旅行摘要</strong>
          {snapshot.travels.slice().reverse().slice(0, 5).map((travel) => (
            <p key={travel.id} style={{ margin: '6px 0 0', fontSize: '0.76rem', lineHeight: 1.55, color: 'var(--ink-soft)' }}>
              {travel.travel_date} · {travel.narrative}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function formatArchiveDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
}

/** qca_site 的用户可读名称（服务端存 'global' | 'cn'） */
function formatQcaSite(site: string) {
  return site === 'global' ? '国际站（qoder.com）' : site === 'cn' ? '中国站（qoder.com.cn）' : site;
}
