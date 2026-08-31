import { describe, expect, it } from 'vitest';
import {
  appearanceToLockedTraits,
  appearanceToPrompt,
  appearanceToVisualDNA,
  BREEDS,
  isValidAppearance,
} from '../src/lib/appearance.js';

const BASE = { baseColor: 'orange', pattern: 'solid', eyes: 'green' } as const;

describe('breed catalog', () => {
  it.each([
    ['abyssinian', ['阿比西尼亚', '瘦长精悍', '楔形脸', '大耳', '滴答纹']],
    ['maine_coon', ['缅因', '大体型长毛', '宽阔口鼻', '耳尖簇毛', '浓密围脖']],
  ] as const)('accepts %s and carries its anatomy through every image prompt contract', (breed, anchors) => {
    const appearance = { ...BASE, breed };

    expect(BREEDS).toContain(breed);
    expect(isValidAppearance(appearance)).toBe(true);

    for (const prompt of [
      appearanceToPrompt(appearance),
      appearanceToLockedTraits(appearance),
      appearanceToVisualDNA(appearance),
    ]) {
      for (const anchor of anchors) expect(prompt).toContain(anchor);
    }
  });

  it('still rejects near-miss breed ids instead of silently accepting asset names or labels', () => {
    expect(isValidAppearance({ ...BASE, breed: 'mainecoon' })).toBe(false);
    expect(isValidAppearance({ ...BASE, breed: '阿比西尼亚' })).toBe(false);
  });
});
