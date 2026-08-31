import { useEffect, useState } from 'react';
import { Icon } from './ui/Icon';
import { AuthImage, isProtectedImageUrl } from './AuthImage';
type Props = {
  imageUrl?: string | null;
  status?: string;
  name?: string;
  size?: number;
  compact?: boolean;
  immersive?: boolean;
};

/** 猫形象：AI 生成图优先，生成中显示水彩光晕加载态 */
export function CatAvatar({ imageUrl, status, name, size = 200, immersive = false }: Props) {
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [imageUrl]);

  if (imageUrl && !imageFailed) {
    const style = {
      width: size,
      height: size,
      objectFit: 'contain' as const,
      borderRadius: immersive ? '42%' : size * 0.1,
      filter: immersive
        ? 'saturate(0.9) contrast(0.96) brightness(1.03) drop-shadow(0 14px 14px rgba(61,64,91,0.2))'
        : 'drop-shadow(0 10px 22px rgba(61,64,91,0.22))',
    };
    const className = immersive ? 'cat-avatar-image cat-avatar-image--immersive' : 'cat-avatar-image';
    const stackClassName = immersive ? 'cat-avatar-stack cat-avatar-stack--immersive' : 'cat-avatar-stack';
    if (isProtectedImageUrl(imageUrl)) {
      return <span className={stackClassName} style={{ width: size, height: size }}><AuthImage className={className} src={imageUrl} alt={name || '小猫'} style={style} onLoadFailure={() => setImageFailed(true)} /></span>;
    }
    return <span className={stackClassName} style={{ width: size, height: size }}><img className={className} src={imageUrl} alt={name || '小猫'} draggable={false} onError={() => setImageFailed(true)} style={style} /></span>;
  }

  if (status === 'generating') {
    return (
      <div
        style={{
          width: size,
          height: size,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          background: 'radial-gradient(circle at 45% 35%, rgba(255,255,255,0.9), rgba(220,237,247,0.7))',
          borderRadius: '50%',
          border: '3px dashed rgba(142,202,230,0.8)',
        }}
      >
        <div className="gs-spinner" />
        <span style={{ fontSize: '0.78rem', color: 'var(--ink-soft)' }}>绘制中…</span>
      </div>
    );
  }

  return (
    <div
      style={{
        width: size,
        height: size,
        display: 'flex',
        alignItems: 'center',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 8,
        background: 'radial-gradient(circle at 42% 34%, #ffffff, #dcedf7)',
        borderRadius: '50%',
        border: '3px solid rgba(255,255,255,0.9)',
        boxShadow: '0 12px 30px rgba(61,64,91,0.18)',
      }}
    >
      <Icon name="paw" size={size * 0.45} color="var(--sky-deep)" strokeWidth={1.4} />
      {imageFailed && <span style={{ fontSize: size * 0.06, color: 'var(--ink-soft)' }}>图片加载失败，请稍后重试</span>}
    </div>
  );
}
