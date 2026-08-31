import './loadEnv.js';
import { config } from './config.js';
import { closeDatabase } from './db/index.js';
import { buildApp } from './app.js';

const app = await buildApp();
const address = await app.listen({ port: config.port, host: '0.0.0.0' });
app.log.info(`Me&Me server listening at ${address} (QCA_MOCK=${config.qcaMock}, IMAGE=QCA)`);

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'graceful shutdown started');
  const forceExit = setTimeout(() => {
    app.log.error('graceful shutdown timed out');
    process.exit(1);
  }, 10_000);
  forceExit.unref();
  try {
    await app.close();
    await closeDatabase();
    clearTimeout(forceExit);
    app.log.info('graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    app.log.error(error, 'graceful shutdown failed');
    process.exit(1);
  }
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
