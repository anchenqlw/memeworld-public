import crypto from 'node:crypto';

export const BASE_COLORS = ['cream', 'gray', 'orange', 'calico', 'black'];
export const PATTERNS = ['solid', 'tabby', 'tuxedo', 'spots', 'stripes'];
export const EYES = ['green', 'amber', 'blue', 'hetero'];
export const BREEDS = ['shorthair', 'british', 'ragdoll', 'siamese', 'fold', 'munchkin', 'abyssinian', 'maine_coon'];

export type Appearance = {
  baseColor: string;
  pattern: string;
  eyes: string;
  /** 品种（决定体型/脸型/耳型），旧数据可能没有 */
  breed?: string;
};

const COLOR_ZH: Record<string, string> = {
  cream: '奶油白',
  gray: '银灰',
  orange: '暖橘',
  calico: '三花玳瑁',
  black: '墨黑',
};

const PATTERN_ZH: Record<string, string> = {
  solid: '纯色无附加花纹',
  tabby: '经典虎斑',
  tuxedo: '黑白燕尾',
  spots: '柔和斑点',
  stripes: '柔和条纹',
};

const COLOR_DNA_ZH: Record<string, string> = {
  cream: '全身主色为均匀奶油白，除品种固有重点色外不凭空增加深色块',
  gray: '全身主色为冷调银灰，面部与身体保持同一灰阶，不漂成蓝色或棕色',
  orange: '全身主色为暖橘，口鼻和胸口略浅，不漂成灰色或纯白猫',
  calico: '固定三花色块：画面左耳与左额为暖橘、右耳与右额为墨黑、鼻梁口鼻胸口为白色，左右分区不得互换',
  black: '全身主色为墨黑，靠水彩高光表现毛发层次，不漂成灰猫或棕猫',
};

const PATTERN_DNA_ZH: Record<string, string> = {
  solid: '不叠加虎斑、条纹、斑点或燕尾服白区，尾巴与四爪延续身体主色；品种固有重点色不视作附加花纹',
  tabby: '固定经典虎斑拓扑：额头清晰M纹、双颊各两道短纹、前腿细环纹、尾巴等距环纹',
  tuxedo: '固定燕尾服拓扑：背部与头顶保留主色，口鼻、倒三角胸口与四只脚尖为对称白区',
  spots: '固定柔和斑点拓扑：画面左眼上方小斑、右肩大斑、左前腿小斑、尾尖深色，其余区域保持主色',
  stripes: '固定细条纹拓扑：额头、双颊、肩背和尾巴为窄而浅的连续细纹，间距均匀且不变成粗虎斑',
};

const EYE_DNA_ZH: Record<string, string> = {
  green: '双眼虹膜均为翠绿色，黑色圆瞳与高光位置对称',
  amber: '双眼虹膜均为琥珀金色，黑色圆瞳与高光位置对称',
  blue: '双眼虹膜均为湛蓝色，黑色圆瞳与高光位置对称',
  hetero: '固定异色瞳：画面左眼湛蓝、画面右眼琥珀金，左右绝不互换',
};

const EYES_ZH: Record<string, string> = {
  green: '翠绿',
  amber: '琥珀金',
  blue: '湛蓝',
  hetero: '异色瞳（一蓝一金）',
};

/** 品种 → 体貌特征描述（用于生图 prompt，强调可辨识的形体差异） */
const BREED_ZH: Record<string, string> = {
  shorthair: '中华田园短毛猫体型，标准圆脸立耳',
  british: '英国短毛猫体型，脸颊圆鼓、身体壮实厚毛',
  ragdoll: '布偶猫体型，蓬松长毛、围脖状毛领、蓬大尾巴',
  siamese: '暹罗猫体型，脸部和耳朵带深色重点色、身形修长优雅',
  fold: '苏格兰折耳猫体型，双耳向前折叠贴头、圆脸',
  munchkin: '曼基康矮脚猫体型，腿特别短小、身体贴地圆润',
  abyssinian: '阿比西尼亚猫体型，瘦长精悍、楔形脸、大耳、蜜色细密滴答纹短毛',
  maine_coon: '缅因猫体型，大体型长毛、宽阔口鼻、耳尖簇毛、颈周浓密围脖',
};

/** 将程序化外观转为生图 prompt 片段 */
export function appearanceToPrompt(a: Appearance): string {
  const color = COLOR_ZH[a.baseColor] || a.baseColor;
  const pattern = PATTERN_ZH[a.pattern] || a.pattern;
  const eyes = EYES_ZH[a.eyes] || a.eyes;
  const breed = a.breed ? BREED_ZH[a.breed] || '' : '';
  return [breed, `${color}${pattern}，${eyes}圆眼`].filter(Boolean).join('，');
}

/**
 * 外貌不可变要点（结构化、逐字段锁定）。
 * 出生图写入 cats.image_identity_anchor 后，成长图必须逐字复用，禁止重算措辞。
 */
export function appearanceToLockedTraits(a: Appearance): string {
  const breed = a.breed ? BREED_ZH[a.breed] || a.breed : BREED_ZH.shorthair;
  const color = COLOR_ZH[a.baseColor] || a.baseColor;
  const pattern = PATTERN_ZH[a.pattern] || a.pattern;
  const eyes = EYES_ZH[a.eyes] || a.eyes;
  return [
    `品种体型=${breed}`,
    `毛色=${color}`,
    `花纹=${pattern}`,
    `瞳色=${eyes}`,
    '脸型与耳型=严格服从上述品种骨相，不套用其他品种',
    '毛长与腿长=严格服从上述品种，不统一改成长毛或短腿',
    '头身比例=可爱Q版，但品种辨识特征必须保留',
  ].join('；');
}

/** 可重复生成的视觉 DNA：比“保持一致”更具体地描述色块与纹路位置。 */
export function appearanceToVisualDNA(a: Appearance): string {
  const breed = a.breed ? BREED_ZH[a.breed] || a.breed : BREED_ZH.shorthair;
  return [
    `品种骨相：${breed}`,
    `毛色布局：${COLOR_DNA_ZH[a.baseColor] || a.baseColor}`,
    `花纹布局：${PATTERN_DNA_ZH[a.pattern] || a.pattern}`,
    `眼睛：${EYE_DNA_ZH[a.eyes] || a.eyes}`,
    '约束优先级：品种固有骨相与重点色 > 毛色布局 > 花纹布局，后级不得否定前级',
    '五官定位：双眼等高、鼻头居中、口鼻宽度固定，耳朵大小与间距固定',
    '禁止新增围脖、白袜、面罩、额纹或尾环，除非品种固有特征或上述视觉DNA明确要求',
  ].join('；');
}

/** 校验前端传入的外貌选择是否都在白名单内 */
export function isValidAppearance(a: unknown): a is Appearance {
  if (!a || typeof a !== 'object') return false;
  const o = a as Record<string, unknown>;
  return (
    typeof o.baseColor === 'string' && BASE_COLORS.includes(o.baseColor) &&
    typeof o.pattern === 'string' && PATTERNS.includes(o.pattern) &&
    typeof o.eyes === 'string' && EYES.includes(o.eyes) &&
    (o.breed === undefined || (typeof o.breed === 'string' && BREEDS.includes(o.breed)))
  );
}

export function generateAppearance(name: string, personality: string): Appearance {
  const hash = crypto.createHash('sha256').update(`${name}:${personality}`).digest();
  return {
    baseColor: BASE_COLORS[hash[0] % BASE_COLORS.length],
    pattern: PATTERNS[hash[1] % PATTERNS.length],
    eyes: EYES[hash[2] % EYES.length],
    breed: BREEDS[hash[3] % BREEDS.length],
  };
}

export function moodToExpression(mood?: string | null): string {
  if (!mood) return 'calm';
  if (/开心|快乐|兴奋/.test(mood)) return 'happy';
  if (/好奇|探索/.test(mood)) return 'curious';
  if (/宁静|治愈|平静/.test(mood)) return 'calm';
  if (/神秘|害怕/.test(mood)) return 'mysterious';
  return 'calm';
}
