import { useEffect, useMemo, useState } from 'react';
import { api, type Appearance, type CatProfile, type OnboardingAnswerInput, type QcaModelOption, type SavePatResult } from '../api/client';
import {
  ATTR_KEYS,
  ATTR_META,
  BREED_OPTIONS,
  COLOR_OPTIONS,
  EYE_OPTIONS,
  MAX_TRAITS,
  PATTERN_OPTIONS,
  TRAIT_OPTIONS,
  deriveAttrsFromTraits,
  type SwatchOption,
} from '../game/catOptions';
import { Sky } from './ui/Sky';
import { Icon } from './ui/Icon';
import { CatAvatar } from './CatAvatar';
import { CatImage } from './CatImage';
import { QcaCreditsRecoveryCard } from './QcaCreditsRecoveryCard';
import { AppearanceFreeformField, validateCustomAppearanceInput } from './AppearanceRepaintCard';

/**
 * 新手引导：缔结契约（PAT）→ 选择模型 → 勾选外貌（品种/毛色/花纹/瞳色）→ 勾选性格 → 起名确认 → 召唤等待 → 揭晓。
 * 外貌配置固化入库，作为该猫所有 AI 生图的一致性约束；
 * 天性由勾选的性格标签自动推导（不再手动分点），后续随旅行成长。
 */

type StepId = 'pat' | 'model' | 'look' | 'trait' | 'name' | 'summon' | 'bond';

type Props = {
  patOk: boolean;
  onDone: () => void;
  existingCat?: CatProfile | null;
};

export function Onboarding({ patOk, onDone, existingCat = null }: Props) {
  const steps: StepId[] = useMemo(
    () => existingCat
      ? ['pat', 'look', 'summon', 'bond']
      : (patOk ? ['model', 'look', 'trait', 'name', 'summon', 'bond'] : ['pat', 'model', 'look', 'trait', 'name', 'summon', 'bond']),
    [patOk, existingCat]
  );
  const [stepIdx, setStepIdx] = useState(() => existingCat ? 2 : 0);
  const step = steps[stepIdx];

  // PAT
  const [pat, setPat] = useState('');
  const [patSaving, setPatSaving] = useState(false);
  const [patError, setPatError] = useState('');
  const [pendingReplacement, setPendingReplacement] = useState<Extract<SavePatResult, { status: 'pending' }> | null>(null);

  // QCA 模型（用户创建时选择，小猫与画师共用）
  const [models, setModels] = useState<QcaModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState(existingCat?.qca?.model || '');
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState('');
  const [modelReloadKey, setModelReloadKey] = useState(0);

  // 外貌
  const [breed, setBreed] = useState<string | null>(existingCat?.appearance.breed || null);
  const [baseColor, setBaseColor] = useState<string | null>(existingCat?.appearance.baseColor || null);
  const [pattern, setPattern] = useState<string | null>(existingCat?.appearance.pattern || null);
  const [eyes, setEyes] = useState<string | null>(existingCat?.appearance.eyes || null);
  const [customAppearance, setCustomAppearance] = useState('');

  // 性格
  const [traits, setTraits] = useState<string[]>([]);
  const [customTrait, setCustomTrait] = useState('');

  // 起名 & 召唤
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [summonedCat, setSummonedCat] = useState<CatProfile | null>(existingCat);
  const [editingAppearance, setEditingAppearance] = useState(false);
  const enterBond = async () => {
    const cat = await api.getCat();
    setSummonedCat(cat);
    setStepIdx(steps.indexOf('bond'));
  };

  useEffect(() => {
    if (step !== 'model' && step !== 'summon') return;
    let cancelled = false;
    setModelsLoading(true);
    setModelsError('');
    api.qcaModels()
      .then(({ models: available }) => {
        if (!cancelled) {
          setModels(available);
          setSelectedModel((current) => available.some((model) => model.id === current) ? current : available[0]?.id || '');
        }
      })
      .catch((error) => {
        if (!cancelled) setModelsError(error instanceof Error ? error.message : '模型列表加载失败');
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [step, modelReloadKey]);

  // 天性 = 性格标签自动推导
  const attrs = useMemo(() => deriveAttrsFromTraits(traits), [traits]);

  const personality = useMemo(() => {
    const parts = TRAIT_OPTIONS.filter((t) => traits.includes(t.id)).map((t) => t.phrase);
    if (customTrait.trim()) parts.push(customTrait.trim());
    return parts.join('；');
  }, [traits, customTrait]);

  const canNext = (() => {
    switch (step) {
      case 'pat': return true; // pat 步内自己处理提交
      case 'model': return selectedModel.length > 0;
      case 'look': return !!(breed && baseColor && pattern && eyes) && !validateCustomAppearanceInput(customAppearance);
      case 'trait': return traits.length > 0 || customTrait.trim().length > 0;
      case 'name': return name.trim().length > 0;
      default: return false;
    }
  })();

  const next = () => setStepIdx((i) => Math.min(i + 1, steps.length - 1));
  const back = () => setStepIdx((i) => Math.max(i - 1, 0));

  const savePat = async () => {
    setPatError('');
    setPatSaving(true);
    try {
      const result = await api.savePat(pat.trim());
      setPat('');
      if (result.status === 'pending') {
        setPendingReplacement(result);
      } else {
        next();
      }
    } catch (e) {
      setPatError(e instanceof Error ? e.message : '校验失败，请检查 Token');
    } finally {
      setPatSaving(false);
    }
  };

  const confirmReplacement = async () => {
    if (!pendingReplacement) return;
    setPatError('');
    setPatSaving(true);
    try {
      await api.confirmPatReplacement(pendingReplacement.replacement_id);
      setPendingReplacement(null);
      await onDone();
    } catch (e) {
      setPatError(e instanceof Error ? e.message : '确认更换失败，请稍后重试');
    } finally {
      setPatSaving(false);
    }
  };

  const cancelReplacement = async () => {
    if (!pendingReplacement) return;
    setPatError('');
    setPatSaving(true);
    try {
      await api.cancelPatReplacement(pendingReplacement.replacement_id);
      setPendingReplacement(null);
    } catch (e) {
      setPatError(e instanceof Error ? e.message : '取消更换失败，请稍后重试');
    } finally {
      setPatSaving(false);
    }
  };

  const summon = async () => {
    setCreateError('');
    setCreating(true);
    try {
      const cat = await api.createCat({
        name: name.trim(),
        personality: personality.slice(0, 200),
        model: selectedModel,
        attrs,
        appearance: { breed: breed!, baseColor: baseColor!, pattern: pattern!, eyes: eyes! } as Appearance,
        custom_description: customAppearance.trim() || undefined,
      });
      setSummonedCat(cat);
      setEditingAppearance(false);
      setStepIdx(steps.indexOf('summon'));
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : '召唤失败，请重试');
    } finally {
      setCreating(false);
    }
  };

  const redrawWithUpdatedAppearance = async () => {
    if (!breed || !baseColor || !pattern || !eyes) return;
    setCreateError('');
    setCreating(true);
    try {
      await api.updateDraftAppearance({ breed, baseColor, pattern, eyes });
      await api.regenerateAppearance(selectedModel || undefined, customAppearance.trim() || undefined);
      const cat = await api.getCat();
      setSummonedCat(cat);
      setEditingAppearance(false);
      setStepIdx(steps.indexOf('summon'));
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : '修改外观后重画失败');
    } finally {
      setCreating(false);
    }
  };

  return (
    <Sky>
      <div
        style={{
          position: 'relative',
          zIndex: 10,
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 16,
          overflowY: 'auto',
        }}
      >
        <div
          className="gs-panel"
          style={{
            width: 'min(640px, 100%)',
            maxHeight: '92vh',
            display: 'flex',
            flexDirection: 'column',
            padding: '22px 26px 24px',
            animation: 'rise-in 0.3s ease',
          }}
        >
          {step !== 'summon' && (
            <div className="wizard-steps">
              {steps.filter((s) => s !== 'summon').map((s, i) => (
                <div key={s} className={`wizard-dot ${i < stepIdx ? 'done' : i === stepIdx ? 'current' : ''}`} />
              ))}
            </div>
          )}

          <div style={{ overflowY: 'auto', flex: 1, paddingTop: 10 }}>
            {step === 'pat' && (
              pendingReplacement ? (
                <ReplacementConfirmation
                  warning={pendingReplacement.warning}
                  saving={patSaving}
                  error={patError}
                  onConfirm={confirmReplacement}
                  onCancel={cancelReplacement}
                />
              ) : (
                <StepPat
                  pat={pat}
                  setPat={setPat}
                  saving={patSaving}
                  error={patError}
                  replacing={Boolean(existingCat)}
                  onSubmit={savePat}
                />
              )
            )}
            {step === 'model' && (
              <StepModel
                models={models}
                selected={selectedModel}
                loading={modelsLoading}
                error={modelsError}
                onSelect={setSelectedModel}
                onRetry={() => setModelReloadKey((value) => value + 1)}
              />
            )}
            {step === 'look' && (
              <StepLook
                breed={breed} baseColor={baseColor} pattern={pattern} eyes={eyes}
                setBreed={setBreed} setBaseColor={setBaseColor} setPattern={setPattern} setEyes={setEyes}
                customAppearance={customAppearance} setCustomAppearance={setCustomAppearance}
              />
            )}
            {step === 'trait' && (
              <StepTrait traits={traits} setTraits={setTraits} custom={customTrait} setCustom={setCustomTrait} />
            )}
            {step === 'name' && (
              <StepName
                name={name} setName={setName}
                breed={breed} baseColor={baseColor} pattern={pattern} eyes={eyes}
                personality={personality} attrs={attrs}
                error={createError}
              />
            )}
            {step === 'summon' && (
              <StepSummon
                initialCat={summonedCat}
                models={models}
                selectedModel={selectedModel}
                customAppearance={customAppearance}
                onModelChange={setSelectedModel}
                onChangePat={existingCat ? () => setStepIdx(steps.indexOf('pat')) : undefined}
                onEditAppearance={() => {
                  setEditingAppearance(true);
                  setStepIdx(steps.indexOf('look'));
                }}
                onEnter={enterBond}
              />
            )}
            {step === 'bond' && <StepBond catName={summonedCat?.name || name} onDone={onDone} />}
          </div>

          {step !== 'summon' && step !== 'bond' && step !== 'pat' && (
            <>
            {editingAppearance && step === 'look' && createError && (
              <p style={{ color: 'var(--danger)', fontSize: '0.85rem', textAlign: 'center', margin: '10px 0 0' }}>{createError}</p>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 18, gap: 12 }}>
              <button type="button" className="gs-btn gs-btn--ghost gs-btn--small" onClick={back} disabled={stepIdx === 0}>
                <Icon name="arrowLeft" size={16} strokeWidth={2.4} />
                上一步
              </button>
              {editingAppearance && step === 'look' ? (
                <button type="button" className="gs-btn" onClick={redrawWithUpdatedAppearance} disabled={!canNext || creating}>
                  {creating ? '保存并重画中…' : '保存外观并重画'}
                  {!creating && <Icon name="sparkle" size={18} strokeWidth={2} />}
                </button>
              ) : step === 'name' ? (
                <button type="button" className="gs-btn" onClick={summon} disabled={!canNext || creating}>
                  {creating ? '生成中…' : '生成小猫'}
                  {!creating && <Icon name="sparkle" size={18} strokeWidth={2} />}
                </button>
              ) : (
                <button type="button" className="gs-btn gs-btn--small" onClick={next} disabled={!canNext}>
                  下一步
                  <Icon name="arrowRight" size={16} strokeWidth={2.4} />
                </button>
              )}
            </div>
            </>
          )}
        </div>
      </div>
    </Sky>
  );
}

/* ---------------- 各步骤 ---------------- */

function StepTitle({ title, sub }: { title: string; sub: string }) {
  return (
    <div style={{ textAlign: 'center', marginBottom: 18 }}>
      <h2 style={{ fontSize: '1.5rem', letterSpacing: '0.1em' }}>{title}</h2>
      <p style={{ margin: '6px 0 0', fontSize: '0.85rem', color: 'var(--ink-soft)' }}>{sub}</p>
    </div>
  );
}

const BOND_QUESTIONS = [
  { id: 'owner_address', text: '你希望我怎么叫你？', choices: [['owner', '主人'], ['partner', '伙伴'], ['poop_officer', '铲屎官']] },
  { id: 'comfort_style', text: '你累的时候，希望我怎么陪你？', choices: [['quiet', '安静陪着'], ['cheer', '逗我开心'], ['listen', '听我说说']] },
  { id: 'daily_joy', text: '最近什么最容易让你开心？', choices: [['weather', '好天气'], ['food', '好吃的'], ['remembered', '被记得'], ['alone', '独处']] },
  { id: 'boundary', text: '哪些话题暂时不要主动提？', choices: [['work', '工作'], ['relationship', '感情'], ['health', '健康'], ['none', '没有']] },
  { id: 'initial_keepsake', text: '第一次出门，想让我带上什么？', choices: [['bell', '小铃铛'], ['handkerchief', '手帕'], ['star', '星星挂坠']] },
] as const;

function StepBond({ catName, onDone }: { catName: string; onDone: () => void }) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<OnboardingAnswerInput[]>([]);
  const [custom, setCustom] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const question = BOND_QUESTIONS[index];

  const finish = async (answer: OnboardingAnswerInput) => {
    const nextAnswers = [...answers.filter((item) => item.question_id !== answer.question_id), answer];
    setAnswers(nextAnswers);
    setCustom('');
    if (index < BOND_QUESTIONS.length - 1) return setIndex(index + 1);
    setSaving(true); setError('');
    try {
      await api.saveOnboardingAnswers(nextAnswers);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : '记忆保存失败，请重试');
      setSaving(false);
    }
  };

  return (
    <div style={{ textAlign: 'center' }}>
      <StepTitle title={`${catName || '小猫'}想认识你`} sub={`第 ${index + 1} / ${BOND_QUESTIONS.length} 题 · 都可以跳过，以后也能修改`} />
      <div style={{ fontSize: '3rem', margin: '4px 0 10px' }}>🐾</div>
      <h3 style={{ fontSize: '1.15rem', marginBottom: 14 }}>{question.text}</h3>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 9 }}>
        {question.choices.map(([id, label]) => (
          <button key={id} type="button" className="gs-btn gs-btn--ghost gs-btn--small" disabled={saving}
            onClick={() => finish({ question_id: question.id, choice_id: id })}>{label}</button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, maxWidth: 440, margin: '16px auto 0' }}>
        <input className="gs-input" value={custom} maxLength={100} onChange={(e) => setCustom(e.target.value)} placeholder="自己写一句（不要填写密码或 Token）" />
        <button type="button" className="gs-btn gs-btn--small" disabled={!custom.trim() || saving}
          onClick={() => finish({ question_id: question.id, answer_text: custom.trim() })}>告诉它</button>
      </div>
      <button type="button" style={{ marginTop: 12, border: 0, background: 'transparent', color: 'var(--ink-soft)', cursor: 'pointer' }}
        disabled={saving} onClick={() => finish({ question_id: question.id, skipped: true })}>暂时不告诉它</button>
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
      {saving && <p style={{ color: 'var(--ink-soft)' }}>{catName || '小猫'}正在把这些话好好记住…</p>}
    </div>
  );
}

function StepPat({ pat, setPat, saving, error, replacing, onSubmit }: {
  pat: string; setPat: (v: string) => void; saving: boolean; error: string; replacing: boolean; onSubmit: () => void;
}) {
  return (
    <div>
      <StepTitle
        title={replacing ? '更换 Qoder PAT' : '缔结契约'}
        sub={replacing
          ? '新 PAT 校验成功后，草稿阶段的 QCA 资源会切换到新账号，已有候选图片仍会保留'
          : '小猫将寄住在你的 Qoder 账号里，等你邀请它去探险'}
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: '0.88rem', lineHeight: 1.7, background: '#fff', border: '2px solid var(--paper-edge)', borderRadius: 14, padding: '14px 18px' }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <Icon name="compass" size={20} color="var(--sky-deep)" style={{ flexShrink: 0, marginTop: 2 }} />
          <span>先登录你使用的 Qoder 站点，在 Account → Integrations 中创建 PAT。权限名称可能随控制台更新，请按小猫使用 Agent、环境、记忆、会话、计划与生图所需能力授权。</span>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <Icon name="lock" size={20} color="var(--grass-deep)" style={{ flexShrink: 0, marginTop: 2 }} />
          <span>Token 通常只展示一次。粘贴后仅传给服务端加密保存，不会写入浏览器存储或日志；PAT 有效不代表账号仍有可用额度。</span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, paddingLeft: 30 }}>
          <a className="gs-btn gs-btn--small" href="https://qoder.com/account/integrations" target="_blank" rel="noreferrer">
            国际站申请入口
          </a>
          <a className="gs-btn gs-btn--small gs-btn--ghost" href="https://qoder.com.cn/account/integrations" target="_blank" rel="noreferrer">
            中国站申请入口
          </a>
        </div>
      </div>
      <input
        className="gs-input"
        type="password"
        value={pat}
        onChange={(e) => setPat(e.target.value)}
        placeholder="粘贴你的 PAT（pt-…）"
        style={{ marginTop: 16 }}
        onKeyDown={(e) => e.key === 'Enter' && pat.trim().length >= 8 && onSubmit()}
      />
      {error && <p style={{ color: 'var(--danger)', fontSize: '0.85rem', margin: '8px 0 0' }}>{error}</p>}
      <div style={{ textAlign: 'center', marginTop: 18 }}>
        <button type="button" className="gs-btn" onClick={onSubmit} disabled={saving || pat.trim().length < 8}>
          {saving ? '校验并保存中…' : replacing ? '保存新 PAT' : '缔结契约'}
          {!saving && <Icon name="check" size={18} strokeWidth={2.4} />}
        </button>
      </div>
    </div>
  );
}

function ReplacementConfirmation({ warning, saving, error, onConfirm, onCancel }: {
  warning: string;
  saving: boolean;
  error: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div>
      <StepTitle title="要和现在的小猫告别吗？" sub="这一步需要你明确确认，取消不会改变现在的契约与小猫" />
      <div style={{ background: '#fff8ef', border: '2px solid rgba(224,123,57,0.35)', borderRadius: 14, padding: '16px 18px', lineHeight: 1.7 }}>
        <p style={{ margin: '0 0 10px', fontWeight: 700, color: 'var(--warm-deep)' }}>{warning}</p>
        <ul style={{ margin: 0, paddingLeft: 22, fontSize: '0.86rem', color: 'var(--ink-soft)' }}>
          <li>现在的小猫会结束旅程，不再继续出行。</li>
          <li>它的旅行、图片、物品和勋章会完整保留为只读档案。</li>
          <li>新契约生效后，你需要重新创建一只小猫。</li>
        </ul>
      </div>
      {error && <p style={{ color: 'var(--danger)', fontSize: '0.85rem', margin: '8px 0 0' }}>{error}</p>}
      <div style={{ display: 'flex', justifyContent: 'center', gap: 10, marginTop: 18, flexWrap: 'wrap' }}>
        <button type="button" className="gs-btn gs-btn--ghost gs-btn--small" onClick={onCancel} disabled={saving}>
          保留现在的小猫
        </button>
        <button type="button" className="gs-btn gs-btn--small" onClick={onConfirm} disabled={saving}>
          {saving ? '处理中…' : '确认归档并重新开始'}
        </button>
      </div>
    </div>
  );
}

function StepModel({ models, selected, loading, error, onSelect, onRetry }: {
  models: QcaModelOption[];
  selected: string;
  loading: boolean;
  error: string;
  onSelect: (id: string) => void;
  onRetry: () => void;
}) {
  return (
    <div>
      <StepTitle title="选择它的思考方式" sub="模型将同时用于小猫探险与专属画师，确认形象前可以更换" />
      {loading && <p style={{ textAlign: 'center', color: 'var(--ink-soft)' }}>正在读取你的可用模型…</p>}
      {error && (
        <div style={{ textAlign: 'center' }}>
          <p style={{ color: 'var(--danger)', fontSize: '0.88rem' }}>{error}</p>
          <button type="button" className="gs-btn gs-btn--ghost gs-btn--small" onClick={onRetry}>重新加载</button>
        </div>
      )}
      {!loading && !error && models.length === 0 && (
        <p style={{ textAlign: 'center', color: 'var(--danger)' }}>该 Qoder 账户当前没有可用模型</p>
      )}
      <div style={{ display: 'grid', gap: 10 }}>
        {models.map((model) => {
          const active = selected === model.id;
          return (
            <button
              key={model.id}
              type="button"
              className={`pick-card ${active ? 'selected' : ''}`}
              onClick={() => onSelect(model.id)}
              style={{ width: '100%', textAlign: 'left', alignItems: 'flex-start', padding: '14px 16px' }}
            >
              {active && (
                <span className="pick-check">
                  <Icon name="check" size={14} strokeWidth={3} />
                </span>
              )}
              <strong style={{ fontSize: '1rem' }}>{model.display_name}</strong>
              <span className="pick-hint">
                {model.price_factor == null ? '价格倍率未提供' : `价格倍率 ${model.price_factor}×`}
                {model.default_effort ? ` · 默认 ${model.default_effort}` : ''}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function PickGroup({ title, options, value, onPick }: {
  title: string; options: SwatchOption[]; value: string | null; onPick: (id: string) => void;
}) {
  return (
    <div style={{ marginBottom: 20 }}>
      <h3 style={{ fontSize: '1.02rem', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: 4, background: 'var(--warm)' }} />
        {title}
      </h3>
      <div className="pick-grid">
        {options.map((o) => (
          <button key={o.id} type="button" className={`pick-card ${value === o.id ? 'selected' : ''}`} onClick={() => onPick(o.id)}>
            {value === o.id && (
              <span className="pick-check">
                <Icon name="check" size={14} strokeWidth={3} />
              </span>
            )}
            <span className="pick-swatch" style={{ background: o.swatch }}>
              <img src={o.image} alt="" draggable={false} />
            </span>
            <span className="pick-label">{o.label}</span>
            <span className="pick-hint">{o.hint}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function StepLook(props: {
  breed: string | null; baseColor: string | null; pattern: string | null; eyes: string | null;
  setBreed: (v: string) => void; setBaseColor: (v: string) => void; setPattern: (v: string) => void; setEyes: (v: string) => void;
  customAppearance: string; setCustomAppearance: (value: string) => void;
}) {
  const chooseForMe = () => {
    props.setBreed(randomOptionId(BREED_OPTIONS));
    props.setBaseColor(randomOptionId(COLOR_OPTIONS));
    props.setPattern(randomOptionId(PATTERN_OPTIONS));
    props.setEyes(randomOptionId(EYE_OPTIONS));
  };

  return (
    <div>
      <StepTitle title="它长什么样？" sub="这些选择会固化成它的出生档案，云端画师会永远照着它画" />
      <AssistedChoice onChoose={chooseForMe} hint="不想纠结？一键配好四项外观，你仍然可以继续微调。" />
      <PickGroup title="品种" options={BREED_OPTIONS} value={props.breed} onPick={props.setBreed} />
      <PickGroup title="毛色" options={COLOR_OPTIONS} value={props.baseColor} onPick={props.setBaseColor} />
      <PickGroup title="花纹" options={PATTERN_OPTIONS} value={props.pattern} onPick={props.setPattern} />
      <PickGroup title="眼睛" options={EYE_OPTIONS} value={props.eyes} onPick={props.setEyes} />
      <AppearanceFreeformField value={props.customAppearance} onChange={props.setCustomAppearance} />
    </div>
  );
}

function StepTrait({ traits, setTraits, custom, setCustom }: {
  traits: string[]; setTraits: (v: string[]) => void; custom: string; setCustom: (v: string) => void;
}) {
  const toggle = (id: string) => {
    if (traits.includes(id)) setTraits(traits.filter((t) => t !== id));
    else if (traits.length < MAX_TRAITS) setTraits([...traits, id]);
  };
  return (
    <div>
      <StepTitle title="它是什么性子？" sub={`最多选 ${MAX_TRAITS} 个标签（已选 ${traits.length}），性格决定它的天性、旅行与说话方式`} />
      <AssistedChoice
        onChoose={() => setTraits(randomOptionIds(TRAIT_OPTIONS, 3))}
        hint="交给缘分，一次挑好 3 个性格；不满意可以再选或手动调整。"
      />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'center' }}>
        {TRAIT_OPTIONS.map((t) => {
          const selected = traits.includes(t.id);
          return (
            <button
              key={t.id}
              type="button"
              className={`trait-chip ${selected ? 'selected' : ''}`}
              onClick={() => toggle(t.id)}
              disabled={!selected && traits.length >= MAX_TRAITS}
            >
              {selected && <Icon name="check" size={14} strokeWidth={3} />}
              {t.label}
            </button>
          );
        })}
      </div>
      <div style={{ marginTop: 14 }}>
        <p style={{ fontSize: '0.82rem', color: 'var(--ink-soft)', margin: '0 0 8px' }}>还有什么想补充的？（选填）</p>
        <textarea
          className="gs-input"
          rows={2}
          maxLength={60}
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder="例如：最喜欢在下雨天睡觉…"
        />
      </div>
    </div>
  );
}

function AssistedChoice({ onChoose, hint }: { onChoose: () => void; hint: string }) {
  return (
    <div className="assisted-choice">
      <span>{hint}</span>
      <button type="button" className="gs-btn gs-btn--ghost gs-btn--small" onClick={onChoose}>
        <Icon name="sparkle" size={16} strokeWidth={2.2} />
        帮我选择
      </button>
    </div>
  );
}

function randomOptionId<T extends { id: string }>(options: readonly T[]): string {
  return options[Math.floor(Math.random() * options.length)]!.id;
}

function randomOptionIds<T extends { id: string }>(options: readonly T[], count: number): string[] {
  const pool = [...options];
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [pool[index], pool[swapIndex]] = [pool[swapIndex]!, pool[index]!];
  }
  return pool.slice(0, count).map((option) => option.id);
}

function StepName({ name, setName, breed, baseColor, pattern, eyes, personality, attrs, error }: {
  name: string; setName: (v: string) => void;
  breed: string | null; baseColor: string | null; pattern: string | null; eyes: string | null;
  personality: string; attrs: Record<(typeof ATTR_KEYS)[number], number>; error: string;
}) {
  const lookText = [
    BREED_OPTIONS.find((o) => o.id === breed)?.label,
    COLOR_OPTIONS.find((o) => o.id === baseColor)?.label,
    PATTERN_OPTIONS.find((o) => o.id === pattern)?.label,
    EYE_OPTIONS.find((o) => o.id === eyes)?.label + '眼',
  ].filter(Boolean).join(' · ');

  return (
    <div>
      <StepTitle title="最后，给它起个名字" sub="名字定下来，就要见面了" />
      <input
        className="gs-input"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="例如：小云、団子、Momo…"
        maxLength={20}
        style={{ fontSize: '1.15rem', textAlign: 'center', fontFamily: 'var(--font-display)' }}
      />
      <div style={{ marginTop: 18, background: '#fff', border: '2px dashed var(--paper-edge)', borderRadius: 14, padding: '14px 18px', fontSize: '0.88rem', lineHeight: 1.9 }}>
        <div><strong style={{ color: 'var(--warm-deep)' }}>外貌</strong>　{lookText}</div>
        <div><strong style={{ color: 'var(--grass-deep)' }}>性格</strong>　{personality || '还没选'}</div>
        <div>
          <strong style={{ color: 'var(--sky-deep)' }}>天性</strong>　
          {ATTR_KEYS.map((k) => `${ATTR_META[k].label} ${attrs[k]}`).join(' / ')}
        </div>
      </div>
      {error && <p style={{ color: 'var(--danger)', fontSize: '0.85rem', marginTop: 10, textAlign: 'center' }}>{error}</p>}
    </div>
  );
}

/* ---------------- 召唤等待与揭晓 ---------------- */

const SUMMON_LINES = [
  '云端画师正在调色…',
  '正在给它梳毛…',
  '它睁开了眼睛…',
  '它在学习怎么喵喵叫…',
  '快好了，它正在挑一朵云坐下…',
];

function StepSummon({ initialCat, models, selectedModel, customAppearance, onModelChange, onChangePat, onEditAppearance, onEnter }: {
  initialCat: CatProfile | null;
  models: QcaModelOption[];
  selectedModel: string;
  customAppearance: string;
  onModelChange: (model: string) => void;
  onChangePat?: () => void;
  onEditAppearance: () => void;
  onEnter: () => void;
}) {
  const [cat, setCat] = useState<CatProfile | null>(initialCat);
  const [lineIdx, setLineIdx] = useState(0);
  const [selectedAppearance, setSelectedAppearance] = useState(initialCat?.selected_birth_appearance_id || '');
  const [actionError, setActionError] = useState('');
  const [regenerating, setRegenerating] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const status = cat?.appearance_status;
  const candidates = cat?.appearance_candidates || [];
  const imageAlert = cat?.image_generation_alert;
  const imageError = cat?.image_generation_error;
  const busy = status === 'pending' || status === 'generating' || regenerating;

  useEffect(() => {
    if (!busy) return;
    const poll = setInterval(async () => {
      try {
        const c = await api.getCat();
        setCat(c);
        if (c.appearance_status !== 'pending' && c.appearance_status !== 'generating') setRegenerating(false);
        const latest = c.appearance_candidates?.at(-1);
        if (latest) setSelectedAppearance((current) => current || latest.id);
      } catch { /* 轮询失败忽略，下次重试 */ }
    }, 2500);
    const rotate = setInterval(() => setLineIdx((i) => (i + 1) % SUMMON_LINES.length), 2800);
    return () => { clearInterval(poll); clearInterval(rotate); };
  }, [busy]);

  const cancelDrawing = async () => {
    setActionError('');
    setCancelling(true);
    try {
      await api.cancelAppearance();
      const refreshed = await api.getCat();
      setCat(refreshed);
      setRegenerating(false);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '取消绘制失败');
    } finally {
      setCancelling(false);
    }
  };

  if (busy && candidates.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '30px 0 20px' }}>
        <div style={{ position: 'relative', width: 150, height: 150, margin: '0 auto 24px' }}>
          <div
            style={{
              position: 'absolute', inset: 0, borderRadius: '50%',
              background: 'radial-gradient(circle, rgba(242,204,96,0.5) 0%, rgba(242,204,96,0) 70%)',
              animation: 'glow-pulse 2s ease-in-out infinite',
            }}
          />
          <div
            style={{
              position: 'absolute', inset: 18, borderRadius: '50%',
              background: 'radial-gradient(circle at 40% 32%, #fff, #dcedf7)',
              border: '3px solid rgba(255,255,255,0.9)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              animation: 'float-y 3s ease-in-out infinite',
              boxShadow: '0 16px 36px rgba(61,64,91,0.2)',
            }}
          >
            <Icon name="sparkle" size={52} color="var(--warm)" strokeWidth={1.6} />
          </div>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              style={{
                position: 'absolute',
                left: `${25 + i * 28}%`,
                bottom: 6,
                animation: `sparkle-drift 2.4s ease-out ${i * 0.7}s infinite`,
              }}
            >
              <Icon name="star" size={14} color="var(--gold)" filled />
            </span>
          ))}
        </div>
        <h2 style={{ fontSize: '1.4rem', letterSpacing: '0.1em' }}>{cat ? `${cat.name} 正在诞生` : '正在生成小猫'}</h2>
        <p style={{ color: 'var(--ink-soft)', fontSize: '0.9rem', marginTop: 10, minHeight: '1.5em' }}>
          {SUMMON_LINES[lineIdx]}
        </p>
        <p style={{ fontSize: '0.75rem', color: 'var(--ink-soft)', opacity: 0.7, marginTop: 20 }}>
          绘制大约需要一分钟，可以先想想见面第一句话说什么
        </p>
        {actionError && <p style={{ color: 'var(--danger)', fontSize: '0.85rem' }}>{actionError}</p>}
        <button type="button" className="gs-btn gs-btn--ghost" onClick={cancelDrawing} disabled={cancelling} style={{ marginTop: 16 }}>
          {cancelling ? '正在取消…' : '取消绘制'}
        </button>
      </div>
    );
  }

  const regenerate = async () => {
    setActionError('');
    setRegenerating(true);
    try {
      await api.regenerateAppearance(selectedModel || undefined, customAppearance.trim() || undefined);
      setCat((current) => current ? { ...current, appearance_status: 'pending' } : current);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '重画失败');
      setRegenerating(false);
    }
  };

  const confirm = async () => {
    if (!selectedAppearance) return;
    setActionError('');
    setConfirming(true);
    try {
      await api.confirmAppearance(selectedAppearance);
      onEnter();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '确认失败');
      setConfirming(false);
    }
  };

  return (
    <div style={{ textAlign: 'center', padding: '16px 0 8px', animation: 'pop-in 0.4s cubic-bezier(0.34, 1.4, 0.64, 1)' }}>
      {onChangePat && (
        <div style={{ textAlign: 'left', marginBottom: 8 }}>
          <button
            type="button"
            className="gs-btn gs-btn--ghost gs-btn--small"
            onClick={onChangePat}
            disabled={busy || confirming}
            title={busy || confirming ? '请等待当前图片任务结束后再更换 PAT' : undefined}
          >
            <Icon name="arrowLeft" size={16} strokeWidth={2.4} />
            上一步：更换 PAT
          </button>
        </div>
      )}
      <h2 style={{ fontSize: '1.5rem', letterSpacing: '0.12em', marginBottom: 8 }}>挑一张最像它的照片</h2>
      <p style={{ fontSize: '0.82rem', color: 'var(--ink-soft)', margin: '0 auto 16px' }}>
        每次重画都会消耗你的 Qoder Credits，满意后再确认进入世界。
      </p>
      {candidates.length > 0 ? (
        <>
          <div style={{ display: 'inline-block', animation: 'float-y 4s ease-in-out infinite' }}>
            <CatAvatar
              name={cat?.name}
              imageUrl={candidates.find((candidate) => candidate.id === selectedAppearance)?.image_url || candidates.at(-1)?.image_url}
              status="ready"
              size={230}
            />
          </div>
          <div style={{ display: 'flex', gap: 10, overflowX: 'auto', padding: '12px 4px', justifyContent: 'center' }}>
            {candidates.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                onClick={() => setSelectedAppearance(candidate.id)}
                style={{
                  border: candidate.id === selectedAppearance ? '3px solid var(--warm)' : '2px solid var(--paper-edge)',
                  borderRadius: 12,
                  padding: 3,
                  background: '#fff',
                  flex: '0 0 auto',
                }}
              >
                <CatImage src={candidate.image_url} alt={`${cat?.name || '小猫'}候选形象`} style={{ width: 72, height: 72, borderRadius: 8, objectFit: 'cover', display: 'block' }} />
              </button>
            ))}
          </div>
        </>
      ) : (
        imageAlert ? (
          <QcaCreditsRecoveryCard
            alert={imageAlert}
            onRecovered={async () => {
              const refreshed = await api.getCat();
              setCat(refreshed);
              setRegenerating(refreshed.appearance_status === 'pending' || refreshed.appearance_status === 'generating');
            }}
          />
        ) : (
          <div style={{ padding: 20, color: 'var(--warm-deep)', lineHeight: 1.7 }}>
            {imageError?.message || '云端画师这次没有画完，请稍后再试。'}
          </div>
        )
      )}
      {models.length > 0 && (
        <select
          className="gs-input"
          value={selectedModel}
          onChange={(event) => onModelChange(event.target.value)}
          disabled={busy}
          style={{ maxWidth: 360, margin: '8px auto' }}
        >
          {models.map((model) => <option key={model.id} value={model.id}>{model.display_name}</option>)}
        </select>
      )}
      {busy && <p style={{ color: 'var(--ink-soft)', fontSize: '0.85rem' }}>{SUMMON_LINES[lineIdx]}</p>}
      {actionError && <p style={{ color: 'var(--danger)', fontSize: '0.85rem' }}>{actionError}</p>}
      <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginTop: 16, flexWrap: 'wrap' }}>
        {busy ? (
          <button type="button" className="gs-btn gs-btn--ghost" onClick={cancelDrawing} disabled={cancelling || confirming}>
            {cancelling ? '正在取消…' : '取消绘制'}
          </button>
        ) : (
          <>
            <button type="button" className="gs-btn gs-btn--ghost" onClick={regenerate} disabled={confirming}>再画一张</button>
            <button type="button" className="gs-btn gs-btn--ghost" onClick={onEditAppearance} disabled={confirming}>修改外观</button>
          </>
        )}
        <button type="button" className="gs-btn gs-btn--big" onClick={confirm} disabled={!selectedAppearance || busy || confirming}>
          {confirming ? '确认中…' : '就选这张，进入世界'}
          {!confirming && <Icon name="arrowRight" size={20} strokeWidth={2.4} />}
        </button>
      </div>
      <h3 style={{ fontSize: '1.25rem', marginTop: 14 }}>{cat?.name}</h3>
    </div>
  );
}
