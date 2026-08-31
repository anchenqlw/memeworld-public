import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  HOME_BACKGROUND_URLS,
  createHomeLightClock,
  homeLightPhaseAt,
  nextHomeLightPhase,
  type HomeLightPhase,
} from '../../game/homeLightPhase';
import {
  createSceneBackgroundLoader,
  sceneBackgroundRequest,
  stageSceneKey,
  type SceneBackgroundStatus,
  type StageScene,
} from '../../game/sceneBackground';

/** 全屏舞台：普通页面使用天空视差层，猫舍使用一张完整且不透底的专属场景。 */

type CloudSpec = { top: string; w: number; h: number; dur: number; delay: number; opacity: number };

const CLOUDS: CloudSpec[] = [
  { top: '8%', w: 150, h: 44, dur: 95, delay: -20, opacity: 0.9 },
  { top: '28%', w: 190, h: 54, dur: 80, delay: -45, opacity: 0.8 },
  { top: '58%', w: 220, h: 60, dur: 70, delay: -10, opacity: 0.72 },
];

function useHomeLightPhase(enabled: boolean): HomeLightPhase {
  const [phase, setPhase] = useState(() => homeLightPhaseAt(new Date()));

  useEffect(() => {
    if (!enabled) return undefined;

    const clock = createHomeLightClock({ onPhase: setPhase });
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') clock.refresh();
    };

    document.addEventListener('visibilitychange', refreshWhenVisible);
    window.addEventListener('focus', clock.refresh);
    window.addEventListener('pageshow', clock.refresh);

    return () => {
      clock.stop();
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      window.removeEventListener('focus', clock.refresh);
      window.removeEventListener('pageshow', clock.refresh);
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const image = new Image();
    image.src = HOME_BACKGROUND_URLS[nextHomeLightPhase(phase)];
  }, [enabled, phase]);

  return phase;
}

const HOME_SCENE: StageScene = { kind: 'home' };

function loadImage(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve();
    image.onerror = () => reject(new Error(`scene background failed: ${url}`));
    image.src = url;
  });
}

export function Sky({
  children,
  dim = false,
  variant = 'sky',
  scene = HOME_SCENE,
}: {
  children?: ReactNode;
  dim?: boolean;
  variant?: 'sky' | 'home';
  scene?: StageScene;
}) {
  const homePhase = useHomeLightPhase(variant === 'home');
  const [backgroundStatus, setBackgroundStatus] = useState<SceneBackgroundStatus>('loading');
  const [backgroundUrl, setBackgroundUrl] = useState<string | null>(null);
  const previousBackgroundUrl = useRef<string | null>(null);
  const [outgoingBackgroundUrl, setOutgoingBackgroundUrl] = useState<string | null>(null);
  const loader = useMemo(() => createSceneBackgroundLoader({
    load: loadImage,
    onChange: (resolution) => {
      setBackgroundStatus(resolution.status);
      if (resolution.url) setBackgroundUrl(resolution.url);
    },
  }), []);
  const request = sceneBackgroundRequest(scene, homePhase);

  useEffect(() => {
    if (variant !== 'home') return undefined;
    void loader.request(request);
    return undefined;
  }, [loader, request.fallbackUrl, request.primaryUrl, variant]);

  useEffect(() => () => loader.stop(), [loader]);

  useEffect(() => {
    if (variant !== 'home' || !backgroundUrl || previousBackgroundUrl.current === backgroundUrl) return undefined;
    const previous = previousBackgroundUrl.current;
    previousBackgroundUrl.current = backgroundUrl;
    if (!previous) return undefined;

    setOutgoingBackgroundUrl(previous);
    const timer = window.setTimeout(() => setOutgoingBackgroundUrl(null), 900);
    return () => window.clearTimeout(timer);
  }, [backgroundUrl, variant]);

  return (
    <div className="gs-viewport">
      {variant === 'home' ? (
        <div
          className="gs-home-bg"
          data-light-phase={homePhase}
          data-scene={stageSceneKey(scene)}
          data-background-status={backgroundStatus}
          aria-hidden="true"
        >
          {outgoingBackgroundUrl && (
            <div
              className="gs-home-bg__layer gs-home-bg__layer--outgoing"
              style={{ backgroundImage: `url(${outgoingBackgroundUrl})` }}
            />
          )}
          {backgroundUrl && (
            <div
              key={backgroundUrl}
              className="gs-home-bg__layer gs-home-bg__layer--active"
              style={{ backgroundImage: `url(${backgroundUrl})` }}
            />
          )}
        </div>
      ) : (
        <>
          <div className="gs-sky" />
          {CLOUDS.map((c, i) => (
            <div
              key={i}
              className="gs-cloud"
              style={{
                top: c.top,
                width: c.w,
                height: c.h,
                opacity: c.opacity,
                animationDuration: `${c.dur}s`,
                animationDelay: `${c.delay}s`,
              }}
            />
          ))}
        </>
      )}
      {dim && <div style={{ position: 'absolute', inset: 0, background: 'rgba(43,54,74,0.18)' }} />}
      {children}
    </div>
  );
}
