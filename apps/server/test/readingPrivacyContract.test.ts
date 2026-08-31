import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getRepoRoot } from '../src/lib/templates.js';

const privateSourceFields = /reading_source(?:_type|_id|_title)?/;

function productionContractViolations(input: {
  selector: string;
  encounter: string;
}): string[] {
  const violations: string[] = [];
  if (!input.selector.includes('nextTravelNumber % READING_INTERVAL !== 0')) {
    violations.push('reading interval guard missing');
  }
  if (!input.selector.includes(".where('deleted_at', 'is', null)")) {
    violations.push('withdrawn growth-card filter missing');
  }
  if (!input.selector.includes('activeBookQuery.forUpdate()')) {
    violations.push('growth-card withdrawal lock missing');
  }
  if (privateSourceFields.test(input.encounter)) violations.push('private source wired into encounter');
  return violations;
}

describe('#092 reading-source privacy production contract', () => {
  it('does not wire private reading metadata into encounter or public chronicle producers', () => {
    for (const relative of [
      'apps/server/src/services/encounterService.ts',
      'apps/server/src/services/chronicleService.ts',
      'apps/server/src/services/worldSync.ts',
    ]) {
      const source = fs.readFileSync(path.join(getRepoRoot(), relative), 'utf8');
      expect(source, relative).not.toMatch(privateSourceFields);
    }
  });

  it('keeps the metadata consumer on the owner-private travel path', () => {
    const travelService = fs.readFileSync(
      path.join(getRepoRoot(), 'apps/server/src/services/travelService.ts'),
      'utf8',
    );
    expect(travelService).toContain(".where('t.cat_id', '=', catId)");
    expect(travelService).toContain("'p.reading_source_type'");
    expect(travelService).toContain('reading_source: reading_source_type');
  });

  it('mechanically locks interval, withdrawal and public-surface guards with mutation proofs', () => {
    const selector = fs.readFileSync(
      path.join(getRepoRoot(), 'apps/server/src/services/readingSourceService.ts'),
      'utf8',
    );
    const encounter = fs.readFileSync(
      path.join(getRepoRoot(), 'apps/server/src/services/encounterService.ts'),
      'utf8',
    );
    expect(productionContractViolations({ selector, encounter })).toEqual([]);
    expect(productionContractViolations({
      selector: selector.replace('nextTravelNumber % READING_INTERVAL !== 0', 'false'),
      encounter,
    })).toContain('reading interval guard missing');
    expect(productionContractViolations({
      selector: selector.replace(".where('deleted_at', 'is', null)", ''),
      encounter,
    })).toContain('withdrawn growth-card filter missing');
    expect(productionContractViolations({
      selector: selector.replace('activeBookQuery.forUpdate()', 'activeBookQuery'),
      encounter,
    })).toContain('growth-card withdrawal lock missing');
    expect(productionContractViolations({ selector, encounter: `${encounter}\nconst reading_source = true;` }))
      .toContain('private source wired into encounter');
  });
});
