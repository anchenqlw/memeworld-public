import { routes } from '@vercel/config/v1';

const rawApiOrigin = process.env.VERCEL_API_ORIGIN;

if (!rawApiOrigin) {
  throw new Error('VERCEL_API_ORIGIN is required for Vercel builds');
}

const apiOrigin = new URL(rawApiOrigin);
const isRailwayHttpsOrigin =
  apiOrigin.protocol === 'https:' &&
  apiOrigin.hostname.endsWith('.up.railway.app') &&
  apiOrigin.pathname === '/' &&
  !apiOrigin.username &&
  !apiOrigin.password &&
  !apiOrigin.search &&
  !apiOrigin.hash;

if (!isRailwayHttpsOrigin) {
  throw new Error('VERCEL_API_ORIGIN must be an HTTPS Railway service origin without path, query, hash, or credentials');
}

export const config = {
  framework: 'vite',
  git: {
    deploymentEnabled: {
      main: false,
      'evo/m5-production-rollout': false,
    },
  },
  ignoreCommand: 'case "$VERCEL_GIT_COMMIT_MESSAGE" in *"[vercel skip]"*) exit 0;; *) exit 1;; esac',
  rewrites: [
    routes.rewrite('/api/:path*', `${apiOrigin.origin}/api/:path*`),
    routes.rewrite('/healthz', `${apiOrigin.origin}/healthz`),
    routes.rewrite('/(.*)', '/index.html'),
  ],
};
