import { beforeEach, describe, expect, it, vi } from 'vitest';

const generateGrowthAppearance = vi.fn(async () => null);
vi.mock('../config.js', () => ({
  config: { imageWorker: { runningTimeoutMs: 60_000, sessionTimeoutMs: 60_000, maxAttempts: 3, pollIntervalMs: 1_000, enabled: false } },
}));
vi.mock('./catImageService.js', () => ({
  cancelImageSessionForCat: vi.fn(),
  generateBirthAppearance: vi.fn(),
  generateGrowthAppearance,
  newRepaintAppearanceId: vi.fn(() => 'repaint-test'),
  setEncounterPhotoStatusForTravel: vi.fn(),
}));

const execute = vi.fn(async () => undefined);
const updateChain = { execute, executeTakeFirst: vi.fn(async () => ({ numUpdatedRows: 1 })), where: vi.fn() };
updateChain.where.mockReturnValue(updateChain);
vi.mock('../db/index.js', () => ({
  db: { updateTable: vi.fn(() => ({ set: vi.fn(() => updateChain) })) },
}));

describe('image job postcard dispatch (#114)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps a non-encounter travel on the ordinary growth-photo path', async () => {
    const { processJob } = await import('./imageJobService.js');
    await processJob({ id: 'job-1', cat_id: 'cat-1', kind: 'growth', travel_id: 'travel-plain', appearance_id: null, custom_description: null, attempts: 1 });
    expect(generateGrowthAppearance).toHaveBeenCalledOnce();
    expect(generateGrowthAppearance).toHaveBeenCalledWith('cat-1', 'travel-plain', { force: false });
  });

  it('does not turn a normal retry into a forced prompt repaint', async () => {
    const { processJob } = await import('./imageJobService.js');
    await processJob({ id: 'job-2', cat_id: 'cat-2', kind: 'growth', travel_id: 'travel-2', appearance_id: null, custom_description: null, attempts: 2 });
    expect(generateGrowthAppearance).toHaveBeenCalledWith('cat-2', 'travel-2', { force: false });
  });
});
