import type { PresenceSemantic } from '../lib/catPresence';
import { ASSET_MANIFEST, REGION_MAP_IMAGES } from './assets';
import { HOME_BACKGROUND_URLS, type HomeLightPhase } from './homeLightPhase';

export type StageScene =
  | { kind: 'home' }
  | { kind: 'world' }
  | { kind: 'region'; regionId: string };

type SceneLocation = { id: string; region_id: string };

/**
 * 主舞台只从「当前打开的云图志」或「正在进行的旅行目的地」派生场景。
 * 愿望和历史明信片都不能冒充小猫此刻所在地。
 */
export function deriveStageScene(input: {
  presence: PresenceSemantic;
  mapOpen: boolean;
  mapRegionId: string | null;
  destinationLocationId: string | null;
  locations: SceneLocation[];
}): StageScene {
  if (input.mapOpen) {
    return input.mapRegionId && REGION_MAP_IMAGES[input.mapRegionId]
      ? { kind: 'region', regionId: input.mapRegionId }
      : { kind: 'world' };
  }

  if (input.presence === 'adventure_running') {
    const destination = input.locations.find((location) => location.id === input.destinationLocationId);
    return destination && REGION_MAP_IMAGES[destination.region_id]
      ? { kind: 'region', regionId: destination.region_id }
      : { kind: 'world' };
  }

  if (input.presence === 'wandering') return { kind: 'world' };
  return { kind: 'home' };
}

export function stageSceneKey(scene: StageScene): string {
  return scene.kind === 'region' ? `region:${scene.regionId}` : scene.kind;
}

export type SceneBackgroundRequest = {
  primaryUrl: string;
  fallbackUrl: string;
};

export function sceneBackgroundRequest(scene: StageScene, phase: HomeLightPhase): SceneBackgroundRequest {
  const homeUrl = HOME_BACKGROUND_URLS[phase];
  if (scene.kind === 'home') return { primaryUrl: homeUrl, fallbackUrl: homeUrl };
  if (scene.kind === 'world') return { primaryUrl: ASSET_MANIFEST.mapBg.path, fallbackUrl: homeUrl };
  return {
    primaryUrl: REGION_MAP_IMAGES[scene.regionId] ?? ASSET_MANIFEST.mapBg.path,
    fallbackUrl: homeUrl,
  };
}

export type SceneBackgroundStatus = 'loading' | 'ready' | 'fallback' | 'unavailable';
export type SceneBackgroundResolution = { status: SceneBackgroundStatus; url: string | null };

type SceneBackgroundLoaderOptions = {
  load: (url: string) => Promise<void>;
  onChange: (resolution: SceneBackgroundResolution) => void;
};

/**
 * 先验证图片可用再切换；主资源失败时回退到当前时段猫舍。
 * epoch fencing 保证慢请求不会覆盖更新的场景。
 */
export function createSceneBackgroundLoader({ load, onChange }: SceneBackgroundLoaderOptions) {
  let epoch = 0;

  return {
    async request({ primaryUrl, fallbackUrl }: SceneBackgroundRequest): Promise<void> {
      const requestEpoch = ++epoch;
      onChange({ status: 'loading', url: null });
      try {
        await load(primaryUrl);
        if (requestEpoch === epoch) onChange({ status: 'ready', url: primaryUrl });
        return;
      } catch {
        // 主资源失效，下方进入已知的猫舍回退。
      }

      if (requestEpoch !== epoch) return;
      if (fallbackUrl !== primaryUrl) {
        try {
          await load(fallbackUrl);
          if (requestEpoch === epoch) onChange({ status: 'fallback', url: fallbackUrl });
          return;
        } catch {
          // CSS 固有渐变是最后一层不依赖网络的回退。
        }
      }

      if (requestEpoch === epoch) onChange({ status: 'unavailable', url: null });
    },
    stop(): void {
      epoch += 1;
    },
  };
}
