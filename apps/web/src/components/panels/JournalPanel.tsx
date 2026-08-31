import { useState } from 'react';
import type { Travel } from '../../api/client';
import { Icon } from '../ui/Icon';
import { Overlay } from '../ui/Overlay';
import { ImageLightbox } from '../ui/Lightbox';
import { PostcardCard } from '../ui/Postcard';
import { journalEmptyText, type PresenceSemantic } from '../../lib/catPresence';

type Props = {
  travels: Travel[];
  catName: string;
  lifecycleStage?: string;
  /** #088 表第 6 行的欠账修复：空态也要消费统一的 presence 真相源，别再自己看 lifecycleStage 猜 */
  presence: PresenceSemantic;
  onClose: () => void;
};

/** 旅行手账：按日倒序的明信片集，点击照片放大查看 */
export function JournalPanel({ travels, catName, lifecycleStage, presence, onClose }: Props) {
  const [zoom, setZoom] = useState<{ src: string; caption: string } | null>(null);

  return (
    <Overlay title="旅行手账" icon="journal" onClose={onClose}>
      {travels.length === 0 ? (
        <div className="asset-placeholder" style={{ padding: '40px 20px' }}>
          <Icon name="send" size={34} color="var(--ink-soft)" strokeWidth={1.6} />
          <span style={{ fontSize: '0.88rem' }}>
            {journalEmptyText(presence, catName, lifecycleStage).split('\n').map((line, i) => (
              <span key={line}>{i > 0 && <br />}{line}</span>
            ))}
          </span>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {travels.map((t) => (
            <PostcardCard key={t.id} travel={t} catName={catName} onZoomImage={(src, caption) => setZoom({ src, caption })} />
          ))}
        </div>
      )}
      {zoom && <ImageLightbox src={zoom.src} caption={zoom.caption} onClose={() => setZoom(null)} />}
    </Overlay>
  );
}
