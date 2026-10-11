// Usage: npm run seed:demo [-- --clear]
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../app.ts';
import { loadConfig } from '../config.ts';
import { clearDemo, hasDemoData, seedDemo } from './seed.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cfg = loadConfig(root);
const app = createApp({ dbPath: join(cfg.dataDir, 'board.db'), tz: cfg.timezone });
if (process.argv.includes('--clear')) console.log(`Removed ${clearDemo(app.ctx)} demo jobs.`);
else if (hasDemoData(app.ctx)) console.log('Demo data already present (use --clear to remove it).');
else console.log(`Created ${seedDemo(app.ctx)} demo jobs.`);
app.ctx.db.close();
