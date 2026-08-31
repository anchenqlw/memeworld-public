/**
 * 矢量图标系统（占位版）。
 * 所有图标为手绘 SVG stroke 风格，后续可整体替换为 AI 生成的精美图标图集：
 * 只需保持 name 不变，把渲染源换成 <img src="/assets/game/icons/<name>.png"> 即可。
 */
import type { CSSProperties, ReactElement } from 'react';

export type IconName =
  | 'map'
  | 'journal'
  | 'medal'
  | 'bag'
  | 'chat'
  | 'mail'
  | 'gear'
  | 'close'
  | 'paw'
  | 'star'
  | 'heart'
  | 'album'
  | 'arrowLeft'
  | 'arrowRight'
  | 'check'
  | 'plus'
  | 'minus'
  | 'logout'
  | 'refresh'
  | 'lock'
  | 'cloud'
  | 'pin'
  | 'send'
  | 'moon'
  | 'sun'
  | 'sparkle'
  | 'compass'
  | 'courage'
  | 'curiosity'
  | 'affinity'
  | 'insight';

type Props = {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
  filled?: boolean;
  style?: CSSProperties;
  className?: string;
};

const PATHS: Record<IconName, ReactElement> = {
  map: (
    <>
      <path d="M3 6.5 9 4l6 2.5L21 4v13.5L15 20l-6-2.5L3 20V6.5Z" />
      <path d="M9 4v13.5M15 6.5V20" />
    </>
  ),
  journal: (
    <>
      <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v16H6.5A1.5 1.5 0 0 0 5 20.5V4.5Z" />
      <path d="M5 17.5A1.5 1.5 0 0 1 6.5 16H19" />
      <path d="M9 7.5h6M9 10.5h4" />
    </>
  ),
  medal: (
    <>
      <circle cx="12" cy="14" r="5" />
      <path d="m12 11.8.9 1.8 2 .3-1.45 1.4.35 2-1.8-.95-1.8.95.35-2L9.1 13.9l2-.3.9-1.8Z" />
      <path d="M8.5 9.5 6 3h4l2 4 2-4h4l-2.5 6.5" />
    </>
  ),
  bag: (
    <>
      <path d="M5 8h14l-1 12H6L5 8Z" />
      <path d="M8.5 10V6.5a3.5 3.5 0 0 1 7 0V10" />
    </>
  ),
  chat: (
    <>
      <path d="M4 6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H10l-4.5 4v-4H7a3 3 0 0 1-3-3V6Z" />
      <path d="M8.5 9.5h.01M12 9.5h.01M15.5 9.5h.01" strokeWidth={2.4} />
    </>
  ),
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="m3.5 7 8.5 6 8.5-6" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.8v2.6M12 18.6v2.6M21.2 12h-2.6M5.4 12H2.8M18.5 5.5l-1.9 1.9M7.4 16.6l-1.9 1.9M18.5 18.5l-1.9-1.9M7.4 7.4 5.5 5.5" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6 6 18" />,
  paw: (
    <>
      <ellipse cx="12" cy="15.5" rx="4.2" ry="3.6" />
      <ellipse cx="6.2" cy="10.5" rx="1.8" ry="2.3" />
      <ellipse cx="10" cy="7.2" rx="1.8" ry="2.3" />
      <ellipse cx="14" cy="7.2" rx="1.8" ry="2.3" />
      <ellipse cx="17.8" cy="10.5" rx="1.8" ry="2.3" />
    </>
  ),
  star: <path d="m12 3 2.6 5.6 6.1.7-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6L3.3 9.3l6.1-.7L12 3Z" />,
  heart: <path d="M12 20s-7.5-4.6-9.3-9.2C1.5 7.6 3.6 4.5 6.8 4.5c2 0 3.8 1.2 5.2 3 1.4-1.8 3.2-3 5.2-3 3.2 0 5.3 3.1 4.1 6.3C19.5 15.4 12 20 12 20Z" />,
  album: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <circle cx="9" cy="10" r="1.8" />
      <path d="m4 17 5-4.5 4 3.5 3-2.5 4 3.5" />
    </>
  ),
  arrowLeft: <path d="M15 5l-7 7 7 7" />,
  arrowRight: <path d="M9 5l7 7-7 7" />,
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  logout: (
    <>
      <path d="M14 4H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7" />
      <path d="m17 8 4 4-4 4M21 12H10" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.4-5.7" />
      <path d="M20 3v5h-5" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3M12 14.5v2" />
    </>
  ),
  cloud: <path d="M7 18a4 4 0 0 1-.6-8A5.5 5.5 0 0 1 17 8.7 4.2 4.2 0 0 1 16.8 18H7Z" />,
  pin: (
    <>
      <path d="M12 21s-6.5-6.2-6.5-10.7a6.5 6.5 0 0 1 13 0C18.5 14.8 12 21 12 21Z" />
      <circle cx="12" cy="10" r="2.3" />
    </>
  ),
  send: <path d="m3.5 11 17-7-4.5 16.5-4.8-6L3.5 11Zm7.7 3.5L20.5 4" />,
  moon: <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M21 12h-2M5 12H3M18.4 5.6 17 7M7 17l-1.4 1.4M18.4 18.4 17 17M7 7 5.6 5.6" />
    </>
  ),
  sparkle: (
    <>
      <path d="M12 4c.6 3.4 2.6 5.4 6 6-3.4.6-5.4 2.6-6 6-.6-3.4-2.6-5.4-6-6 3.4-.6 5.4-2.6 6-6Z" />
      <path d="M18.5 15.5c.3 1.5 1.2 2.4 2.7 2.7-1.5.3-2.4 1.2-2.7 2.7-.3-1.5-1.2-2.4-2.7-2.7 1.5-.3 2.4-1.2 2.7-2.7Z" />
    </>
  ),
  compass: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m15.5 8.5-2 5-5 2 2-5 5-2Z" />
    </>
  ),
  courage: <path d="M12 3.5c2 2.2 6.5 2.6 6.5 7.2 0 5-4.2 8.4-6.5 9.8-2.3-1.4-6.5-4.8-6.5-9.8 0-4.6 4.5-5 6.5-7.2ZM12 8v6" />,
  curiosity: (
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="m15 15 5.5 5.5" />
    </>
  ),
  affinity: <path d="M12 19.5s-6.8-4.1-8.4-8.3C2.5 8.4 4.4 5.6 7.3 5.6c1.8 0 3.4 1.1 4.7 2.7 1.3-1.6 2.9-2.7 4.7-2.7 2.9 0 4.8 2.8 3.7 5.6-1.6 4.2-8.4 8.3-8.4 8.3Z" />,
  insight: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
};

export function Icon({ name, size = 24, color = 'currentColor', strokeWidth = 1.8, filled = false, style, className }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? color : 'none'}
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      className={className}
      aria-hidden
    >
      {PATHS[name]}
    </svg>
  );
}
