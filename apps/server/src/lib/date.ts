export function shanghaiDate(d = new Date()): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

/**
 * 当前上海业务日的下一个 00:00，返回真实 UTC instant。
 * 显式使用 Asia/Shanghai 的历日与 UTC+08:00，不受宿主机本地时区/DST 影响。
 */
export function nextShanghaiMidnightIso(now = new Date()): string {
  const [year, month, day] = shanghaiDate(now).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1) - 8 * 60 * 60 * 1000).toISOString();
}

export function shanghaiDateFromIso(iso: string): string {
  return shanghaiDate(new Date(iso));
}

/**
 * 数据库历史 text timestamp 有三种形态：ISO Z、新 PG 的 `+08`、SQLite CURRENT_TIMESTAMP 的无时区 UTC。
 * 统一转成真实 instant；禁止直接按字符串排序或截日期。
 */
export function dbTimestampMs(value: string): number {
  const text = String(value || '').trim();
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)
    ? `${text.replace(' ', 'T')}Z`
    : text;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY;
}

export function shanghaiDateFromDbText(value: string): string {
  return shanghaiDate(new Date(dbTimestampMs(value)));
}

export function compareDbTimestamps(a: string, b: string): number {
  return dbTimestampMs(a) - dbTimestampMs(b) || String(a).localeCompare(String(b));
}

export function daysDiff(a: string, b: string): number {
  const da = new Date(a + 'T00:00:00+08:00');
  const db = new Date(b + 'T00:00:00+08:00');
  return Math.round((db.getTime() - da.getTime()) / 86400000);
}

/** QCA run 已结束但 travels/report 尚未落库时的宽限期，避免误报「探险受阻」 */
export const ADVENTURE_REPORT_GRACE_MS = 15 * 60 * 1000;

export function isWithinAdventureReportGrace(iso: string | null | undefined, now = Date.now()): boolean {
  if (!iso) return false;
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return false;
  return now - ts < ADVENTURE_REPORT_GRACE_MS;
}
