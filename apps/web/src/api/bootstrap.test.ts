import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './client';
import { loadBootstrap } from './bootstrap';

function client(overrides: Record<string, unknown> = {}) {
  return {
    me: vi.fn().mockResolvedValue({ display_name: '主人' }),
    patStatus: vi.fn().mockResolvedValue({ status: 'valid' }),
    getCat: vi.fn().mockResolvedValue({ id: 'cat-1', name: '小猫' }),
    travels: vi.fn().mockResolvedValue({ travels: [] }),
    badges: vi.fn().mockResolvedValue({ badges: [] }),
    worldMap: vi.fn().mockResolvedValue({ locations: [], manifest: null }),
    worldDigest: vi.fn().mockResolvedValue({}),
    proposals: vi.fn().mockResolvedValue({ proposals: [], contribution: {} }),
    worldChronicle: vi.fn().mockResolvedValue({ entries: [] }),
    ...overrides,
  };
}

describe('loadBootstrap', () => {
  it('keeps the cat when one auxiliary request fails', async () => {
    const result = await loadBootstrap(client({ badges: vi.fn().mockRejectedValue(new Error('temporary')) }) as never);
    expect(result.cat).toMatchObject({ id: 'cat-1' });
    expect(result.extras?.badges.status).toBe('rejected');
    expect(result.extras?.travels.status).toBe('fulfilled');
  });

  it('keeps the signed-in session when PAT status is temporarily unavailable', async () => {
    const result = await loadBootstrap(client({ patStatus: vi.fn().mockRejectedValue(new Error('temporary')) }) as never);
    expect(result.me.display_name).toBe('主人');
    expect(result.cat).toMatchObject({ id: 'cat-1' });
    expect(result.pat.status).toBe('rejected');
  });

  it('treats only a cat 404 as onboarding', async () => {
    const result = await loadBootstrap(client({ getCat: vi.fn().mockRejectedValue(new ApiError('没有猫', 404, 'NO_CAT')) }) as never);
    expect(result.cat).toBeNull();
    expect(result.extras).toBeNull();
  });

  it('propagates authentication and non-404 cat failures', async () => {
    await expect(loadBootstrap(client({ me: vi.fn().mockRejectedValue(new ApiError('未登录', 401)) }) as never)).rejects.toMatchObject({ status: 401 });
    await expect(loadBootstrap(client({ getCat: vi.fn().mockRejectedValue(new ApiError('服务异常', 503)) }) as never)).rejects.toMatchObject({ status: 503 });
  });
});
