import './loadEnv.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import session from '@fastify/session';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { config, assertConfig } from './config.js';
import { runMigrations } from './db/index.js';
import { syncWorldFromRepo } from './services/worldSync.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerApiRoutes } from './routes/api.js';
import { registerEvolutionRoutes } from './routes/evolution.js';
import { closeRedis, createSessionStore, initializeRedis } from './infrastructure/redis.js';
import { startImageWorker, stopImageWorker } from './services/imageJobService.js';
import { startTravelScheduler, stopTravelScheduler } from './services/travelScheduler.js';
import { pauseLegacyTravelSchedules } from './services/catService.js';
import { startChatWorker, stopChatWorker } from './services/chatTurnService.js';

export async function buildApp() {
  assertConfig();
  if (config.runMigrationsOnStartup) {
    await runMigrations();
  }
  await initializeRedis();

  const app = Fastify({
    logger: config.nodeEnv !== 'test',
    trustProxy: config.trustProxy,
  });

  await pauseLegacyTravelSchedules(app.log);

  try {
    await syncWorldFromRepo();
    app.log.info('World data synced from repo.');
  } catch (error) {
    app.log.warn({ err: error }, 'World sync skipped');
  }

  await app.register(cors, {
    origin: config.corsOrigin,
    credentials: true,
  });
  await app.register(cookie);
  await app.register(session, {
    secret: config.sessionSecret,
    store: createSessionStore(),
    cookie: {
      secure: config.nodeEnv === 'production' || config.nodeEnv === 'staging',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  });

  registerAuthRoutes(app);
  registerApiRoutes(app);
  registerEvolutionRoutes(app);

  if (config.storageDriver === 'local') {
    if (!fs.existsSync(config.catImagesDir)) fs.mkdirSync(config.catImagesDir, { recursive: true });
    await app.register(fastifyStatic, {
      root: path.resolve(config.catImagesDir),
      prefix: '/static/cats/',
      decorateReply: false,
    });
  }

  await startImageWorker(app.log);
  await startChatWorker(app.log);
  startTravelScheduler(app.log);
  app.addHook('onClose', async () => {
    stopTravelScheduler();
    await stopChatWorker();
    await stopImageWorker();
    await closeRedis();
  });

  return app;
}
