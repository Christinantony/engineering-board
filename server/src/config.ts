// Configuration: defaults ← config.json (next to the app folder) ← environment variables.
//
// config.json is edited by hand in Notepad, so this is forgiving where it is
// safe to be (a UTF-8 BOM, "_comment" keys) and explains every mistake in plain
// words instead of failing with a JSON parser message.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  timezone: string;
  backupDir: string;
  backupKeepDays: number;
  restoreUploadMaxMB: number;
  hoursPerDay: number;
  workingDays: number[];
}

export interface LoadedConfig extends Config {
  /** Full path of the config.json that was read, or null when there is none (all defaults). */
  file: string | null;
  /** Things worth telling the person who starts the board (unknown settings, for example). */
  warnings: string[];
}

const KNOWN = ['port', 'host', 'dataDir', 'timezone', 'backupDir', 'backupKeepDays', 'restoreUploadMaxMB', 'hoursPerDay', 'workingDays'] as const;

function readConfigFile(file: string): Record<string, unknown> {
  // Notepad saves "UTF-8" with a byte-order mark; JSON.parse does not accept one.
  const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const msg = (e as Error).message;
    const hint = /\\[^"\\/bfnrtu]|Bad escaped character|Bad control character/i.test(msg + text)
      ? '\n  Windows paths need forward slashes ("D:/Board/backups") or double backslashes ("D:\\\\Board\\\\backups").'
      : /Unexpected token|Expected/.test(msg)
        ? '\n  Check for a missing comma between settings, a comma after the last one, or a missing quote.'
        : '';
    throw new Error(`config.json could not be read: ${msg}${hint}\n  File: ${file}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`config.json must be a set of settings in { }.\n  File: ${file}`);
  return parsed as Record<string, unknown>;
}

export function loadConfig(appRoot: string, env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const path = join(appRoot, 'config.json');
  const file = existsSync(path) ? path : null;
  const fromFile = file ? readConfigFile(file) : {};
  const warnings: string[] = [];
  for (const key of Object.keys(fromFile)) {
    if (key.startsWith('_') || (KNOWN as readonly string[]).includes(key)) continue;
    const near = KNOWN.find((k) => k.toLowerCase() === key.toLowerCase());
    warnings.push(`config.json: "${key}" is not a setting the board knows, so it is ignored.${near ? ` Did you mean "${near}"?` : ''}`);
  }
  const f = fromFile as Partial<Record<(typeof KNOWN)[number], any>>;
  const problems: string[] = [];
  const num = (name: string, v: unknown, ok: (n: number) => boolean, rule: string): number => {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : (v as number);
    if (typeof n !== 'number' || !Number.isFinite(n) || !ok(n)) problems.push(`"${name}" is ${JSON.stringify(v)}; it must be ${rule}.`);
    return n;
  };
  const str = (name: string, v: unknown): string => {
    if (typeof v !== 'string' || v.trim() === '') problems.push(`"${name}" must be text in quotes.`);
    return String(v ?? '').trim();
  };

  const dataDir = resolve(appRoot, str('dataDir', env.EB_DATA_DIR ?? f.dataDir ?? 'data'));
  const cfg: Config = {
    port: num('port', env.EB_PORT ?? f.port ?? 8080, (n) => Number.isInteger(n) && n >= 1 && n <= 65535, 'a whole number from 1 to 65535'),
    host: str('host', env.EB_HOST ?? f.host ?? '0.0.0.0'),
    dataDir,
    timezone: str('timezone', env.EB_TIMEZONE ?? f.timezone ?? 'Asia/Kolkata'),
    backupDir: resolve(appRoot, str('backupDir', env.EB_BACKUP_DIR ?? f.backupDir ?? join(dataDir, 'backups'))),
    backupKeepDays: num('backupKeepDays', env.EB_BACKUP_KEEP_DAYS ?? f.backupKeepDays ?? 30, (n) => Number.isInteger(n) && n >= 1, 'a whole number of days, 1 or more'),
    restoreUploadMaxMB: num('restoreUploadMaxMB', env.EB_RESTORE_UPLOAD_MAX_MB ?? f.restoreUploadMaxMB ?? 64, (n) => Number.isInteger(n) && n >= 1 && n <= 1024, 'a whole number of MiB from 1 to 1024'),
    hoursPerDay: num('hoursPerDay', f.hoursPerDay ?? 8, (n) => n > 0 && n <= 24, 'a number of hours from 1 to 24'),
    // 0 = Sunday … 6 = Saturday. Default Monday to Saturday.
    workingDays: [1, 2, 3, 4, 5, 6],
  };
  if (f.workingDays !== undefined) {
    const ok = Array.isArray(f.workingDays) && f.workingDays.length > 0 && f.workingDays.every((d: unknown) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6);
    if (ok) cfg.workingDays = [...new Set<number>(f.workingDays)].sort((a, b) => a - b);
    else problems.push(`"workingDays" is ${JSON.stringify(f.workingDays)}; it must be a list of day numbers like [1, 2, 3, 4, 5] (0 is Sunday, 6 is Saturday).`);
  }
  if (cfg.timezone) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: cfg.timezone });
    } catch {
      problems.push(`"timezone" is "${cfg.timezone}", which is not a time zone name. Use a name like "Asia/Kolkata" or "Europe/London".`);
    }
  }
  if (problems.length) throw new Error(`Some settings are not right:\n  - ${problems.join('\n  - ')}${file ? `\n  File: ${file}` : ''}`);
  return { ...cfg, file, warnings };
}
