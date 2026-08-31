/**
 * AI 素材清单（占位登记表）。
 *
 * 当前所有视觉素材均为 CSS/SVG 占位。后续用 AI 生成图片后，
 * 把文件放到 apps/web/public/assets/game/ 对应路径，并把 ready 改为 true，
 * 相关组件会自动优先使用位图素材。
 *
 * 风格统一约束：宫崎骏水彩绘本风（与服务端 lib/meandmeImageStyle.ts 的 STYLE_ANCHOR 一致）。
 */

export type AssetSlot = {
  /** public 下的路径 */
  path: string;
  /** 用途说明（同时是 AI 生成的提示词基础） */
  desc: string;
  ready: boolean;
};

export const ASSET_MANIFEST: Record<string, AssetSlot> = {
  logo: { path: '/assets/game/ui/logo.png', desc: '游戏 Logo：云朵托着一只猫的水彩字标「Me&Me 我&猫」', ready: false },
  titleCat: { path: '/assets/game/scene/title-cat.png', desc: '标题屏主视觉：云端招手的奶油小猫 + 浮岛远景', ready: true },
  paperGrain: { path: '/assets/game/scene/paper-grain.png', desc: '全屏水彩纸纹理叠加', ready: false },
  cloudLayer: { path: '/assets/game/scene/cloud-layer.png', desc: '前景漂浮云层（透明底）', ready: false },
  islandFar: { path: '/assets/game/scene/island-far.png', desc: '远景浮空岛剪影', ready: false },
  stageCloud: { path: '/assets/game/scene/stage-cloud.png', desc: '主舞台猫脚下的大云朵坐垫', ready: false },
  cloudHomeDawn: { path: '/assets/game/home/cloud-home-dawn-v2.png', desc: '主舞台清晨：柔和晨光下的云上浮岛猫舍', ready: true },
  cloudHomeDay: { path: '/assets/game/home/cloud-home-day-v2.png', desc: '主舞台白昼：明亮自然光下的云上浮岛猫舍', ready: true },
  cloudHomeDusk: { path: '/assets/game/home/cloud-home-dusk-v2.png', desc: '主舞台黄昏：暖色夕照下的云上浮岛猫舍', ready: true },
  cloudHomeNight: { path: '/assets/game/home/cloud-home-night-v2.png', desc: '主舞台夜晚：星空与暖灯下的云上浮岛猫舍', ready: true },
  mapBg: { path: '/assets/map/world-map-bg.png', desc: '世界地图水彩底图', ready: true },
  mapNorthClouds: { path: '/assets/map/regions/region-north-clouds-v1.png', desc: '北境云海区域水彩地图：花丘、灯塔与风铃云台', ready: true },
  mapHeartlands: { path: '/assets/map/regions/region-heartlands-v1.png', desc: '中央晴原区域水彩地图：风车集、茶屋与望远驿站', ready: true },
  mapStarlakeGreen: { path: '/assets/map/regions/region-starlake-green-v2.png', desc: '星湖绿境区域水彩地图：雾林、星湖与云港', ready: true },
  mapSkyRim: { path: '/assets/map/regions/region-sky-rim-v1.png', desc: '天际浮岛区域水彩地图：云巅望台与风铃浮岛', ready: true },
  mapLunarStarsea: { path: '/assets/map/regions/region-lunar-starsea-v1.png', desc: '月海星原区域水彩地图：月球静海、星海渡口与月阶回廊', ready: true },
  catPlaceholder: { path: '/assets/cat-placeholder.png', desc: '猫形象未生成时的占位插画', ready: true },
  stamp: { path: '/assets/game/ui/stamp.png', desc: '明信片邮票贴图（云端小猫+浮岛）', ready: true },
  medalGold: { path: '/assets/game/ui/medal-gold.png', desc: '勋章（已获得）：金橘水彩爪印奖章', ready: true },
  medalEmpty: { path: '/assets/game/ui/medal-empty.png', desc: '勋章（未获得）：银灰沉睡态同款奖章', ready: true },
  itemTrinket: { path: '/assets/game/ui/item-trinket.png', desc: '行囊物品通用贴图：星星挂坠小包袱', ready: true },
};

/** 云图志与主舞台共用的区域底图真相源，避免两处版本漂移。 */
export const REGION_MAP_IMAGES: Readonly<Record<string, string>> = {
  'region-north-clouds': ASSET_MANIFEST.mapNorthClouds.path,
  'region-heartlands': ASSET_MANIFEST.mapHeartlands.path,
  'region-starlake-green': ASSET_MANIFEST.mapStarlakeGreen.path,
  'region-sky-rim': ASSET_MANIFEST.mapSkyRim.path,
  'region-lunar-starsea': ASSET_MANIFEST.mapLunarStarsea.path,
};

export const ITEM_ART: Record<string, string> = {
  'item-straw-hat': '/assets/game/items/item-straw-hat.png',
  'item-red-scarf': '/assets/game/items/item-red-scarf.png',
  'item-copper-bell': '/assets/game/items/item-copper-bell.png',
  'item-tiny-backpack': '/assets/game/items/item-tiny-backpack.png',
  'item-star-charm': '/assets/game/items/item-star-charm.png',
  'item-creator-bell': '/assets/game/items/item-creator-bell.png',
};

export const DOCK_ART: Record<string, string> = {
  profile: '/assets/game/ui/dock-profile.png',
  growth: '/assets/game/ui/dock-growth.png',
  map: '/assets/game/ui/dock-map.png',
  journal: '/assets/game/ui/dock-journal.png',
  badges: '/assets/game/ui/dock-badges.png',
  bag: '/assets/game/ui/dock-bag.png',
  chat: '/assets/game/ui/dock-chat.png',
  mail: '/assets/game/ui/dock-mail.png',
  chronicle: '/assets/game/creator/pika-chronicle.png',
};

export const BADGE_ART: Record<string, string> = {
  'badge-first-trip': '/assets/game/ui/badge-first-trip.png',
  'badge-week-streak': '/assets/game/ui/badge-week-streak.png',
  'badge-mood-collector': '/assets/game/ui/badge-mood-collector.png',
  'badge-first-arrival': '/assets/game/ui/badge-first-arrival.png',
  'badge-proposal-shipped': '/assets/game/ui/badge-proposal-shipped.png',
  'badge-full-attr': '/assets/game/ui/badge-full-attr.png',
};

export function assetUrl(key: keyof typeof ASSET_MANIFEST): string | null {
  const slot = ASSET_MANIFEST[key];
  return slot.ready ? slot.path : null;
}

/** 服务端返回的相对图片地址补全 */
export function resolveImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('http') || url.startsWith('/assets')) return url;
  return url; // /static/* 由 vite proxy / nginx 转发
}
