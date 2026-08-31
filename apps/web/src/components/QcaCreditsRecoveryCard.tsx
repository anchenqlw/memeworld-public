import { useRef, useState } from 'react';
import { api, ApiError, type QcaUserAlert } from '../api/client';
import { Icon } from './ui/Icon';

type Props = {
  alert: QcaUserAlert;
  compact?: boolean;
  onRecovered: () => void | Promise<void>;
};

type RecoveryState = 'idle' | 'checking' | 'still_unavailable' | 'temporary_error' | 'restored';

export function QcaCreditsRecoveryCard({ alert, compact = false, onRecovered }: Props) {
  const [state, setState] = useState<RecoveryState>('idle');
  const [message, setMessage] = useState('');
  const checkingRef = useRef(false);

  const recheck = async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setState('checking');
    setMessage('正在听一听云端的回音…');
    try {
      const result = await api.recheckQcaCredits();
      setState('restored');
      setMessage(result.message);
      await onRecovered();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'QCA_CREDITS_STILL_UNAVAILABLE') {
        setState('still_unavailable');
        setMessage('好像还没有同步过来。充值完成后可能要等一小会儿，再确认一次就好。');
      } else if (error instanceof ApiError && error.code === 'QCA_PAT_INVALID') {
        setState('temporary_error');
        setMessage('云端契约需要重新连接。你的小猫和相册都好好的，可以到设置里检查一下。');
      } else {
        setState('temporary_error');
        setMessage('云端暂时没有回音。小猫会在这里等你，稍后再试就好。');
      }
    } finally {
      checkingRef.current = false;
    }
  };

  return (
    <section className={`qca-recovery-card${compact ? ' qca-recovery-card--compact' : ''}`} role="alert" aria-live="polite">
      <div className="qca-recovery-card__glow" aria-hidden="true">
        <Icon name="sparkle" size={compact ? 24 : 30} color="var(--gold)" strokeWidth={1.8} />
      </div>
      <div className="qca-recovery-card__body">
        <strong>小猫在云朵上歇一会儿</strong>
        <p>{alert.message} 你的契约没有丢，已经留下的照片和记忆也都在。</p>
        {message && (
          <p className={`qca-recovery-card__status qca-recovery-card__status--${state}`} role="status">
            {message}
          </p>
        )}
        <div className="qca-recovery-card__actions">
          <a className="gs-btn gs-btn--ghost gs-btn--small" href={alert.help_url} target="_blank" rel="noreferrer">
            去补充云端能量
          </a>
          <button
            type="button"
            className="gs-btn gs-btn--small"
            onClick={() => void recheck()}
            disabled={state === 'checking' || state === 'restored'}
          >
            {state === 'checking' ? '正在确认…' : state === 'restored' ? '已经恢复' : '我已完成充值'}
          </button>
        </div>
      </div>
    </section>
  );
}
