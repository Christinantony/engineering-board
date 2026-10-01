// Entry point: node server.mjs  (or `npm start` in development)

import { networkInterfaces, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp, APP_VERSION } from './app.ts';
import { loadConfig } from './config.ts';

// In the packaged build this file sits in <app>/app/server.mjs; in dev, in server/src.
const here = dirname(fileURLToPath(import.meta.url));
const appRoot = process.env.EB_APP_ROOT
  ? resolve(process.env.EB_APP_ROOT)
  : existsSync(join(here, '..', 'config.json')) || here.endsWith('app')
    ? resolve(here, '..')
    : resolve(here, '..', '..');

async function main() {
  const cfg = loadConfig(appRoot);
  const webRoot = [join(appRoot, 'app', 'web'), join(appRoot, 'dist', 'app', 'web')].find((p) => existsSync(p));
  const app = createApp({ dbPath: join(cfg.dataDir, 'board.db'), tz: cfg.timezone, webRoot, log: process.env.EB_LOG === '1' });

  let port: number;
  try {
    port = await app.listen(cfg.port, cfg.host);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'EADDRINUSE') {
      console.error(`\nPort ${cfg.port} is already in use. Is the board already running?\nChange "port" in config.json if another program needs it.\n`);
      process.exit(1);
    }
    throw e;
  }

  const ips = Object.values(networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n!.address);
  console.log(`
  Engineering Board v${APP_VERSION}
  ─────────────────────────────────────────────
  On this PC:        http://localhost:${port}
  For your team:     http://${hostname()}:${port}
${ips.map((ip) => `                     http://${ip}:${port}`).join('\n')}
  Data folder:       ${cfg.dataDir}
  Time zone:         ${cfg.timezone}
  ${webRoot ? '' : '(web app not built yet — API only)\n  '}Keep this window open. Press Ctrl+C to stop.
`);

  const shutdown = async (sig: string) => {
    console.log(`\n${sig} received — shutting down cleanly…`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error('\nThe board could not start:\n ', e instanceof Error ? e.message : e, '\n');
  process.exit(1);
});
