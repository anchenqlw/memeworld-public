import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type BondState, type CatProfile, type GrowthTagSummary, type ReturnMessage, type VisibleMemory, type WeeklyRecap } from '../../api/client';
import {
  ATTR_GROWTH_HINT,
  ATTR_KEYS,
  ATTR_META,
  attrLevelLabel,
  BREED_OPTIONS,
  COLOR_OPTIONS,
  EYE_OPTIONS,
  PATTERN_OPTIONS,
} from '../../game/catOptions';
import { Icon } from '../ui/Icon';
import { Overlay } from '../ui/Overlay';
import { ImageLightbox } from '../ui/Lightbox';
import { CatAvatar } from '../CatAvatar';
import { CareDiagnosisCard, careDiagnosisFor } from '../CareDiagnosisCard';
import { AppearanceRepaintCard } from '../AppearanceRepaintCard';

type Props = {
  cat: CatProfile;
  onChanged: () => void;
  onClose: () => void;
  /** #072：「需要照看」诊断卡的「检查 PAT」入口——跳到设置面板 */
  onOpenSettings?: () => void;
};

export function personalityDraftForEdit(
  editing: boolean,
  draft: { name: string; personality: string },
  cat: Pick<CatProfile, 'name' | 'personality'>,
) {
  return editing ? draft : { name: cat.name, personality: cat.personality };
}

type PersonalityEditorTarget = Pick<HTMLTextAreaElement, 'scrollIntoView' | 'focus'>;

export type OpenPersonalityEditorDeps = {
  editing: boolean;
  draft: { name: string; personality: string };
  cat: Pick<CatProfile, 'name' | 'personality'>;
  setName: (value: string) => void;
  setPersonality: (value: string) => void;
  setError: (value: string) => void;
  setEditing: (value: boolean) => void;
  schedule: (callback: () => void) => void;
  target: () => PersonalityEditorTarget | null;
};

export function createOpenPersonalityEditor(deps: OpenPersonalityEditorDeps) {
  return () => {
    const draft = personalityDraftForEdit(deps.editing, deps.draft, deps.cat);
    deps.setName(draft.name);
    deps.setPersonality(draft.personality);
    deps.setError('');
    deps.setEditing(true);
    deps.schedule(() => {
      const target = deps.target();
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target?.focus();
    });
  };
}

export function PersonalityEditRepaintCard(props: {
  cat: CatProfile;
  onChanged: () => void;
  editor: OpenPersonalityEditorDeps;
}) {
  return (
    <AppearanceRepaintCard
      cat={props.cat}
      onChanged={props.onChanged}
      onEditPersonality={createOpenPersonalityEditor(props.editor)}
    />
  );
}

/**
 * 猫咪档案：查看出生信息 + 编辑名字/性格。
 * 外貌出生即定（生图一致性锚点，只读）；天性由出生派生 + 旅行成长，只读展示。
 */
export function ProfilePanel({ cat, onChanged, onClose, onOpenSettings }: Props) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(cat.name);
  const [personality, setPersonality] = useState(cat.personality);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [savedTip, setSavedTip] = useState(false);
  const [zoomImg, setZoomImg] = useState(false);
  const [memories, setMemories] = useState<VisibleMemory[]>([]);
  const [bond, setBond] = useState<BondState | null>(null);
  const [recap, setRecap] = useState<WeeklyRecap | null>(null);
  const [returnMessage, setReturnMessage] = useState<ReturnMessage | null>(null);
  const [growth, setGrowth] = useState<GrowthTagSummary>({ source_count: 0, tags: [] });
  const [editingMemory, setEditingMemory] = useState<VisibleMemory | null>(null);
  const [memoryText, setMemoryText] = useState('');
  const personalityInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    Promise.all([api.memories(), api.bond(), api.weeklyRecap(), api.returnMessage(), api.growthTags()]).then(([memoryResult, bondResult, recapResult, returnResult, growthResult]) => {
      setMemories(memoryResult.memories); setBond(bondResult); setRecap(recapResult); setReturnMessage(returnResult); setGrowth(growthResult);
    }).catch(() => undefined);
  }, []);

  const forget = async (memory: VisibleMemory) => {
    await api.deleteMemory(memory.question_id);
    setMemories((current) => current.filter((item) => item.id !== memory.id));
  };
  const correctMemory = async () => {
    if (!editingMemory || !memoryText.trim()) return;
    await api.saveOnboardingAnswers([{ question_id: editingMemory.question_id, answer_text: memoryText.trim() }]);
    const result = await api.memories(); setMemories(result.memories); setEditingMemory(null); setMemoryText('');
  };

  const lookText = useMemo(() => {
    const a = cat.appearance;
    return [
      a?.breed ? BREED_OPTIONS.find((o) => o.id === a.breed)?.label || a.breed : null,
      COLOR_OPTIONS.find((o) => o.id === a?.baseColor)?.label || a?.baseColor,
      PATTERN_OPTIONS.find((o) => o.id === a?.pattern)?.label || a?.pattern,
      (EYE_OPTIONS.find((o) => o.id === a?.eyes)?.label || a?.eyes) + '眼',
    ].filter(Boolean).join(' · ');
  }, [cat.appearance]);

  const dirty = name.trim() !== cat.name || personality.trim() !== cat.personality;
  // #072：status=broken 时档案顶部显示「需要照看」诊断；非 broken 不显示
  const careDiagnosis = careDiagnosisFor(cat);

  const startEdit = () => {
    const draft = personalityDraftForEdit(editing, { name, personality }, cat);
    setName(draft.name);
    setPersonality(draft.personality);
    setError('');
    setEditing(true);
  };

  const personalityEditor = {
    editing,
    draft: { name, personality },
    cat,
    setName,
    setPersonality,
    setError,
    setEditing,
    schedule: requestAnimationFrame,
    target: () => personalityInputRef.current,
  };

  const save = async () => {
    setError('');
    if (!name.trim()) { setError('名字不能为空'); return; }
    if (!personality.trim()) { setError('性格不能为空'); return; }
    setSaving(true);
    try {
      await api.updateCat({ name: name.trim(), personality: personality.trim().slice(0, 200) });
      setEditing(false);
      setSavedTip(true);
      setTimeout(() => setSavedTip(false), 3000);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败，请重试');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Overlay
      title="猫咪档案"
      icon="paw"
      onClose={onClose}
      headExtra={
        !editing ? (
          <button type="button" className="gs-btn gs-btn--ghost gs-btn--small" onClick={startEdit}>
            编辑档案
          </button>
        ) : undefined
      }
    >
      {careDiagnosis && (
        <CareDiagnosisCard diagnosis={careDiagnosis} onOpenSettings={onOpenSettings} onChanged={onChanged} />
      )}

      {/* 头部：画像（点击放大） + 名字 */}
      <div style={{ display: 'flex', gap: 18, alignItems: 'center', marginBottom: 18 }}>
        <div
          style={{ flexShrink: 0, cursor: cat.current_image_url ? 'zoom-in' : 'default' }}
          onClick={() => cat.current_image_url && setZoomImg(true)}
          title={cat.current_image_url ? '点击放大' : undefined}
        >
          <CatAvatar imageUrl={cat.current_image_url} status={cat.appearance_status} name={cat.name} size={110} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          {editing ? (
            <input
              className="gs-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={20}
              style={{ fontSize: '1.15rem', fontFamily: 'var(--font-display)', marginBottom: 6 }}
            />
          ) : (
            <h3 style={{ fontSize: '1.5rem', letterSpacing: '0.06em', display: 'flex', alignItems: 'center', gap: 10 }}>
              {cat.name}
              {savedTip && <span style={{ fontSize: '0.7rem', color: 'var(--grass-deep)', fontWeight: 700 }}>档案已更新</span>}
            </h3>
          )}
          <p style={{ margin: '4px 0 0', fontSize: '0.78rem', color: 'var(--ink-soft)', display: 'flex', alignItems: 'center', gap: 5 }}>
            <Icon name="sparkle" size={13} color="var(--warm-deep)" strokeWidth={2} />
            {cat.created_at ? `${cat.created_at.slice(0, 10)} 诞生于云端` : '诞生于云端'}
          </p>
          <p style={{ margin: '4px 0 0', fontSize: '0.78rem', color: 'var(--ink-soft)', display: 'flex', alignItems: 'center', gap: 5 }}>
            <Icon name="cloud" size={13} color="var(--sky-deep)" strokeWidth={2} />
            {lookText}
          </p>
        </div>
      </div>

      {/* #077：形象重画申诉——仅形象确认后可见；新图须用户明确确认才替换主形象 */}
      <PersonalityEditRepaintCard cat={cat} onChanged={onChanged} editor={personalityEditor} />

      {/* 性格 */}
      <h4 style={{ fontSize: '0.95rem', margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: 4, background: 'var(--grass-deep)' }} />
        性格
      </h4>
      {editing ? (
        <textarea
          ref={personalityInputRef}
          className="gs-input"
          rows={3}
          maxLength={200}
          value={personality}
          onChange={(e) => setPersonality(e.target.value)}
          placeholder="它是什么性子？（≤200 字，会影响旅行与说话方式）"
        />
      ) : (
        <p style={{ margin: 0, fontSize: '0.88rem', lineHeight: 1.75, background: '#fff', border: '2px solid var(--paper-edge)', borderRadius: 12, padding: '10px 14px' }}>
          {cat.personality}
        </p>
      )}

      {/* 天性（只读：出生派生 + 旅行成长） */}
      <h4 style={{ fontSize: '0.95rem', margin: '16px 0 10px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: 4, background: 'var(--warm)' }} />
        天性
        <span style={{ fontSize: '0.7rem', fontWeight: 400, color: 'var(--ink-soft)' }}>随旅行自然成长</span>
      </h4>
      {ATTR_KEYS.map((key) => (
        <div
          key={key}
          className="attr-row"
          style={{ marginBottom: 10 }}
          title={`${ATTR_META[key].desc}｜${ATTR_GROWTH_HINT}`}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, width: 74, fontWeight: 700, fontSize: '0.86rem' }}>
            <Icon name={ATTR_META[key].icon} size={17} color="var(--warm-deep)" strokeWidth={2.2} />
            {ATTR_META[key].label}
          </span>
          <div className="attr-track" style={{ height: 12 }}>
            <div className="attr-fill" style={{ width: `${cat.attrs[key] * 10}%` }} />
          </div>
          <strong style={{ width: 40, textAlign: 'right', fontSize: '0.9rem', whiteSpace: 'nowrap' }}>
            {cat.attrs[key]}<span style={{ fontWeight: 400, color: 'var(--ink-soft)', fontSize: '0.68rem' }}>/10</span>
          </strong>
          <span style={{ marginLeft: 8, fontSize: '0.72rem', color: 'var(--ink-soft)', whiteSpace: 'nowrap' }}>
            {attrLevelLabel(cat.attrs[key])}
          </span>
        </div>
      ))}

      <section style={{ marginTop: 16 }}>
        <h4 style={{ margin: '0 0 8px', fontSize: '0.95rem' }}>长出来的技能与兴趣</h4>
        {growth.tags.length === 0 ? (
          <p style={{ margin: 0, color: 'var(--ink-soft)', fontSize: '0.8rem' }}>喂养成长卡片后，它会在这里长出更像你的标签。</p>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {growth.tags.map((tag) => <span key={tag.name} style={{ padding: '5px 10px', borderRadius: 999, background: '#fff8ef', border: '1.5px solid var(--paper-edge)', fontSize: '0.74rem' }}>{tag.name} · {tag.source_count}</span>)}
          </div>
        )}
        {growth.source_count > 0 && <p style={{ margin: '7px 0 0', fontSize: '0.7rem', color: 'var(--ink-soft)' }}>来自 {growth.source_count} 张主人确认的成长卡片</p>}
      </section>

      {bond && (
        <section style={{ marginTop: 18, padding: '12px 14px', borderRadius: 14, background: '#fff8ef', border: '2px solid var(--paper-edge)' }}>
          <h4 style={{ margin: 0, fontSize: '0.95rem' }}>我们的羁绊</h4>
          <strong style={{ display: 'block', marginTop: 5, color: 'var(--warm-deep)' }}>{bond.label}</strong>
          <p style={{ margin: '5px 0 0', color: 'var(--ink-soft)', fontSize: '0.78rem' }}>{bond.reason}</p>
          <p style={{ margin: '8px 0 0', fontSize: '0.78rem' }}>{bond.story.message}</p>
          {bond.story.step < bond.story.total && (
            <p style={{ margin: '4px 0 0', fontSize: '0.7rem', color: 'var(--ink-soft)', display: 'flex', alignItems: 'center', gap: 5 }}>
              <Icon name="compass" size={12} strokeWidth={2} />
              回应它寄回的来信、带它出门旅行，都能推进这段故事
            </p>
          )}
          <p style={{ margin: '8px 0 0', fontSize: '0.74rem', color: 'var(--ink-soft)' }}>现在会：{bond.unlocks.join('、')}</p>
        </section>
      )}

      <section style={{ marginTop: 16 }}>
        <h4 style={{ margin: '0 0 8px', fontSize: '0.95rem' }}>它记住的事</h4>
        {memories.length === 0 ? <p style={{ color: 'var(--ink-soft)', fontSize: '0.8rem' }}>你还没有告诉它这些事。</p> : memories.map((memory) => (
          <div key={memory.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 10px', marginBottom: 6, borderRadius: 10, background: '#fff', border: '1.5px solid var(--paper-edge)' }}>
            <span style={{ flex: 1, fontSize: '0.8rem' }}>{memory.memory_digest}</span>
            <button type="button" onClick={() => { setEditingMemory(memory); setMemoryText(memory.answer_text || ''); }} style={{ border: 0, background: 'transparent', color: 'var(--sky-deep)', cursor: 'pointer' }}>纠正</button>
            <button type="button" onClick={() => forget(memory)} aria-label="让它忘记这条记忆" style={{ border: 0, background: 'transparent', color: 'var(--ink-soft)', cursor: 'pointer' }}>忘记</button>
          </div>
        ))}
      </section>

      {editingMemory && <div style={{ marginTop: 10, display: 'flex', gap: 8 }}><input className="gs-input" maxLength={100} value={memoryText} onChange={(event) => setMemoryText(event.target.value)} /><button type="button" className="gs-btn gs-btn--small" onClick={correctMemory}>改好啦</button></div>}

      {returnMessage && <section style={{ marginTop: 16, padding: '10px 12px', borderRadius: 12, background: '#fff8ef', fontSize: '0.8rem' }}><p style={{ margin: 0 }}>{returnMessage.message}</p>{returnMessage.unfinished && <p style={{ margin: '6px 0 0', color: 'var(--warm-deep)' }}>还没讲完：{returnMessage.unfinished}</p>}</section>}

      {recap && (
        <section style={{ marginTop: 16, padding: '12px 14px', borderRadius: 14, background: '#f3f8ff' }}>
          <h4 style={{ margin: 0 }}>{recap.title}</h4>
          <p style={{ margin: '6px 0', color: 'var(--ink-soft)', fontSize: '0.8rem' }}>{recap.message}</p>
          {recap.travels.slice(0, 3).map((travel) => <div key={travel.id} style={{ fontSize: '0.76rem', marginTop: 4 }}>· {travel.travel_date} {travel.location_name}：{travel.title || '一段小小旅行'}</div>)}
        </section>
      )}

      {editing && (
        <>
          {error && <p style={{ color: 'var(--danger)', fontSize: '0.8rem', margin: '8px 0 0' }}>{error}</p>}
          <p style={{ fontSize: '0.72rem', color: 'var(--ink-soft)', margin: '10px 0 12px', display: 'flex', alignItems: 'center', gap: 5 }}>
            <Icon name="compass" size={13} strokeWidth={2} />
            保存后会同步给云端的它——性格变了，旅行风格也会跟着变
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="gs-btn gs-btn--ghost gs-btn--small" onClick={() => setEditing(false)} disabled={saving}>
              取消
            </button>
            <button type="button" className="gs-btn gs-btn--small" onClick={save} disabled={saving || !dirty}>
              {saving ? '保存中…' : '保存档案'}
            </button>
          </div>
        </>
      )}

      {zoomImg && cat.current_image_url && (
        <ImageLightbox src={cat.current_image_url} caption={cat.name} onClose={() => setZoomImg(false)} />
      )}
    </Overlay>
  );
}
