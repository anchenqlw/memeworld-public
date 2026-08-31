import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** monorepo 根目录 .env（npm -w 时 cwd 在 apps/server，默认 dotenv 读不到） */
const repoEnv = path.resolve(__dirname, '../../../.env');
dotenv.config({ path: repoEnv });
dotenv.config(); // 本地覆盖
