/** 非 production 环境角标，避免 staging / 本地与正式环境混淆 */
const LABELS: Record<string, string> = {
  development: 'LOCAL',
  staging: 'STAGING',
  test: 'TEST',
};

export function EnvBadge({ env }: { env: string }) {
  if (env === 'production') return null;
  const label = LABELS[env] ?? env.toUpperCase();
  return (
    <div className="env-badge" aria-label={`运行环境：${label}`} title={`当前后端环境：${env}`}>
      {label}
    </div>
  );
}
