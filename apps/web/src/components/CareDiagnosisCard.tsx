import { useState } from 'react';
import { api, type CatProfile, type QcaDiagnosis } from '../api/client';
import { Icon } from './ui/Icon';

/**
 * #072：「需要照看」诊断卡——status=broken 时给出原因摘要（服务端脱敏）与自助修复入口。
 * 展示分支（broken 显示 / 非 broken 不显示）由 careDiagnosisFor 决定，红点语义与档案内容一致。
 */
export function careDiagnosisFor(cat: Pick<CatProfile, 'status' | 'qca_health' | 'qca_diagnosis'>): QcaDiagnosis | null {
  const broken = cat.status === 'broken' || cat.qca_health?.status === 'broken';
  if (!broken || !cat.qca_diagnosis) return null;
  return cat.qca_diagnosis;
}

type Props = {
  diagnosis: QcaDiagnosis;
  /** 提供时显示「检查 / 更换 PAT」按钮并跳到设置面板；设置面板内不传（PAT 区就在下方） */
  onOpenSettings?: () => void;
  /** 一键修复成功后刷新档案 */
  onChanged: () => void;
};

export const CARE_REPAIR_SUCCESS_NOTICE = '修复已完成，小猫的云端行囊已经恢复。';

export async function completeCareRepair(input: {
  repairAdventure: () => Promise<unknown>;
  setNotice: (notice: string) => void;
  onChanged: () => void;
}) {
  await input.repairAdventure();
  input.setNotice(CARE_REPAIR_SUCCESS_NOTICE);
  input.onChanged();
}

export function CareDiagnosisCard({ diagnosis, onOpenSettings, onChanged }: Props) {
  const [repairing, setRepairing] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  // 防连点：repairing 期间按钮禁用；服务端另有限流兜底
  const repair = async () => {
    if (repairing) return;
    setRepairing(true);
    setNotice('');
    setError('');
    try {
      await completeCareRepair({ repairAdventure: () => api.repairAdventure(), setNotice, onChanged });
    } catch (e) {
      setError(e instanceof Error ? e.message : '修复没有成功，请稍后再试');
    } finally {
      setRepairing(false);
    }
  };

  return (
    <section
      role="status"
      style={{
        marginBottom: 16, padding: '12px 14px', borderRadius: 14,
        background: '#fdf1ee', border: '2px solid rgba(200,92,92,0.35)',
      }}
    >
      <h4 style={{ margin: 0, fontSize: '0.95rem', display: 'flex', alignItems: 'center', gap: 8, color: '#8c4a52' }}>
        <span style={{ width: 8, height: 8, borderRadius: 4, background: 'var(--danger)' }} />
        需要照看
      </h4>
      <p style={{ margin: '8px 0 0', fontSize: '0.8rem', lineHeight: 1.7 }}>{diagnosis.summary}</p>
      <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: '0.78rem', color: 'var(--ink-soft)', lineHeight: 1.7 }}>
        {diagnosis.causes.map((cause) => <li key={cause}>{cause}</li>)}
      </ul>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
        {diagnosis.actions.map((action) => {
          if (action.id === 'check_pat') {
            if (!onOpenSettings) return null;
            return (
              <button key={action.id} type="button" className="gs-btn gs-btn--ghost gs-btn--small" onClick={onOpenSettings}>
                <Icon name="lock" size={15} strokeWidth={2.2} />
                {action.label}
              </button>
            );
          }
          if (action.id === 'check_credits' && action.href) {
            return (
              <a key={action.id} className="gs-btn gs-btn--ghost gs-btn--small" href={action.href} target="_blank" rel="noreferrer">
                <Icon name="sparkle" size={15} strokeWidth={2.2} />
                {action.label}
              </a>
            );
          }
          if (action.id === 'repair') {
            return (
              <button key={action.id} type="button" className="gs-btn gs-btn--small" onClick={repair} disabled={repairing}>
                <Icon name="refresh" size={15} strokeWidth={2.2} />
                {repairing ? '修复中…' : action.label}
              </button>
            );
          }
          return null;
        })}
      </div>
      {notice && <p role="status" style={{ margin: '8px 0 0', fontSize: '0.76rem', color: 'var(--grass-deep)' }}>{notice}</p>}
      {error && <p style={{ margin: '8px 0 0', fontSize: '0.76rem', color: 'var(--danger)' }}>{error}</p>}
      {diagnosis.checked_at && (
        <p style={{ margin: '8px 0 0', fontSize: '0.7rem', color: 'var(--ink-soft)' }}>
          上次检查：{formatCheckedAt(diagnosis.checked_at)}
        </p>
      )}
    </section>
  );
}

function formatCheckedAt(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
}
