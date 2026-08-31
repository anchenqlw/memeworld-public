import { useState } from 'react';
import type { CatProfile } from '../../api/client';
import { Icon } from '../ui/Icon';
import { Overlay } from '../ui/Overlay';
import { ImageLightbox } from '../ui/Lightbox';
import { CatImage } from '../CatImage';
import { assetUrl, ITEM_ART } from '../../game/assets';

type Props = {
  cat: CatProfile;
  onClose: () => void;
};

const KIND_LABEL: Record<string, string> = { wearable: '饰物收藏', toy: '玩具', souvenir: '旅行纪念', consumable: '消耗品' };

type BagItem = NonNullable<CatProfile['items']>[number];

/** 获得来源一行字（backlog #063）：'7月20日 · 来自风铃浮岛'；数据缺失时逐级降级 */
export function itemSourceText(item: Pick<BagItem, 'acquired_at' | 'source_location_name' | 'source_travel_date'>): string | null {
  const date = item.source_travel_date || (item.acquired_at ? item.acquired_at.slice(0, 10) : null);
  const dateText = date ? `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日` : null;
  if (dateText && item.source_location_name) return `${dateText} · 来自${item.source_location_name}`;
  if (item.source_location_name) return `来自${item.source_location_name}`;
  if (dateText) return `${dateText} 获得`;
  return null;
}

/** 行囊：旅行掉落收藏 + 成长相册；饰物不再提供佩戴操作。 */
export function BagPanel({ cat, onClose }: Props) {
  const items = cat.items || [];
  const history = cat.appearance_history || [];
  const [zoom, setZoom] = useState<{ src: string; caption: string } | null>(null);
  const [detail, setDetail] = useState<BagItem | null>(null);
  return (
    <Overlay title="行囊" icon="bag" onClose={onClose}>
      <h3 style={{ fontSize: '1rem', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: 4, background: 'var(--warm)' }} />
        旅行收获
      </h3>
      {items.length === 0 ? (
        <div className="asset-placeholder" style={{ padding: '26px 16px', marginBottom: 20 }}>
          <Icon name="bag" size={30} color="var(--ink-soft)" strokeWidth={1.6} />
          <span>行囊空空——猫在旅途中拾到的宝贝会放在这里</span>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 10, marginBottom: 20 }}>
          {items.map((it) => {
            const source = itemSourceText(it);
            return (
              <button
                key={it.item_id}
                type="button"
                onClick={() => setDetail(it)}
                title="查看详情"
                style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
                  padding: '14px 10px', borderRadius: 14, background: '#fff',
                  border: '2px solid var(--paper-edge)', cursor: 'pointer', font: 'inherit', color: 'inherit',
                }}
              >
                {ITEM_ART[it.item_id] || assetUrl('itemTrinket') ? (
                  <img
                    src={ITEM_ART[it.item_id] || assetUrl('itemTrinket')!}
                    alt=""
                    draggable={false}
                    style={{ width: 54, height: 54, objectFit: 'contain', mixBlendMode: 'multiply' }}
                  />
                ) : (
                  <div
                    style={{
                      width: 46, height: 46, borderRadius: 12,
                      background: 'linear-gradient(160deg,#fdf3d8,#f4e6bd)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      border: '1.5px solid rgba(217,207,174,0.8)',
                    }}
                  >
                    <Icon name="star" size={24} color="var(--warm-deep)" strokeWidth={1.8} />
                  </div>
                )}
                <strong style={{ fontSize: '0.84rem' }}>{it.name}</strong>
                <span className="item-use-label">{KIND_LABEL[it.kind] || '旅行收藏'}</span>
                {source && <span style={{ fontSize: '0.68rem', color: 'var(--ink-soft)' }}>{source}</span>}
              </button>
            );
          })}
        </div>
      )}

      <h3 style={{ fontSize: '1rem', margin: '4px 0 10px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: 4, background: 'var(--sky-deep)' }} />
        成长相册
      </h3>
      {history.length === 0 ? (
        <div className="asset-placeholder" style={{ padding: '26px 16px' }}>
          <Icon name="album" size={30} color="var(--ink-soft)" strokeWidth={1.6} />
          <span>相册还是空的——每次旅行归来都会留下一张新画像</span>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 8 }}>
          {history.map((a, i) => {
            const caption = `${a.kind === 'birth' ? '初遇' : `成长 ${i}`} · ${a.created_at.slice(0, 10)}`;
            return (
              <figure key={a.id} style={{ flex: '0 0 auto', margin: 0, textAlign: 'center' }}>
                <CatImage
                  src={a.image_url}
                  alt=""
                  draggable={false}
                  className="zoomable"
                  onClick={() => setZoom({ src: a.image_url, caption: `${cat.name} · ${caption}` })}
                  title="点击放大"
                  style={{
                    width: 120, height: 120, objectFit: 'cover', borderRadius: 14,
                    border: '3px solid #fff', boxShadow: '0 6px 14px rgba(61,64,91,0.18)',
                    background: '#eef5fa',
                  }}
                />
                <figcaption style={{ fontSize: '0.7rem', color: 'var(--ink-soft)', marginTop: 6 }}>
                  {caption}
                </figcaption>
              </figure>
            );
          })}
        </div>
      )}
      {zoom && <ImageLightbox src={zoom.src} caption={zoom.caption} onClose={() => setZoom(null)} />}
      {detail && (
        <div className="map-popup-backdrop" onClick={() => setDetail(null)}>
          <div className="gs-panel map-popup" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 360 }}>
            <div className="overlay-head">
              <div className="overlay-title">
                <Icon name="bag" size={18} color="var(--warm-deep)" strokeWidth={2.2} />
                {detail.name}
              </div>
              <button type="button" className="gs-iconbtn" onClick={() => setDetail(null)} aria-label="关闭详情">
                <Icon name="close" size={16} />
              </button>
            </div>
            <div className="overlay-body" style={{ fontSize: '0.84rem', lineHeight: 1.7 }}>
              <p style={{ margin: '0 0 6px' }}>
                <span className="item-use-label">{KIND_LABEL[detail.kind] || '旅行收藏'}</span>
              </p>
              {detail.description && <p style={{ margin: '0 0 8px' }}>{detail.description}</p>}
              <p style={{ margin: 0, color: 'var(--ink-soft)', fontSize: '0.78rem' }}>
                {itemSourceText(detail) || '来历成谜——它悄悄出现在了行囊里'}
              </p>
            </div>
          </div>
        </div>
      )}
    </Overlay>
  );
}
