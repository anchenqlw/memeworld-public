import { config } from '../config.js';
import {
  createQcaCreditsError,
  detectQcaCreditsUnavailable,
} from '../lib/qcaErrors.js';
import { QcaApiError, type QcaCredential } from './qca.js';
import { db } from '../db/index.js';
import { alwaysAllowToolConfig } from '../lib/qcaPermissions.js';

const FORWARD_BASES: Record<QcaCredential['site'], string> = {
  global: 'https://api.qoder.com/api/v1/forward',
  cn: 'https://api.qoder.com.cn/api/v1/forward',
};

const TRANSIENT_NOT_FOUND_DELAYS_MS = [250, 500, 1000, 2000] as const;

type ForwardFetchOptions = { timeoutMs?: number; fetchImpl?: typeof fetch; source?: 'travel' | 'chat' };
type ForwardFetcher = (
  credential: QcaCredential,
  method: string,
  path: string,
  body?: unknown,
  idempotencyKey?: string,
  options?: ForwardFetchOptions,
) => Promise<Record<string, unknown>>;

type TransientNotFoundOptions = ForwardFetchOptions & {
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  fetcher?: ForwardFetcher;
};

function extractForwardErrorDetail(data: unknown) {
  if (!data || typeof data !== 'object') return undefined;
  const record = data as Record<string, unknown>;
  const nested = record.error;
  if (nested && typeof nested === 'object') {
    const message = (nested as Record<string, unknown>).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  if (typeof record.message === 'string' && record.message.trim()) return record.message.trim();
  return undefined;
}

function formatForwardApiFailure(method: string, path: string, data: unknown, rawText: string) {
  const detail = extractForwardErrorDetail(data) || (rawText.trim().slice(0, 200) || undefined);
  return detail
    ? `QCA Forward ${method} ${path} 请求失败：${detail}`
    : `QCA Forward ${method} ${path} 请求失败`;
}

export async function forwardFetch(
  credential: QcaCredential,
  method: string,
  path: string,
  body?: unknown,
  idempotencyKey?: string,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch; source?: 'travel' | 'chat' } = {},
) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credential.pat}`,
    'Content-Type': 'application/json',
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res: Response;
    try {
      res = await (options.fetchImpl || fetch)(`${FORWARD_BASES[credential.site]}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
    } catch {
      lastError = new QcaApiError('QCA 服务暂时不可用，请稍后重试', 'QCA_TEMPORARY_ERROR');
      if (attempt < 2) continue;
      throw lastError;
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const source = options.source ?? 'travel';
      if (detectQcaCreditsUnavailable(data || text, { status: res.status, source })) {
        throw createQcaCreditsError({ status: res.status, source }, text);
      }
      if (res.status === 401) {
        if (credential.userId) {
          await db.updateTable('pat_credentials').set({
            status: 'invalid',
            updated_at: new Date().toISOString(),
          }).where('user_id', '=', credential.userId).execute();
        }
        throw new QcaApiError('PAT 已失效，请重新绑定', 'QCA_PAT_INVALID', 401);
      }
      if (res.status === 403) throw new QcaApiError('PAT 权限不足', 'QCA_PERMISSION_DENIED', 403);
      if (res.status === 429 || res.status >= 500) {
        lastError = new QcaApiError('QCA 服务暂时不可用，请稍后重试', 'QCA_TEMPORARY_ERROR', res.status);
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      lastError = new QcaApiError(formatForwardApiFailure(method, path, data, text), 'QCA_API_ERROR', res.status);
      throw lastError;
    }
    return data as Record<string, unknown>;
  }
  throw lastError || new Error('QCA Forward request failed after retries');
}

function isForwardNotFound(error: unknown) {
  return error instanceof QcaApiError && error.status === 404;
}

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function waitForForwardIdentityReady(
  credential: QcaCredential,
  identityId: string,
  options: TransientNotFoundOptions = {},
) {
  const delays = options.delaysMs ?? TRANSIENT_NOT_FOUND_DELAYS_MS;
  const fetcher = options.fetcher ?? forwardFetch;
  const sleep = options.sleep ?? defaultSleep;
  let lastNotFound: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      await fetcher(credential, 'GET', `/identities/${identityId}`, undefined, undefined, {
        timeoutMs: options.timeoutMs,
        fetchImpl: options.fetchImpl,
        source: options.source,
      });
      return;
    } catch (error) {
      if (!isForwardNotFound(error) || attempt === delays.length) throw error;
      lastNotFound = error;
      await sleep(delays[attempt]);
    }
  }
  throw lastNotFound;
}

export async function forwardFetchWithTransientNotFoundRetry(
  credential: QcaCredential,
  method: string,
  path: string,
  body?: unknown,
  idempotencyKey?: string,
  options: TransientNotFoundOptions = {},
) {
  const delays = options.delaysMs ?? TRANSIENT_NOT_FOUND_DELAYS_MS;
  const fetcher = options.fetcher ?? forwardFetch;
  const sleep = options.sleep ?? defaultSleep;
  let lastNotFound: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fetcher(credential, method, path, body, idempotencyKey, {
        timeoutMs: options.timeoutMs,
        fetchImpl: options.fetchImpl,
        source: options.source,
      });
    } catch (error) {
      if (!isForwardNotFound(error) || attempt === delays.length) throw error;
      lastNotFound = error;
      await sleep(delays[attempt]);
    }
  }
  throw lastNotFound;
}

export function forwardTravelToolConfigs() {
  return (['Read', 'Write', 'Edit', 'Bash'] as const).map(alwaysAllowToolConfig);
}

export function forwardChatToolConfigs() {
  return (['Read', 'Grep', 'Write'] as const).map(alwaysAllowToolConfig);
}
