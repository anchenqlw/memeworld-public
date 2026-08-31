import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { readingSourceLabel, travelThemeLabel } from './Postcard';

function readingBadgeWiringViolations(source: string): string[] {
  const violations: string[] = [];
  if (!source.includes('data-testid="reading-source"')) violations.push('reading badge selector missing');
  if (!source.includes('readingSourceLabel(travel.reading_source) &&')) violations.push('reading badge condition missing');
  if (!source.includes('📖 {readingSourceLabel(travel.reading_source)}')) violations.push('reading badge label missing');
  return violations;
}

// #062：手账每条记录都有主题徽标——有事件用事件名，无事件从心情派生，都没有则中性兜底。
describe('travelThemeLabel', () => {
  it('有事件的旅行用事件名', () => {
    expect(travelThemeLabel({ event_name: '旅人故事夜', mood: '好奇' })).toBe('旅人故事夜');
  });

  it('无事件有心情时从心情派生', () => {
    expect(travelThemeLabel({ mood: '平静' })).toBe('平静小记');
  });

  it('无事件无心情时中性兜底', () => {
    expect(travelThemeLabel({ mood: '' })).toBe('日常漫游');
  });
});

describe('#092 private reading source label', () => {
  it('renders a traceable owner-private source label', () => {
    expect(readingSourceLabel({ source_type: 'growth_card', source_id: 'card-1', title: '在读的书' }))
      .toBe('猫咪读了 · 在读的书');
    expect(readingSourceLabel(null)).toBeNull();
  });

  it('locks the real PostcardCard JSX wiring with mutation proofs', () => {
    const source = fs.readFileSync(new URL('./Postcard.tsx', import.meta.url), 'utf8');
    expect(readingBadgeWiringViolations(source)).toEqual([]);
    expect(readingBadgeWiringViolations(source.replace('data-testid="reading-source"', '')))
      .toContain('reading badge selector missing');
    expect(readingBadgeWiringViolations(source.replace('readingSourceLabel(travel.reading_source) &&', 'true &&')))
      .toContain('reading badge condition missing');
    expect(readingBadgeWiringViolations(source.replace('📖 {readingSourceLabel(travel.reading_source)}', '📖')))
      .toContain('reading badge label missing');
  });
});
