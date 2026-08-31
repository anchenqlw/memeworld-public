import { useState } from 'react';
import { api, type CatProfile, type ContributionSummary, type Proposal } from '../../api/client';
import { buildClientProposalContext } from '../../lib/proposalContext';
import { Icon } from '../ui/Icon';
import { Overlay } from '../ui/Overlay';
import { proposalNextStep, PROPOSAL_REVIEW_CADENCE } from './proposalProgress';

type Props = {
  proposals: Proposal[];
  contribution: ContributionSummary;
  cat: CatProfile;
  panel?: string | null;
  lastUiError?: string;
  onSubmitted: () => void;
  onClose: () => void;
};

const STATUS_LABEL: Record<string, { text: string; color: string; bg: string }> = {
  received: { text: '已收信', color: '#7a6b28', bg: '#fdf3d8' },
  'under-review': { text: '评估中', color: '#2d6284', bg: '#e2f1f9' },
  accepted: { text: '已采纳', color: '#4e6e2c', bg: '#f2f8e4' },
  'partially-accepted': { text: '部分采纳', color: '#7a5b24', bg: '#fff2cf' },
  'in-progress': { text: '制作中', color: '#2d6284', bg: '#e2f1f9' },
  validating: { text: '待上线验证', color: '#2d6284', bg: '#e2f1f9' },
  verified: { text: '已上线', color: '#fff', bg: 'var(--grass-deep)' },
  'not-planned': { text: '未采纳', color: '#8c4a52', bg: '#fbe9eb' },
};

const EVENT_STATUS_LABEL: Record<string, { text: string; color: string; bg: string }> = {
  new: STATUS_LABEL.received,
  exported: STATUS_LABEL['under-review'],
  triaged: STATUS_LABEL['under-review'],
  accepted: STATUS_LABEL.accepted,
  'partially-accepted': STATUS_LABEL['partially-accepted'],
  'in-progress': STATUS_LABEL['in-progress'],
  rejected: STATUS_LABEL['not-planned'],
  shipped: STATUS_LABEL.validating,
  verified: STATUS_LABEL.verified,
};

/** 贡献点计数 chip 样式：0 点用中性样式，避免空状态被误读为奖励或告警（backlog #047） */
export function contributionCounterClass(points: number) {
  return points > 0
    ? 'trait-chip contribution-counter'
    : 'trait-chip contribution-counter contribution-counter--zero';
}

function formatEventTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 16).replace('T', ' ');
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

/** 皮卡反馈站：向造物主寄出 issue，参与世界进化 */
export function MailPanel({ proposals, contribution, cat, panel, lastUiError, onSubmitted, onClose }: Props) {
  const [text, setText] = useState('');
  const [type, setType] = useState<'feature' | 'bug'>('feature');
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);

  const submit = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    setFeedback(null);
    try {
      const clientContext = type === 'bug'
        ? buildClientProposalContext({
          scene: 'game',
          panel,
          cat,
          lastUiError,
        })
        : undefined;
      await api.createProposal(type, text.trim(), clientContext);
      setText('');
      setFeedback({ tone: 'success', message: '皮卡已经收到，并为它建立了独立 issue。评估与上线进展会继续显示在这里。' });
      onSubmitted();
    } catch (error) {
      setFeedback({ tone: 'error', message: error instanceof Error ? error.message : '信没有寄出去，请稍后重试' });
    } finally {
      setSending(false);
    }
  };

  return (
    <Overlay title="告诉皮卡" icon="mail" onClose={onClose}>
      <section className="pika-panel-hero">
        <img src="/assets/game/creator/pika-reply.png" alt="造物主皮卡正在阅读玩家来信" />
        <div>
          <span className="pika-kicker">造物主 Agent · 皮卡</span>
          <h3>你的每条反馈，都有回音</h3>
          <p>我会记录是谁、何时提出，评估后明确回复：不做、部分采纳、进入制作或已经上线。</p>
        </div>
      </section>

      <div className="feedback-rewards" aria-label="反馈奖励">
        <span><strong>+10</strong> 想法被采纳</span>
        <span><strong>+40</strong> 完成上线</span>
        <span><strong>礼物</strong> 勋章与造物铃</span>
        <span><strong>留名</strong> 进入编年史署上猫名</span>
      </div>

      <p style={{ fontSize: '0.84rem', color: 'var(--ink-soft)', lineHeight: 1.7, margin: '0 0 14px' }}>
        告诉皮卡你的愿望或遇到的问题；好想法不只会得到奖励，也可能真的改变所有猫能抵达的世界。
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <span className={contributionCounterClass(contribution.points)}>贡献 {contribution.points} 点</span>
        <span className="trait-chip">采纳 {contribution.accepted}</span>
        <span className="trait-chip">上线 {contribution.shipped}</span>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        {(
          [
            ['feature', '许个愿', 'sparkle'],
            ['bug', '报个问题', 'compass'],
          ] as const
        ).map(([id, label, icon]) => (
          <button
            key={id}
            type="button"
            className={`trait-chip ${type === id ? 'selected' : ''}`}
            onClick={() => setType(id)}
          >
            <Icon name={icon} size={15} strokeWidth={2.2} />
            {label}
          </button>
        ))}
      </div>

      <textarea
        className="gs-input"
        rows={3}
        maxLength={200}
        value={text}
        onChange={(e) => { setText(e.target.value); if (feedback) setFeedback(null); }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void submit();
          }
        }}
        placeholder={type === 'feature' ? '希望世界里有一片海，猫可以去看灯塔…' : '我的猫的明信片好像没有送到…'}
        aria-label={type === 'feature' ? '写下你的愿望' : '描述你遇到的问题'}
      />
      {type === 'bug' && (
        <p style={{ fontSize: '0.72rem', color: 'var(--ink-soft)', margin: '8px 0 0', lineHeight: 1.5 }}>
          报问题时我们会自动附上当前页面、时间与浏览器信息，方便造物主定位问题（不含 PAT 或聊天内容）。
        </p>
      )}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 }}>
        <span style={{ fontSize: '0.75rem', color: 'var(--ink-soft)' }}>{text.length}/200 · Cmd/Ctrl + Enter 寄出</span>
        <button type="button" className="gs-btn gs-btn--small" onClick={submit} disabled={sending || !text.trim()}>
          {sending ? '寄送中…' : '寄出'}
          <Icon name="send" size={16} strokeWidth={2.2} />
        </button>
      </div>
      {feedback && (
        <p className={`ui-feedback ui-feedback--${feedback.tone}`} role={feedback.tone === 'error' ? 'alert' : 'status'}>
          {feedback.message}
        </p>
      )}

      <h3 style={{ fontSize: '1rem', margin: '22px 0 10px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: 4, background: 'var(--sky-deep)' }} />
        我的 issue 与皮卡回复
      </h3>
      <p data-testid="proposal-review-cadence" style={{ fontSize: '0.76rem', color: 'var(--ink-soft)', lineHeight: 1.6, margin: '0 0 10px' }}>
        {PROPOSAL_REVIEW_CADENCE}
      </p>
      {proposals.length === 0 ? (
        <div className="asset-placeholder" style={{ padding: '22px 16px' }}>
          <Icon name="mail" size={28} color="var(--ink-soft)" strokeWidth={1.6} />
          <span>还没有寄出过信</span>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {proposals.map((p) => {
            const s = STATUS_LABEL[p.public_status] || STATUS_LABEL['under-review'];
            return (
              <div key={p.id} style={{ background: '#fff', border: '2px solid var(--paper-edge)', borderRadius: 12, padding: '10px 14px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span style={{ fontSize: '0.68rem', fontWeight: 700, color: s.color, background: s.bg, padding: '2px 10px', borderRadius: 999 }}>
                    {s.text}
                  </span>
                  <span style={{ fontSize: '0.7rem', color: 'var(--ink-soft)' }}>{p.created_at.slice(0, 10)}</span>
                </div>
                <p style={{ margin: 0, fontSize: '0.88rem', lineHeight: 1.6 }}>{p.content}</p>
                {p.public_note && (
                  <div className="pika-latest-reply">
                    <img src="/assets/game/creator/pika-portrait.png" alt="" />
                    <p><strong>皮卡最新回复</strong>{p.public_note}</p>
                  </div>
                )}
                {p.backlog_ref && <p style={{ margin: '4px 0 0', fontSize: '0.7rem', color: 'var(--ink-soft)' }}>进化记录：{p.backlog_ref}</p>}
                <p data-testid="proposal-next-step" style={{ margin: '6px 0 0', fontSize: '0.76rem', color: 'var(--ink-soft)', lineHeight: 1.6 }}>
                  {proposalNextStep(p.public_status)}
                </p>
                {p.contribution_points > 0 && (
                  <p style={{ margin: '4px 0 0', fontSize: '0.72rem', color: 'var(--grass-deep)', fontWeight: 700 }}>
                    +{p.contribution_points} 贡献点{p.reward_status === 'awarded' ? ' · 造物铃与造世者勋章已送达' : p.reward_status === 'pending' ? ' · 奖励将在小猫诞生后送达' : ''}
                  </p>
                )}
                {p.events?.length > 0 && (
                  <details className="proposal-timeline">
                    <summary>查看处理路径 · {p.events.length} 个节点</summary>
                    <ol>
                      {p.events.map((event) => {
                        const eventStatus = EVENT_STATUS_LABEL[event.to_status] || STATUS_LABEL['under-review'];
                        return (
                          <li key={event.id}>
                            <span style={{ background: eventStatus.bg, color: eventStatus.color }}>{eventStatus.text}</span>
                            <time>{formatEventTime(event.created_at)}</time>
                            {event.public_note && <p><strong>{event.actor_name}：</strong>{event.public_note}</p>}
                          </li>
                        );
                      })}
                    </ol>
                  </details>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Overlay>
  );
}
