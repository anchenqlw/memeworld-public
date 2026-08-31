import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, type CatProfile, type ChatHistoryMessage, type QcaUserAlert } from '../../api/client';
import { Icon } from '../ui/Icon';
import { Overlay } from '../ui/Overlay';
import { CatAvatar } from '../CatAvatar';
import { QcaCreditsRecoveryCard } from '../QcaCreditsRecoveryCard';

type Msg = ChatHistoryMessage;

type Props = {
  cat: CatProfile;
  onClose: () => void;
  /** 从首页气泡进入时携带的留言（backlog #064）：置顶展示，让上下文跟着玩家进聊天窗 */
  entryMessage?: string | null;
};

const isPending = (message: Msg) => message.role === 'user'
  && ['queued', 'processing', 'cancel_requested'].includes(message.turn_status || '');

export function turnStatusText(message: Msg, catName: string) {
  if (message.turn_status === 'queued') return `排队中${message.queue_position ? ` · 前面 ${message.queue_position - 1} 条` : ''}`;
  if (message.turn_status === 'processing') return `${catName}正在想…`;
  if (message.turn_status === 'cancel_requested') return '正在打断上一轮…';
  if (message.turn_status === 'canceled') return '已打断';
  if (message.turn_status === 'failed') return '这条没有执行成功';
  return null;
}

/** 输入框提示语：带着首页留言进来时引导玩家回应（backlog #064） */
export function chatInputPlaceholder(catName: string, hasEntryMessage: boolean) {
  return hasEntryMessage ? `回应它刚才说的话，或跟 ${catName} 聊点别的…` : `跟 ${catName} 说点什么…`;
}

/** #093：聊天发生前必须直接可见；不得展示系统拿不到的余额或单次消耗数值。 */
export const CHAT_CREDITS_NOTICE = '聊天回应会消耗你自己的 Qoder Credits。';

/**
 * #073：历史就绪后的落点决策（可测纯函数）。
 * - 初次打开：瞬时（auto）滚到底 + 聚焦输入框——smooth 在长历史下会被浏览器
 *   中途落定停在半山腰；玩家点开聊天就是要说话，聚焦（移动端会弹出软键盘）
 *   符合意图，也保证输入框随浏览器滚入可视区。
 * - 后续 log 更新：平滑跟随最新一条，不抢焦点（不打断正在输入的玩家）。
 */
export function chatReadyActions(
  historyState: 'loading' | 'ready' | 'error',
  initialPending: boolean,
): { scrollBehavior: 'auto' | 'smooth'; focusInput: boolean } | null {
  if (historyState !== 'ready') return null;
  return initialPending
    ? { scrollBehavior: 'auto', focusInput: true }
    : { scrollBehavior: 'smooth', focusInput: false };
}

/** 撸猫对话：服务端持久队列承接 turn，页面刷新或关闭不影响云端继续执行。 */
export function ChatPanel({ cat, onClose, entryMessage }: Props) {
  const [log, setLog] = useState<Msg[]>([]);
  const [historyState, setHistoryState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [input, setInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [creditsAlert, setCreditsAlert] = useState<QcaUserAlert | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const initialLandingRef = useRef(true);
  const composingRef = useRef(false);
  const mountedRef = useRef(true);

  const loadHistory = async (initial = false) => {
    if (initial) setHistoryState('loading');
    try {
      const history = await api.chatHistory();
      if (!mountedRef.current) return;
      setLog(history.messages);
      setHistoryState('ready');
    } catch {
      if (initial && mountedRef.current) setHistoryState('error');
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    void loadHistory(true);
    return () => { mountedRef.current = false; };
  }, []);

  const hasActiveTurn = useMemo(
    () => log.some((message) => message.turn_status === 'processing' || message.turn_status === 'cancel_requested'),
    [log],
  );
  const hasPendingTurn = useMemo(() => log.some(isPending), [log]);

  useEffect(() => {
    if (!hasPendingTurn) return undefined;
    const timer = window.setInterval(() => { void loadHistory(false); }, 1_000);
    return () => window.clearInterval(timer);
  }, [hasPendingTurn]);

  // #073：初次打开瞬时落到最新消息并聚焦输入框；后续更新平滑跟随、不抢焦点。
  useEffect(() => {
    const actions = chatReadyActions(historyState, initialLandingRef.current);
    if (!actions) return;
    initialLandingRef.current = false;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: actions.scrollBehavior });
    if (actions.focusInput) inputRef.current?.focus();
  }, [log, historyState]);

  const send = async (mode: 'queue' | 'interrupt' = 'queue') => {
    const msg = input.trim();
    if (!msg || submitting) return;
    setInput('');
    setSubmitting(true);
    try {
      await api.enqueueChat(msg, mode);
      await loadHistory(false);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'QCA_CREDITS_UNAVAILABLE') {
        setCreditsAlert({
          code: 'QCA_CREDITS_UNAVAILABLE',
          message: '云端能量暂时不够，小猫把想说的话先轻轻收好了。',
          help_url: e.help_url || 'https://qoder.com/pricing',
          source: 'chat',
        });
      } else {
        setInput(msg);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Overlay
      title={`和 ${cat.name} 说话`}
      icon="chat"
      onClose={onClose}
      fillBody
      headExtra={
        <span
          style={{ fontSize: '0.78rem', color: 'var(--ink-soft)', display: 'flex', alignItems: 'center', gap: 4 }}
        >
          <Icon name="sun" size={14} color="var(--warm-deep)" strokeWidth={2.2} />
          随便聊
        </span>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        <aside
          data-testid="chat-credits-notice"
          role="note"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            marginBottom: 10,
            padding: '8px 11px',
            border: '1.5px solid var(--paper-edge)',
            borderRadius: 12,
            background: 'rgba(255, 249, 226, 0.96)',
            color: 'var(--ink)',
            fontSize: '0.8rem',
            lineHeight: 1.45,
            flexShrink: 0,
          }}
        >
          <Icon name="sun" size={15} color="var(--warm-deep)" strokeWidth={2.2} />
          <span>{CHAT_CREDITS_NOTICE}</span>
        </aside>
        {creditsAlert && (
          <QcaCreditsRecoveryCard alert={creditsAlert} compact onRecovered={() => setCreditsAlert(null)} />
        )}
        <div ref={scrollRef} className="chat-scroll" role="log" aria-live="polite" aria-relevant="additions text">
          {entryMessage && (
            <div
              style={{
                margin: '0 0 10px',
                padding: '8px 14px',
                borderRadius: 12,
                background: 'rgba(255,250,235,0.9)',
                border: '1.5px dashed var(--paper-edge)',
                fontSize: '0.8rem',
                color: 'var(--ink-soft)',
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontWeight: 700, color: 'var(--warm-deep)', marginBottom: 2 }}>
                <Icon name="chat" size={13} strokeWidth={2.2} />
                {cat.name} 留在花坡的话
              </span>
              {entryMessage}
            </div>
          )}
          {historyState === 'loading' && (
            <p style={{ textAlign: 'center', color: 'var(--ink-soft)', padding: '28px 0' }}>正在翻开你们的聊天…</p>
          )}
          {historyState === 'error' && (
            <div style={{ textAlign: 'center', padding: '22px 0' }}>
              <p style={{ color: 'var(--ink-soft)', marginBottom: 10 }}>聊天历史暂时没有加载出来</p>
              <button type="button" className="gs-btn gs-btn--ghost gs-btn--small" onClick={() => void loadHistory(true)}>再试一次</button>
            </div>
          )}
          {historyState === 'ready' && log.length === 0 && (
            <div style={{ textAlign: 'center', padding: '18px 0 6px' }}>
              <div style={{ display: 'inline-block', animation: 'float-y 4s ease-in-out infinite' }}>
                <CatAvatar imageUrl={cat.current_image_url} status={cat.appearance_status} name={cat.name} size={110} />
              </div>
              <p style={{ fontSize: '0.85rem', color: 'var(--ink-soft)', marginTop: 10 }}>
                {cat.name} 歪着头看你——它记得你们之间的每一次对话，也记得自己去过的每一个地方
              </p>
            </div>
          )}
          {historyState !== 'loading' && log.map((m) => {
            const status = turnStatusText(m, cat.name);
            return (
              <div key={m.id}>
                <div className={`chat-bubble ${m.role}`}>{m.text}</div>
                {status && (
                  <div style={{ textAlign: 'right', margin: '-4px 8px 8px', color: 'var(--ink-soft)', fontSize: '0.72rem' }}>
                    {status}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <form
          style={{ display: 'flex', gap: 10, marginTop: 12 }}
          onSubmit={(event) => {
            event.preventDefault();
            if (!composingRef.current) void send('queue');
          }}
        >
          <input
            ref={inputRef}
            className="gs-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; }}
            placeholder={chatInputPlaceholder(cat.name, Boolean(entryMessage))}
            disabled={historyState === 'loading' || Boolean(creditsAlert)}
            aria-label={`给 ${cat.name} 的消息`}
          />
          <button
            type="submit"
            className="gs-btn"
            style={{ padding: '10px 20px', flexShrink: 0 }}
            disabled={submitting || historyState === 'loading' || Boolean(creditsAlert) || !input.trim()}
            aria-label={hasActiveTurn ? '加入队列' : '发送'}
          >
            {submitting ? '发送中' : <Icon name="send" size={20} strokeWidth={2} />}
          </button>
        </form>
        {hasActiveTurn && input.trim() && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8, alignItems: 'center' }}>
            <span style={{ color: 'var(--ink-soft)', fontSize: '0.74rem' }}>发送键会排队，不会打断{cat.name}</span>
            <button
              type="button"
              className="gs-btn gs-btn--ghost gs-btn--small"
              disabled={submitting || Boolean(creditsAlert)}
              onClick={() => void send('interrupt')}
            >
              打断并发送
            </button>
          </div>
        )}
      </div>
    </Overlay>
  );
}
