import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// backlog #077「生图肢体异常（五只脚）：已确认形象的修复出口」
// 四个分支：确认前不给入口 / 确认后可申诉 / 活跃 job 冲突 / 次数用尽；
// 外加 #024 语义硬断言：重画只产生候选，用户确认前主形象绝不变（不静默换猫）。
// 独立文件而非塞进 app.test.ts：重画限次按猫累计，需要干净的 per-user 计数与限流窗口。

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meme-repaint-test-'));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'mock';
process.env.QCA_MOCK = 'true';
// 与 app.test.ts 同款：外部注入 DATABASE_URL 时走 postgres，否则 sqlite
process.env.DB_DIALECT = process.env.DATABASE_URL ? 'postgres' : 'sqlite';
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

let app: FastifyInstance;

beforeAll(async () => {
  const module = await import('../src/app.js');
  app = await module.buildApp();
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
  const { closeDatabase } = await import('../src/db/index.js');
  await closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function loginCookies() {
  const login = await app.inject({
    method: 'GET',
    url: `/api/v1/auth/login?json=1&fresh=1&nonce=${randomUUID()}`,
    headers: { accept: 'application/json' },
  });
  const cookie = login.cookies[0];
  return { [cookie.name]: cookie.value };
}

/**
 * 排空队列直到指定猫的某个 appearance 落库。
 * 只领取当前猫的任务；共享 PostgreSQL 中其它套件的 pending job 不得影响本猫断言。
 */
async function drainUntilAppearance(catId: string, appearanceId: string) {
  const { db } = await import('../src/db/index.js');
  const { runImageJobOnceForCat } = await import('../src/services/imageJobService.js');
  for (let index = 0; index < 12; index += 1) {
    const row = await db.selectFrom('cat_appearances').select('id')
      .where('id', '=', appearanceId).where('cat_id', '=', catId).executeTakeFirst();
    if (row) return;
    await runImageJobOnceForCat(catId);
  }
  throw new Error(`appearance ${appearanceId} 未在限定轮次内生成`);
}

/** 建一只猫并停在「形象未确认」阶段（已有一张候选图） */
async function createCatWithCandidate(cookies: Record<string, string>) {
  const pat = await app.inject({
    method: 'PUT', url: '/api/v1/pat', cookies, payload: { pat: `pt-repaint-${randomUUID()}` },
  });
  expect(pat.statusCode).toBe(200);
  const created = await app.inject({
    method: 'POST', url: '/api/v1/cats', cookies,
    payload: { name: '五只脚猫', personality: '好奇又温柔', model: 'ultimate' },
  });
  expect(created.statusCode).toBe(200);
  const { db } = await import('../src/db/index.js');
  const birthJob = await db.selectFrom('image_jobs').select('appearance_id')
    .where('cat_id', '=', created.json().id).where('kind', '=', 'birth').executeTakeFirstOrThrow();
  await drainUntilAppearance(created.json().id, birthJob.appearance_id!);
  const profile = await app.inject({ method: 'GET', url: '/api/v1/cats/me', cookies });
  expect(profile.json().appearance_candidates).toHaveLength(1);
  return profile.json();
}

/** 建猫并确认形象（lifecycle_stage → world），返回被确认的形象 id */
async function createConfirmedCat(cookies: Record<string, string>) {
  const profile = await createCatWithCandidate(cookies);
  const birthId = profile.appearance_candidates[0].id;
  const confirmed = await app.inject({
    method: 'POST', url: '/api/v1/cats/me/appearance/confirm', cookies,
    payload: { appearance_id: birthId },
  });
  expect(confirmed.statusCode).toBe(200);
  expect(confirmed.json().lifecycle_stage).toBe('world');
  return { catId: confirmed.json().id, birthAppearanceId: birthId };
}

describe('appearance repaint appeal (backlog #077)', () => {
  it('形象确认前不暴露重画申诉入口，端点也拒绝', async () => {
    const cookies = await loginCookies();
    const profile = await createCatWithCandidate(cookies);

    // 入口可见性：eligible=false（建猫向导里本来就能重画，不需要这条申诉路径）
    expect(profile.lifecycle_stage).toBe('appearance');
    expect(profile.appearance_repaint).toMatchObject({ eligible: false, pending_candidate: null });

    const response = await app.inject({ method: 'POST', url: '/api/v1/cats/me/appearance/repaint', cookies, payload: {} });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('APPEARANCE_NOT_CONFIRMED');
  });

  it('形象确认后可申诉重画，新图须用户明确确认才替换主形象（#024 不静默换猫）', async () => {
    const cookies = await loginCookies();
    const { catId, birthAppearanceId } = await createConfirmedCat(cookies);
    const { db } = await import('../src/db/index.js');

    const before = await app.inject({ method: 'GET', url: '/api/v1/cats/me', cookies });
    expect(before.json().appearance_repaint).toMatchObject({
      eligible: true, used: 0, limit: 2, remaining: 2, image_job_active: false, pending_candidate: null,
    });
    // 消耗告知：入口下发的文案必须提到 Credits
    expect(before.json().appearance_repaint.credits_notice).toContain('Credits');

    const requested = await app.inject({ method: 'POST', url: '/api/v1/cats/me/appearance/repaint', cookies, payload: {} });
    expect(requested.statusCode).toBe(200);
    expect(requested.json()).toMatchObject({ ok: true, status: 'pending' });
    const repaintId: string = requested.json().appearance_id;
    expect(repaintId.startsWith('repaint-')).toBe(true);
    expect(requested.json().repaint).toMatchObject({ used: 1, remaining: 1, image_job_active: true });

    // 复用既有 image_jobs 队列：同一张表、同一 worker、去重键带 repaint 候选 id
    const job = await db.selectFrom('image_jobs').select(['kind', 'status', 'dedupe_key', 'appearance_id'])
      .where('cat_id', '=', catId).where('appearance_id', '=', repaintId).executeTakeFirstOrThrow();
    expect(job).toMatchObject({ kind: 'birth', status: 'pending', dedupe_key: `birth:${catId}:${repaintId}` });

    await drainUntilAppearance(catId, repaintId);

    // 画好之后：主形象仍是老图，新图只是「等你决定」的候选
    const pending = await app.inject({ method: 'GET', url: '/api/v1/cats/me', cookies });
    expect(pending.json().selected_birth_appearance_id).toBe(birthAppearanceId);
    expect(pending.json().appearance_repaint.pending_candidate).toMatchObject({ id: repaintId });
    expect(pending.json().appearance_repaint).toMatchObject({ used: 1, remaining: 1 });

    // 有待决定的候选时不能再申请下一张
    const again = await app.inject({ method: 'POST', url: '/api/v1/cats/me/appearance/repaint', cookies, payload: {} });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('REPAINT_DECISION_PENDING');

    // 用户明确确认 → 主形象才替换；老图仍在 cat_appearances 里（不删图）
    const confirmed = await app.inject({
      method: 'POST', url: '/api/v1/cats/me/appearance/repaint/confirm', cookies,
      payload: { appearance_id: repaintId },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({
      selected_birth_appearance_id: repaintId,
      lifecycle_stage: 'world',
    });
    expect(confirmed.json().appearance_repaint.pending_candidate).toBeNull();
    const oldRow = await db.selectFrom('cat_appearances').select(['id', 'selection_status'])
      .where('id', '=', birthAppearanceId).executeTakeFirstOrThrow();
    expect(oldRow.selection_status).toBe('replaced');

    // 确认过的重画图不会被再次当成「等你决定的新图」——用户不会卡在决定态，
    // 且还能用掉最后一次额度（回归：若被换下的图降级成 candidate 就会永久卡住）
    const second = await app.inject({ method: 'POST', url: '/api/v1/cats/me/appearance/repaint', cookies, payload: {} });
    expect(second.statusCode).toBe(200);
    expect(second.json().repaint).toMatchObject({ used: 2, remaining: 0 });
  });

  it('用户可以放弃重画的新图，保留原来的主形象', async () => {
    const cookies = await loginCookies();
    const { catId, birthAppearanceId } = await createConfirmedCat(cookies);

    const requested = await app.inject({ method: 'POST', url: '/api/v1/cats/me/appearance/repaint', cookies, payload: {} });
    expect(requested.statusCode).toBe(200);
    const repaintId: string = requested.json().appearance_id;
    await drainUntilAppearance(catId, repaintId);

    const discarded = await app.inject({ method: 'DELETE', url: '/api/v1/cats/me/appearance/repaint', cookies });
    expect(discarded.statusCode).toBe(200);
    // 保留原图：主形象不变，且不再有等待决定的候选
    expect(discarded.json().selected_birth_appearance_id).toBe(birthAppearanceId);
    expect(discarded.json().appearance_repaint.pending_candidate).toBeNull();
    // 放弃过的候选不会被再次当成待决定项（也不占用「等待决定」这道闸）
    expect(discarded.json().appearance_repaint).toMatchObject({ used: 1, remaining: 1 });

    const confirmDiscarded = await app.inject({
      method: 'POST', url: '/api/v1/cats/me/appearance/repaint/confirm', cookies,
      payload: { appearance_id: repaintId },
    });
    expect(confirmDiscarded.statusCode).toBe(404);
    expect(confirmDiscarded.json().error.code).toBe('REPAINT_CANDIDATE_NOT_FOUND');
  });

  it('已有绘制任务在跑时拒绝重画（复用既有活跃 job 校验）', async () => {
    const cookies = await loginCookies();
    const { catId } = await createConfirmedCat(cookies);
    const { db } = await import('../src/db/index.js');

    // 模拟另一张出生图任务仍在队列里（例如刚被 repair 重排）
    await db.insertInto('image_jobs').values({
      id: randomUUID(), dedupe_key: `birth:${catId}:${randomUUID()}`, cat_id: catId, kind: 'birth',
      status: 'running', attempts: 1, available_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
    }).execute();

    const profile = await app.inject({ method: 'GET', url: '/api/v1/cats/me', cookies });
    expect(profile.json().appearance_repaint).toMatchObject({ eligible: true, image_job_active: true });

    const response = await app.inject({ method: 'POST', url: '/api/v1/cats/me/appearance/repaint', cookies, payload: {} });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('IMAGE_JOB_ACTIVE');
  });

  it('次数用尽后拒绝重画，并给出固定的求助文案', async () => {
    const cookies = await loginCookies();
    const { catId, birthAppearanceId } = await createConfirmedCat(cookies);
    const { db } = await import('../src/db/index.js');
    const { APPEARANCE_REPAINT_LIMIT } = await import('../src/services/catService.js');

    // 直接落两条已完成的重画任务把额度用满：本用例只验限次闸门，不重复跑生图
    for (let index = 0; index < APPEARANCE_REPAINT_LIMIT; index += 1) {
      const usedId = `repaint-${randomUUID()}`;
      await db.insertInto('image_jobs').values({
        id: randomUUID(), dedupe_key: `birth:${catId}:${usedId}`, cat_id: catId, kind: 'birth',
        appearance_id: usedId, status: 'succeeded', attempts: 1, available_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      }).execute();
      // 对应候选图已被用户放弃（discarded）——否则会先撞上「等你决定」这道闸
      await db.insertInto('cat_appearances').values({
        id: usedId, cat_id: catId, kind: 'birth', image_url: '/assets/cat-placeholder.png',
        local_path: '/assets/cat-placeholder.png', object_key: null, prompt: 'used repaint',
        travel_id: null, selection_status: 'discarded',
      }).execute();
    }

    const profile = await app.inject({ method: 'GET', url: '/api/v1/cats/me', cookies });
    expect(profile.json().appearance_repaint).toMatchObject({
      eligible: true, used: APPEARANCE_REPAINT_LIMIT, remaining: 0, pending_candidate: null,
    });

    const response = await app.inject({ method: 'POST', url: '/api/v1/cats/me/appearance/repaint', cookies, payload: {} });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('REPAINT_LIMIT_REACHED');
    expect(response.json().error.message).toContain('给世界写信');
    // 没有偷偷排新任务，主形象也没动
    const pendingJobs = await db.selectFrom('image_jobs').select('id').where('cat_id', '=', catId)
      .where('status', 'in', ['pending', 'running']).execute();
    expect(pendingJobs).toHaveLength(0);
    const after = await app.inject({ method: 'GET', url: '/api/v1/cats/me', cookies });
    expect(after.json().selected_birth_appearance_id).toBe(birthAppearanceId);
  });

  it('云端失败（failed）不扣次数——系统侧没交付任何图，不该让用户承担额度损失', async () => {
    const cookies = await loginCookies();
    const { catId } = await createConfirmedCat(cookies);
    const { db } = await import('../src/db/index.js');

    const wastedId = `repaint-${randomUUID()}`;
    await db.insertInto('image_jobs').values({
      id: randomUUID(), dedupe_key: `birth:${catId}:${wastedId}`, cat_id: catId, kind: 'birth',
      appearance_id: wastedId, status: 'failed', attempts: 3, available_at: new Date().toISOString(),
      finished_at: new Date().toISOString(), last_error: 'ImageJobError',
    }).execute();

    const profile = await app.inject({ method: 'GET', url: '/api/v1/cats/me', cookies });
    expect(profile.json().appearance_repaint).toMatchObject({ used: 0, remaining: 2, image_job_active: false });
  });

  // 首轮独立验收（evolution/reviews/pr-66-a4f7073.md）发现的限次绕过：canceled 原先不计数，
  // 而 `appearance/cancel` 是用户可自行触发的端点、取消发生在图**已开画之后**（Credits 可能已消耗），
  // 于是「发起 → 取消」循环可无限刷图（行为探针在上限 2 的声明下实测拿到 6 次）。
  // 修复后 canceled 必须计入额度；本用例固定该行为，防回退。
  it('用户主动取消（canceled）计入次数——否则「发起→取消」循环可无限刷图（限次绕过回归）', async () => {
    const cookies = await loginCookies();
    const { catId } = await createConfirmedCat(cookies);
    const { db } = await import('../src/db/index.js');
    const { APPEARANCE_REPAINT_LIMIT } = await import('../src/services/catService.js');

    for (let index = 0; index < APPEARANCE_REPAINT_LIMIT; index += 1) {
      const canceledId = `repaint-${randomUUID()}`;
      await db.insertInto('image_jobs').values({
        id: randomUUID(), dedupe_key: `birth:${catId}:${canceledId}`, cat_id: catId, kind: 'birth',
        appearance_id: canceledId, status: 'canceled', attempts: 1, available_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      }).execute();
    }

    // 额度已被取消掉的任务占满
    const profile = await app.inject({ method: 'GET', url: '/api/v1/cats/me', cookies });
    expect(profile.json().appearance_repaint).toMatchObject({
      used: APPEARANCE_REPAINT_LIMIT, remaining: 0,
    });

    // 再发起必须被封顶，而不是靠取消退还额度继续画
    const response = await app.inject({ method: 'POST', url: '/api/v1/cats/me/appearance/repaint', cookies, payload: {} });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('REPAINT_LIMIT_REACHED');
    const jobs = await db.selectFrom('image_jobs').select('id').where('cat_id', '=', catId)
      .where('status', 'in', ['pending', 'running']).execute();
    expect(jobs).toHaveLength(0);
  });

  it('重画确认端点只接受本猫的重画候选，未知 code 不透传异常正文', async () => {
    const cookies = await loginCookies();
    await createConfirmedCat(cookies);

    const missingId = await app.inject({
      method: 'POST', url: '/api/v1/cats/me/appearance/repaint/confirm', cookies, payload: {},
    });
    expect(missingId.statusCode).toBe(400);
    expect(missingId.json().error.code).toBe('INVALID');

    // 非 repaint 前缀的 id（例如出生候选图）不能走这条替换路径
    const foreign = await app.inject({
      method: 'POST', url: '/api/v1/cats/me/appearance/repaint/confirm', cookies,
      payload: { appearance_id: randomUUID() },
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error.code).toBe('REPAINT_CANDIDATE_NOT_FOUND');

    // 存在但属于别人的重画候选同样不可替换
    const otherCookies = await loginCookies();
    const other = await createConfirmedCat(otherCookies);
    const { db } = await import('../src/db/index.js');
    const otherRepaintId = `repaint-${randomUUID()}`;
    await db.insertInto('cat_appearances').values({
      id: otherRepaintId, cat_id: other.catId, kind: 'birth', image_url: '/assets/cat-placeholder.png',
      local_path: '/assets/cat-placeholder.png', object_key: null, prompt: 'other cat repaint',
      travel_id: null, selection_status: 'candidate',
    }).execute();
    const crossTenant = await app.inject({
      method: 'POST', url: '/api/v1/cats/me/appearance/repaint/confirm', cookies,
      payload: { appearance_id: otherRepaintId },
    });
    expect(crossTenant.statusCode).toBe(404);
    expect(crossTenant.json().error.code).toBe('REPAINT_CANDIDATE_NOT_FOUND');
  });

  it('没有等待决定的新图时，放弃端点返回固定 404 文案', async () => {
    const cookies = await loginCookies();
    await createConfirmedCat(cookies);
    const response = await app.inject({ method: 'DELETE', url: '/api/v1/cats/me/appearance/repaint', cookies });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('REPAINT_CANDIDATE_NOT_FOUND');
  });

  it('重画请求限流：同一用户短时间内连点会被挡下', async () => {
    const cookies = await loginCookies();
    const { catId } = await createConfirmedCat(cookies);
    const { db } = await import('../src/db/index.js');
    // 让每次请求都因活跃 job 被业务拒绝，从而只观察限流计数（不真的排多张图）
    await db.insertInto('image_jobs').values({
      id: randomUUID(), dedupe_key: `birth:${catId}:${randomUUID()}`, cat_id: catId, kind: 'birth',
      status: 'running', attempts: 1, available_at: new Date().toISOString(), started_at: new Date().toISOString(),
    }).execute();

    const codes: number[] = [];
    for (let index = 0; index < 7; index += 1) {
      const response = await app.inject({ method: 'POST', url: '/api/v1/cats/me/appearance/repaint', cookies, payload: {} });
      codes.push(response.statusCode);
    }
    // 限流额度（6）刻意宽于业务上限，被拒请求也计数；第 7 次才落到 429
    expect(codes.slice(0, 6)).toEqual([409, 409, 409, 409, 409, 409]);
    expect(codes[6]).toBe(429);
  });
  // #077 验收标准 1：个案形象审计只读端点（运营诊断入口）
  it('审计端点判定主形象归属并给出修复路径建议（成长图 vs 出生定妆照）', async () => {
    const cookies = await loginCookies();
    const { catId, birthAppearanceId } = await createConfirmedCat(cookies);
    const { db } = await import('../src/db/index.js');
    const userId = await db.selectFrom('cats').select('user_id').where('id', '=', catId).executeTakeFirstOrThrow();
    const internalHeaders = { 'x-internal-key': 'dev-internal-key' };

    const confirmed = await app.inject({
      method: 'GET', url: `/api/v1/internal/ops/cat-appearance-audit?user_id=${userId.user_id}`, headers: internalHeaders,
    });
    expect(confirmed.statusCode).toBe(200);
    const audit = confirmed.json().audit;
    expect(audit).toMatchObject({
      found: true, cat_id: catId, appearance_confirmed: true,
    });
    expect(audit.main_appearance).toMatchObject({ id: birthAppearanceId, kind: 'birth', is_repaint: false });
    // 出生定妆照异常 + 已确认形象 → 建议走 #077 申诉出口
    expect(audit.suggested_repair_path).toContain('#077');

    // 脱敏边界硬断言：不得回显图片本体/prompt/存储键
    const raw = confirmed.payload;
    for (const forbidden of ['image_url', 'local_path', 'object_key', 'prompt']) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it('审计端点无 user_id 报 400、无内部 key 拒绝、找不到猫返回 found:false', async () => {
    const internalHeaders = { 'x-internal-key': 'dev-internal-key' };
    const missing = await app.inject({ method: 'GET', url: '/api/v1/internal/ops/cat-appearance-audit', headers: internalHeaders });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe('MISSING_USER_ID');

    const unauthorized = await app.inject({ method: 'GET', url: '/api/v1/internal/ops/cat-appearance-audit?user_id=whoever' });
    expect(unauthorized.statusCode).toBe(403);

    const absent = await app.inject({
      method: 'GET', url: '/api/v1/internal/ops/cat-appearance-audit?user_id=no-such-user', headers: internalHeaders,
    });
    expect(absent.statusCode).toBe(200);
    expect(absent.json().audit).toEqual({ found: false });
  });
});
