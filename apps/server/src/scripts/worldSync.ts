import { closeDatabase, runMigrations } from '../db/index.js';
import { syncWorldFromRepo } from '../services/worldSync.js';

try {
  await runMigrations();
  const result = await syncWorldFromRepo();
  console.log('Synced:', result);
} finally {
  await closeDatabase();
}
