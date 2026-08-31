import { useEffect, useState } from 'react';
import { api, type Travel } from '../../api/client';
import { Icon } from './Icon';
import { CatImage } from '../CatImage';

/**
 * 明信片卡片：正文 + 该次旅行生成的猫咪照片。
 * 点击照片放大查看大图；没有照片的旅行只显示文字。
 */

/** 主题徽标（backlog #062）：有事件用事件名；无事件从心情派生中性主题，保证每条记录都有主题标签 */
export function travelThemeLabel(travel: Pick<Travel, 'event_name' | 'mood'>): string {
  if (travel.event_name) return travel.event_name;
  if (travel.mood) return `${travel.mood}小记`;
  return '日常漫游';
}

export function readingSourceLabel(source: Travel['reading_source']): string | null {
  return source ? `猫咪读了 · ${source.title}` : null;
}

export function PostcardCard({ travel, catName, compact, onZoomImage }: {
  travel: Travel;
  catName?: string;
  compact?: boolean;
  onZoomImage: (src: string, caption: string) => void;
}) {
  const caption = `${travel.encounter_photo ? '猫遇合照' : travel.postcard_title || '旅行记录'} · ${travel.travel_date} · ${travel.location_name}`;
  const [responded, setResponded] = useState<string[]>(travel.cherished_at ? ['cherish'] : []);
  const [reply, setReply] = useState('');
  const [showReply, setShowReply] = useState(false);
  const [photoStatus, setPhotoStatus] = useState(travel.photo_status);
  useEffect(() => {
    setPhotoStatus(travel.image_url ? 'ready' : travel.photo_status);
  }, [travel.id, travel.image_url, travel.photo_status]);
  const respond = async (type: 'pat' | 'cherish') => {
    if (!travel.postcard_id) return;
    if (type === 'pat') await api.patPostcard(travel.postcard_id); else await api.cherishPostcard(travel.postcard_id);
    setResponded((current) => current.includes(type) ? current : [...current, type]);
  };
  const sendReply = async () => {
    if (!travel.postcard_id || !reply.trim()) return;
    await api.replyPostcard(travel.postcard_id, { content: reply.trim() });
    setResponded((current) => [...current.filter((item) => item !== 'reply'), 'reply']);
    setShowReply(false);
  };
  const retryPhoto = async () => {
    if (!travel.postcard_id) return;
    const result = await api.repairPostcardPhoto(travel.postcard_id);
    setPhotoStatus(result.status as Travel['photo_status']);
  };

  return (
    <div className="postcard">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.74rem', color: 'var(--ink-soft)', paddingRight: 50 }}>
        <Icon name="pin" size={14} color="var(--warm-deep)" strokeWidth={2.2} />
        {travel.travel_date}
        {!compact && ` · ${travel.location_name}`}
        {travel.mood && (
          <span style={{ background: '#fff3e4', color: 'var(--warm-deep)', padding: '1px 10px', borderRadius: 999, fontWeight: 700 }}>
            {travel.mood}
          </span>
        )}
        <span style={{ background: '#eef7e2', color: 'var(--grass-deep)', padding: '1px 10px', borderRadius: 999, fontWeight: 700 }}>
          {travelThemeLabel(travel)}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 14, marginTop: 8, alignItems: 'flex-start' }}>
        {travel.image_url && photoStatus !== 'failed' && (
          <CatImage
            src={travel.image_url}
            alt={travel.encounter_photo
              ? `${catName || '小猫'}在${travel.location_name}与另一只旅行猫的猫遇合照`
              : `${catName || '小猫'}在${travel.location_name}${travel.event_name ? `参与${travel.event_name}` : '旅行'}的现场照片`}
            tabIndex={0}
            role="button"
            onKeyDown={(event) => (event.key === 'Enter' || event.key === ' ') && onZoomImage(travel.image_url!, caption)}
            draggable={false}
            className="zoomable"
            title="点击放大"
            onClick={() => onZoomImage(travel.image_url!, caption)}
            style={{
              width: compact ? 76 : 96,
              height: compact ? 76 : 96,
              objectFit: 'cover',
              borderRadius: 12,
              border: '3px solid #fff',
              boxShadow: '0 4px 10px rgba(61,64,91,0.18)',
              background: '#eef5fa',
              flexShrink: 0,
            }}
          />
        )}
        {!travel.image_url && (photoStatus === 'pending' || photoStatus === 'generating') && (
          <div className="postcard-photo-placeholder" aria-live="polite">📷<span>正在冲洗照片…</span></div>
        )}
        {!travel.image_url && photoStatus === 'failed' && (
          <button type="button" className="postcard-photo-placeholder postcard-photo-placeholder--failed" onClick={retryPhoto}>🐾<span>照片冲洗失败<br />点我再试一次</span></button>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          {travel.encounter_photo && (
            <span style={{ display: 'inline-block', marginBottom: 5, padding: '2px 9px', borderRadius: 999, background: '#fff3e4', color: 'var(--warm-deep)', fontSize: '0.72rem', fontWeight: 700 }}>
              🐾 猫遇合照
            </span>
          )}
          {readingSourceLabel(travel.reading_source) && (
            <span
              data-testid="reading-source"
              style={{ display: 'inline-block', marginBottom: 5, padding: '2px 9px', borderRadius: 999, background: '#f2edff', color: '#65519a', fontSize: '0.72rem', fontWeight: 700 }}
            >
              📖 {readingSourceLabel(travel.reading_source)}
            </span>
          )}
          <h3 style={{ fontSize: compact ? '1rem' : '1.08rem', margin: '0 0 6px' }}>{travel.postcard_title || '旅行记录'}</h3>
          <p
            style={{
              margin: 0,
              fontSize: '0.9rem',
              lineHeight: 1.75,
              ...(compact
                ? { display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' as const, overflow: 'hidden' }
                : {}),
            }}
          >
            {travel.postcard_content || travel.narrative}
          </p>
        </div>
      </div>
      {catName && (
        <p style={{ margin: '10px 0 0', textAlign: 'right', fontSize: '0.8rem', color: 'var(--ink-soft)', fontFamily: 'var(--font-display)' }}>
          —— {catName}
        </p>
      )}
      {travel.dropped_item && (
        <div style={{ marginTop: 10, paddingTop: 9, borderTop: '1.5px dashed var(--paper-edge)', display: 'flex', alignItems: 'center', gap: 7, fontSize: '0.78rem', color: 'var(--warm-deep)', fontWeight: 700 }}>
          <Icon name="bag" size={15} color="var(--warm-deep)" strokeWidth={2} />
          旅行收获：{travel.dropped_item.name}
        </div>
      )}
      {travel.memory_reference && <p style={{ margin: '9px 0 0', fontSize: '0.76rem', color: 'var(--sky-deep)' }}>它想起了：{travel.memory_reference}</p>}
      {travel.encounter_summary && <p style={{ margin: '7px 0 0', fontSize: '0.76rem', color: 'var(--ink-soft)' }}>🐾 {travel.encounter_summary}</p>}
      {travel.postcard_id && (
        <div className="postcard-actions">
          <button type="button" onClick={() => respond('pat')} className={responded.includes('pat') ? 'active' : ''}>♡ {responded.includes('pat') ? '摸过它了' : '摸摸它'}</button>
          <button type="button" onClick={() => setShowReply((value) => !value)} className={responded.includes('reply') ? 'active' : ''}>✎ 回一句</button>
          <button type="button" onClick={() => respond('cherish')} className={responded.includes('cherish') ? 'active' : ''}>☆ {responded.includes('cherish') ? '已珍藏' : '收进珍藏'}</button>
        </div>
      )}
      {showReply && (
        <div className="postcard-reply">
          {travel.postcard_question && <p>{travel.postcard_question}</p>}
          <div><input className="gs-input" maxLength={200} value={reply} onChange={(event) => setReply(event.target.value)} placeholder="写一句给它…" />
          <button type="button" className="gs-btn gs-btn--small" onClick={sendReply} disabled={!reply.trim()}>寄出</button></div>
        </div>
      )}
    </div>
  );
}
