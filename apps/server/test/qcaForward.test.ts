import { describe, expect, it, vi } from 'vitest';
import { toAdventureStartUserMessage } from '../src/lib/qcaErrors.js';
import {
  buildDeploymentTaskInstructionPatch,
  QcaApiError,
  updateDeploymentTaskInstruction,
} from '../src/services/qca.js';
import {
  forwardFetchWithTransientNotFoundRetry,
  waitForForwardIdentityReady,
} from '../src/services/qcaForward.js';
import { buildForwardScheduleIdempotencyKey } from '../src/services/qcaForwardService.js';

const credential = { pat: 'test-pat', site: 'global' as const };

describe('QCA Forward transient 404 handling', () => {
  it('waits until a newly-created identity is readable', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new QcaApiError('not found', 'QCA_API_ERROR', 404))
      .mockResolvedValueOnce({ id: 'idn_ready' });
    const sleep = vi.fn(async () => undefined);

    await waitForForwardIdentityReady(credential, 'idn_ready', {
      delaysMs: [1],
      sleep,
      fetcher,
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map((call) => call[2])).toEqual([
      '/identities/idn_ready',
      '/identities/idn_ready',
    ]);
    expect(sleep).toHaveBeenCalledWith(1);
  });

  it('retries identity-template config when Forward returns a transient not found', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new QcaApiError('not found', 'QCA_API_ERROR', 404))
      .mockResolvedValueOnce({ ok: true });
    const sleep = vi.fn(async () => undefined);

    await expect(forwardFetchWithTransientNotFoundRetry(
      credential,
      'POST',
      '/identities/idn_1/templates/tmpl_1/config',
      { name: 'travel-profile' },
      undefined,
      { delaysMs: [1], sleep, fetcher, source: 'travel' },
    )).resolves.toEqual({ ok: true });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1);
  });

  it('keeps permanent not found failures visible after the finite retry budget', async () => {
    const notFound = new QcaApiError('not found', 'QCA_API_ERROR', 404);
    const fetcher = vi.fn().mockRejectedValue(notFound);

    await expect(waitForForwardIdentityReady(credential, 'idn_missing', {
      delaysMs: [1, 2],
      sleep: vi.fn(async () => undefined),
      fetcher,
    })).rejects.toBe(notFound);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

describe('QCA Forward user-facing errors', () => {
  it('does not expose internal Forward paths or resource ids on adventure start', () => {
    const message = toAdventureStartUserMessage(new QcaApiError(
      'QCA Forward POST /identities/idn_1/templates/tmpl_1/config 请求失败：not found',
      'QCA_API_ERROR',
      404,
    ));

    expect(message).toBe('云端探险准备稍有延迟，请稍后重试。');
    expect(message).not.toContain('/identities/');
    expect(message).not.toContain('idn_1');
  });
});

describe('QCA Forward schedule idempotency', () => {
  it('is stable for retries of the same cat', () => {
    expect(buildForwardScheduleIdempotencyKey('cat-123')).toBe('meme-forward-schedule-cat-123');
    expect(buildForwardScheduleIdempotencyKey('cat-123')).toBe(
      buildForwardScheduleIdempotencyKey('cat-123'),
    );
  });

  it('does not collide when two cats have the same display name', () => {
    expect(buildForwardScheduleIdempotencyKey('cat-123')).not.toBe(
      buildForwardScheduleIdempotencyKey('cat-456'),
    );
  });
});

describe('#134 Build task reconciliation adapter', () => {
  it('patches only initial_events and cannot overwrite environment_variables or CAT_TOKEN', async () => {
    const fetcher = vi.fn(async () => ({ ok: true }));
    const patch = buildDeploymentTaskInstructionPatch('repository rendered instruction');
    expect(patch).toEqual({
      initial_events: [{ type: 'user.message', content: [{ type: 'text', text: 'repository rendered instruction' }] }],
    });
    expect(patch).not.toHaveProperty('environment_variables');
    expect(JSON.stringify(patch)).not.toContain('CAT_TOKEN');

    await updateDeploymentTaskInstruction(credential, 'dep-134', 'repository rendered instruction', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      credential,
      'POST',
      '/deployments/dep-134',
      patch,
    );
  });
});
