import { describe, expect, it } from 'vitest';
import { itemSourceText } from './BagPanel';

// #063：行囊物品显示获得来源；数据缺失逐级降级，最终 null 由详情弹层兜底文案处理。
describe('itemSourceText', () => {
  it('有旅行来源时显示日期与地点', () => {
    expect(itemSourceText({ source_travel_date: '2026-07-20', source_location_name: '旧风车市集', acquired_at: '2026-07-20T08:00:00Z' }))
      .toBe('7月20日 · 来自旧风车市集');
  });

  it('无旅行日期时退用 acquired_at', () => {
    expect(itemSourceText({ source_travel_date: null, source_location_name: '星湖岸', acquired_at: '2026-07-19T08:00:00Z' }))
      .toBe('7月19日 · 来自星湖岸');
  });

  it('只有日期时显示获得时间', () => {
    expect(itemSourceText({ source_travel_date: null, source_location_name: null, acquired_at: '2026-07-18T08:00:00Z' }))
      .toBe('7月18日 获得');
  });

  it('全缺失时返回 null', () => {
    expect(itemSourceText({ source_travel_date: null, source_location_name: null, acquired_at: undefined })).toBeNull();
  });
});
