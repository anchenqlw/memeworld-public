import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BREED_OPTIONS } from './catOptions';

function serverBreedIds(): string[] {
  const source = fs.readFileSync(new URL('../../../server/src/lib/appearance.ts', import.meta.url), 'utf8');
  const declaration = source.match(/export const BREEDS = \[([^\]]+)\]/)?.[1];
  if (!declaration) throw new Error('无法从服务端唯一白名单读取 BREEDS');
  return [...declaration.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

function pngDimensions(file: URL): { width: number; height: number } {
  const png = fs.readFileSync(file);
  expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

describe('breed selector catalog', () => {
  it('stays exactly aligned with the server whitelist', () => {
    const webIds = BREED_OPTIONS.map((option) => option.id);
    expect(webIds).toEqual(serverBreedIds());
    expect(new Set(webIds).size).toBe(webIds.length);
  });

  it.each(['abyssinian', 'maine_coon'])('%s has a production selector asset and copy', (id) => {
    const option = BREED_OPTIONS.find((candidate) => candidate.id === id);
    expect(option).toBeDefined();
    expect(option?.label).toMatch(/阿比西尼亚|缅因/);
    expect(option?.hint.length).toBeGreaterThanOrEqual(8);
    expect(option?.image).toBe(`/assets/game/appearance/breed-${id}.png`);

    const asset = new URL(`../../public${option?.image}`, import.meta.url);
    expect(fs.existsSync(asset)).toBe(true);
    expect(pngDimensions(asset)).toEqual({ width: 256, height: 256 });
  });
});
