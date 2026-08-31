import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// backlog #072 复核修复：repair 端点错误响应必须走白名单映射——
// 未枚举异常绝不把 error.message（可能含凭据/栈/QCA 响应体）透传给用户。
// 独立文件 + partial mock：不影响 app.test.ts 里的真实 repair 流程测试。

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meme-repair-test-'));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'mock';
process.env.QCA_MOCK = 'true';
// 与 app.test.ts 同款：外部注入 DATABASE_URL 时走 postgres，否则 sqlite（不硬设 dialect）
process.env.DB_DIALECT = process.env.DATABASE_URL ? 'postgres' : 'sqlite';
// DATABASE_PATH 仅 sqlite 需要；postgres 用注入的 DATABASE_URL
if (process.env.DB_DIALECT === 'sqlite') {
  process.env.DATABASE_PATH = path.join(tempDir, 'meme.db');
}
process.env.CAT_IMAGES_DIR = path.join(tempDir, 'cat-images');
process.env.REPO_ROOT = repoRoot;
process.env.PAT_ENCRYPTION_KEY = '1'.repeat(64);
process.env.SESSION_SECRET = 'test-session-secret-at-least-32-characters';
process.env.INTERNAL_API_KEY = 'dev-internal-key';
process.env.REDIS_DRIVER ||= 'memory';
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
process.env.REDIS_NAMESPACE ||= `meme:test:${randomUUID()}`;
process.env.STORAGE_DRIVER ||= 'local';
process.env.IMAGE_WORKER_ENABLED = 'false';
process.env.TRAVEL_SCHEDULER_ENABLED = 'false';

// synthetic 标记（非真实凭据）：PAT 样式 / 内部栈样式 / QCA 响应体字段样式
const syntheticPatMarker = 'pt-synthetic-leak-check-DO-NOT-USE';
const syntheticStackMarker = 'at RepairBridge.run (/srv/private/repair-bridge.ts:417:19)';
const syntheticQcaBodyMarker = 'qca-synthetic-body-field-072';

// 第二轮复验回归：继承属性 code（constructor/__proto__）不得命中白名单——用 let 让各用例注入不同 code
let thrownCode: unknown = 'UNEXPECTED_REPAIR_FAILURE';

vi.mock('../src/services/catService.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/services/catService.js')>();
  return {
    ...actual,
    repairTravelAgent: vi.fn(async () => {
      throw Object.assign(
        new Error(`repair blew up: ${syntheticPatMarker}\n  ${syntheticStackMarker}\n  body={"detail":"${syntheticQcaBodyMarker}"}`),
        { code: thrownCode },
      );
    }),
  };
});

// 本测试不涉及聊天；禁用聊天 worker 轮询，避免 in-flight scanChatQueue
// 与 afterAll 的 closeDatabase 竞态产生 unhandled rejection（postgres 跑法下暴露）
vi.mock('../src/services/chatTurnService.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/services/chatTurnService.js')>();
  return {
    ...actual,
    startChatWorker: vi.fn(async () => {}),
    stopChatWorker: vi.fn(async () => {}),
  };
});

let app: FastifyInstance;

beforeAll(async () => {
  const module = await import('../src/app.js');
  app = await module.buildApp();
  await app.ready();
});

afterAll(async () => {
  // setup 失败时 app 可能未赋值——兜底避免二次报错遮蔽根因
  if (app) await app.close();
  const { closeDatabase } = await import('../src/db/index.js');
  await closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('adventure repair error whitelist (backlog #072)', () => {
  it('builds audit records from the explicit non-sensitive whitelist only', async () => {
    const { buildAdventureRepairAudit } = await import('../src/routes/api.js');
    const audit = buildAdventureRepairAudit({
      userId: 'user-safe',
      requestId: 'request-safe',
      result: 'failure',
      code: 'REPAIR_HEALTH_STILL_BROKEN',
      catId: 'cat-safe',
      repair: { mode: 'forward', health_before: 'broken', health_after: 'unknown' },
      // 运行时多余字段不得通过构造器进入日志。
      raw: syntheticQcaBodyMarker,
      token: syntheticPatMarker,
    } as Parameters<typeof buildAdventureRepairAudit>[0] & { raw: string; token: string });

    expect(audit).toEqual({
      audit: 'adventure_repair',
      user_id: 'user-safe',
      cat_id: 'cat-safe',
      result: 'failure',
      code: 'REPAIR_HEALTH_STILL_BROKEN',
      request_id: 'request-safe',
      mode: 'forward',
      health_before: 'broken',
      health_after: 'unknown',
    });
    expect(JSON.stringify(audit)).not.toContain(syntheticQcaBodyMarker);
    expect(JSON.stringify(audit)).not.toContain(syntheticPatMarker);
  });

  it('maps unknown exceptions to fixed REPAIR_FAILED copy and never echoes message contents', async () => {
    const login = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/login?json=1&fresh=1&nonce=${randomUUID()}`,
      headers: { accept: 'application/json' },
    });
    const cookie = login.cookies[0];
    const cookies = { [cookie.name]: cookie.value };

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/cats/me/adventure/repair',
      cookies,
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { code: 'REPAIR_FAILED', message: '照看修复没有成功，请稍后再试' },
    });

    // 脱敏硬断言：响应全串不含 synthetic PAT / 栈行 / QCA body 标记，也不含未知 code
    const raw = response.payload;
    expect(raw).not.toContain(syntheticPatMarker);
    expect(raw).not.toContain(syntheticStackMarker);
    expect(raw).not.toContain(syntheticQcaBodyMarker);
    expect(raw).not.toContain('repair blew up');
    expect(raw).not.toContain('UNEXPECTED_REPAIR_FAILURE');
  });

  // 第二轮复验回归：REPAIR_ERROR_COPY 为普通对象，直接索引会命中 Object.prototype
  // 继承属性（constructor/toString/__proto__），未知 code 被误判白名单命中并回显。
  // 修复后必须 Object.hasOwn 判定，二者均归一为固定 REPAIR_FAILED。
  it.each(['constructor', '__proto__'])(
    'inherited-property code %s is not treated as whitelist hit',
    async (inheritedCode) => {
      thrownCode = inheritedCode;
      const login = await app.inject({
        method: 'GET',
        url: `/api/v1/auth/login?json=1&fresh=1&nonce=${randomUUID()}`,
        headers: { accept: 'application/json' },
      });
      const cookie = login.cookies[0];
      const cookies = { [cookie.name]: cookie.value };

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/cats/me/adventure/repair',
        cookies,
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: { code: 'REPAIR_FAILED', message: '照看修复没有成功，请稍后再试' },
      });
      expect(response.payload).not.toContain(inheritedCode);
      expect(response.payload).not.toContain(syntheticPatMarker);
    },
  );
});
