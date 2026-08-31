import { describe, expect, it } from 'vitest';
import type { CatProfile, QcaModelOption } from '../../api/client';
import { modelChangeNoticeFor, modelChangeViewFor } from './SettingsPanel';

// backlog #084：建猫时选过模型之后没有任何更换入口。
// 设置面板的判定逻辑在这里覆盖「有猫 → 展示当前模型 → 更换 → 生效」全程。

const models: QcaModelOption[] = [
  { id: 'ultimate', display_name: 'Ultimate', price_factor: 1.6, efforts: ['low', 'high'], default_effort: 'high' },
  { id: 'lite', display_name: 'Lite', price_factor: 0.4, efforts: ['low'], default_effort: 'low' },
];

function catWith(model: string | null, extra: Partial<CatProfile> = {}): Pick<CatProfile, 'qca' | 'appearance_status'> {
  return { qca: { model }, ...extra };
}

describe('modelChangeViewFor', () => {
  it('展示当前模型的可读名称并允许更换', () => {
    const view = modelChangeViewFor(catWith('ultimate'), models);
    expect(view.currentId).toBe('ultimate');
    expect(view.currentLabel).toBe('Ultimate');
    expect(view.canChange).toBe(true);
    expect(view.unavailable).toBe(false);
    expect(view.hint).toContain('重新准备一位云端画师');
  });

  it('更换生效后展示的是新模型（服务端回包驱动）', () => {
    const before = modelChangeViewFor(catWith('ultimate'), models);
    const after = modelChangeViewFor(catWith('lite'), models);
    expect(before.currentLabel).toBe('Ultimate');
    expect(after.currentLabel).toBe('Lite');
    expect(after.unavailable).toBe(false);
  });

  it('模型列表还没加载好时不给更换入口（避免拿空列表提交）', () => {
    const view = modelChangeViewFor(catWith('ultimate'), []);
    expect(view.canChange).toBe(false);
    // 列表为空不能推断「不可用」——只是还没读到
    expect(view.unavailable).toBe(false);
    expect(view.currentLabel).toBe('ultimate');
  });

  it('当前模型不在可用列表里时明确提示更换', () => {
    const view = modelChangeViewFor(catWith('ultimate'), [models[1]]);
    expect(view.unavailable).toBe(true);
    expect(view.canChange).toBe(true);
    expect(view.hint).toContain('已经用不了了');
  });

  it('有图片正在生成时禁用更换——旧画师会被归档，服务端同样拒绝', () => {
    for (const status of ['pending', 'generating'] as const) {
      const view = modelChangeViewFor(catWith('ultimate', { appearance_status: status }), models);
      expect(view.blockedByImageJob).toBe(true);
      expect(view.canChange).toBe(false);
      expect(view.hint).toContain('图片任务进行中');
    }
  });

  it('图片已就绪时不算被图片任务挡住', () => {
    const view = modelChangeViewFor(catWith('lite', { appearance_status: 'ready' }), models);
    expect(view.blockedByImageJob).toBe(false);
    expect(view.canChange).toBe(true);
  });

  it('还没有选过模型时不谎报模型名', () => {
    const view = modelChangeViewFor(catWith(null), models);
    expect(view.currentId).toBeNull();
    expect(view.currentLabel).toBe('未选择');
    expect(view.unavailable).toBe(false);
  });
});

describe('modelChangeNoticeFor', () => {
  it('真的换了画师时说明重建', () => {
    expect(modelChangeNoticeFor('Lite', true)).toBe('已经换成 Lite，并为它重新准备了一位云端画师。');
  });

  it('提交的就是当前模型时不假称换过', () => {
    expect(modelChangeNoticeFor('Ultimate', false)).toBe('Ultimate 就是当前的模型，没有变化。');
    expect(modelChangeNoticeFor('Ultimate', undefined)).toBe('Ultimate 就是当前的模型，没有变化。');
  });
});
