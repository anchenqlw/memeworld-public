export const SHIPPED_VALIDATING_PUBLIC_NOTE = '这个想法已完成交付，正在等待 production 观察验证；通过后才会显示已上线。';
export const PRODUCTION_VERIFIED_PUBLIC_NOTE = '这个想法已通过 production 观察验证，已经正式上线。';

const FIXED_PUBLIC_NOTES: Readonly<Record<string, string>> = Object.freeze({
  new: '我已经收到这封信，会把它放进下一轮评估。',
  exported: '我已经把这封信收进世界的 issue 档案，接下来会认真评估。',
  triaged: '我正在评估它的价值、成本和风险，有结论会继续写信告诉你。',
  accepted: '这个想法被采纳了，我会把它放进世界的进化计划。',
  'partially-accepted': '这个想法有一部分会进入进化计划，具体范围以最终交付为准。',
  rejected: '这次暂不采纳；如果条件发生变化，可以再写信告诉我。',
  'in-progress': '这个想法已经开始制作，我会继续记录进展。',
  shipped: SHIPPED_VALIDATING_PUBLIC_NOTE,
});

/**
 * 玩家可见说明只能来自服务端状态模板。普通 ack 的自由文本不进入这里；历史数据库
 * 中的 public_note 也不能回流。只有可信的 production-verified 事件能选择 verified 模板。
 */
export function proposalPublicNote(status: string | null | undefined, productionVerified = false) {
  if (productionVerified) return PRODUCTION_VERIFIED_PUBLIC_NOTE;
  return FIXED_PUBLIC_NOTES[status || ''] ?? FIXED_PUBLIC_NOTES.triaged;
}
