import { Redis } from 'ioredis';
import type { Session } from 'fastify';
import { config } from '../config.js';

type Callback<T = void> = (error?: Error | null, value?: T | null) => void;
type SessionStore = {
  get(sessionId: string, callback: Callback<Session>): void;
  set(sessionId: string, session: Session, callback: Callback): void;
  destroy(sessionId: string, callback: Callback): void;
};

let client: Redis | null = null;
const memoryCounters = new Map<string, { count: number; expiresAt: number }>();
const memorySessions = new Map<string, { value: Session; expiresAt: number }>();

function key(kind: string, value: string) {
  return `${config.redisNamespace}:${kind}:${value}`;
}

export async function initializeRedis() {
  if (config.redisDriver === 'memory') return;
  client = new Redis(config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
  });
  await client.connect();
  await client.ping();
}

export async function closeRedis() {
  if (!client) return;
  const current = client;
  client = null;
  await current.quit().catch(() => current.disconnect());
}

export async function checkRedis() {
  if (config.redisDriver === 'memory') return { driver: 'memory' as const };
  if (!client) throw new Error('Redis is not initialized');
  await client.ping();
  return { driver: 'redis' as const };
}

export async function consumeRateLimit(name: string, identity: string, limit: number, ttlMs: number) {
  const redisKey = key(`rate:${name}`, identity);
  if (config.redisDriver === 'redis') {
    if (!client) throw new Error('Redis is unavailable');
    const result = await client.eval(
      "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end; return n",
      1,
      redisKey,
      ttlMs
    );
    return Number(result) <= limit;
  }

  const now = Date.now();
  const current = memoryCounters.get(redisKey);
  if (!current || current.expiresAt <= now) {
    memoryCounters.set(redisKey, { count: 1, expiresAt: now + ttlMs });
    return true;
  }
  current.count += 1;
  return current.count <= limit;
}

function sessionTtl(session: Session) {
  const expires = session.cookie?.expires ? new Date(session.cookie.expires).getTime() - Date.now() : 0;
  return Math.max(1_000, expires || session.cookie?.maxAge || 7 * 24 * 60 * 60 * 1000);
}

export function createSessionStore(): SessionStore {
  return {
    get(sessionId, callback: Callback<Session>) {
      const redisKey = key('session', sessionId);
      if (config.redisDriver === 'redis') {
        if (!client) return callback(new Error('Redis is unavailable'));
        void client.get(redisKey)
          .then((value) => callback(null, value ? JSON.parse(value) as Session : null))
          .catch(callback);
        return;
      }
      const entry = memorySessions.get(redisKey);
      if (!entry || entry.expiresAt <= Date.now()) {
        memorySessions.delete(redisKey);
        callback(null, null);
        return;
      }
      callback(null, entry.value);
    },
    set(sessionId, session, callback: Callback) {
      const redisKey = key('session', sessionId);
      const ttl = sessionTtl(session);
      if (config.redisDriver === 'redis') {
        if (!client) return callback(new Error('Redis is unavailable'));
        void client.set(redisKey, JSON.stringify(session), 'PX', ttl).then(() => callback(null)).catch(callback);
        return;
      }
      memorySessions.set(redisKey, { value: session, expiresAt: Date.now() + ttl });
      callback(null);
    },
    destroy(sessionId, callback: Callback) {
      const redisKey = key('session', sessionId);
      if (config.redisDriver === 'redis') {
        if (!client) return callback(new Error('Redis is unavailable'));
        void client.del(redisKey).then(() => callback(null)).catch(callback);
        return;
      }
      memorySessions.delete(redisKey);
      callback(null);
    },
  };
}
