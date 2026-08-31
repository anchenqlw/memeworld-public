import type { Proposal } from '../../api/client';

export type ProposalPublicStatus = Proposal['public_status'];

export const PROPOSAL_REVIEW_CADENCE = '新来信进入队列后会被周期性整理；结论与上线时间取决于评估、开发和验证，不承诺固定期限。';

const NEXT_STEP: Record<ProposalPublicStatus, string> = {
  received: '下一步：收录来信并整理公开内容，然后进入价值、成本与风险评估。',
  'under-review': '下一步：评估价值、成本与风险；形成结论后，皮卡会在这里回复。',
  accepted: '下一步：已采纳，等待进入制作；完成后还要经过验证。',
  'partially-accepted': '下一步：只制作回复中说明的部分范围；完成后还要经过验证。',
  'in-progress': '下一步：正在制作；完成测试后仍需通过 production 观察，才会标记已上线。',
  validating: '下一步：交付内容正在验证；只有 production 观察通过后，才会标记已上线。',
  verified: '下一步：production 观察已经通过，本项已上线。',
  'not-planned': '下一步：本轮不进入制作；原因见皮卡回复，有新信息时可以再次来信。',
};

export function proposalNextStep(status: ProposalPublicStatus | string | undefined) {
  return NEXT_STEP[status as ProposalPublicStatus] || NEXT_STEP['under-review'];
}

/** 防止产品文案把处理节奏写成中文数字、相对日期或 SLA 承诺。 */
export function containsDeadlinePromise(text: string) {
  const numberedDeadline = /(?:\d+|[零〇一二两三四五六七八九十百千万半]+)\s*(?:分钟|小时|天|日|周|星期|个月|月|年)(?:内|后|前|之内)?/;
  const relativeDeadline = /(?:今天|明天|后天|本周|下周|这周|月底|月末|年内|年底)(?:内|前|完成|上线|回复)?/;
  const promise = /(?:保证|最迟|一定会|务必在|确保在|承诺(?!固定期限)|预计[^，。；]*(?:内|前|后))/;
  return numberedDeadline.test(text) || relativeDeadline.test(text) || promise.test(text);
}
