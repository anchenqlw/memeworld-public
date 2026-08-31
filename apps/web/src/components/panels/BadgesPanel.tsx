import type { Badge } from '../../api/client';
import { Icon } from '../ui/Icon';
import { Overlay } from '../ui/Overlay';
import { BADGE_ART } from '../../game/assets';

type Props = {
  badges: Badge[];
  onClose: () => void;
};

/** 获得方式恒显（#069）：已获得 = 描述 + 日期两行；未获得 = 「如何点亮」引导语。 */
export function badgeCaption(badge: Badge): { how: string; earnedAt: string | null } {
  if (badge.earned) {
    return {
      how: badge.description,
      earnedAt: badge.earned_at ? `${badge.earned_at.slice(0, 10)} 获得` : '已获得',
    };
  }
  return { how: `如何点亮：${badge.description}`, earnedAt: null };
}

/** 勋章墙 */
export function BadgesPanel({ badges, onClose }: Props) {
  const earned = badges.filter((b) => b.earned).length;
  return (
    <Overlay
      title="勋章墙"
      icon="medal"
      onClose={onClose}
      headExtra={
        <span style={{ fontSize: '0.8rem', color: 'var(--ink-soft)' }}>
          已点亮 {earned} / {badges.length}
        </span>
      }
    >
      {badges.length === 0 ? (
        <div className="asset-placeholder" style={{ padding: '40px 20px' }}>
          <Icon name="medal" size={34} color="var(--ink-soft)" strokeWidth={1.6} />
          <span>世界还没有颁发任何勋章</span>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12 }}>
          {badges.map((b) => {
            const caption = badgeCaption(b);
            return (
              <div
                key={b.id}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 8,
                  padding: '18px 10px 14px',
                  borderRadius: 16,
                  textAlign: 'center',
                  background: b.earned ? 'linear-gradient(180deg,#fffdf4,#fdf3d8)' : '#f4f2ea',
                  border: b.earned ? '2px solid var(--gold)' : '2px dashed rgba(107,110,140,0.3)',
                  boxShadow: b.earned ? '0 6px 16px rgba(242,204,96,0.35)' : 'none',
                  opacity: b.earned ? 1 : 0.65,
                }}
              >
                <MedalArt badgeId={b.id} earned={b.earned} />
                <strong style={{ fontSize: '0.88rem' }}>{b.name}</strong>
                <span style={{ fontSize: '0.7rem', color: 'var(--ink-soft)', lineHeight: 1.5 }}>
                  {caption.how}
                </span>
                {caption.earnedAt && (
                  <span style={{ fontSize: '0.68rem', color: '#a07d2a', fontWeight: 600 }}>
                    {caption.earnedAt}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Overlay>
  );
}

/** 每枚勋章使用独立语义水彩图；未生成的新基因才退回 SVG 占位。 */
function MedalArt({ badgeId, earned }: { badgeId: string; earned: boolean }) {
  const src = BADGE_ART[badgeId];
  if (src) {
    return (
      <img
        src={src}
        alt=""
        draggable={false}
        style={{
          width: 96,
          height: 96,
          objectFit: 'contain',
          filter: earned ? 'saturate(1.05)' : 'grayscale(0.9) opacity(0.58)',
        }}
      />
    );
  }
  return (
    <div
      style={{
        width: 56,
        height: 56,
        borderRadius: '50%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: earned
          ? 'radial-gradient(circle at 40% 32%, #ffe9a8, var(--gold))'
          : 'radial-gradient(circle at 40% 32%, #e8e6dd, #cfccc0)',
        border: '2.5px solid #fff',
        boxShadow: earned ? '0 4px 12px rgba(217,154,43,0.45)' : 'inset 0 2px 5px rgba(61,64,91,0.15)',
      }}
    >
      <Icon name="medal" size={30} color={earned ? '#8a6210' : '#a09d92'} strokeWidth={1.8} />
    </div>
  );
}
