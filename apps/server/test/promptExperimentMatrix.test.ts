import { describe, expect, it } from 'vitest';
import { buildPromptExperimentMatrix } from '../src/lib/promptExperimentMatrix.js';

describe('QCA prompt controlled experiment matrix', () => {
  it('builds exactly 25 birth and 25 travel cases with five replicates per cohort', () => {
    const matrix = buildPromptExperimentMatrix();
    expect(matrix).toHaveLength(50);
    expect(matrix.filter((item) => item.kind === 'birth')).toHaveLength(25);
    expect(matrix.filter((item) => item.kind === 'travel')).toHaveLength(25);
    const cohortCounts = new Map<string, number>();
    for (const item of matrix) {
      const key = `${item.kind}:${item.cohort}`;
      cohortCounts.set(key, (cohortCounts.get(key) || 0) + 1);
      expect(item.promptSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(item.prompt.length).toBeGreaterThan(100);
    }
    expect([...cohortCounts.values()]).toEqual(Array(10).fill(5));
  });

  it('keeps final birth and travel templates independent and free of cover/name metadata', () => {
    const matrix = buildPromptExperimentMatrix();
    const finals = matrix.filter((item) => item.cohort === 'strong-no-text');
    expect(finals).toHaveLength(10);
    for (const item of finals) {
      expect(item.prompt).not.toMatch(/宫崎骏|吉卜力|童书|绘本|封面|名叫|小云|【|】/);
      expect(item.prompt).toContain('零文字');
    }
    const birth = finals.find((item) => item.kind === 'birth')!;
    const travel = finals.find((item) => item.kind === 'travel')!;
    expect(birth.prompt).toContain('全身完整入镜');
    expect(birth.prompt).not.toContain('星湖绿境');
    expect(travel.prompt).toContain('星湖绿境的清晨');
    expect(travel.prompt).toContain('旅行现场图');
    expect(travel.prompt).not.toContain('标准角色定妆构图');
  });

  it('freezes the historical production baseline after the production template changes', () => {
    const matrix = buildPromptExperimentMatrix();
    for (const kind of ['birth', 'travel'] as const) {
      const baseline = matrix.find((item) => item.kind === kind && item.cohort === 'current-baseline')!;
      const withoutCover = matrix.find((item) => item.kind === kind && item.cohort === 'remove-cover-signal')
        || matrix.find((item) => item.kind === kind && item.cohort === 'independent-scene')!;
      expect(baseline.prompt).toContain('欧洲高端儿童绘本封面质感');
      expect(withoutCover.promptSha256).not.toBe(baseline.promptSha256);
    }
  });
});
