import crypto from 'node:crypto';
import {
  buildCatIdentityAnchor,
  CANONICAL_BIRTH_COMPOSITION,
  CONSISTENCY_GUARD_NO_REF,
  CUTE_BACKGROUNDS,
  CUTE_POSES,
} from './meandmeImageStyle.js';
import { appearanceToLockedTraits, appearanceToVisualDNA, type Appearance } from './appearance.js';

export type PromptExperimentKind = 'birth' | 'travel';

export type PromptExperimentCase = {
  id: string;
  kind: PromptExperimentKind;
  cohort: string;
  cohortLabel: string;
  replicate: number;
  changedVariable: string;
  prompt: string;
  promptSha256: string;
};

const TEST_NAME = '小云';
const TEST_PERSONALITY = '温柔、好奇、喜欢观察发光的植物';
const TEST_APPEARANCE: Appearance = {
  breed: 'british',
  baseColor: 'orange',
  pattern: 'tabby',
  eyes: 'hetero',
};
/** 冻结 2026-07-16 实验使用的旧生产基线，避免生产定稿后历史矩阵漂移。 */
const LEGACY_STYLE_ANCHOR =
  '宫崎骏吉卜力工作室风格的水彩童书插画，欧洲高端儿童绘本封面质感，手工水彩湿画法、粗纹纸可见、水痕自然晕染、色彩轻柔通透叠加，线条极细极柔、无硬黑描边，暖粉彩色调（杏橙、奶油白、淡金、鼠尾草绿、天蓝），黄金时刻温暖侧光、高调明亮、空气感强、治愈梦幻';
const LEGACY_STYLE_GUARD =
  '不要写实照片、不要3D渲染、不要CG、不要塑料感、不要矢量扁平、不要硬黑描边、不要畸形肢体、不要多余肢体、不要恐怖、不要文字水印';
const LEGACY_STYLE_CLOSING =
  '猫咪占画面主体清晰、背景柔焦虚化不抢主体，儿童绘本级精美水彩，梦幻治愈';

const DESCRIPTIVE_STYLE =
  '单幅满版手绘水彩幻想动画插画，粗纹水彩纸可见，湿画法自然晕染，透明颜料柔和叠色，极细柔棕色轮廓，无硬黑描边，杏橙、奶油白、淡金、鼠尾草绿和天蓝的暖粉彩色调，黄金时刻温暖侧光，高调明亮，空气透视，背景柔焦但仍有环境层次';

const SIMPLE_NO_TEXT =
  '纯画面插画，不添加文字、标题、签名或水印';

const STRONG_NO_TEXT =
  '纯画面、无任何排版元素；画面中零文字、零字母、零数字、零符号、零标题、零字幕、零签名、零水印、零徽标、零边框、零标签；所有纸张、招牌、书本和物体表面保持完全空白；no text, letters, words, numbers, captions, signatures, logos or watermarks anywhere';

const SANITIZED_IDENTITY = [
  '单只英国短毛猫，脸颊圆鼓、身体壮实、短而浓密的毛发，保持英国短毛猫骨相',
  '全身主色为暖橘，口鼻与胸口略浅；固定经典虎斑拓扑：额头M纹、双颊各两道短纹、前腿细环纹、尾巴等距环纹',
  '固定异色瞳：画面左眼湛蓝、画面右眼琥珀金，双眼等高，鼻头居中，耳朵大小与间距固定',
  '可爱但不过度幼化的角色比例，四肢与尾巴完整，禁止改变毛色、纹路、眼睛方向、品种骨相和五官比例',
].join('，');

const FIXED_BIRTH_POSE =
  '单只猫正面略微四分之三视角自然端坐，全身完整入镜，头顶耳朵、尾巴和四爪均不裁切，镜头与猫眼齐平，猫位于画面中央，周围保留均衡呼吸空间';

const FIXED_BIRTH_BACKGROUND =
  '清晨云端草坡，少量无文字野花与远处柔焦浮岛，背景简洁，不出现纸张、书本、招牌、横幅或可书写平面';

const FIXED_TRAVEL_SCENE =
  '星湖绿境的清晨，单只猫站在浅蓝星光湖岸，伸出右前爪轻触一片悬浮发光的银绿色叶子；湖面形成一圈细小涟漪，后方是薄雾森林、低矮草丛和两三颗自然萤光，镜头与猫眼齐平，中景抓拍，动作自然，环境与角色构成一个连续现场';

function promptHash(prompt: string) {
  return crypto.createHash('sha256').update(prompt).digest('hex');
}

function legacyPick<T>(values: T[], seed: number): T {
  return values[Math.abs(seed) % values.length];
}

function legacySeedFrom(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index++) hash = (hash * 31 + value.charCodeAt(index)) | 0;
  return hash;
}

function legacyTraitFromAttrs() {
  return '耳朵微竖满是好奇、表情温柔亲人';
}

function withoutCoverSignal(prompt: string) {
  return prompt.replace('欧洲高端儿童绘本封面质感', '单幅手绘水彩幻想插画质感');
}

function currentIdentity() {
  return buildCatIdentityAnchor({ name: TEST_NAME, appearance: TEST_APPEARANCE });
}

function currentBirthPrompt() {
  const seed = legacySeedFrom(`${TEST_NAME}:${TEST_PERSONALITY}`);
  return [
    LEGACY_STYLE_ANCHOR,
    LEGACY_STYLE_GUARD,
    currentIdentity(),
    CANONICAL_BIRTH_COMPOSITION,
    `动作姿态：${legacyPick(CUTE_POSES, seed)}`,
    `背景：${legacyPick(CUTE_BACKGROUNDS, seed >> 3)}`,
    `性格${TEST_PERSONALITY.slice(0, 40)}，神态${legacyTraitFromAttrs()}`,
    LEGACY_STYLE_CLOSING,
  ].join('，');
}

function currentTravelPrompt() {
  const narrative = '在星湖绿境的湖边发现一片会发光的叶子，伸出右前爪轻轻碰了碰，湖面荡开细小涟漪';
  const seed = legacySeedFrom(`${TEST_NAME}:${narrative}`);
  const variable = [
    CONSISTENCY_GUARD_NO_REF,
    '本次仅允许改变：动作姿态、表情神态、背景场景、与旅行相关的细微装饰（如轻围巾、草叶、星光）',
    '刚结束在「星湖绿境」的旅行，心情安静而好奇',
    `动作姿态：${legacyPick(CUTE_POSES, seed)}`,
    `经历：${narrative}`,
    `神态${legacyTraitFromAttrs()}`,
    `背景：${legacyPick(CUTE_BACKGROUNDS, seed >> 3)}`,
  ].join('，');
  return [LEGACY_STYLE_ANCHOR, LEGACY_STYLE_GUARD, currentIdentity(), variable, LEGACY_STYLE_CLOSING].join('，');
}

function labeledIdentity() {
  return [
    currentIdentity(),
    `【受控外貌补充】${appearanceToLockedTraits(TEST_APPEARANCE)}`,
    `【受控视觉DNA】${appearanceToVisualDNA(TEST_APPEARANCE)}`,
  ].join('，');
}

function birthDescriptiveWithMetadata() {
  return [
    DESCRIPTIVE_STYLE,
    LEGACY_STYLE_GUARD,
    labeledIdentity(),
    CANONICAL_BIRTH_COMPOSITION,
    `动作姿态：${FIXED_BIRTH_POSE}`,
    `背景：${FIXED_BIRTH_BACKGROUND}`,
    `性格：${TEST_PERSONALITY}；神态温柔亲人、耳朵微竖、目光灵动`,
    SIMPLE_NO_TEXT,
  ].join('，');
}

function birthDescriptiveSanitized(noText: string) {
  return [
    DESCRIPTIVE_STYLE,
    SANITIZED_IDENTITY,
    FIXED_BIRTH_POSE,
    FIXED_BIRTH_BACKGROUND,
    '神态温柔放松，耳朵自然微竖，目光看向画面左前方的一点柔光',
    noText,
  ].join('，');
}

function travelSplitScene(style: string, identity: string, noText: string) {
  return [
    style,
    LEGACY_STYLE_GUARD,
    identity,
    '旅行现场图，不是角色定妆照；只表现一个连续瞬间，不拼贴、不分栏、不另加随机动作或通用云背景',
    FIXED_TRAVEL_SCENE,
    '猫的神态安静而好奇，注意力集中在发光叶子上；保持身份外貌不变，只改变动作、表情和现场环境',
    noText,
  ].join('，');
}

type CohortDefinition = Omit<PromptExperimentCase, 'id' | 'replicate' | 'promptSha256'>;

function repeat(definition: CohortDefinition, cohortIndex: number): PromptExperimentCase[] {
  return Array.from({ length: 5 }, (_, index) => {
    const replicate = index + 1;
    const prefix = definition.kind === 'birth' ? 'B' : 'T';
    const id = `${prefix}${String(cohortIndex).padStart(2, '0')}-${replicate}`;
    return {
      ...definition,
      id,
      replicate,
      promptSha256: promptHash(definition.prompt),
    };
  });
}

export function buildPromptExperimentMatrix(): PromptExperimentCase[] {
  const birthBase = currentBirthPrompt();
  const travelBase = currentTravelPrompt();
  const travelCurrentStyle = [LEGACY_STYLE_ANCHOR, LEGACY_STYLE_CLOSING].join('，');
  const birthCohorts: CohortDefinition[] = [
    {
      kind: 'birth', cohort: 'current-baseline', cohortLabel: '当前生产基线',
      changedVariable: '无；测量当前提示词的随机文字发生率', prompt: birthBase,
    },
    {
      kind: 'birth', cohort: 'remove-cover-signal', cohortLabel: '仅移除封面信号',
      changedVariable: '只把“儿童绘本封面质感”替换为“单幅水彩幻想插画质感”',
      prompt: withoutCoverSignal(birthBase),
    },
    {
      kind: 'birth', cohort: 'descriptive-style', cohortLabel: '描述式水彩风格',
      changedVariable: '不用品牌、童书、封面词，保留猫名、标签和性格原文',
      prompt: birthDescriptiveWithMetadata(),
    },
    {
      kind: 'birth', cohort: 'sanitized-visual-fields', cohortLabel: '仅受控视觉字段',
      changedVariable: '移除猫名、字段标签和性格原文，只保留受控视觉描述',
      prompt: birthDescriptiveSanitized(SIMPLE_NO_TEXT),
    },
    {
      kind: 'birth', cohort: 'strong-no-text', cohortLabel: '完整无文字约束',
      changedVariable: '在受控视觉字段模板上加强无文字、无排版、空白表面约束',
      prompt: birthDescriptiveSanitized(STRONG_NO_TEXT),
    },
  ];
  const travelCohorts: CohortDefinition[] = [
    {
      kind: 'travel', cohort: 'current-baseline', cohortLabel: '当前生产基线',
      changedVariable: '无；测量当前成长图模板的随机文字与场景漂移率', prompt: travelBase,
    },
    {
      kind: 'travel', cohort: 'independent-scene', cohortLabel: '独立旅行现场模板',
      changedVariable: '去除随机通用动作和随机通用云背景，固定为单一旅行现场',
      prompt: travelSplitScene(travelCurrentStyle, currentIdentity(), SIMPLE_NO_TEXT),
    },
    {
      kind: 'travel', cohort: 'descriptive-style', cohortLabel: '描述式旅行水彩风格',
      changedVariable: '独立现场不变，只移除品牌、童书和封面风格词',
      prompt: travelSplitScene(DESCRIPTIVE_STYLE, currentIdentity(), SIMPLE_NO_TEXT),
    },
    {
      kind: 'travel', cohort: 'sanitized-visual-fields', cohortLabel: '仅受控旅行视觉字段',
      changedVariable: '移除猫名、字段标签和旅行原文，只保留受控动作与环境',
      prompt: travelSplitScene(DESCRIPTIVE_STYLE, SANITIZED_IDENTITY, SIMPLE_NO_TEXT),
    },
    {
      kind: 'travel', cohort: 'strong-no-text', cohortLabel: '完整无文字旅行图',
      changedVariable: '在受控旅行模板上加强无文字、无排版、空白表面约束',
      prompt: travelSplitScene(DESCRIPTIVE_STYLE, SANITIZED_IDENTITY, STRONG_NO_TEXT),
    },
  ];
  return [
    ...birthCohorts.flatMap((definition, index) => repeat(definition, index + 1)),
    ...travelCohorts.flatMap((definition, index) => repeat(definition, index + 1)),
  ];
}
