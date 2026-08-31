/**
 * ISSUES #246 第一阶段止血：这里只生成单猫、只读的刷新计划。
 *
 * 安全批次状态机、shadow appearance 与原子切换尚未实现。在它们完成前，--apply 必须
 * fail-closed；本入口不得调用 QCA、运行 migration、删除 appearance 或删除底层对象。
 *
 * 用法：npm run refresh:cat-images -w @meme/server -- --cat-id <catId>
 *       npm run refresh:cat-images -w @meme/server -- --cat-id <catId> --dry-run
 */
import type { Kysely } from 'kysely';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSchema } from '../db/schema.js';

export const SAFE_BATCH_CUTOVER_NOT_IMPLEMENTED = 'SAFE_BATCH_CUTOVER_NOT_IMPLEMENTED';

type RefreshArgs =
  | { ok: true; catId: string; mode: 'dry-run' }
  | { ok: false; exitCode: 2; message: string };

export function parseCatImageRefreshArgs(argv: string[]): RefreshArgs {
  let catId: string | null = null;
  let applyRequested = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') continue;
    if (arg === '--apply') {
      applyRequested = true;
      continue;
    }
    if (arg === '--all') {
      return { ok: false, exitCode: 2, message: '禁止全库刷新；必须显式指定唯一 --cat-id <catId>。' };
    }
    if (arg === '--cat-id') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        return { ok: false, exitCode: 2, message: '--cat-id 必须带一个猫 ID。' };
      }
      if (catId) return { ok: false, exitCode: 2, message: '只能指定一个 --cat-id。' };
      catId = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--cat-id=')) {
      if (catId) return { ok: false, exitCode: 2, message: '只能指定一个 --cat-id。' };
      catId = arg.slice('--cat-id='.length);
      continue;
    }
    return {
      ok: false,
      exitCode: 2,
      message: `不支持参数 ${JSON.stringify(arg)}；必须显式使用 --cat-id <catId>，旧 positional/全库形式已停用。`,
    };
  }
  if (applyRequested) {
    const suffix = catId ? '' : '；同时缺少 --cat-id';
    return {
      ok: false,
      exitCode: 2,
      message: `${SAFE_BATCH_CUTOVER_NOT_IMPLEMENTED}: --apply 已禁用，当前只能生成 dry-run plan${suffix}。`,
    };
  }
  if (!catId) {
    return { ok: false, exitCode: 2, message: '禁止无参数全库刷新；必须显式指定唯一 --cat-id <catId>。' };
  }
  if (catId.length > 128 || !/^[A-Za-z0-9_-]+$/.test(catId)) {
    return { ok: false, exitCode: 2, message: '--cat-id 格式无效。' };
  }
  return { ok: true, catId, mode: 'dry-run' };
}

export async function buildCatImageRefreshPlan(db: Kysely<DatabaseSchema>, catId: string) {
  const cat = await db.selectFrom('cats').select([
    'id', 'selected_birth_appearance_id', 'current_image_url', 'appearance_status',
  ]).where('id', '=', catId).executeTakeFirst();
  if (!cat) throw Object.assign(new Error(`CAT_NOT_FOUND: ${catId}`), { code: 'CAT_NOT_FOUND' });

  const [appearances, travels] = await Promise.all([
    db.selectFrom('cat_appearances').select(['id', 'kind', 'travel_id', 'created_at'])
      .where('cat_id', '=', catId).orderBy('created_at', 'desc').orderBy('id', 'desc').execute(),
    db.selectFrom('travels').select(['id', 'travel_date']).where('cat_id', '=', catId)
      .orderBy('travel_date').orderBy('reported_at').orderBy('id').execute(),
  ]);
  const latestGrowthByTravel = new Map<string, string>();
  for (const appearance of appearances) {
    if (appearance.kind === 'growth' && appearance.travel_id && !latestGrowthByTravel.has(appearance.travel_id)) {
      latestGrowthByTravel.set(appearance.travel_id, appearance.id);
    }
  }
  return {
    schema_version: 1,
    mode: 'dry-run',
    safe_to_apply: false,
    blocked_reason: SAFE_BATCH_CUTOVER_NOT_IMPLEMENTED,
    cat_id: cat.id,
    current: {
      selected_birth_appearance_id: cat.selected_birth_appearance_id,
      current_image_url: cat.current_image_url,
      appearance_status: cat.appearance_status,
    },
    existing: { appearances: appearances.length, travels: travels.length },
    items: [
      { key: 'birth', kind: 'birth', current_appearance_id: cat.selected_birth_appearance_id },
      ...travels.map((travel) => ({
        key: `growth:${travel.id}`,
        kind: 'growth',
        travel_id: travel.id,
        current_appearance_id: latestGrowthByTravel.get(travel.id) ?? null,
      })),
    ],
    guarantees: [
      '本命令只读数据库，不运行 migration',
      '本命令不调用 QCA/ImageGen，不消耗用户 Credits',
      '本命令不删除或写入 appearance、image job、postcard 或对象存储',
      '后续 apply 必须由 durable batch + shadow rows + CAS 原子切换另行实现',
    ],
  };
}

async function main() {
  const args = parseCatImageRefreshArgs(process.argv.slice(2));
  if (!args.ok) {
    console.error(args.message);
    return args.exitCode;
  }

  // 参数通过后才打开数据库；无参数/--all/--apply 都不会创建 SQLite 文件或触碰 production pool。
  const { db, closeDatabase } = await import('../db/index.js');
  try {
    const plan = await buildCatImageRefreshPlan(db, args.catId);
    console.log(JSON.stringify(plan, null, 2));
    return 0;
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error && error.code === 'CAT_NOT_FOUND'
      ? 'CAT_NOT_FOUND'
      : 'CAT_IMAGE_REFRESH_PLAN_FAILED';
    console.error(code);
    return 1;
  } finally {
    await closeDatabase();
  }
}

export function isDirectCli(metaUrl: string, argv1: string | undefined) {
  return Boolean(argv1) && path.resolve(fileURLToPath(metaUrl)) === path.resolve(argv1!);
}

if (isDirectCli(import.meta.url, process.argv[1])) process.exitCode = await main();
