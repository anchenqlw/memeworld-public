import type { FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { v4 as uuid } from 'uuid';
import { consumeRateLimit } from '../infrastructure/redis.js';

type OAuthProvider = 'google' | 'github';
type OAuthProfile = {
  providerUserId: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
};

export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  if (!req.session.userId) {
    return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: '请先登录' } });
  }
}

export function registerAuthRoutes(app: import('fastify').FastifyInstance) {
  app.get('/api/v1/auth/login', async (req, reply) => {
    if (config.authMode !== 'mock') {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: '请使用 OAuth 登录' } });
    }
    return loginMock(req, reply);
  });

  app.get('/api/v1/auth/:provider/login', async (req, reply) => {
    const provider = parseProvider((req.params as { provider?: string }).provider);
    if (!provider) return reply.status(404).send({ error: { code: 'UNKNOWN_PROVIDER', message: '不支持的登录方式' } });
    if (!await consumeRateLimit('oauth-login', req.ip, 20, 10 * 60_000)) {
      return reply.status(429).send({ error: { code: 'RATE_LIMIT', message: '登录请求过于频繁，请稍后再试' } });
    }
    if (config.authMode === 'mock') return loginMock(req, reply);

    const oauth = config.oauth[provider];
    if (!oauth.clientId || !oauth.clientSecret) {
      req.log.error({ provider }, 'OAuth provider is not configured');
      return reply.status(503).send({ error: { code: 'OAUTH_UNAVAILABLE', message: '该登录方式暂不可用' } });
    }

    const state = crypto.randomBytes(32).toString('base64url');
    const codeVerifier = crypto.randomBytes(48).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const next = safeNext((req.query as { next?: string }).next);
    req.session.oauthState = state;
    req.session.oauthCodeVerifier = codeVerifier;
    req.session.oauthProvider = provider;
    req.session.oauthNext = next;
    await req.session.save();

    const authorizationUrl = buildAuthorizationUrl(provider, {
      clientId: oauth.clientId,
      callbackUrl: oauth.callbackUrl,
      state,
      codeChallenge,
    });
    return reply.redirect(authorizationUrl);
  });

  app.get('/api/v1/auth/:provider/callback', async (req, reply) => {
    const provider = parseProvider((req.params as { provider?: string }).provider);
    const query = req.query as { code?: string; state?: string; error?: string };
    if (!provider || provider !== req.session.oauthProvider || !query.state || query.state !== req.session.oauthState) {
      clearOAuthSession(req);
      return redirectAuthError(reply, 'INVALID_OAUTH_STATE');
    }
    if (query.error || !query.code || !req.session.oauthCodeVerifier) {
      clearOAuthSession(req);
      return redirectAuthError(reply, 'OAUTH_DENIED');
    }

    const next = req.session.oauthNext || '/';
    const codeVerifier = req.session.oauthCodeVerifier;
    clearOAuthSession(req);
    try {
      const profile = await fetchOAuthProfile(provider, query.code, codeVerifier);
      const userId = await upsertOAuthUser(provider, profile);
      req.session.userId = userId;
      await req.session.regenerate();
      req.session.userId = userId;
      await req.session.save();
      return reply.redirect(`${config.corsOrigin}${next}`);
    } catch (error) {
      req.log.error({ err: error, provider }, 'OAuth callback failed');
      return redirectAuthError(reply, 'OAUTH_FAILED');
    }
  });

  app.post('/api/v1/auth/logout', async (req, reply) => {
    await req.session.destroy();
    return reply.send({ ok: true });
  });

  app.get('/api/v1/auth/me', async (req, reply) => {
    if (!req.session.userId) {
      return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: '未登录' } });
    }
    const user = await db.selectFrom('users').select(['provider', 'display_name', 'email', 'avatar_url'])
      .where('id', '=', req.session.userId).executeTakeFirst();
    if (!user) return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: '用户不存在' } });
    return reply.send({
      provider: user.provider,
      display_name: user.display_name,
      email: maskEmail(user.email),
      avatar_url: user.avatar_url,
    });
  });
}

async function loginMock(req: FastifyRequest, reply: FastifyReply) {
  const query = req.query as { json?: string; next?: string; fresh?: string; nonce?: string };
  const fresh = query.fresh === '1';
  const freshId = query.nonce?.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || String(Date.now());
  const providerUserId = fresh ? `mock_dev_user_${freshId}` : 'mock_dev_user';
  const displayName = fresh ? `访客${freshId.slice(-4)}` : '测试用户';
  let user = await db.selectFrom('users').select('id').where('provider', '=', 'mock')
    .where('provider_user_id', '=', providerUserId).executeTakeFirst();
  if (!user) {
    const userId = uuid();
    await db.insertInto('users').values({
      id: userId, provider: 'mock', provider_user_id: providerUserId, buc_id: providerUserId,
      display_name: displayName, email: fresh ? `${providerUserId}@meme.local` : 'dev@meme.local',
    }).execute();
    user = { id: userId };
  }
  req.session.userId = user.id;
  await req.session.save();
  const accept = req.headers.accept || '';
  if (accept.includes('application/json') || query.json === '1') {
    return reply.send({ ok: true, display_name: displayName });
  }
  return reply.redirect(`${config.corsOrigin}${safeNext(query.next)}`);
}

function parseProvider(value?: string): OAuthProvider | null {
  return value === 'google' || value === 'github' ? value : null;
}

function safeNext(value?: string): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

function clearOAuthSession(req: FastifyRequest) {
  delete req.session.oauthState;
  delete req.session.oauthCodeVerifier;
  delete req.session.oauthProvider;
  delete req.session.oauthNext;
}

// OAuth 回调是浏览器顶层导航：错误必须 302 回前端展示，直接 send JSON 会让用户看到裸 JSON（backlog #055）。
function redirectAuthError(reply: FastifyReply, code: 'INVALID_OAUTH_STATE' | 'OAUTH_DENIED' | 'OAUTH_FAILED') {
  return reply.redirect(`${config.corsOrigin}/?auth_error=${code}`);
}

function buildAuthorizationUrl(
  provider: OAuthProvider,
  params: { clientId: string; callbackUrl: string; state: string; codeChallenge: string }
) {
  const url = new URL(
    provider === 'google' ? 'https://accounts.google.com/o/oauth2/v2/auth' : 'https://github.com/login/oauth/authorize'
  );
  url.search = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.callbackUrl,
    response_type: 'code',
    scope: provider === 'google' ? 'openid profile email' : 'read:user user:email',
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

async function fetchOAuthProfile(provider: OAuthProvider, code: string, codeVerifier: string): Promise<OAuthProfile> {
  const oauth = config.oauth[provider];
  const tokenUrl =
    provider === 'google' ? 'https://oauth2.googleapis.com/token' : 'https://github.com/login/oauth/access_token';
  const tokenResponse = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: oauth.clientId,
      client_secret: oauth.clientSecret,
      code,
      redirect_uri: oauth.callbackUrl,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }),
  });
  if (!tokenResponse.ok) throw new Error(`OAuth token exchange failed (${tokenResponse.status})`);
  const token = (await tokenResponse.json()) as { access_token?: string };
  if (!token.access_token) throw new Error('OAuth provider returned no access token');

  return provider === 'google' ? fetchGoogleProfile(token.access_token) : fetchGitHubProfile(token.access_token);
}

async function fetchGoogleProfile(accessToken: string): Promise<OAuthProfile> {
  const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`Google userinfo failed (${response.status})`);
  const profile = (await response.json()) as { sub: string; name?: string; email?: string; picture?: string };
  return {
    providerUserId: profile.sub,
    displayName: profile.name || profile.email?.split('@')[0] || 'Google 用户',
    email: profile.email || null,
    avatarUrl: profile.picture || null,
  };
}

async function fetchGitHubProfile(accessToken: string): Promise<OAuthProfile> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'meme-cloud-cat',
  };
  const response = await fetch('https://api.github.com/user', { headers });
  if (!response.ok) throw new Error(`GitHub userinfo failed (${response.status})`);
  const profile = (await response.json()) as {
    id: number;
    login: string;
    name?: string;
    email?: string | null;
    avatar_url?: string;
  };
  let email = profile.email || null;
  if (!email) {
    const emailsResponse = await fetch('https://api.github.com/user/emails', { headers });
    if (emailsResponse.ok) {
      const emails = (await emailsResponse.json()) as Array<{
        email: string;
        primary: boolean;
        verified: boolean;
      }>;
      email = emails.find((item) => item.primary && item.verified)?.email || null;
    }
  }
  return {
    providerUserId: String(profile.id),
    displayName: profile.name || profile.login,
    email,
    avatarUrl: profile.avatar_url || null,
  };
}

async function upsertOAuthUser(provider: OAuthProvider, profile: OAuthProfile): Promise<string> {
  const existing = await db.selectFrom('users').select('id').where('provider', '=', provider)
    .where('provider_user_id', '=', profile.providerUserId).executeTakeFirst();
  if (existing) {
    await db.updateTable('users').set({
      display_name: profile.displayName, email: profile.email, avatar_url: profile.avatarUrl,
      updated_at: new Date().toISOString(),
    }).where('id', '=', existing.id).execute();
    return existing.id;
  }
  const id = uuid();
  await db.insertInto('users').values({
    id, provider, provider_user_id: profile.providerUserId, buc_id: `${provider}:${profile.providerUserId}`,
    display_name: profile.displayName, email: profile.email, avatar_url: profile.avatarUrl,
  }).execute();
  return id;
}

function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const [local, domain] = email.split('@');
  if (!domain) return null;
  return `${local.slice(0, 2)}***@${domain}`;
}
