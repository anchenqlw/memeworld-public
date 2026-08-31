/**
 * 第二轮纯文本 prompt 试跑：10 种不同结构，目标逼近 v10/hero 画风。
 * 全部不传参考图；主体统一为暖橘虎斑「小云」坐云上，排除毛色干扰。
 */

const GUARD =
  '不要写实照片、不要3D渲染、不要CG、不要塑料感、不要矢量、不要硬黑描边、不要畸形、不要文字水印';

const CAT =
  '名叫小云的暖橘色圆胖虎斑猫，大圆深琥珀纽扣眼，粉色小鼻，蓬松长毛，懒洋洋温柔微笑，端坐在蓬松水彩白云上';

const WORLD =
  '远景浮空岛、红顶白屋、绿野瀑布、蜿蜒石径、绵软云海，天空淡蓝到暖黄渐变';

export const PROMPT_STRUCTURES_V2: Array<{
  id: string;
  label: string;
  structure: string;
  prompt: string;
}> = [
  {
    id: 's01',
    label: 'v10纯文本加强版',
    structure: '单层叙述·复刻v10语义',
    prompt: [
      '宫崎骏吉卜力水彩童书插画，学习提案hero图的技法色彩笔触光影，不复制构图',
      GUARD,
      CAT,
      `背景${WORLD}`,
      '儿童绘本级精美水彩，湿画法纸纹可见，暖粉彩 pastel，黄金时刻侧光，治愈梦幻',
    ].join('，'),
  },
  {
    id: 's02',
    label: '主体优先·风格后置',
    structure: '主体→场景→风格→禁止',
    prompt: [
      CAT + '，全身像，微微侧脸，占画面主体',
      `场景：${WORLD}，背景柔焦虚化`,
      '画风：宫崎骏动画背景美术、手工水彩、柔边无描线、暖橙奶油白天蓝鼠尾草绿',
      GUARD,
    ].join('。'),
  },
  {
    id: 's03',
    label: '风格前缀·五层锚定',
    structure: '流派→技法→色调→光影→内容',
    prompt: [
      '【流派】宫崎骏吉卜力工作室概念美术，欧洲童书水彩',
      '【技法】湿画法、粗纹纸、水痕晕染、透明叠色、极细柔线',
      '【色调】杏橙、奶油白、淡金、鼠尾草绿、天蓝粉彩',
      '【光影】黄金时刻暖侧光、高调明亮、空气透视',
      `【内容】${CAT}，${WORLD}`,
      `【禁止】${GUARD}`,
    ].join('，'),
  },
  {
    id: 's04',
    label: '中英混排·模型友好',
    structure: '英文风格词+中文叙事',
    prompt: [
      'Studio Ghibli style, Hayao Miyazaki inspired, soft watercolor illustration, storybook art, pastel warm palette, golden hour lighting, wet-on-wet technique, visible paper texture, no harsh outlines, dreamy atmosphere',
      GUARD,
      '一只chubby ginger tabby cat named Xiaoyun sitting on a fluffy painted cloud',
      'background: floating islands with red-roof cottage, waterfall, stone path, soft clouds',
      '治愈系，儿童绘本封面级精美',
    ].join('，'),
  },
  {
    id: 's05',
    label: '标签分段·XML式',
    structure: '[风格][角色][构图][世界][负向]',
    prompt: [
      '<风格>宫崎骏吉卜力水彩绘本，手工湿画，暖粉彩，无硬描边</风格>',
      '<角色>暖橘圆胖虎斑猫小云，大圆琥珀眼，粉鼻，蓬松，坐云上</角色>',
      '<构图>猫居中偏下，全身像，背景虚化，主体清晰</构图>',
      `<世界>${WORLD}</世界>`,
      `<负向>${GUARD}</负向>`,
    ].join(' '),
  },
  {
    id: 's06',
    label: '镜头语言·电影分镜',
    structure: '景别+机位+焦点+氛围',
    prompt: [
      '中景镜头，略微俯拍15度，焦点在猫眼部，浅景深',
      '宫崎骏动画电影概念海报水彩风格',
      CAT,
      `环境${WORLD}，大气透视，远景朦胧`,
      '色彩：暖橙主导，辅以奶油白与天蓝，黄金时刻',
      '质感：手绘水彩纸纹、水痕、柔边，' + GUARD,
    ].join('，'),
  },
  {
    id: 's07',
    label: '艺术家引用栈',
    structure: '多艺术家风格叠加',
    prompt: [
      '融合宫崎骏天空之城背景美术、吉卜力猫咪角色设计、英国童书水彩绘本质感',
      '像《龙猫》《魔女宅急便》概念原画的水彩手绘感',
      GUARD,
      CAT,
      WORLD,
      '温暖治愈、粉彩、无写实、无3D',
    ].join('，'),
  },
  {
    id: 's08',
    label: '色板量化描述',
    structure: '显式色彩占比+材质',
    prompt: [
      '色彩配比：暖橘色30%、奶油白25%、淡金15%、鼠尾草绿15%、天蓝15%',
      '材质：粗纹水彩纸、颜料透明叠加、边缘水渍晕染',
      '宫崎骏吉卜力童书插画光影',
      CAT,
      WORLD,
      '线条棕色细铅笔感，不要纯黑线，' + GUARD,
    ].join('，'),
  },
  {
    id: 's09',
    label: '负向前置·正向精简',
    structure: '先禁止后描述·短句高密度',
    prompt: [
      GUARD,
      '宫崎骏水彩',
      '暖橘胖虎斑猫小云坐云',
      '大圆琥珀眼粉鼻',
      '浮岛红屋瀑布云海',
      '暖粉彩黄金光绘本质感湿画法纸纹柔边',
    ].join('，'),
  },
  {
    id: 's10',
    label: 'hero场景文字临摹',
    structure: '逐元素描述提案图',
    prompt: [
      '复刻Me&Me提案hero图的艺术风格但不画同一只猫：',
      '宫崎骏吉卜力水彩，暖色粉彩，手绘纸纹，黄金时刻侧光，柔边无硬线',
      '主角：暖橘圆胖虎斑猫小云，坐蓬松白云上，大圆深眼，温柔微笑，蓬松可爱',
      '背景元素同提案：浮空岛漂浮、岛上翠绿草地、红顶白墙小屋、细瀑布入云、蜿蜒石径、蓬松水彩云、淡蓝到暖黄天空',
      '猫清晰前景，世界柔焦远景，治愈童书感，' + GUARD,
    ].join('，'),
  },
];
