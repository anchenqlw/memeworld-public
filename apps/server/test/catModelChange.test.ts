import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// backlog #084：建猫向导选过 model 之后没有任何更换入口（prop_bee5b8c7）。
// 覆盖 PATCH /cats/me/model 的完整语义：换 model 只重建画师、旧画师被归档、
// qca_model 落库；非法 model 被拒；有活跃 image job 时拒绝；聊天/旅行的 Forward
// 配置不被触碰。独立文件 + partial mock：只监听归档调用，不改变真实行为。

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meme-model-change-test-'));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'mock';
process.env.QCA_MOCK = 'true';
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

// QCA_MOCK 下 archiveImageArtistResources 是 no-op，归档这件事只能从调用上观察。
// 保留真实实现（仍然是 no-op），仅加一层 spy。
// createImageArtistResources 在 QCA_MOCK 下是同步返回的（无真实网络 await），因此并发竞态
// 在 mock 下**不会自然发生**——首轮独立验收正是靠注入 50ms 延迟才复现出画师泄漏。
// 这里用可控延迟开关让并发用例能真实触达那个窗口（默认 0，不影响其他用例）。
let artistCreateDelayMs = 0;
vi.mock('../src/services/qcaImage.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/services/qcaImage.js')>();
  return {
    ...actual,
    archiveImageArtistResources: vi.fn(actual.archiveImageArtistResources),
    createImageArtistResources: vi.fn(async (...args: Parameters<typeof actual.createImageArtistResources>) => {
      if (artistCreateDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, artistCreateDelayMs));
      return actual.createImageArtistResources(...args);
    }),
  };
});

// 本测试不涉及聊天；禁用聊天 worker 轮询，避免 in-flight 查询与 afterAll 的 closeDatabase 竞态
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
  if (app) await app.close();
  const { closeDatabase } = await import('../src/db/index.js');
  await closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(async () => {
  const { archiveImageArtistResources } = await import('../src/services/qcaImage.js');
  vi.mocked(archiveImageArtistResources).mockClear();
});

/**
 * 把这只猫自己的 image job 跑完；共享 PostgreSQL 里的其它猫任务不会被该回归消费。
 */
async function drainImageJobsFor(catId: string, limit = 60) {
  const { runImageJobOnceForCat } = await import('../src/services/imageJobService.js');
  const { db } = await import('../src/db/index.js');
  for (let attempt = 0; attempt < limit; attempt += 1) {
    const active = await db.selectFrom('image_jobs').select('id').where('cat_id', '=', catId)
      .where('status', 'in', ['pending', 'running']).executeTakeFirst();
    if (!active) return;
    await runImageJobOnceForCat(catId);
  }
  throw new Error(`排空 ${limit} 轮后 cat ${catId} 仍有未完成的 image job`);
}

/** 建一只已确认形象、可进设置面板的猫 */
async function createConfirmedCat(patSuffix: string, model = 'ultimate') {
  const login = await app.inject({
    method: 'GET',
    url: `/api/v1/auth/login?json=1&fresh=1&nonce=${randomUUID()}`,
    headers: { accept: 'application/json' },
  });
  const cookie = login.cookies[0];
  const cookies = { [cookie.name]: cookie.value };

  const pat = await app.inject({ method: 'PUT', url: '/api/v1/pat', cookies, payload: { pat: `pt-model-change-${patSuffix}` } });
  expect(pat.statusCode).toBe(200);

  const created = await app.inject({
    method: 'POST', url: '/api/v1/cats', cookies,
    payload: { name: '换模型猫', personality: '好奇', model },
  });
  expect(created.statusCode).toBe(200);

  await drainImageJobsFor(created.json().id);
  const profile = await app.inject({ method: 'GET', url: '/api/v1/cats/me', cookies });
  const candidates = profile.json().appearance_candidates || [];
  expect(candidates.length, '出生图任务跑完后应有形象候选').toBeGreaterThan(0);
  const candidateId = candidates[0].id;
  const confirmed = await app.inject({
    method: 'POST', url: '/api/v1/cats/me/appearance/confirm', cookies,
    payload: { appearance_id: candidateId },
  });
  expect(confirmed.statusCode).toBe(200);
  expect(confirmed.json().lifecycle_stage).toBe('world');
  return { cookies, catId: confirmed.json().id, profile: confirmed.json() };
}

describe('changing the cat model after birth (backlog #084)', () => {
  it('rebuilds the image artist, archives the previous one and persists qca_model', async () => {
    const { cookies, catId, profile } = await createConfirmedCat('happy');
    expect(profile.qca.model).toBe('ultimate');
    const previous = { envId: profile.qca.image_env_id, agentId: profile.qca.image_agent_id };
    expect(previous.envId).toBeTruthy();
    expect(previous.agentId).toBeTruthy();

    const changed = await app.inject({
      method: 'PATCH', url: '/api/v1/cats/me/model', cookies, payload: { model: 'lite' },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().model_changed).toBe(true);
    expect(changed.json().qca.model).toBe('lite');

    // 新画师：env/agent 都换了新的
    expect(changed.json().qca.image_env_id).not.toBe(previous.envId);
    expect(changed.json().qca.image_agent_id).not.toBe(previous.agentId);

    // 旧画师被归档（QCA_MOCK 下 no-op，故断言调用本身）
    const { archiveImageArtistResources } = await import('../src/services/qcaImage.js');
    expect(vi.mocked(archiveImageArtistResources)).toHaveBeenCalledWith(
      expect.objectContaining({ pat: expect.any(String) }),
      previous,
    );

    // 落库：下次生图/对话读到的就是新 model
    const { db } = await import('../src/db/index.js');
    const row = await db.selectFrom('cats')
      .select(['qca_model', 'qca_image_env_id', 'qca_image_agent_id'])
      .where('id', '=', catId).executeTakeFirstOrThrow();
    expect(row.qca_model).toBe('lite');
    expect(row.qca_image_env_id).toBe(changed.json().qca.image_env_id);
    expect(row.qca_image_agent_id).toBe(changed.json().qca.image_agent_id);

    // GET /cats/me 也如实反映（设置面板重新拉取时看到的是新模型）
    const reread = await app.inject({ method: 'GET', url: '/api/v1/cats/me', cookies });
    expect(reread.json().qca.model).toBe('lite');
  });

  it('does not rebuild the main agent or touch chat/travel forward config', async () => {
    const { cookies, catId } = await createConfirmedCat('untouched');
    const { db } = await import('../src/db/index.js');

    // 首轮独立验收（M1b 变异）发现的盲区：夹具猫未 startAdventure，这九个绑定字段基线**全是 null**，
    // 原断言实为 null===null，只能抓「null → 非空」方向；把字段清成 null 的变异反而全绿。
    // 故此处先写入可辨识的非空值，断言才真正覆盖「非空 → 变化/被清空」两个方向。
    const sentinels = {
      qca_env_id: 'env-untouched-sentinel',
      qca_agent_id: 'agent-untouched-sentinel',
      qca_memstore_id: 'memstore-untouched-sentinel',
      qca_deployment_id: 'deployment-untouched-sentinel',
      qca_forward_travel_template_id: 'tpl-travel-sentinel',
      qca_forward_chat_template_id: 'tpl-chat-sentinel',
      qca_forward_im_channel_id: 'im-channel-sentinel',
      qca_forward_identity_id: 'identity-sentinel',
      qca_forward_schedule_id: 'schedule-sentinel',
    } as const;
    await db.updateTable('cats').set(sentinels).where('id', '=', catId).execute();

    const before = (await app.inject({ method: 'GET', url: '/api/v1/cats/me', cookies })).json().qca;
    // 前置自证：基线确实非空，否则下面的断言又会退化成 null===null
    for (const field of ['env_id', 'agent_id', 'forward_chat_template_id'] as const) {
      expect(before[field], `前置：qca.${field} 必须非空，否则断言无效`).toBeTruthy();
    }

    const changed = await app.inject({
      method: 'PATCH', url: '/api/v1/cats/me/model', cookies, payload: { model: 'lite' },
    });
    expect(changed.statusCode).toBe(200);
    const after = changed.json().qca;

    // 主 agent / 旅行 / 聊天 / IM 的绑定一个都不动——它们读时取 cat.qca_model，无 model 状态
    for (const field of [
      'env_id', 'agent_id', 'memstore_id', 'deployment_id',
      'forward_travel_template_id', 'forward_chat_template_id',
      'forward_im_channel_id', 'forward_identity_id', 'forward_schedule_id',
    ] as const) {
      expect(after[field], `qca.${field} 不应因换 model 变化`).toEqual(before[field]);
    }
    // 库里也逐字段核对（防「响应投影正确但落库被改」）
    const row = await db.selectFrom('cats').select(Object.keys(sentinels) as never[])
      .where('id', '=', catId).executeTakeFirstOrThrow() as Record<string, unknown>;
    for (const [column, value] of Object.entries(sentinels)) {
      expect(row[column], `cats.${column} 不应因换 model 变化`).toBe(value);
    }
  });

  // 首轮独立验收实测复现的画师泄漏：createImageArtistResources 是真实 QCA 网络调用，
  // 两个并发换 model 请求各建一个画师，而后写的 UPDATE 覆盖先写的 → 先建那个画师永久孤立在
  // 用户 QCA 账号（既不在库也不会被归档），且请求方拿到作废 id。修复为乐观并发 + 败者自清。
  it('concurrent model changes do not leak an orphan image artist', async () => {
    const { cookies, catId } = await createConfirmedCat('concurrent');
    const { db } = await import('../src/db/index.js');
    const { createImageArtistResources } = await import('../src/services/qcaImage.js');
    const createSpy = vi.mocked(createImageArtistResources);
    createSpy.mockClear();

    // 打开延迟：让两个请求都进入「已建画师、尚未 UPDATE」的窗口（mock 默认同步，不注入则竞态不发生）
    artistCreateDelayMs = 50;
    const [first, second] = await Promise.all([
      app.inject({ method: 'PATCH', url: '/api/v1/cats/me/model', cookies, payload: { model: 'lite' } }),
      app.inject({ method: 'PATCH', url: '/api/v1/cats/me/model', cookies, payload: { model: 'lite' } }),
    ]);
    // 两个请求都不该报错（换 model 对用户是幂等诉求）
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);

    const row = await db.selectFrom('cats').select(['qca_model', 'qca_image_env_id', 'qca_image_agent_id'])
      .where('id', '=', catId).executeTakeFirstOrThrow();
    expect(row.qca_model).toBe('lite');

    artistCreateDelayMs = 0;

    // 前置自证：延迟确实让两个请求都建了画师（否则本用例没触达竞态窗口，等于空跑）
    expect(createSpy.mock.calls.length, '两个并发请求都应各自建过画师，否则未触达竞态').toBe(2);

    // 关键断言：两个请求返回的画师 id 都不得与库里的不一致——
    // 修复前败者会把作废 id 返回给前端（实测复现），修复后它自清并读实况返回。
    for (const [label, response] of [['first', first], ['second', second]] as const) {
      const envId = response.json().qca?.image_env_id;
      expect(envId, `${label} 返回的 image_env_id 必须等于库中实况，否则是作废画师（泄漏窗口未关闭）`)
        .toBe(row.qca_image_env_id);
    }
    // 败者建的那个画师必须被归档（自清），否则永久孤立在用户 QCA 账号
    const { archiveImageArtistResources } = await import('../src/services/qcaImage.js');
    expect(vi.mocked(archiveImageArtistResources).mock.calls.length,
      '败者应归档自己刚建的画师（自清），加上胜者归档旧画师，至少两次').toBeGreaterThanOrEqual(2);
  });

  // 二轮独立验收指出的零覆盖分支：乐观并发令牌的 null 分支（历史猫 qca_image_env_id 为 NULL——
  // qca_image_* 是后加列，存量猫可能没有画师）。变异测试证明把 `is null` 退化成 `=` 时
  // 开发者全套测试仍全绿，故此处补真实覆盖。
  it('changes model for a legacy cat whose image artist columns are NULL', async () => {
    const { cookies, catId } = await createConfirmedCat('legacy-null');
    const { db } = await import('../src/db/index.js');
    // 模拟存量猫：画师列为 NULL
    await db.updateTable('cats')
      .set({ qca_image_env_id: null, qca_image_agent_id: null })
      .where('id', '=', catId).execute();

    const changed = await app.inject({
      method: 'PATCH', url: '/api/v1/cats/me/model', cookies, payload: { model: 'lite' },
    });
    expect(changed.statusCode, 'NULL 画师列的猫也必须能换 model（is null 分支）').toBe(200);
    expect(changed.json().model_changed).toBe(true);

    const row = await db.selectFrom('cats').select(['qca_model', 'qca_image_env_id', 'qca_image_agent_id'])
      .where('id', '=', catId).executeTakeFirstOrThrow();
    expect(row.qca_model).toBe('lite');
    expect(row.qca_image_env_id, 'is null 分支写入后画师必须落库').toBeTruthy();
    expect(row.qca_image_agent_id).toBeTruthy();
  });

  // 二轮独立验收指出的静默丢弃：并发赢家换到**别的** model 时，败者原先一律回
  // model_changed:false + 实况，用户选 Ultimate 却收到「Lite 就是当前的模型，没有变化」——
  // 请求被静默丢弃还被「没有变化」掩盖。修复为明确报 MODEL_CHANGE_CONFLICT。
  //
  // 复现手法：mock 只有 ultimate/lite 两个 model，两个并发请求若换同一个 model，败者的实况
  // 恰等于自己所请求的值（那是正确的幂等），测不到冲突分支。故让起始为 lite、两请求都换 ultimate，
  // 并在赢家落库后由第三方把 model 改成 lite（模拟「赢家换到别的 model」的等价终态），
  // 使败者读到的实况 ≠ 自己请求的 ultimate。
  it('reports conflict instead of faking idempotency when the live model differs from the requested one', async () => {
    const { cookies, catId } = await createConfirmedCat('conflict', 'lite');
    const { db } = await import('../src/db/index.js');

    artistCreateDelayMs = 60;
    const inflight = app.inject({
      method: 'PATCH', url: '/api/v1/cats/me/model', cookies, payload: { model: 'ultimate' },
    });
    // 在途期间：另一路径先把画师换掉（令牌失效）且最终 model 与在途请求所要的不同
    await new Promise((resolve) => setTimeout(resolve, 20));
    await db.updateTable('cats')
      .set({ qca_image_env_id: 'env_img_taken_by_other', qca_image_agent_id: 'agent_img_taken_by_other', qca_model: 'lite' })
      .where('id', '=', catId).execute();
    const loser = await inflight;
    artistCreateDelayMs = 0;

    expect(loser.statusCode, '实况 model 与所请求不同时必须报冲突，不得装幂等回 200').toBe(409);
    expect(loser.json().error.code).toBe('MODEL_CHANGE_CONFLICT');
    // 关键：不得用「没有变化」掩盖被丢弃的请求
    expect(loser.json().error.message).not.toContain('没有变化');

    // 败者不得把库改成自己建的画师（乐观并发令牌拦住了）
    const row = await db.selectFrom('cats').select(['qca_model', 'qca_image_env_id'])
      .where('id', '=', catId).executeTakeFirstOrThrow();
    expect(row.qca_image_env_id).toBe('env_img_taken_by_other');
    expect(row.qca_model).toBe('lite');
  });

  it('rejects a model that is not in the account model list', async () => {
    const { cookies, catId } = await createConfirmedCat('invalid');
    const rejected = await app.inject({
      method: 'PATCH', url: '/api/v1/cats/me/model', cookies, payload: { model: 'disabled-model' },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.code).toBe('INVALID_QCA_MODEL');

    const { archiveImageArtistResources } = await import('../src/services/qcaImage.js');
    expect(vi.mocked(archiveImageArtistResources)).not.toHaveBeenCalled();

    const { db } = await import('../src/db/index.js');
    const row = await db.selectFrom('cats').select('qca_model').where('id', '=', catId).executeTakeFirstOrThrow();
    expect(row.qca_model).toBe('ultimate');
  });

  it('rejects an empty model instead of silently clearing it', async () => {
    const { cookies } = await createConfirmedCat('empty');
    const rejected = await app.inject({
      method: 'PATCH', url: '/api/v1/cats/me/model', cookies, payload: { model: '   ' },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.code).toBe('QCA_MODEL_REQUIRED');
  });

  it('reports no-op when the requested model is already the current one', async () => {
    const { cookies } = await createConfirmedCat('noop');
    const same = await app.inject({
      method: 'PATCH', url: '/api/v1/cats/me/model', cookies, payload: { model: 'ultimate' },
    });
    expect(same.statusCode).toBe(200);
    expect(same.json().model_changed).toBe(false);

    const { archiveImageArtistResources } = await import('../src/services/qcaImage.js');
    expect(vi.mocked(archiveImageArtistResources)).not.toHaveBeenCalled();
  });

  it('refuses while an image job is still running (IMAGE_JOB_ACTIVE)', async () => {
    const { cookies, catId } = await createConfirmedCat('busy');
    const { enqueueBirthCandidate } = await import('../src/services/imageJobService.js');
    await enqueueBirthCandidate(catId);

    const refused = await app.inject({
      method: 'PATCH', url: '/api/v1/cats/me/model', cookies, payload: { model: 'lite' },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('IMAGE_JOB_ACTIVE');

    const { archiveImageArtistResources } = await import('../src/services/qcaImage.js');
    expect(vi.mocked(archiveImageArtistResources)).not.toHaveBeenCalled();

    const { db } = await import('../src/db/index.js');
    const row = await db.selectFrom('cats').select('qca_model').where('id', '=', catId).executeTakeFirstOrThrow();
    expect(row.qca_model).toBe('ultimate');

    // 画完之后可以正常更换
    await drainImageJobsFor(catId);
    const changed = await app.inject({
      method: 'PATCH', url: '/api/v1/cats/me/model', cookies, payload: { model: 'lite' },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().qca.model).toBe('lite');
  });

  it('requires a cat and a session', async () => {
    const anonymous = await app.inject({ method: 'PATCH', url: '/api/v1/cats/me/model', payload: { model: 'lite' } });
    expect(anonymous.statusCode).toBe(401);

    const login = await app.inject({
      method: 'GET', url: `/api/v1/auth/login?json=1&fresh=1&nonce=${randomUUID()}`,
      headers: { accept: 'application/json' },
    });
    const cookie = login.cookies[0];
    const catless = await app.inject({
      method: 'PATCH', url: '/api/v1/cats/me/model',
      cookies: { [cookie.name]: cookie.value }, payload: { model: 'lite' },
    });
    expect(catless.statusCode).toBe(404);
    expect(catless.json().error.code).toBe('NO_CAT');
  });
});
