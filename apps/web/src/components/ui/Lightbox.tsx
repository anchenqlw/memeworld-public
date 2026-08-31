import { useRef, type ReactNode } from 'react';
import { Icon } from './Icon';
import { useDialogFocus } from './useDialogFocus';
import { AuthImage, isProtectedImageUrl } from '../AuthImage';

type Props = {
  onClose: () => void;
  children: ReactNode;
};

/**
 * 全屏放大浮层：用于图片/明信片等内容的点击放大展示。
 * 点击空白处或右上角关闭；Esc 关闭。层级在所有面板之上。
 */
export function Lightbox({ onClose, children }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, onClose);

  return (
    <div
      ref={dialogRef}
      className="lightbox"
      onClick={(event) => event.target === event.currentTarget && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      tabIndex={-1}
    >
      <button type="button" className="lightbox-close" onClick={onClose} aria-label="关闭">
        <Icon name="close" size={22} strokeWidth={2.6} color="#fff" />
      </button>
      <div className="lightbox-content">
        {children}
      </div>
    </div>
  );
}

/** 便捷封装：放大展示一张图片 */
export function ImageLightbox({ src, alt, caption, onClose }: { src: string; alt?: string; caption?: string; onClose: () => void }) {
  return (
    <Lightbox onClose={onClose}>
      {isProtectedImageUrl(src) ? (
        <AuthImage src={src} alt={alt || ''} className="lightbox-img" />
      ) : (
        <img src={src} alt={alt || ''} className="lightbox-img" draggable={false} />
      )}
      {caption && <p className="lightbox-caption">{caption}</p>}
    </Lightbox>
  );
}
