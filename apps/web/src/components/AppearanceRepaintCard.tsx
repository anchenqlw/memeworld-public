import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type CatProfile } from '../api/client';
import { CatImage } from './CatImage';
import { Icon } from './ui/Icon';
import { appearanceRepaintViewFor, createRepaintFlow } from './appearanceRepaintFlow';

/**
 * #077：形象重画申诉卡（档案面板内）。
 *
 * 背景：`prop_b484a28c`「希望我的猫不再是五只脚」——生图偶发肢体异常，而形象一旦确认
 * （lifecycle_stage 非 appearance）此前没有任何自助出口。
 *
 * 两条硬语义（分支与动作序列都在 appearanceRepaintFlow.ts，可被测试直接驱动）：
 * 1. 入口只在形象确认后可见，由服务端 appearance_repaint.eligible 决定；
 * 2. 不静默换猫（#024）：重画只产生候选图，用户二次确认才替换主形象，
 *    「保留原来的它」是同等地位的另一条出口。
 */

type Props = {
  cat: Pick<CatProfile, 'appearance_repaint'>;
  /** 申请 / 替换 / 保留成功后刷新档案 */
  onChanged: () => void;
  /** #108：跳到档案里唯一的性格编辑入口，不在重画流程复制一份表单。 */
  onEditPersonality: () => void;
};

export const CUSTOM_APPEARANCE_MAX_LENGTH = 60;

export function validateCustomAppearanceInput(value: string): string {
  const normalized = value.trim().replace(/\s+/gu, ' ');
  if (!normalized) return '';
  if (Array.from(normalized).length > CUSTOM_APPEARANCE_MAX_LENGTH) return `外貌描述最多 ${CUSTOM_APPEARANCE_MAX_LENGTH} 个字`;
  if (!/^[\p{L}\p{N}\p{M}\s，。！？、,.!?:：;；'"“”‘’（）()·—-]+$/u.test(normalized)) {
    return '请只填写毛发、花纹、体型等可见特征，不要使用特殊符号';
  }
  if (/ignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|prompts?)|(?:reveal|show|print|repeat)\s+(?:the\s+)?(?:system|developer)\s+(?:prompt|instructions?)|system\s*prompt|\b(?:style|composition|camera|lens|lighting)\b|\b(?:draw|paint|render|generate|change|replace|remove|add)\b|忽略(?:之前|以上|前面|所有)?(?:的)?(?:指令|提示|要求)|(?:显示|泄露|输出|复述)(?:系统|开发者)(?:提示词|指令)|(?:风格|构图|镜头|相机参数)|(?:请|必须|不要|改成|换成|画成|绘制|生成)/iu.test(normalized)) {
    return '请只描述小猫的外貌，不要加入要求画师执行的指令';
  }
  return '';
}

export function AppearanceFreeformField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const error = validateCustomAppearanceInput(value);
  return (
    <div style={{ marginTop: 12 }}>
      <label htmlFor="appearance-freeform-input" style={{ display: 'block', fontSize: '0.8rem', marginBottom: 6 }}>
        还有哪些只有你知道的外貌特征？（选填）
      </label>
      <textarea
        id="appearance-freeform-input"
        data-testid="appearance-freeform-input"
        className="gs-input"
        rows={2}
        maxLength={CUSTOM_APPEARANCE_MAX_LENGTH}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="例如：长毛狮子猫，尾巴尖有点黑…"
      />
      <p
        data-testid="appearance-freeform-error"
        hidden={!error}
        style={{ color: 'var(--danger)', fontSize: '0.72rem', margin: '6px 0 0' }}
      >
        {error}
      </p>
    </div>
  );
}

export function PersonalityEditLink({ onEditPersonality }: Pick<Props, 'onEditPersonality'>) {
  return (
    <button
      type="button"
      onClick={onEditPersonality}
      style={{ border: 0, padding: 0, background: 'transparent', color: 'var(--warm-deep)', fontWeight: 700, cursor: 'pointer', textDecoration: 'underline' }}
    >
      去改性格
    </button>
  );
}

export function AppearanceRepaintCard({ cat, onChanged, onEditPersonality }: Props) {
  const view = appearanceRepaintViewFor(cat);
  const [customDescription, setCustomDescription] = useState('');
  const customDescriptionError = validateCustomAppearanceInput(customDescription);
  // onChanged 每次渲染都是新引用；flow 只建一次，回调走 ref 以免拿到过期闭包
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const flow = useMemo(
    () => createRepaintFlow(
      {
        request: (description) => api.requestAppearanceRepaint(description),
        confirm: (id) => api.confirmAppearanceRepaint(id),
        discard: () => api.discardAppearanceRepaint(),
      },
      () => onChangedRef.current(),
    ),
    [],
  );
  const [flowState, setFlowState] = useState(flow.getState());
  useEffect(() => flow.subscribe(() => setFlowState(flow.getState())), [flow]);

  if (!view) return null;
  const { busy, notice, error, stage } = flowState;

  return (
    <section
      data-testid="appearance-repaint-card"
      style={{
        marginTop: 16, padding: '12px 14px', borderRadius: 14,
        background: '#fff8ef', border: '2px solid var(--paper-edge)',
      }}
    >
      <h4 style={{ margin: 0, fontSize: '0.95rem', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: 4, background: 'var(--warm)' }} />
        它画得不像它？
      </h4>
      <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 10, background: '#fff' }}>
        <span style={{ fontSize: '0.78rem', lineHeight: 1.6 }}>想改它的性格？</span>{' '}
        <PersonalityEditLink onEditPersonality={onEditPersonality} />
      </div>

      {view.mode === 'decide' ? (
        <>
          <p style={{ margin: '8px 0 0', fontSize: '0.8rem', lineHeight: 1.7 }}>
            新的定妆照画好了。看看是不是更像它——<strong>你确认之后才会替换主形象</strong>，也可以保留原来的它。
          </p>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10 }}>
            <CatImage
              src={view.candidate.image_url}
              alt="重画的新形象"
              style={{
                width: 96, height: 96, borderRadius: 12, objectFit: 'cover',
                border: '2px solid var(--paper-edge)', background: '#fff',
              }}
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {stage === 'confirming' ? (
                <>
                  <span style={{ fontSize: '0.78rem', color: 'var(--warm-deep)' }}>
                    换成这一张后，它以后就是这个样子；原来那张图不会被删掉，只是不再作为主形象。
                  </span>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button
                      type="button" className="gs-btn gs-btn--small" disabled={busy}
                      onClick={() => flow.confirmReplace(view.candidate.id)}
                    >
                      {busy ? '替换中…' : '确认替换'}
                    </button>
                    <button type="button" className="gs-btn gs-btn--ghost gs-btn--small" disabled={busy} onClick={() => flow.cancelReplace()}>
                      再想想
                    </button>
                  </div>
                </>
              ) : (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button type="button" className="gs-btn gs-btn--small" disabled={busy} onClick={() => flow.askReplace()}>
                    <Icon name="sparkle" size={15} strokeWidth={2.2} />
                    换成这一张
                  </button>
                  <button type="button" className="gs-btn gs-btn--ghost gs-btn--small" disabled={busy} onClick={() => flow.discard()}>
                    保留原来的它
                  </button>
                </div>
              )}
            </div>
          </div>
        </>
      ) : view.mode === 'exhausted' ? (
        <p style={{ margin: '8px 0 0', fontSize: '0.8rem', lineHeight: 1.7, color: 'var(--ink-soft)' }}>
          重画次数已经用完（{view.state.used}/{view.state.limit}）。如果它还是画得不对，来「给世界写信」告诉我们，我们帮你看看。
        </p>
      ) : (
        <>
          <p style={{ margin: '8px 0 0', fontSize: '0.8rem', lineHeight: 1.7 }}>
            如果云端画师把它画成了五只脚、多了一条尾巴这种明显不对的样子，可以请它重新画一张定妆照。
          </p>
          <p style={{ margin: '6px 0 0', fontSize: '0.76rem', lineHeight: 1.7, color: 'var(--warm-deep)' }}>
            {view.state.credits_notice}
          </p>
          <p style={{ margin: '6px 0 0', fontSize: '0.72rem', color: 'var(--ink-soft)' }}>
            还可以重画 {view.state.remaining} 次（共 {view.state.limit} 次）
          </p>
          {view.blockedReason && (
            <p style={{ margin: '6px 0 0', fontSize: '0.72rem', color: 'var(--ink-soft)' }}>{view.blockedReason}</p>
          )}
          <AppearanceFreeformField value={customDescription} onChange={setCustomDescription} />
          <div style={{ marginTop: 10 }}>
            <button
              data-testid="appearance-repaint-submit"
              type="button" className="gs-btn gs-btn--small"
              disabled={busy || Boolean(view.blockedReason) || Boolean(customDescriptionError)}
              onClick={() => flow.request(customDescription.trim() || undefined)}
            >
              <Icon name="refresh" size={15} strokeWidth={2.2} />
              {busy ? '申请中…' : '请画师重画一张'}
            </button>
          </div>
        </>
      )}

      {notice && <p role="status" style={{ margin: '8px 0 0', fontSize: '0.76rem', color: 'var(--grass-deep)' }}>{notice}</p>}
      {error && <p style={{ margin: '8px 0 0', fontSize: '0.76rem', color: 'var(--danger)' }}>{error}</p>}
    </section>
  );
}
