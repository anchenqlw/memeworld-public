import { useEffect, useRef, useState, type CSSProperties, type ImgHTMLAttributes } from 'react';
import { apiUrl } from '../api/client';

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  src?: string | null;
  style?: CSSProperties;
  onLoadFailure?: () => void;
};

const blobCache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

export function isProtectedImageUrl(imageUrl: string) {
  const path = imageUrl.startsWith('http')
    ? (() => { try { return new URL(imageUrl).pathname; } catch { return imageUrl; } })()
    : imageUrl;
  return path.startsWith('/api/v1/cat-images/');
}

function normalizeImageRequestUrl(src: string) {
  if (src.startsWith('http')) {
    try {
      const url = new URL(src);
      if (url.pathname.startsWith('/api/v1/cat-images/')) return url.pathname;
    } catch { /* fall through */ }
    return src;
  }
  return apiUrl(src);
}

function loadProtectedImage(requestUrl: string) {
  const cached = blobCache.get(requestUrl);
  if (cached) return Promise.resolve(cached);

  const pending = inflight.get(requestUrl);
  if (pending) return pending;

  const task = fetch(requestUrl, { credentials: 'include' })
    .then((response) => {
      if (!response.ok) throw new Error(String(response.status));
      return response.blob();
    })
    .then((blob) => {
      const objectUrl = URL.createObjectURL(blob);
      blobCache.set(requestUrl, objectUrl);
      inflight.delete(requestUrl);
      return objectUrl;
    })
    .catch((error) => {
      inflight.delete(requestUrl);
      throw error;
    });

  inflight.set(requestUrl, task);
  return task;
}

/** 需要登录态的图片：用 fetch 携带 cookie，再转为 blob URL 供 img 显示 */
export function AuthImage({ src, onLoadFailure, onError, style, alt, className, ...rest }: Props) {
  const requestUrl = src ? normalizeImageRequestUrl(src) : '';
  const [blobUrl, setBlobUrl] = useState<string | null>(() => (
    requestUrl ? blobCache.get(requestUrl) ?? null : null
  ));
  const stableUrlRef = useRef<string | null>(blobUrl);
  const onLoadFailureRef = useRef(onLoadFailure);
  onLoadFailureRef.current = onLoadFailure;

  useEffect(() => {
    if (!src || !requestUrl) {
      setBlobUrl(null);
      stableUrlRef.current = null;
      return;
    }

    let active = true;
    const cached = blobCache.get(requestUrl);
    if (cached) {
      setBlobUrl(cached);
      stableUrlRef.current = cached;
      return;
    }

    loadProtectedImage(requestUrl)
      .then((url) => {
        if (active) {
          setBlobUrl(url);
          stableUrlRef.current = url;
        }
      })
      .catch(() => {
        if (!active) return;
        if (!stableUrlRef.current) setBlobUrl(null);
        onLoadFailureRef.current?.();
      });

    return () => {
      active = false;
    };
  }, [src, requestUrl]);

  const displayUrl = blobUrl ?? stableUrlRef.current;
  if (!displayUrl) {
    return (
      <span
        aria-hidden
        className={className}
        style={{ ...style, display: style?.display ?? 'inline-block', visibility: 'hidden' }}
      />
    );
  }

  return (
    <img
      {...rest}
      className={className}
      src={displayUrl}
      alt={alt}
      style={style}
      draggable={false}
      onError={(event) => {
        onLoadFailureRef.current?.();
        onError?.(event);
      }}
    />
  );
}
