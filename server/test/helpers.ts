import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type App } from '../src/app.ts';
import { run, type Db } from '../src/db/connection.ts';

/** A controllable clock. Default: 2026-10-01 10:00 IST (04:30Z). */
export class Clock {
  t: number;
  constructor(iso = '2026-10-01T04:30:00.000Z') {
    this.t = Date.parse(iso);
  }
  now = () => new Date(this.t);
  set(iso: string) {
    this.t = Date.parse(iso);
  }
  advance(ms: number) {
    this.t += ms;
  }
}

export interface Harness {
  app: App;
  base: string;
  dir: string;
  dbPath: string;
  clock: Clock;
  as(userName: string): Promise<Client>;
  restart(): Promise<void>;
  close(): Promise<void>;
}

export class Client {
  cookies = new Map<string, string>();
  constructor(public base: string) {}
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i);
      const v = pair.slice(i + 1);
      if (/Max-Age=0/.test(sc)) this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, body: json };
  }
  get = (p: string) => this.req('GET', p);
  post = (p: string, b: unknown = {}, h?: Record<string, string>) => this.req('POST', p, b, h);
  patch = (p: string, b: unknown) => this.req('PATCH', p, b);
  put = (p: string, b: unknown) => this.req('PUT', p, b);
  del = (p: string) => this.req('DELETE', p);

  /** Create a ticket and return it (asserts success). */
  async create(fields: Record<string, unknown>) {
    const r = await this.post('/api/tickets', fields);
    if (r.status !== 201) throw new Error(`create failed: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.ticket;
  }
}

export async function startHarness(clock = new Clock()): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'eb-test-'));
  const dbPath = join(dir, 'board.db');
  const h: Harness = {
    app: undefined as unknown as App,
    base: '',
    dir,
    dbPath,
    clock,
    async as(name) {
      const c = new Client(h.base);
      const users = (await c.get('/api/users')).body.users as { id: number; name: string }[];
      const u = users.find((x) => x.name === name);
      if (!u) throw new Error(`no user ${name}`);
      const r = await c.post('/api/session', { user_id: u.id });
      if (r.status !== 200) throw new Error('login failed');
      return c;
    },
    async restart() {
      await h.app.close();
      await boot();
    },
    async close() {
      await h.app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  async function boot() {
    h.app = createApp({ dbPath, tz: 'Asia/Kolkata', now: clock.now });
    const port = await h.app.listen(0, '127.0.0.1');
    h.base = `http://127.0.0.1:${port}`;
  }
  await boot();
  return h;
}

/** What undoes each migration, to rebuild the database an older version wrote. */
export const UNDO: Record<number, string> = {
  2: 'DROP TABLE user_state;',
  3: 'DROP TABLE imports;',
  4: `UPDATE users SET color = '#059669' WHERE color = '#047857';
      UPDATE users SET color = '#d97706' WHERE color = '#b45309';`,
  // version 4 wrote the users table with the two-role CHECK
  5: `PRAGMA foreign_keys = OFF;
      PRAGMA legacy_alter_table = ON;
      ALTER TABLE users RENAME TO users_v5;
      CREATE TABLE users (
        id         INTEGER PRIMARY KEY,
        name       TEXT NOT NULL COLLATE NOCASE UNIQUE,
        initials   TEXT NOT NULL,
        color      TEXT NOT NULL,
        role       TEXT NOT NULL DEFAULT 'engineer' CHECK (role IN ('engineer','manager')),
        is_admin   INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0,1)),
        active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
        created_at TEXT NOT NULL
      );
      INSERT INTO users SELECT * FROM users_v5;
      DROP TABLE users_v5;
      PRAGMA legacy_alter_table = OFF;
      PRAGMA foreign_keys = ON;`,
  6: `DROP TABLE review_sync; DROP TABLE project_files; DROP TABLE review_events; DROP TABLE review_comments;
      DROP TABLE review_attempts; DROP TABLE review_drawings; DROP TABLE review_submissions;
      DROP TABLE review_references; DROP TABLE review_files;`,
};

/** Take a database back to schema `to`, as the version that wrote it would have left it. */
export function undoMigrationsAfter(db: Db, to: number) {
  for (const id of Object.keys(UNDO).map(Number).sort((a, b) => b - a)) {
    if (id <= to) continue;
    db.exec(UNDO[id]);
    run(db, 'DELETE FROM schema_migrations WHERE id = ?', id);
  }
}
