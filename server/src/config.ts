// Configuration: defaults ← config.json (next to the app) ← environment variables.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  timezone: string;
  backupDir: string;
  backupKeepDays: number;
}

export function loadConfig(appRoot: string): Config {
  const file = join(appRoot, 'config.json');
  let fromFile: Partial<Config> = {};
  if (existsSync(file)) {
    try {
      fromFile = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`config.json is not valid JSON: ${(e as Error).message}`);
    }
  }
  const env = process.env;
  const dataDir = resolve(appRoot, env.EB_DATA_DIR ?? fromFile.dataDir ?? 'data');
  const cfg: Config = {
    port: Number(env.EB_PORT ?? fromFile.port ?? 8080),
    host: env.EB_HOST ?? fromFile.host ?? '0.0.0.0',
    dataDir,
    timezone: env.EB_TIMEZONE ?? fromFile.timezone ?? 'Asia/Kolkata',
    backupDir: resolve(appRoot, env.EB_BACKUP_DIR ?? fromFile.backupDir ?? join(dataDir, 'backups')),
    backupKeepDays: Number(env.EB_BACKUP_KEEP_DAYS ?? fromFile.backupKeepDays ?? 30),
  };
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) throw new Error(`Invalid port: ${cfg.port}`);
  try {
    new Intl.DateTimeFormat('en', { timeZone: cfg.timezone });
  } catch {
    throw new Error(`Unknown timezone "${cfg.timezone}" (use an IANA name like Asia/Kolkata)`);
  }
  return cfg;
}
