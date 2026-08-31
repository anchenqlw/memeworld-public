import sharp from 'sharp';
import { imageStorage } from './imageStorage.js';

/**
 * 猫图分发格式（ADR-0068 §决策 1/2）。
 *
 * PNG 母版是唯一事实源，q90 WebP 衍生图是唯一分发物。衍生 key 由母版 key 换扩展名推导，
 * 不落库——避开一次 production migration 审批（EVOLUTION.md §11 红线 2）。
 *
 * q90 + effort:6 的依据：50 张真实 QCA 出图实测平均 1703 KB → 202 KB（11.9%），SSIM 0.968。
 * effort 默认值 4 只能压到 217 KB，所以显式指定 6。
 */
export const WEBP_QUALITY = 90;
export const WEBP_EFFORT = 6;

/** 母版 key → WebP 兄弟 key；非 `.png` 结尾返回 null（只改结尾扩展名，对 local driver 拍平后的 key 同样成立）。 */
export function webpKeyFor(objectKey: string): string | null {
  if (!objectKey.toLowerCase().endsWith('.png')) return null;
  return `${objectKey.slice(0, -'.png'.length)}.webp`;
}

/** 编码 q90 WebP；失败返回 null——衍生图是可选优化，不能让它拖垮母版写入。 */
export async function encodeWebp(body: Buffer): Promise<Buffer | null> {
  try {
    return await sharp(body).webp({ quality: WEBP_QUALITY, effort: WEBP_EFFORT }).toBuffer();
  } catch (error) {
    console.warn(`[imageDerivative] WebP 编码失败，仅保留 PNG 母版：${(error as Error).message}`);
    return null;
  }
}

/**
 * 写入 WebP 衍生图。**非致命**：任何失败只记 warn，母版已经落盘，读路径会自动回落 PNG。
 * 传入的必须是 `put` 返回的 `objectKey`（local driver 会拍平斜杠），否则读路径推导不出同一个 key。
 */
export async function writeWebpDerivative(storedObjectKey: string, body: Buffer): Promise<void> {
  const webpKey = webpKeyFor(storedObjectKey);
  if (!webpKey) return;
  const webp = await encodeWebp(body);
  if (!webp) return;
  try {
    await imageStorage.put(webpKey, webp, 'image/webp');
  } catch (error) {
    console.warn(`[imageDerivative] WebP 衍生图写入失败 ${webpKey}：${(error as Error).message}`);
  }
}
