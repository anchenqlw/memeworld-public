/** 通道抽象（S-11）：Web 实现，IM 留插槽 */

export type NotificationPayload = {
  type: 'travel_complete' | 'badge_earned' | 'system';
  title: string;
  body: string;
  data?: Record<string, unknown>;
};

export interface Channel {
  readonly name: 'web' | 'im';
  send(userId: string, payload: NotificationPayload): Promise<void>;
}

/** Phase 1：站内通知暂为 no-op（前端拉取时间线）；保留接口供后续 WebSocket/站内信 */
export class WebChannel implements Channel {
  readonly name = 'web' as const;
  async send(_userId: string, _payload: NotificationPayload): Promise<void> {
    /* Phase 1: pull-based timeline */
  }
}

/** Phase 2：对接 QCA IM channel */
export class ImChannel implements Channel {
  readonly name = 'im' as const;
  async send(_userId: string, _payload: NotificationPayload): Promise<void> {
    throw new Error('IM channel not implemented');
  }
}

let webChannel: WebChannel | null = null;

export function getWebChannel(): WebChannel {
  if (!webChannel) webChannel = new WebChannel();
  return webChannel;
}

export async function notifyUser(userId: string, payload: NotificationPayload) {
  await getWebChannel().send(userId, payload);
}
