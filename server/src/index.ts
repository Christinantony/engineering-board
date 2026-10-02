// Entry point: node server.mjs  (or `npm start` in development)

import { networkInterfaces, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
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
  // Forgotten admin PIN: an empty file called RESET-ADMIN-PIN next to start.bat puts it back to
  // 1234 on the next start. Only someone who can reach the host PC's folder can do this.
  // (Windows hides extensions, so Notepad's RESET-ADMIN-PIN.txt counts too.)
  const resetFiles = ['RESET-ADMIN-PIN', 'RESET-ADMIN-PIN.txt'].map((n) => join(appRoot, n)).filter((p) => existsSync(p));
  const app = createApp({ dbPath: join(cfg.dataDir, 'board.db'), tz: cfg.timezone, webRoot,
    resetAdminPin: resetFiles.length > 0,
    workday: { hoursPerDay: cfg.hoursPerDay, workingDays: cfg.workingDays },
    log: process.env.EB_LOG === '1',
    backupDir: cfg.backupDir,
    backupKeepDays: cfg.backupKeepDays,
    restoreUploadMaxMB: cfg.restoreUploadMaxMB,
    reviewUploadMaxMB: cfg.reviewUploadMaxMB,
    autoBackup: true,
    reviewMaintenance: true,
  });

  for (const f of resetFiles) rmSync(f, { force: true });
  if (resetFiles.length) console.log('\n  The admin PIN has been reset to 1234. Change it now in Admin, Admin PIN.');

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

  const localOnly = /^(127\.|localhost$|::1$)/.test(cfg.host);
  // Local-only and container banners do not need interface discovery. Some
  // restricted hosts also forbid it; that must not prevent the board starting.
  const inContainer = existsSync('/.dockerenv') || existsSync('/run/.containerenv');
  let ips: string[] = [];
  if (!localOnly && !inContainer) {
    try {
      ips = Object.values(networkInterfaces()).flat()
        .filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n!.address);
    } catch {
      console.log('  LAN IP addresses could not be listed. Use the PC name shown below.');
    }
  }
  const team = localOnly
    ? `  For your team:     (nobody else: "host" in config.json is ${cfg.host}, which allows this PC only)`
    : inContainer
      ? `  For your team:     http://<this machine's name or IP>:<published port> (running in a container)`
      : [`  For your team:     http://${hostname()}:${port}`, ...ips.map((ip) => `                     http://${ip}:${port}`)].join('\n');
  console.log(`
  Engineering Board v${APP_VERSION}
  ─────────────────────────────────────────────
  On this PC:        http://localhost:${port}
${team}
  User guide:        http://localhost:${port}/guides/user-guide.html
  Data folder:       ${cfg.dataDir}
  Backups:           ${cfg.backupDir}
  Settings:          ${cfg.file ?? 'defaults (no config.json; see config.example.json)'}
  Time zone:         ${cfg.timezone}
${cfg.warnings.map((w) => `  ! ${w}\n`).join('')}  ${webRoot ? '' : '(web app not built yet: API only)\n  '}Keep this window open. Press Ctrl+C to stop.
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
