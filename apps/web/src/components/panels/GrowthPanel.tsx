import { useEffect, useState } from 'react';
import {
  api,
  type GrowthCard,
  type GrowthCardInput,
  type GrowthCardType,
  type GrowthTagSummary,
} from '../../api/client';
import { Icon } from '../ui/Icon';
import { Overlay } from '../ui/Overlay';

const TYPES: Array<{ value: GrowthCardType; label: string }> = [
  { value: 'book', label: '在读的书' },
  { value: 'skill', label: '在学的技能' },
  { value: 'interest', label: '兴趣爱好' },
  { value: 'life', label: '生活日常' },
];

const EMPTY: GrowthCardInput = { type: 'book', title: '', summary: '', source_url: null, tags: [], visibility: 'private' };

function inferCard(text: string, current?: GrowthCard): GrowthCardInput {
  const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '一条新的成长记录';
  const title = firstLine.replace(/^#{1,6}\s*/, '').replace(/https:\/\/\S+/g, '').trim().slice(0, 80) || '一条新的成长记录';
  const sourceUrl = text.match(/https:\/\/[^\s）)\]}]+/u)?.[0] || null;
  const tags = [...new Set([...text.matchAll(/#([\p{L}\p{N}_-]{1,20})/gu)].map((match) => match[1]))].slice(0, 5);
  const type: GrowthCardType = /《[^》]+》|读书|阅读|book|read/i.test(text)
    ? 'book'
    : /学习|在学|练习|课程|skill|learn/i.test(text)
      ? 'skill'
      : /兴趣|喜欢|爱好|球赛|比赛|hobby|interest/i.test(text)
        ? 'interest'
        : current?.type || 'life';
  return { type, title, summary: text, source_url: sourceUrl, tags, visibility: current?.visibility || 'private' };
}

function RichSummary({ text }: { text: string }) {
  return <>{text.split(/(https:\/\/\S+)/g).map((part, index) => part.startsWith('https://')
    ? <a key={`${part}-${index}`} href={part} target="_blank" rel="noreferrer">{part}</a>
    : part)}</>;
}

export function GrowthPanel({ onClose }: { onClose: () => void }) {
  const [cards, setCards] = useState<GrowthCard[]>([]);
  const [growth, setGrowth] = useState<GrowthTagSummary>({ source_count: 0, tags: [] });
  const [form, setForm] = useState<GrowthCardInput>(EMPTY);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    const [cardResult, tagResult] = await Promise.all([api.growthCards(), api.growthTags()]);
    setCards(cardResult.cards);
    setGrowth(tagResult);
  };

  useEffect(() => { void load().catch((e) => setError(e instanceof Error ? e.message : '成长记录加载失败')); }, []);

  const reset = () => { setForm(EMPTY); setEditingId(null); setError(''); };
  const edit = (card: GrowthCard) => {
    setEditingId(card.id);
    setForm({ type: card.type, title: card.title, summary: card.summary, source_url: card.source_url, tags: card.tags, visibility: card.visibility });
    setError('');
  };

  const save = async () => {
    setError('');
    const content = form.summary.trim();
    if (!content) { setError('写一点最近想让小猫了解的内容吧'); return; }
    setBusy(true);
    try {
      const payload = inferCard(content, editingId ? cards.find((card) => card.id === editingId) : undefined);
      if (editingId) await api.updateGrowthCard(editingId, payload);
      else await api.createGrowthCard(payload);
      reset();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally { setBusy(false); }
  };

  const remove = async (card: GrowthCard) => {
    if (!window.confirm(`撤回《${card.title}》？它会立即停止展示，并从小猫当前可读的长期记忆中移除。`)) return;
    setBusy(true);
    try {
      const result = await api.deleteGrowthCard(card.id);
      if (!result.memory_revoked) setError('卡片已停止展示，但云端长期记忆撤回尚未确认，请稍后联系维护者重试。');
      if (editingId === card.id) reset();
      await load();
    }
    catch (e) { setError(e instanceof Error ? e.message : '撤回失败'); }
    finally { setBusy(false); }
  };

  const retry = async (card: GrowthCard) => {
    setBusy(true);
    try { await api.retryGrowthCardSync(card.id); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : '重试失败'); }
    finally { setBusy(false); }
  };

  return (
    <Overlay title="喂养成长" icon="sparkle" onClose={onClose}>
      <section style={{ padding: '12px 14px', borderRadius: 14, background: '#fff8ef', border: '2px solid var(--paper-edge)', marginBottom: 16 }}>
        <strong>{growth.source_count ? `已经从 ${growth.source_count} 张卡片里认识你` : '从第一张成长卡片开始认识你'}</strong>
        <p style={{ margin: '5px 0 10px', fontSize: '0.78rem', color: 'var(--ink-soft)' }}>随手写就好。支持换行、https 链接和 #标签；不要粘贴密码、Token 或整篇文档。</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {growth.tags.map((tag) => <span key={tag.name} style={{ padding: '4px 9px', borderRadius: 999, background: '#fff', border: '1.5px solid var(--paper-edge)', fontSize: '0.74rem' }}>{tag.name} · {tag.source_count}</span>)}
        </div>
      </section>

      <section style={{ display: 'grid', gap: 10, padding: '14px', borderRadius: 14, background: '#fff', border: '2px solid var(--paper-edge)' }}>
        <label htmlFor="growth-content" style={{ fontWeight: 700 }}>最近想让小猫了解什么？</label>
        <textarea id="growth-content" className="gs-input" rows={8} maxLength={3000} value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} placeholder={'例如：\n最近在读《设计心理学》，发现好的设计会让人少思考一步。\nhttps://example.com/notes\n#设计 #阅读'} />
        <p style={{ margin: '-4px 0 0', fontSize: '0.72rem', color: 'var(--ink-soft)' }}><Icon name="lock" size={13} /> 默认只给自己和小猫看；标题、类型、链接和标签会自动整理。</p>
        {error && <p role="alert" style={{ margin: 0, color: 'var(--danger)', fontSize: '0.78rem' }}>{error}</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          {editingId && <button type="button" className="gs-btn gs-btn--ghost gs-btn--small" onClick={reset}>取消编辑</button>}
          <button type="button" className="gs-btn gs-btn--small" disabled={busy} onClick={save}>{busy ? '同步中…' : editingId ? '保存并重新喂养' : '喂给小猫'}</button>
        </div>
      </section>

      <section style={{ marginTop: 18 }}>
        <h3 style={{ fontSize: '0.95rem', marginBottom: 10 }}>成长记录</h3>
        {cards.length === 0 && <p style={{ color: 'var(--ink-soft)', fontSize: '0.82rem' }}>还没有卡片。先告诉它一本书、一项技能或最近的生活吧。</p>}
        {cards.map((card) => (
          <article key={card.id} style={{ padding: '12px 14px', marginBottom: 9, borderRadius: 13, background: '#fff', border: '2px solid var(--paper-edge)' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <strong>{card.title}</strong>
                <span style={{ marginLeft: 7, fontSize: '0.68rem', color: 'var(--ink-soft)' }}>{TYPES.find((item) => item.value === card.type)?.label}</span>
                <p style={{ margin: '6px 0', fontSize: '0.8rem', lineHeight: 1.6, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}><RichSummary text={card.summary} /></p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>{card.tags.map((tag) => <span key={tag} style={{ fontSize: '0.68rem', color: 'var(--sky-deep)' }}>#{tag}</span>)}</div>
              </div>
              <span title={card.sync_error || undefined} style={{ fontSize: '0.68rem', color: card.sync_status === 'synced' ? 'var(--grass-deep)' : card.sync_status === 'failed' ? 'var(--danger)' : 'var(--ink-soft)' }}>
                {card.sync_status === 'synced' ? '已记住' : card.sync_status === 'failed' ? '未同步' : '同步中'}
              </span>
            </div>
            {card.sync_status === 'failed' && <p style={{ margin: '7px 0 0', fontSize: '0.72rem', color: 'var(--danger)' }}>{card.sync_error || '长期记忆同步失败，本地卡片已保留。'}</p>}
            <div style={{ display: 'flex', gap: 10, marginTop: 8, justifyContent: 'flex-end' }}>
              {card.sync_status === 'failed' && <button type="button" onClick={() => retry(card)} disabled={busy} style={{ border: 0, background: 'transparent', color: 'var(--warm-deep)', cursor: 'pointer' }}>重试同步</button>}
              <button type="button" onClick={() => edit(card)} disabled={busy} style={{ border: 0, background: 'transparent', color: 'var(--sky-deep)', cursor: 'pointer' }}>编辑</button>
              <button type="button" onClick={() => remove(card)} disabled={busy} style={{ border: 0, background: 'transparent', color: 'var(--ink-soft)', cursor: 'pointer' }}>撤回</button>
            </div>
          </article>
        ))}
      </section>
    </Overlay>
  );
}
