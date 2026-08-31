/** QCA 资源名 / Idempotency-Key 仅允许 ASCII，中文猫名需转 slug */
export function qcaAsciiSlug(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}
