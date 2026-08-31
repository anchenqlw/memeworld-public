import type { ImgHTMLAttributes } from 'react';
import { AuthImage, isProtectedImageUrl } from './AuthImage';

type Props = ImgHTMLAttributes<HTMLImageElement> & {
  src?: string | null;
};

/** 猫图展示：受鉴权路径走 fetch+cookie，其余走普通 img */
export function CatImage({ src, ...props }: Props) {
  if (!src) return null;
  if (isProtectedImageUrl(src)) return <AuthImage src={src} {...props} />;
  return <img src={src} {...props} />;
}
