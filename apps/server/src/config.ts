import './loadEnv.js';

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  releaseSha: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || '',
  databasePath: process.env.DATABASE_PATH || './data/meme.db',
  dbDialect: (process.env.DB_DIALECT || (process.env.DATABASE_URL ? 'postgres' : 'sqlite')) as 'sqlite' | 'postgres',
  databaseUrl: process.env.DATABASE_URL || '',
  migrationDatabaseUrl: process.env.MIGRATION_DATABASE_URL || '',
  runMigrationsOnStartup: process.env.RUN_MIGRATIONS_ON_STARTUP !== 'false',
  databasePoolSize: parseInt(process.env.DATABASE_POOL_SIZE || '10', 10),
  databaseSsl: process.env.DATABASE_SSL === 'true',
  trustProxy: process.env.TRUST_PROXY === 'true',
  sessionSecret: process.env.SESSION_SECRET || 'dev-session-secret-must-be-32-chars-min!!',
  patEncryptionKey: process.env.PAT_ENCRYPTION_KEY || '',
  internalApiKey: process.env.INTERNAL_API_KEY || 'dev-internal-key',
  evolution: {
    enabled: process.env.EVOLUTION_CONTROL_PLANE_ENABLED === 'true',
    triagePolicyVersion: process.env.EVOLUTION_TRIAGE_POLICY_VERSION || 'triage-v1',
    standingDraftPolicyVersion: process.env.EVOLUTION_STANDING_DRAFT_POLICY_VERSION || 'standing-draft-v1',
    reviewPolicyVersion: process.env.EVOLUTION_REVIEW_POLICY_VERSION || 'review-v1',
    developmentMaxConcurrency: Number(process.env.EVOLUTION_DEVELOPMENT_MAX_CONCURRENCY || 1),
    feedbackReadToken: process.env.EVOLUTION_FEEDBACK_READ_TOKEN || '',
    feedbackWriteToken: process.env.EVOLUTION_FEEDBACK_WRITE_TOKEN || '',
    triageToken: process.env.EVOLUTION_TRIAGE_TOKEN || '',
    controlToken: process.env.EVOLUTION_CONTROL_TOKEN || '',
    developmentToken: process.env.EVOLUTION_DEVELOPMENT_TOKEN || '',
    reviewToken: process.env.EVOLUTION_REVIEW_TOKEN || '',
    orchestratorToken: process.env.EVOLUTION_ORCHESTRATOR_TOKEN || '',
    releaseToken: process.env.EVOLUTION_RELEASE_TOKEN || '',
    monitorToken: process.env.EVOLUTION_MONITOR_TOKEN || '',
    alertToken: process.env.EVOLUTION_ALERT_TOKEN || '',
    ownerApprovalToken: process.env.EVOLUTION_OWNER_APPROVAL_TOKEN || '',
  },
  authMode: (process.env.AUTH_MODE || 'mock') as 'mock' | 'oauth',
  oauth: {
    google: {
      clientId: process.env.GOOGLE_OAUTH_CLIENT_ID || '',
      clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || '',
      callbackUrl:
        process.env.GOOGLE_OAUTH_CALLBACK_URL || 'http://localhost:3001/api/v1/auth/google/callback',
    },
    github: {
      clientId: process.env.GITHUB_OAUTH_CLIENT_ID || '',
      clientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET || '',
      callbackUrl:
        process.env.GITHUB_OAUTH_CALLBACK_URL || 'http://localhost:3001/api/v1/auth/github/callback',
    },
  },
  qcaMock: process.env.QCA_MOCK !== 'false',
  qcaApiBase: process.env.QCA_API_BASE || 'https://api.qoder.com/api/v1/cloud',
  qcaAgentModel: process.env.QCA_AGENT_MODEL || '',
  qcaChatTimeoutMs: parseInt(process.env.QCA_CHAT_TIMEOUT_MS || '60000', 10),
  serverPublicUrl: process.env.SERVER_PUBLIC_URL || 'http://localhost:3001',
  catApiPublicUrl: process.env.CAT_API_PUBLIC_URL || process.env.SERVER_PUBLIC_URL || 'http://localhost:3001',
  repoRoot: process.env.REPO_ROOT || new URL('../../../', import.meta.url).pathname,
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  catImagesDir: process.env.CAT_IMAGES_DIR || './data/cat-images',
  redisDriver: (process.env.REDIS_DRIVER || 'memory') as 'memory' | 'redis',
  redisUrl: process.env.REDIS_URL || '',
  redisNamespace: process.env.REDIS_NAMESPACE || `meme:${process.env.NODE_ENV || 'development'}`,
  storageDriver: (process.env.STORAGE_DRIVER || 'local') as 'local' | 'oss' | 'r2',
  oss: {
    endpoint: process.env.OSS_ENDPOINT || '',
    region: process.env.OSS_REGION || '',
    bucket: process.env.OSS_BUCKET || '',
    accessKeyId: process.env.OSS_ACCESS_KEY_ID || '',
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET || '',
    stsToken: process.env.OSS_STS_TOKEN || '',
  },
  /** Cloudflare R2（ADR-0068 §决策 3）。endpoint 由 account id 推导，region 固定 auto。 */
  r2: {
    accountId: process.env.R2_ACCOUNT_ID || '',
    bucket: process.env.R2_BUCKET || '',
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
  },
  /**
   * 迁移期双读回落（ADR-0068 §决策 4）：R2 读未命中时回落读 OSS 并计数。
   * 切换验收口径是「观察窗内回落命中数为 0」，达标后关闭本开关并摘除 OSS 凭据。
   */
  legacyOssFallback: process.env.LEGACY_OSS_FALLBACK === 'true',
  imageWorker: {
    enabled: process.env.IMAGE_WORKER_ENABLED !== 'false',
    pollIntervalMs: parseInt(process.env.IMAGE_WORKER_POLL_INTERVAL_MS || '1000', 10),
    runningTimeoutMs: parseInt(process.env.IMAGE_WORKER_RUNNING_TIMEOUT_MS || '900000', 10),
    sessionTimeoutMs: parseInt(process.env.IMAGE_SESSION_TIMEOUT_MS || '300000', 10),
    maxAttempts: parseInt(process.env.IMAGE_WORKER_MAX_ATTEMPTS || '3', 10),
  },
  travelScheduler: {
    pollIntervalMs: parseInt(process.env.TRAVEL_SCHEDULER_POLL_INTERVAL_MS || '60000', 10),
  },
  get qcaForwardTravel() {
    return process.env.QCA_FORWARD_TRAVEL === 'true';
  },
  get qcaForwardImChannel() {
    return process.env.QCA_FORWARD_IM_CHANNEL === 'true';
  },
};

/** Forward 模式下默认关闭自研 scheduler，除非显式 TRAVEL_SCHEDULER_ENABLED=true */
export function isTravelSchedulerEnabled() {
  if (process.env.QCA_FORWARD_TRAVEL === 'true') {
    return process.env.TRAVEL_SCHEDULER_ENABLED === 'true';
  }
  return process.env.TRAVEL_SCHEDULER_ENABLED !== 'false';
}

export function assertConfig() {
  const errors: string[] = [];
  if (!['memory', 'redis'].includes(config.redisDriver)) errors.push('REDIS_DRIVER must be memory or redis');
  if (config.redisDriver === 'redis' && !/^rediss?:\/\//.test(config.redisUrl)) {
    errors.push('REDIS_URL must be a Redis connection URL when REDIS_DRIVER=redis');
  }
  if (!['local', 'oss', 'r2'].includes(config.storageDriver)) errors.push('STORAGE_DRIVER must be local, oss or r2');
  const ossRequired = config.storageDriver === 'oss' || (config.storageDriver === 'r2' && config.legacyOssFallback);
  if (ossRequired) {
    const because = config.storageDriver === 'oss' ? 'STORAGE_DRIVER=oss' : 'LEGACY_OSS_FALLBACK=true';
    for (const [name, value] of [
      ['OSS_ENDPOINT', config.oss.endpoint],
      ['OSS_REGION', config.oss.region],
      ['OSS_BUCKET', config.oss.bucket],
      ['OSS_ACCESS_KEY_ID', config.oss.accessKeyId],
      ['OSS_ACCESS_KEY_SECRET', config.oss.accessKeySecret],
    ] as const) {
      if (!value) errors.push(`${name} is required when ${because}`);
    }
    if (config.oss.endpoint.includes('-internal.aliyuncs.com') && config.nodeEnv !== 'test') {
      errors.push('OSS_ENDPOINT must use the public oss-<region>.aliyuncs.com endpoint outside Aliyun VPC');
    }
  }
  if (config.storageDriver === 'r2') {
    for (const [name, value] of [
      ['R2_ACCOUNT_ID', config.r2.accountId],
      ['R2_BUCKET', config.r2.bucket],
      ['R2_ACCESS_KEY_ID', config.r2.accessKeyId],
      ['R2_SECRET_ACCESS_KEY', config.r2.secretAccessKey],
    ] as const) {
      if (!value) errors.push(`${name} is required when STORAGE_DRIVER=r2`);
    }
  }
  if (!Number.isInteger(config.qcaChatTimeoutMs) || config.qcaChatTimeoutMs < 1000 || config.qcaChatTimeoutMs > 300000) {
    errors.push('QCA_CHAT_TIMEOUT_MS must be an integer between 1000 and 300000');
  }
  if (errors.length > 0) {
    throw new Error(`Invalid configuration:\n- ${errors.join('\n- ')}`);
  }
  if (config.nodeEnv !== 'production' && config.nodeEnv !== 'staging') return;

  if (!/^[0-9a-fA-F]{64}$/.test(config.patEncryptionKey)) {
    errors.push('PAT_ENCRYPTION_KEY must be exactly 64 hex chars (32 bytes)');
  }
  if (config.sessionSecret === 'dev-session-secret-must-be-32-chars-min!!' || config.sessionSecret.length < 32) {
    errors.push('SESSION_SECRET must be a non-default value of at least 32 characters');
  }
  if (config.internalApiKey === 'dev-internal-key' || config.internalApiKey.length < 32) {
    errors.push('INTERNAL_API_KEY must be a non-default value of at least 32 characters');
  }
  if (config.authMode === 'mock') {
    errors.push('AUTH_MODE=mock is forbidden in production');
  }
  if (config.dbDialect !== 'postgres') {
    errors.push('DB_DIALECT=postgres is required in production; SQLite fallback is forbidden');
  }
  if (!/^postgres(ql)?:\/\//.test(config.databaseUrl)) {
    errors.push('DATABASE_URL must be a PostgreSQL connection URL in production');
  }
  if (config.runMigrationsOnStartup) {
    errors.push('RUN_MIGRATIONS_ON_STARTUP=false is required in staging/production');
  }
  if (!config.databaseSsl) {
    errors.push('DATABASE_SSL=true is required in staging/production');
  }
  if (!config.trustProxy) {
    errors.push('TRUST_PROXY=true is required behind the staging/production reverse proxy');
  }
  if (config.redisDriver !== 'redis' || !config.redisUrl) {
    errors.push('REDIS_DRIVER=redis and REDIS_URL are required in staging/production');
  }
  if (!['oss', 'r2'].includes(config.storageDriver)) {
    errors.push('STORAGE_DRIVER=oss or r2 is required in staging/production');
  }
  for (const [provider, oauth] of Object.entries(config.oauth)) {
    if (!oauth.clientId || !oauth.clientSecret) {
      errors.push(`${provider.toUpperCase()} OAuth client credentials are required`);
    }
    if (!oauth.callbackUrl.startsWith('https://')) {
      errors.push(`${provider.toUpperCase()} OAuth callback URL must use https`);
    }
  }
  if (config.qcaMock) {
    errors.push('QCA_MOCK=true is forbidden in production');
  }
  if (config.evolution.enabled) {
    const scopedTokens = [
      ['EVOLUTION_FEEDBACK_READ_TOKEN', config.evolution.feedbackReadToken],
      ['EVOLUTION_FEEDBACK_WRITE_TOKEN', config.evolution.feedbackWriteToken],
      ['EVOLUTION_TRIAGE_TOKEN', config.evolution.triageToken],
      ['EVOLUTION_CONTROL_TOKEN', config.evolution.controlToken],
      ['EVOLUTION_DEVELOPMENT_TOKEN', config.evolution.developmentToken],
      ['EVOLUTION_REVIEW_TOKEN', config.evolution.reviewToken],
      ['EVOLUTION_ORCHESTRATOR_TOKEN', config.evolution.orchestratorToken],
      ['EVOLUTION_RELEASE_TOKEN', config.evolution.releaseToken],
      ['EVOLUTION_MONITOR_TOKEN', config.evolution.monitorToken],
      ['EVOLUTION_ALERT_TOKEN', config.evolution.alertToken],
      ['EVOLUTION_OWNER_APPROVAL_TOKEN', config.evolution.ownerApprovalToken],
    ] as const;
    for (const [name, value] of scopedTokens) {
      if (value.length < 32) errors.push(`${name} must be at least 32 characters when evolution control plane is enabled`);
    }
    if (new Set(scopedTokens.map(([, value]) => value)).size !== scopedTokens.length) {
      errors.push('Evolution scoped tokens must be distinct');
    }
    if (!config.evolution.triagePolicyVersion.trim() || !config.evolution.standingDraftPolicyVersion.trim() ||
      !config.evolution.reviewPolicyVersion.trim()) {
      errors.push('Evolution triage, standing Draft and review policy versions must be non-empty');
    }
    if (![1, 2].includes(config.evolution.developmentMaxConcurrency)) {
      errors.push('EVOLUTION_DEVELOPMENT_MAX_CONCURRENCY must be 1 or 2');
    }
  }
  for (const [name, value] of [
    ['SERVER_PUBLIC_URL', config.serverPublicUrl],
    ['CAT_API_PUBLIC_URL', config.catApiPublicUrl],
    ['CORS_ORIGIN', config.corsOrigin],
  ] as const) {
    if (!value.startsWith('https://')) errors.push(`${name} must use https in production`);
  }
  if (errors.length > 0) {
    throw new Error(`Invalid production configuration:\n- ${errors.join('\n- ')}`);
  }
}
