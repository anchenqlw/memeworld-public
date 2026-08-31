/**
 * 建猫向导的全部可勾选项。
 * 外貌四项（品种/毛色/花纹/瞳色）与服务端 lib/appearance.ts 白名单一一对应，
 * 服务端校验后固化入库，并作为生图 prompt 的一致性约束。
 */

export type SwatchOption = {
  id: string;
  label: string;
  /** AI 生成的水彩外观示例；swatch 仅作为图片加载前/失败时的兜底。 */
  image: string;
  swatch: string;
  hint: string;
};

export const BREED_OPTIONS: SwatchOption[] = [
  { id: 'shorthair', label: '田园短毛', image: '/assets/game/appearance/breed-shorthair.png', swatch: 'linear-gradient(135deg,#e8d9bd,#c9ab7e)', hint: '皮实机灵的小土猫' },
  { id: 'british', label: '英短', image: '/assets/game/appearance/breed-british.png', swatch: 'linear-gradient(135deg,#cdd5de,#8e9bad)', hint: '圆脸鼓腮的小胖墩' },
  { id: 'ragdoll', label: '布偶', image: '/assets/game/appearance/breed-ragdoll.png', swatch: 'linear-gradient(135deg,#fdf6ec,#d9c9e8)', hint: '蓬松华丽的大围脖' },
  { id: 'siamese', label: '暹罗', image: '/assets/game/appearance/breed-siamese.png', swatch: 'linear-gradient(135deg,#f0e2ce,#6b5544)', hint: '自带深色小面罩' },
  { id: 'fold', label: '折耳', image: '/assets/game/appearance/breed-fold.png', swatch: 'linear-gradient(135deg,#e9dfd2,#b7a58e)', hint: '耳朵软软趴下来' },
  { id: 'munchkin', label: '矮脚', image: '/assets/game/appearance/breed-munchkin.png', swatch: 'linear-gradient(135deg,#fbeed4,#e2b784)', hint: '小短腿走路一扭一扭' },
  { id: 'abyssinian', label: '阿比西尼亚', image: '/assets/game/appearance/breed-abyssinian.png', swatch: 'linear-gradient(135deg,#e7bb72,#9f5f32)', hint: '大耳朵的蜜色小猎手' },
  { id: 'maine_coon', label: '缅因', image: '/assets/game/appearance/breed-maine_coon.png', swatch: 'linear-gradient(135deg,#d8bf94,#76533a)', hint: '耳尖带毛簇的长毛大猫' },
];

export const COLOR_OPTIONS: SwatchOption[] = [
  { id: 'cream', label: '奶油白', image: '/assets/game/appearance/color-cream.png', swatch: 'linear-gradient(135deg,#fdf6e3,#f5e6c8)', hint: '像刚出炉的牛奶面包' },
  { id: 'gray', label: '银灰', image: '/assets/game/appearance/color-gray.png', swatch: 'linear-gradient(135deg,#cdd5de,#9aa7b5)', hint: '雾气一样安静的颜色' },
  { id: 'orange', label: '暖橘', image: '/assets/game/appearance/color-orange.png', swatch: 'linear-gradient(135deg,#ffd9a0,#f4a261)', hint: '十只橘猫九只馋' },
  { id: 'calico', label: '三花', image: '/assets/game/appearance/color-calico.png', swatch: 'linear-gradient(135deg,#fdf6e3 33%,#f4a261 33% 66%,#6b5b4d 66%)', hint: '幸运的三色拼布' },
  { id: 'black', label: '墨黑', image: '/assets/game/appearance/color-black.png', swatch: 'linear-gradient(135deg,#4a4a58,#23232e)', hint: '夜色里的小影子' },
];

export const PATTERN_OPTIONS: SwatchOption[] = [
  { id: 'solid', label: '纯色', image: '/assets/game/appearance/pattern-solid.png', swatch: 'linear-gradient(135deg,#e8e2d4,#d8d0be)', hint: '干干净净一整块' },
  { id: 'tabby', label: '虎斑', image: '/assets/game/appearance/pattern-tabby.png', swatch: 'repeating-linear-gradient(115deg,#d9c6a5 0 8px,#a98d68 8px 13px)', hint: '经典的小老虎条纹' },
  { id: 'tuxedo', label: '燕尾服', image: '/assets/game/appearance/pattern-tuxedo.png', swatch: 'linear-gradient(115deg,#2e2e3a 45%,#f7f3e8 45%)', hint: '天生穿着小礼服' },
  { id: 'spots', label: '斑点', image: '/assets/game/appearance/pattern-spots.png', swatch: 'radial-gradient(circle at 30% 30%,#a98d68 12%,transparent 13%),radial-gradient(circle at 70% 60%,#a98d68 12%,transparent 13%),#e8ddc8', hint: '奶牛一样的软斑点' },
  { id: 'stripes', label: '细条纹', image: '/assets/game/appearance/pattern-stripes.png', swatch: 'repeating-linear-gradient(90deg,#e8ddc8 0 10px,#c9b189 10px 12px)', hint: '细细柔柔的纹路' },
];

export const EYE_OPTIONS: SwatchOption[] = [
  { id: 'green', label: '翠绿', image: '/assets/game/appearance/eyes-green.png', swatch: 'radial-gradient(circle,#7fce8f 30%,#3c8d54 70%)', hint: '春天草地的颜色' },
  { id: 'amber', label: '琥珀金', image: '/assets/game/appearance/eyes-amber.png', swatch: 'radial-gradient(circle,#ffd884 30%,#d99a2b 70%)', hint: '傍晚的暖阳' },
  { id: 'blue', label: '湛蓝', image: '/assets/game/appearance/eyes-blue.png', swatch: 'radial-gradient(circle,#8ecae6 30%,#3573a6 70%)', hint: '晴天的高空' },
  { id: 'hetero', label: '异色瞳', image: '/assets/game/appearance/eyes-hetero.png', swatch: 'linear-gradient(90deg,#3573a6 50%,#d99a2b 50%)', hint: '一蓝一金，独一无二' },
];

export type TraitOption = {
  id: string;
  label: string;
  /** 拼入性格描述的短句 */
  phrase: string;
  /** 该性格对天性的加成（勾选后自动推导天性，不再手动分点） */
  attrs?: Partial<Record<AttrKey, number>>;
};

export const TRAIT_OPTIONS: TraitOption[] = [
  { id: 'lazy', label: '慵懒', phrase: '慵懒爱睡，一天要打十个哈欠', attrs: { affinity: 1 } },
  { id: 'energetic', label: '元气', phrase: '精力旺盛，见到什么都想扑', attrs: { courage: 2, curiosity: 1 } },
  { id: 'clingy', label: '黏人', phrase: '黏人精，恨不得挂在主人身上', attrs: { affinity: 3 } },
  { id: 'aloof', label: '高冷', phrase: '表面高冷，其实偷偷在意主人', attrs: { insight: 2 } },
  { id: 'brave', label: '爱冒险', phrase: '胆子很大，越是没去过的地方越想去', attrs: { courage: 3 } },
  { id: 'chatty', label: '话痨', phrase: '话很多，遇到什么都要喵喵评论一番', attrs: { affinity: 2, curiosity: 1 } },
  { id: 'foodie', label: '贪吃', phrase: '闻到好吃的就走不动路', attrs: { curiosity: 2 } },
  { id: 'dreamy', label: '爱幻想', phrase: '喜欢发呆看云，脑袋里全是小剧场', attrs: { insight: 2, curiosity: 1 } },
  { id: 'gentle', label: '温柔', phrase: '性子软软的，对谁都轻声细语', attrs: { affinity: 2 } },
  { id: 'curious', label: '好奇宝宝', phrase: '好奇心爆棚，什么都要闻一闻碰一碰', attrs: { curiosity: 3 } },
  { id: 'shy', label: '怕生', phrase: '有点怕生，熟了之后才会露出肚皮', attrs: { insight: 1, affinity: 1 } },
  { id: 'proud', label: '傲娇', phrase: '嘴上嫌弃，身体却很诚实', attrs: { courage: 1, insight: 1 } },
];

export const MAX_TRAITS = 4;

export const ATTR_META = {
  courage: { label: '勇气', icon: 'courage' as const, desc: '敢不敢去更远的地方' },
  curiosity: { label: '好奇', icon: 'curiosity' as const, desc: '发现新鲜事物的概率' },
  affinity: { label: '亲和', icon: 'affinity' as const, desc: '与其他猫和居民的缘分' },
  insight: { label: '洞察', icon: 'insight' as const, desc: '看懂世界细节的能力' },
};

export const ATTR_KEYS = ['courage', 'curiosity', 'affinity', 'insight'] as const;
export type AttrKey = (typeof ATTR_KEYS)[number];

/** 天性数值（0~10）→ 等级文案：让玩家不用猜量表就知道这个数字算高算低（backlog #061） */
export function attrLevelLabel(value: number): string {
  if (value >= 9) return '出类拔萃';
  if (value >= 7) return '相当出色';
  if (value >= 5) return '渐入佳境';
  if (value >= 3) return '初露头角';
  return '慢慢萌芽';
}

/** 天性成长提示：hover/tooltip 用（backlog #061） */
export const ATTR_GROWTH_HINT = '天性满分 10，会随每次旅行中的经历慢慢成长';

/** 由勾选的性格标签自动推导初始天性（基础 3 点 + 标签加成，上限 10） */
export function deriveAttrsFromTraits(traitIds: string[]): Record<AttrKey, number> {
  const result: Record<AttrKey, number> = { courage: 3, curiosity: 3, affinity: 3, insight: 3 };
  for (const id of traitIds) {
    const t = TRAIT_OPTIONS.find((o) => o.id === id);
    if (!t?.attrs) continue;
    for (const key of ATTR_KEYS) {
      result[key] = Math.min(10, result[key] + (t.attrs[key] ?? 0));
    }
  }
  return result;
}
