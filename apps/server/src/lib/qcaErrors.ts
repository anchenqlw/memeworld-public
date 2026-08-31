export const QCA_CREDITS_UNAVAILABLE = 'QCA_CREDITS_UNAVAILABLE';

export type QcaUserAlert = {
  code: typeof QCA_CREDITS_UNAVAILABLE;
  message: string;
  help_url: string;
  source: 'image' | 'travel' | 'chat';
};

export const QCA_CREDITS_STILL_UNAVAILABLE = 'QCA_CREDITS_STILL_UNAVAILABLE';

export function qcaCreditsRecoveryPendingError(helpUrl = 'https://qoder.com/pricing') {
  return Object.assign(
    new Error('云端能量好像还没有同步过来。请确认充值已经完成，稍等片刻后再试一次。'),
    {
      code: QCA_CREDITS_STILL_UNAVAILABLE,
      status: 409,
      help_url: helpUrl,
    },
  );
}

export function shouldSurfaceQcaCreditsFailure(failureCreatedAt?: string, creditsRecoveredAt?: string) {
  if (!creditsRecoveredAt || !failureCreatedAt) return true;
  const failureTime = Date.parse(failureCreatedAt);
  const recoveryTime = Date.parse(creditsRecoveredAt);
  if (!Number.isFinite(failureTime) || !Number.isFinite(recoveryTime)) return true;
  return failureTime > recoveryTime;
}

type QcaErrorContext = {
  status?: number;
  source: QcaUserAlert['source'];
  imageGen?: boolean;
};

export function detectQcaCreditsUnavailable(value: unknown, context: QcaErrorContext): boolean {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const status = context.status ?? Number(text.match(/\bHTTP\s+(\d{3})\b/i)?.[1] || text.match(/\bstatus[=:]\s*(\d{3})\b/i)?.[1]);
  if (status === 402) return true;
  if (context.imageGen && (status === 403 || /\bimage[_\s-]?gen\b.*\bHTTP\s+403\b/i.test(text))) return true;
  // 仅匹配明确的额度/计费错误，避免 tool schema 的 "required" 或成功事件的 "credits_used" 误报
  return /(?:insufficient|exhausted|depleted|unavailable).{0,48}(?:credit|credits|quota|balance)|(?:credit|credits|quota|balance).{0,48}(?:insufficient|exhausted|depleted|unavailable)|billing|payment required|额度不足|余额不足|欠费|计费失败|请充值/i.test(text);
}

export function createQcaCreditsError(context: QcaErrorContext, detail?: string) {
  return Object.assign(
    new Error('Qoder Credits 不足或对应能力未开通'),
    {
      name: 'QcaCreditsUnavailableError',
      code: QCA_CREDITS_UNAVAILABLE,
      status: context.status,
      retryable: false,
      source: context.source,
      detail: detail?.slice(0, 500),
    }
  );
}

export function toQcaUserAlert(source: QcaUserAlert['source']): QcaUserAlert {
  return {
    code: QCA_CREDITS_UNAVAILABLE,
    message: source === 'image'
      ? '云端画师的能量暂时不够，小猫会在这里好好等你。'
      : source === 'travel'
        ? '今天的云端能量暂时不够，小猫先回猫舍歇一会儿。'
        : '云端能量暂时不够，小猫把想说的话先轻轻收好了。',
    help_url: 'https://qoder.com/pricing',
    source,
  };
}

export function toAdventureStartUserMessage(error: unknown) {
  const typed = error as { code?: string; message?: string } | null | undefined;
  const message = typed?.message?.trim();
  if (
    typed?.code === 'QCA_API_ERROR'
    || Boolean(message && /QCA(?: Forward)?\s+\w+\s+\/|\/identities\/|\/templates\/|\/schedules\//i.test(message))
  ) {
    return '云端探险准备稍有延迟，请稍后重试。';
  }
  return message || '探险启动失败';
}

export function isNonRetryableQcaError(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'retryable' in error && error.retryable === false);
}
