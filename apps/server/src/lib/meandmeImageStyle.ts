/**
 * Me&Me 猫形象生图·双场景模板（基于 2026-07-16 QCA 50 图实验定稿）。
 *
 * 设计目标：
 *   - 「风格」严格锁死，保证所有猫画风一致。
 *   - 「身份锚点」建猫时冻结，后续每次生图逐字复用（QCA 无 ref 图时的强一致性保障）。
 *   - 出生图是角色定妆照；旅行图是地点中的连续现场，两者不共享构图槽位。
 *
 * Prompt 结构（固定顺序）：
 *   [STYLE] + [GUARD] + [IDENTITY_ANCHOR 冻结] + [可变槽位] + [CLOSING]
 */
import { appearanceToPrompt, appearanceToLockedTraits, appearanceToVisualDNA, type Appearance } from './appearance.js';

/** ===== 固定层：风格锚点（禁止改动，改动即破坏一致性）===== */
export const STYLE_ANCHOR =
  '宫崎骏吉卜力工作室风格的水彩童书插画，单幅手绘水彩幻想插画质感，手工水彩湿画法、粗纹纸可见、水痕自然晕染、色彩轻柔通透叠加，线条极细极柔、无硬黑描边，暖粉彩色调（杏橙、奶油白、淡金、鼠尾草绿、天蓝），黄金时刻温暖侧光、高调明亮、空气感强、治愈梦幻';

export const NO_TEXT_GUARD =
  '纯画面、无任何排版元素；画面中零可读文字、零字母、零数字、零标题、零字幕、零签名、零水印、零徽标、零边框、零标签，尤其禁止画面底部或边缘出现书名、说明文字和副标题；地图可保留路线、罗盘、星图等非文字旅行图形，但不得出现可读文字、字母或数字；no readable text, letters, words, numbers, captions, titles, signatures, logos or watermarks anywhere';

export const ANATOMY_GUARD =
  '【主角猫四肢硬约束】主角猫全身总共恰好四条腿：两条前腿、两条后腿，并且只有一条尾巴；每条腿只出现一次且与身体自然连接，禁止第五条腿、额外爪子、重复前爪、重复后腿、悬空肢体、融合肢体；exactly four legs total (two forelegs and two hind legs), one tail, no extra or duplicated limbs or paws';

export const STYLE_GUARD =
  `不要写实照片、不要3D渲染、不要CG、不要塑料感、不要矢量扁平、不要硬黑描边、不要恐怖，${ANATOMY_GUARD}，${NO_TEXT_GUARD}`;

export const BIRTH_STYLE_CLOSING =
  '猫咪占画面主体清晰、背景柔焦虚化不抢主体，儿童绘本级精美水彩，梦幻治愈';

export const TRAVEL_STYLE_CLOSING =
  '猫咪与旅行环境共同构成画面主体，地点特征清楚，景深自然，单幅精美水彩旅行插画，梦幻治愈';

/** 兼容历史调用；新代码应明确选择出生或旅行 closing。 */
export const STYLE_CLOSING = BIRTH_STYLE_CLOSING;

/** 无参考图时：强制同猫约束（每次成长图必须附带） */
export const CONSISTENCY_GUARD_NO_REF =
  '【同猫强约束】画面必须是与首次出生图完全同一只猫，禁止换毛色、禁止换花纹、禁止换瞳色、禁止换品种体型、禁止换脸型耳型、禁止改变毛色花纹分布与五官比例，只允许改变动作姿态、表情神态、背景场景及与旅行相关的细微装饰';

/** ===== 可变层：猫的「可爱造型」基准（写入身份锚点后不再改动）===== */
export const CUTE_BODY =
  '超可爱 Q 版比例、大而有神的眼睛、小巧鼻头、温柔自然的表情；身体骨相、脸型、耳型、毛长和腿长严格服从品种设定，不使用统一猫模板';

export const CANONICAL_BIRTH_COMPOSITION =
  '标准角色定妆构图：单只猫、正面略微四分之三视角、全身完整入镜、头顶耳朵到尾巴与四爪均不裁切，头部/颈部/背部边界清楚，镜头高度与猫眼齐平，禁止大透视、禁止鱼眼、禁止遮挡脸和身体';

export const TRAVEL_SCENE_COMPOSITION =
  '旅行现场图，不是角色定妆照；只表现一个连续瞬间，不拼贴、不分栏、不另加随机动作或通用云背景；动作、视线、道具、光线和环境必须共同服务于本次旅行经历';

export const TRAVEL_LIMB_GUARD =
  '【旅行持物四肢约束】主角猫持地图或其他道具时，只能使用上述已有的两只前爪；被道具、身体或背包遮挡的腿保持被遮挡，宁可少露出也绝不补画；背包、衣物、道具和动作不得复制任何前爪或后腿';

export const ENCOUNTER_ANATOMY_GUARD =
  '【双猫数量与四肢硬约束】画面中恰好两只猫、禁止第三只猫或其他动物；每只猫各自恰好四条腿（两条前腿、两条后腿）和一条尾巴，两只猫的身体、四肢、尾巴与花纹必须彼此独立，禁止融合身体、共享肢体、额外爪子、重复尾巴或交换外貌';

function anonymousVisualAnchor(label: string, appearance: Appearance) {
  return [
    `${label}：一只${appearanceToPrompt(appearance)}的云旅行猫，${CUTE_BODY}`,
    `【${label}外貌锁定】${appearanceToLockedTraits(appearance)}`,
    `【${label}视觉DNA】${appearanceToVisualDNA(appearance)}`,
  ].join('，');
}

/** 猫遇合照：只使用两只猫的视觉 DNA，不把任一猫名或主人信息发送给另一方账号。 */
export function buildEncounterPhotoPrompt(params: {
  leftAppearance: Appearance;
  rightAppearance: Appearance;
  locationName: string;
  encounterSummary: string;
}): string {
  return [
    STYLE_ANCHOR,
    NO_TEXT_GUARD,
    ENCOUNTER_ANATOMY_GUARD,
    anonymousVisualAnchor('猫A', params.leftAppearance),
    anonymousVisualAnchor('猫B', params.rightAppearance),
    '猫遇合照构图：两只猫都完整清晰入镜，处在同一连续场景、同一光线与同一镜头中，像旅途中自然留下的一张友好合照；不拼贴、不分栏、不做证件照、不添加名字牌',
    `地点：${params.locationName.slice(0, 40)}`,
    `共同瞬间：${params.encounterSummary.slice(0, 90)}`,
    '两只猫保持舒适友好的距离，自然看向彼此或镜头，动作轻松但不拥挤，不改变各自毛色、花纹、瞳色、品种体型与脸型耳型',
    TRAVEL_STYLE_CLOSING,
  ].join('，');
}

/** 默认动作库：拟人化、软萌、有故事感 */
export const CUTE_POSES = [
  '双手（前爪）捧着一颗小星星，好奇地歪着头',
  '慵懒地趴在云朵上，一只前爪托着下巴发呆',
  '张开两只前爪，像在拥抱整个天空',
  '盘腿坐着，双爪放在膝盖上，闭眼微笑晒太阳',
  '踮起后腿伸懒腰，尾巴俏皮地翘起',
  '侧身回眸，一只小爪轻轻招手打招呼',
  '抱着一朵小云当抱枕，睡眼惺忪',
  '坐在云边轻轻晃着两只后爪，仰头看飞鸟',
];

/** 默认背景库：均为 Me&Me 云世界，柔焦远景 */
export const CUTE_BACKGROUNDS = [
  '远景浮空岛漂浮于绵软云海，岛上绿野红顶白屋、细瀑布、蜿蜒石径，天空淡蓝到暖黄渐变',
  '身处蓬松云海之上，远处几座漂浮小岛与彩虹，暖金晨光',
  '坐在一朵大云上，四周点缀细碎星光与柔焦飞鸟，暮色粉橘天空',
  '云端花田，四周飘着蒲公英绒毛与野花花瓣，远景浮岛小屋',
];

export type CatPromptSlots = {
  look: string;
  pose: string;
  background: string;
  extra?: string;
};

/** 核心：把槽位拼成统一风格 prompt（出生图用） */
export function composeCatPrompt(slots: CatPromptSlots): string {
  return [
    STYLE_ANCHOR,
    STYLE_GUARD,
    `一只${slots.look}的云旅行猫，${CUTE_BODY}`,
    `动作姿态：${slots.pose}`,
    `背景：${slots.background}`,
    slots.extra ? slots.extra : '',
    BIRTH_STYLE_CLOSING,
  ]
    .filter(Boolean)
    .join('，');
}

function pick<T>(arr: T[], seed: number): T {
  return arr[Math.abs(seed) % arr.length];
}

function seedFrom(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

function traitFromAttrs(attrs: {
  courage: number;
  curiosity: number;
  affinity: number;
  insight: number;
}): string {
  const traits: string[] = [];
  if (attrs.courage >= 6) traits.push('眼神坚定勇敢');
  if (attrs.curiosity >= 6) traits.push('耳朵微竖满是好奇');
  if (attrs.affinity >= 6) traits.push('表情温柔亲人');
  if (attrs.insight >= 6) traits.push('目光灵动有神');
  if (traits.length === 0) traits.push('气质懒洋洋而软萌');
  return traits.join('、');
}

/**
 * 身份锚点：建猫时生成一次并写入 cats.image_identity_anchor。
 * 后续所有生图（出生重试、成长）必须逐字复用此文本，禁止重新措辞。
 */
export function buildCatIdentityAnchor(params: { name: string; appearance: Appearance }): string {
  const look = appearanceToPrompt(params.appearance);
  const locked = appearanceToLockedTraits(params.appearance);
  return [
    `一只${look}的云旅行猫，${CUTE_BODY}，名叫「${params.name}」`,
    `【外貌锁定·禁止改变】${locked}`,
    `【视觉DNA v2】${appearanceToVisualDNA(params.appearance)}`,
  ].join('，');
}

function ensureVisualDna(identityAnchor: string, appearance: Appearance): string {
  if (identityAnchor.includes('【视觉DNA v2】')) return identityAnchor;
  return `${identityAnchor}，【视觉DNA v2】${appearanceToVisualDNA(appearance)}`;
}

export type BirthPromptResult = { prompt: string; identityAnchor: string };

/** 建猫：出生形象。身份锚点随 prompt 一并返回供落库 */
export function buildBirthPrompt(params: {
  name: string;
  personality: string;
  appearance: Appearance;
  attrs: { courage: number; curiosity: number; affinity: number; insight: number };
  /** 若已有锚点（重试生图），直接复用 */
  identityAnchor?: string;
}): BirthPromptResult {
  const { name, personality, appearance, attrs } = params;
  const identityAnchor = ensureVisualDna(
    params.identityAnchor || buildCatIdentityAnchor({ name, appearance }),
    appearance,
  );
  const seed = seedFrom(`${name}:${personality}`);
  const prompt = [
    STYLE_ANCHOR,
    STYLE_GUARD,
    identityAnchor,
    CANONICAL_BIRTH_COMPOSITION,
    `动作姿态：${pick(CUTE_POSES, seed)}`,
    `背景：${pick(CUTE_BACKGROUNDS, seed >> 3)}`,
    `性格${personality.slice(0, 40)}，神态${traitFromAttrs(attrs)}`,
    BIRTH_STYLE_CLOSING,
  ].join('，');
  return { prompt, identityAnchor };
}

/** 旅行现场：身份锚点逐字复用，构图只由地点、经历与心情驱动。 */
export function buildTravelPrompt(params: {
  name: string;
  personality: string;
  appearance: Appearance;
  narrative: string;
  mood?: string;
  locationName: string;
  attrs: { courage: number; curiosity: number; affinity: number; insight: number };
  /** 必填：来自 cats.image_identity_anchor，保证与出生图同措辞 */
  identityAnchor: string;
  hasRef?: boolean;
}): string {
  const { name, appearance, narrative, mood, locationName, attrs, hasRef } = params;
  const identityAnchor = ensureVisualDna(params.identityAnchor, appearance);
  const variable = [
    hasRef
      ? `画面主角必须是参考图中的同一只猫「${name}」，五官毛色花纹瞳色体型与参考图完全一致，只改变动作、神态与背景`
      : CONSISTENCY_GUARD_NO_REF,
    TRAVEL_SCENE_COMPOSITION,
    TRAVEL_LIMB_GUARD,
    `旅行地点：「${locationName}」；心情${mood || '平静'}`,
    `旅行现场：${narrative.slice(0, 90)}`,
    '根据旅行现场自然决定猫的动作姿态、视线方向、环境位置和细微装饰，不套用出生定妆动作',
    `神态${traitFromAttrs(attrs)}`,
  ].join('，');

  return [STYLE_ANCHOR, STYLE_GUARD, identityAnchor, variable, TRAVEL_STYLE_CLOSING].join('，');
}

/** 兼容数据库与既有服务中的 growth 命名。 */
export const buildGrowthPrompt = buildTravelPrompt;

/** 兼容旧调用名 */
export const buildMeAndMeBirthPrompt = (params: Parameters<typeof buildBirthPrompt>[0]) =>
  buildBirthPrompt(params).prompt;
export const buildMeAndMeGrowthPrompt = buildTravelPrompt;
