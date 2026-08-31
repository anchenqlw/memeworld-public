import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { PresenceSemantic } from '../lib/catPresence';
import { ASSET_MANIFEST, REGION_MAP_IMAGES } from './assets';
import {
  createSceneBackgroundLoader,
  deriveStageScene,
  sceneBackgroundRequest,
  stageSceneKey,
  type SceneBackgroundResolution,
} from './sceneBackground';
import { HOME_BACKGROUND_URLS } from './homeLightPhase';

const locations = [
  { id: 'loc-cloudflower-hill', region_id: 'region-north-clouds' },
  { id: 'loc-mist-forest', region_id: 'region-starlake-green' },
];

describe('#116 主舞台场景派生', () => {
  it('云图志打开时世界/区域浏览态优先于猫的位置', () => {
    expect(deriveStageScene({
      presence: 'adventure_running', mapOpen: true, mapRegionId: null,
      destinationLocationId: 'loc-mist-forest', locations,
    })).toEqual({ kind: 'world' });
    expect(deriveStageScene({
      presence: 'home_idle', mapOpen: true, mapRegionId: 'region-north-clouds',
      destinationLocationId: null, locations,
    })).toEqual({ kind: 'region', regionId: 'region-north-clouds' });
  });

  it('正在旅行只使用当前目的地；未知地点 fail-safe 到世界地图', () => {
    expect(deriveStageScene({
      presence: 'adventure_running', mapOpen: false, mapRegionId: null,
      destinationLocationId: 'loc-mist-forest', locations,
    })).toEqual({ kind: 'region', regionId: 'region-starlake-green' });
    expect(deriveStageScene({
      presence: 'adventure_running', mapOpen: false, mapRegionId: null,
      destinationLocationId: 'loc-unknown', locations,
    })).toEqual({ kind: 'world' });
  });

  it('自由流浪只显示世界地图，其他位置语义保持猫舍', () => {
    expect(deriveStageScene({
      presence: 'wandering', mapOpen: false, mapRegionId: null,
      destinationLocationId: null, locations,
    })).toEqual({ kind: 'world' });

    const homePresences: PresenceSemantic[] = [
      'home_idle', 'home_ready', 'adventure_starting', 'adventure_failed', 'recalled', 'broken',
    ];
    for (const presence of homePresences) {
      expect(deriveStageScene({
        presence, mapOpen: false, mapRegionId: null,
        destinationLocationId: null, locations,
      })).toEqual({ kind: 'home' });
    }
  });

  it('场景 key 可供 Chromium 直接观测', () => {
    expect(stageSceneKey({ kind: 'home' })).toBe('home');
    expect(stageSceneKey({ kind: 'world' })).toBe('world');
    expect(stageSceneKey({ kind: 'region', regionId: 'region-heartlands' })).toBe('region:region-heartlands');
  });
});

describe('#116 只复用现有底图且资源失败封闭', () => {
  it('五张区域底图与云图志共用单一 manifest，文件全部存在', () => {
    expect(REGION_MAP_IMAGES).toEqual({
      'region-north-clouds': ASSET_MANIFEST.mapNorthClouds.path,
      'region-heartlands': ASSET_MANIFEST.mapHeartlands.path,
      'region-starlake-green': ASSET_MANIFEST.mapStarlakeGreen.path,
      'region-sky-rim': ASSET_MANIFEST.mapSkyRim.path,
      'region-lunar-starsea': ASSET_MANIFEST.mapLunarStarsea.path,
    });
    expect(ASSET_MANIFEST.mapStarlakeGreen.path).toContain('-v2.png');
    for (const url of [ASSET_MANIFEST.mapBg.path, ...Object.values(REGION_MAP_IMAGES), ...Object.values(HOME_BACKGROUND_URLS)]) {
      expect(existsSync(fileURLToPath(new URL(`../../public${url}`, import.meta.url))), url).toBe(true);
    }
  });

  it('世界/区域图失败时回退当前时段猫舍', () => {
    expect(sceneBackgroundRequest({ kind: 'world' }, 'dusk')).toEqual({
      primaryUrl: ASSET_MANIFEST.mapBg.path,
      fallbackUrl: HOME_BACKGROUND_URLS.dusk,
    });
    expect(sceneBackgroundRequest({ kind: 'region', regionId: 'region-north-clouds' }, 'night')).toEqual({
      primaryUrl: REGION_MAP_IMAGES['region-north-clouds'],
      fallbackUrl: HOME_BACKGROUND_URLS.night,
    });
    expect(sceneBackgroundRequest({ kind: 'region', regionId: 'region-future' }, 'day')).toEqual({
      primaryUrl: ASSET_MANIFEST.mapBg.path,
      fallbackUrl: HOME_BACKGROUND_URLS.day,
    });
  });

  it('主图失败会真正加载回退图，两层都失败才交给 CSS 渐变', async () => {
    const events: SceneBackgroundResolution[] = [];
    const attempts: string[] = [];
    const loader = createSceneBackgroundLoader({
      load: async (url) => {
        attempts.push(url);
        if (url.includes('broken')) throw new Error('broken');
      },
      onChange: (event) => events.push(event),
    });
    await loader.request({ primaryUrl: '/broken.png', fallbackUrl: '/home.png' });
    expect(attempts).toEqual(['/broken.png', '/home.png']);
    expect(events.at(-1)).toEqual({ status: 'fallback', url: '/home.png' });

    await loader.request({ primaryUrl: '/broken.png', fallbackUrl: '/also-broken.png' });
    expect(events.at(-1)).toEqual({ status: 'unavailable', url: null });
  });

  it('慢的旧图加载不得覆盖新场景', async () => {
    const events: SceneBackgroundResolution[] = [];
    const resolves = new Map<string, () => void>();
    const loader = createSceneBackgroundLoader({
      load: (url) => new Promise<void>((resolve) => { resolves.set(url, resolve); }),
      onChange: (event) => events.push(event),
    });
    const oldRequest = loader.request({ primaryUrl: '/old.png', fallbackUrl: '/home.png' });
    const newRequest = loader.request({ primaryUrl: '/new.png', fallbackUrl: '/home.png' });
    resolves.get('/old.png')?.();
    await oldRequest;
    expect(events).not.toContainEqual({ status: 'ready', url: '/old.png' });
    resolves.get('/new.png')?.();
    await newRequest;
    expect(events.at(-1)).toEqual({ status: 'ready', url: '/new.png' });
  });

  it('已过时的主图失败后也不得继续请求旧回退图', async () => {
    const rejects = new Map<string, (error: Error) => void>();
    const attempts: string[] = [];
    const loader = createSceneBackgroundLoader({
      load: (url) => new Promise<void>((_resolve, reject) => {
        attempts.push(url);
        rejects.set(url, reject);
      }),
      onChange: () => undefined,
    });
    const oldRequest = loader.request({ primaryUrl: '/old.png', fallbackUrl: '/old-home.png' });
    void loader.request({ primaryUrl: '/new.png', fallbackUrl: '/new-home.png' });
    rejects.get('/old.png')?.(new Error('late failure'));
    await oldRequest;
    expect(attempts).toEqual(['/old.png', '/new.png']);
    loader.stop();
  });
});

describe('#116 生产接线变异守卫', () => {
  const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

  it('GameStage 派生场景并交给 Sky，MapPanel 上报区域', () => {
    const stage = read('../components/GameStage.tsx');
    const panel = read('../components/panels/MapPanel.tsx');
    expect(stage).toContain('deriveStageScene({');
    expect(stage).toContain('<Sky variant="home" scene={stageScene}>');
    expect(stage).toContain('onSceneChange={setMapSceneRegionId}');
    expect(panel).toContain('onSceneChange?.(selectedRegion)');
    expect(panel).toContain("import { assetUrl, REGION_MAP_IMAGES } from '../../game/assets'");
  });

  it('Sky 必须经过可失败的 loader，并暴露场景/加载态给 Chromium', () => {
    const sky = read('../components/ui/Sky.tsx');
    expect(sky).toContain('createSceneBackgroundLoader({');
    expect(sky).toContain('void loader.request(request)');
    expect(sky).toContain('data-scene={stageSceneKey(scene)}');
    expect(sky).toContain('data-background-status={backgroundStatus}');
    expect(sky).not.toContain('HOME_BACKGROUND_URLS[homePhase]})`');
  });
});
