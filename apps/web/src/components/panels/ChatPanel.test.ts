import { describe, expect, it } from 'vitest';
import { CHAT_CREDITS_NOTICE, chatInputPlaceholder, chatReadyActions, turnStatusText } from './ChatPanel';
import type { ChatHistoryMessage } from '../../api/client';

// #053 回归：processing 提示不得写死猫名，必须使用当前猫的名字。
function msg(overrides: Partial<ChatHistoryMessage> = {}): ChatHistoryMessage {
  return {
    id: 't1', role: 'user', text: '你好', created_at: '2026-07-24T00:00:00Z',
    turn_status: 'processing', ...overrides,
  } as ChatHistoryMessage;
}

describe('turnStatusText', () => {
  it('processing 提示嵌入当前猫名，不写死"蛋蛋"', () => {
    expect(turnStatusText(msg({ turn_status: 'processing' }), '布丁')).toBe('布丁正在想…');
    expect(turnStatusText(msg({ turn_status: 'processing' }), '喵喵')).toBe('喵喵正在想…');
    expect(turnStatusText(msg({ turn_status: 'processing' }), '蛋蛋')).toBe('蛋蛋正在想…');
  });

  it('非 processing 状态不引入猫名（与用户输入解耦）', () => {
    expect(turnStatusText(msg({ turn_status: 'queued' }), '布丁')).toBe('排队中');
    expect(turnStatusText(msg({ turn_status: 'queued', queue_position: 3 }), '布丁')).toBe('排队中 · 前面 2 条');
    expect(turnStatusText(msg({ turn_status: 'cancel_requested' }), '布丁')).toBe('正在打断上一轮…');
    expect(turnStatusText(msg({ turn_status: 'canceled' }), '布丁')).toBe('已打断');
    expect(turnStatusText(msg({ turn_status: 'failed' }), '布丁')).toBe('这条没有执行成功');
    expect(turnStatusText(msg({ turn_status: 'completed' }), '布丁')).toBeNull();
  });
});

// #064：从首页气泡进聊天窗时，输入框引导玩家回应留言；正常进入保持原提示。
describe('chatInputPlaceholder', () => {
  it('带留言进入时引导回应', () => {
    expect(chatInputPlaceholder('布丁', true)).toBe('回应它刚才说的话，或跟 布丁 聊点别的…');
  });

  it('正常进入保持原提示', () => {
    expect(chatInputPlaceholder('布丁', false)).toBe('跟 布丁 说点什么…');
  });
});

// #073：初次打开聊天窗必须直接落在输入框——瞬时滚到底 + 聚焦；
// 后续消息更新平滑跟随且不抢焦点（不打断正在输入的玩家）。
describe('chatReadyActions', () => {
  it('历史加载中/失败时不做任何滚动或聚焦（时机未到，滚了也会被后到的内容顶回去）', () => {
    expect(chatReadyActions('loading', true)).toBeNull();
    expect(chatReadyActions('error', true)).toBeNull();
    expect(chatReadyActions('loading', false)).toBeNull();
    expect(chatReadyActions('error', false)).toBeNull();
  });

  it('初次打开：瞬时(auto)滚到底并聚焦输入框——smooth 在长历史下会停在半山腰', () => {
    expect(chatReadyActions('ready', true)).toEqual({ scrollBehavior: 'auto', focusInput: true });
  });

  it('后续 log 更新（#048 队列轮询/新回复）：平滑跟随最新一条，不抢焦点', () => {
    expect(chatReadyActions('ready', false)).toEqual({ scrollBehavior: 'smooth', focusInput: false });
  });
});

describe('CHAT_CREDITS_NOTICE', () => {
  it('只交代聊天消耗用户自己的 Qoder Credits，不虚构余额、数值或查询入口', () => {
    expect(CHAT_CREDITS_NOTICE).toBe('聊天回应会消耗你自己的 Qoder Credits。');
  });
});
