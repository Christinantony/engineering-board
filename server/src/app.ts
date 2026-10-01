import { createServer, type Server } from 'node:http';
import { STATUSES, PRIORITIES, ESTIMATE_BUCKETS, STATUS_LABEL, type User } from '@board/shared';
import { v } from '@board/shared';
import { openDb, migrate, run, all, type Db } from './db/connection.ts';
import { seedBase, seedDemo, clearDemo, hasDemoData } from './db/seed.ts';
import { EventHub, HttpError, forbidden, type Ctx } from './lib/core.ts';
import { localDate } from './lib/time.ts';
import {
  HANDLED,
  Reply,
  Router,
  buildRequest,
  cookie,
  errorToReply,
  send,
  serveStatic,
  type Request,
} from './http/http.ts';
import {
  ADMIN_TTL_SECONDS,
  adminCookie,
  changePin,
  ensureAuthSettings,
  pinIsDefault,
  readAdmin,
  readSession,
  sessionCookie,
  verifyPin,
} from './domain/auth.ts';
import { createUser, getUser, listUsers, updateUser } from './domain/users.ts';
import { createJobType, listJobTypes, updateJobType } from './domain/jobTypes.ts';
import {
  addComment,
  archiveTicket,
  claimTicket,
  createTicket,
  getTicket,
  listTickets,
  moveTicket,
  parseFilters,
  recentActivity,
  releaseTicket,
  restoreTicket,
  setMyRank,
  ticketActivity,
  activityPage,
  updateTicket,
} from './domain/tickets.ts';
import { dashboard, myWork, todayView, workload, type Horizon } from './domain/views.ts';
import { report } from './domain/reports.ts';
import { markSeen, notifications } from './domain/notifications.ts';
import { Presence } from './domain/presence.ts';

export const APP_VERSION = '0.5.0';

export interface AppOptions {
  dbPath: string;
  tz?: string;
  now?: () => Date;
  webRoot?: string;
  /** Planning reference shown on the workload page (not a capacity limit). */
  workday?: { hoursPerDay: number; workingDays: number[] };
  log?: boolean;
}

export interface App {
  ctx: Ctx;
  server: Server;
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

const SESSION_COOKIE = 'eb_session';
const ADMIN_COOKIE = 'eb_admin';
const ONE_YEAR = 365 * 24 * 3600;

export function createApp(opts: AppOptions): App {
  const db: Db = openDb(opts.dbPath);
  const ctx: Ctx = { db, tz: opts.tz ?? 'Asia/Kolkata', now: opts.now ?? (() => new Date()), events: new EventHub() };
  migrate(db);
  ensureAuthSettings(ctx);
  seedBase(ctx);
  // forget idempotency keys older than 7 days
  run(db, 'DELETE FROM idempotency WHERE created_at < ?', new Date(ctx.now().getTime() - 7 * 86_400_000).toISOString());

  const presence = new Presence(ctx.events, () => ctx.now().getTime());
  const router = new Router();
  const id = (req: Request) => v.int({ min: 1 })(req.params.id, 'id');

  // ---- auth wrappers ----
  function currentUser(req: Request): User | null {
    const uid = readSession(ctx, req.cookies[SESSION_COOKIE]);
    if (!uid) return null;
    const u = getUser(ctx, uid);
    return u && u.active ? u : null;
  }
  const pub = (method: string, path: string, h: (req: Request) => unknown) => router.add(method, path, h);
  const authed = (method: string, path: string, h: (req: Request, user: User) => unknown) =>
    router.add(method, path, (req) => {
      const user = currentUser(req);
      if (!user) throw new HttpError(401, 'unauthenticated', 'Please choose who you are first.');
      return h(req, user);
    });
  const admin = (method: string, path: string, h: (req: Request, user: User) => unknown) =>
    authed(method, path, (req, user) => {
      if (!readAdmin(ctx, req.cookies[ADMIN_COOKIE], user.id)) throw new HttpError(403, 'admin_locked', 'Unlock the admin area with the PIN first.');
      return h(req, user);
    });

  // ---- public ----
  pub('GET', '/api/health', () => ({ ok: true, version: APP_VERSION, time: ctx.now().toISOString() }));
  pub('GET', '/api/meta', () => ({
    version: APP_VERSION,
    tz: ctx.tz,
    today: localDate(ctx.now().getTime(), ctx.tz),
    statuses: STATUSES.map((s) => ({ id: s, label: STATUS_LABEL[s] })),
    priorities: PRIORITIES,
    estimates: ESTIMATE_BUCKETS.map(({ label, minutes }) => ({ label, minutes })),
    pin_is_default: pinIsDefault(ctx),
    workday: { hours_per_day: opts.workday?.hoursPerDay ?? 8, working_days: opts.workday?.workingDays ?? [1, 2, 3, 4, 5, 6] },
    demo_present: hasDemoData(ctx),
  }));
  pub('GET', '/api/users', (req) => ({ users: listUsers(ctx, req.query.get('all') === '1') }));
  pub('GET', '/api/session', (req) => ({ user: currentUser(req) }));
  pub('POST', '/api/session', (req) => {
    const { user_id } = v.object({ user_id: v.int({ min: 1 }) })(req.body);
    const u = getUser(ctx, user_id);
    if (!u || !u.active) throw new HttpError(400, 'bad_user', 'That user is not available.');
    return new Reply(200, { user: u }, { 'Set-Cookie': cookie(SESSION_COOKIE, sessionCookie(ctx, u.id), { maxAge: ONE_YEAR }) });
  });
  pub('DELETE', '/api/session', () =>
    new Reply(200, { ok: true }, { 'Set-Cookie': [cookie(SESSION_COOKIE, '', { maxAge: 0 }), cookie(ADMIN_COOKIE, '', { maxAge: 0 })] }),
  );

  // ---- reference data ----
  authed('GET', '/api/job-types', () => ({ job_types: listJobTypes(ctx) }));
  authed('GET', '/api/tags', () => ({
    tags: all<{ name: string; count: number }>(
      db,
      'SELECT g.name, COUNT(tt.ticket_id) count FROM tags g LEFT JOIN ticket_tags tt ON tt.tag_id = g.id GROUP BY g.id ORDER BY count DESC, g.name',
    ),
  }));

  // ---- tickets ----
  authed('GET', '/api/tickets', (req) => listTickets(ctx, parseFilters(req.query)));
  authed('POST', '/api/tickets', (req, user) => {
    const key = req.headers['idempotency-key'];
    const k = typeof key === 'string' && key.length >= 8 && key.length <= 100 ? key : undefined;
    const { ticket, replayed } = createTicket(ctx, user, req.body ?? {}, k);
    return new Reply(replayed ? 200 : 201, { ticket, replayed });
  });
  authed('GET', '/api/tickets/:id', (req) => ({ ticket: getTicket(ctx, id(req)), activity: ticketActivity(ctx, id(req)) }));
  authed('PATCH', '/api/tickets/:id', (req, user) => ({ ticket: updateTicket(ctx, user, id(req), req.body ?? {}) }));
  authed('POST', '/api/tickets/:id/move', (req, user) => ({ ticket: moveTicket(ctx, user, id(req), req.body ?? {}) }));
  authed('POST', '/api/tickets/:id/claim', (req, user) => ({ ticket: claimTicket(ctx, user, id(req)) }));
  authed('POST', '/api/tickets/:id/release', (req, user) => ({ ticket: releaseTicket(ctx, user, id(req)) }));
  authed('POST', '/api/tickets/:id/my-rank', (req, user) => ({ ticket: setMyRank(ctx, user, id(req), req.body ?? {}) }));
  authed('POST', '/api/tickets/:id/comments', (req, user) => new Reply(201, { activity: addComment(ctx, user, id(req), req.body ?? {}) }));
  authed('POST', '/api/tickets/:id/archive', (req, user) => ({ ticket: archiveTicket(ctx, user, id(req)) }));
  authed('POST', '/api/tickets/:id/restore', (req, user) => ({ ticket: restoreTicket(ctx, user, id(req)) }));
  authed('GET', '/api/tickets/:id/activity', (req) => ({ activity: ticketActivity(ctx, id(req)) }));

  // ---- views ----
  authed('GET', '/api/activity', (req) => {
    const limit = Math.min(Math.max(Number(req.query.get('limit')) || 30, 1), 200);
    const since = Number(req.query.get('since')) || undefined;
    if (since) return { activity: recentActivity(ctx, limit, since) };
    return {
      activity: activityPage(ctx, {
        limit,
        before: Number(req.query.get('before')) || undefined,
        userId: Number(req.query.get('user')) || undefined,
      }),
    };
  });

  // ---- collaboration: notifications and presence ----
  authed('GET', '/api/notifications', (_req, user) => notifications(ctx, user));
  authed('POST', '/api/notifications/seen', (req, user) => {
    const { up_to } = v.object({ up_to: v.int({ min: 0 }) })(req.body);
    markSeen(ctx, user.id, up_to);
    return { ok: true };
  });
  authed('GET', '/api/presence', () => ({ online: presence.snapshot() }));
  authed('POST', '/api/presence', (req, user) => {
    const { job_id, tab } = v.object({
      job_id: v.nullable(v.int({ min: 1 })),
      tab: v.string({ min: 1, max: 64 }),
    })(req.body);
    presence.view(user.id, tab, job_id);
    return { ok: true };
  });
  authed('GET', '/api/dashboard', () => dashboard(ctx));
  authed('GET', '/api/today', () => todayView(ctx));
  authed('GET', '/api/my-work', (req, user) => {
    const uid = req.query.get('user') ? v.int({ min: 1 })(req.query.get('user'), 'user') : user.id;
    return myWork(ctx, uid);
  });
  authed('GET', '/api/reports', (req) => {
    const today = localDate(ctx.now().getTime(), ctx.tz);
    return report(ctx, req.query.get('from') ?? today, req.query.get('to') ?? today);
  });
  authed('GET', '/api/workload', (req) => workload(ctx, (req.query.get('horizon') ?? 'today') as Horizon));

  // ---- live updates (Server-Sent Events) ----
  authed('GET', '/api/events', (req, user) => {
    const res = req.res;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ time: ctx.now().toISOString(), version: APP_VERSION })}\n\n`);
    const unsubscribe = ctx.events.subscribe((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    const leave = presence.connect(user.id);
    const cleanup = () => {
      clearInterval(ping);
      unsubscribe();
      leave();
    };
    req.raw.on('close', cleanup);
    sseConnections.add(res);
    res.on('close', () => sseConnections.delete(res));
    return HANDLED;
  });

  // ---- admin ----
  authed('GET', '/api/admin/status', (req, user) => ({
    unlocked: readAdmin(ctx, req.cookies[ADMIN_COOKIE], user.id),
    pin_is_default: pinIsDefault(ctx),
  }));
  authed('POST', '/api/admin/unlock', (req, user) => {
    const { pin } = v.object({ pin: v.string({ min: 1, max: 32 }) })(req.body);
    if (!verifyPin(ctx, pin)) throw forbidden('Wrong PIN');
    return new Reply(200, { unlocked: true }, { 'Set-Cookie': cookie(ADMIN_COOKIE, adminCookie(ctx, user.id), { maxAge: ADMIN_TTL_SECONDS }) });
  });
  authed('POST', '/api/admin/lock', () => new Reply(200, { unlocked: false }, { 'Set-Cookie': cookie(ADMIN_COOKIE, '', { maxAge: 0 }) }));
  admin('POST', '/api/admin/pin', (req) => {
    const { new_pin } = v.object({
      new_pin: v.string({ min: 4, max: 32, pattern: /^\S+$/, patternMessage: 'must not contain spaces' }),
    })(req.body);
    changePin(ctx, new_pin);
    return { ok: true };
  });
  admin('GET', '/api/admin/users', () => ({ users: listUsers(ctx, true) }));
  admin('POST', '/api/admin/users', (req) => new Reply(201, { user: createUser(ctx, req.body ?? {}) }));
  admin('PATCH', '/api/admin/users/:id', (req) => ({ user: updateUser(ctx, id(req), req.body ?? {}) }));
  admin('POST', '/api/admin/job-types', (req) => new Reply(201, { job_type: createJobType(ctx, req.body ?? {}) }));
  admin('PATCH', '/api/admin/job-types/:id', (req) => ({ job_type: updateJobType(ctx, id(req), req.body ?? {}) }));
  admin('POST', '/api/admin/demo', () => {
    if (hasDemoData(ctx)) throw new HttpError(409, 'conflict', 'Demo data is already loaded.');
    return { created: seedDemo(ctx) };
  });
  admin('DELETE', '/api/admin/demo', () => ({ removed: clearDemo(ctx) }));

  // ---- server ----
  const sseConnections = new Set<import('node:http').ServerResponse>();
  const server = createServer(async (raw, res) => {
    const started = Date.now();
    let status = 500;
    try {
      const url = raw.url ?? '/';
      if (!url.startsWith('/api/')) {
        if ((raw.method === 'GET' || raw.method === 'HEAD') && opts.webRoot && serveStatic(opts.webRoot, raw, res, url.split('?')[0])) {
          status = 200;
          return;
        }
        status = 404;
        return send(res, 404, { error: 'not_found', message: 'Not found' });
      }
      const req = await buildRequest(raw, res);
      const m = router.match(req.method, req.path);
      if (m === null) throw new HttpError(404, 'not_found', `No API route for ${req.method} ${req.path}`);
      if (m === 'method') throw new HttpError(405, 'method_not_allowed', `${req.method} is not allowed here`);
      req.params = m.params;
      let result: unknown;
      try {
        result = await m.route.handler(req);
        ctx.events.flush();
      } catch (e) {
        ctx.events.discard();
        throw e;
      }
      if (result === HANDLED) {
        status = 200;
        return;
      }
      const reply = result instanceof Reply ? result : new Reply(200, result);
      status = reply.status;
      send(res, reply.status, reply.body, reply.headers);
    } catch (err) {
      const reply = errorToReply(err);
      status = reply.status;
      send(res, reply.status, reply.body, reply.headers);
    } finally {
      if (opts.log && raw.url?.startsWith('/api/') && raw.url !== '/api/events')
        console.log(`${new Date().toISOString()} ${raw.method} ${raw.url} ${status} ${Date.now() - started}ms`);
    }
  });
  server.keepAliveTimeout = 65_000;

  return {
    ctx,
    server,
    listen(port, host = '0.0.0.0') {
      return new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const addr = server.address();
          resolveListen(typeof addr === 'object' && addr ? addr.port : port);
        });
      });
    },
    close() {
      return new Promise((resolveClose) => {
        for (const res of sseConnections) res.end();
        server.close(() => {
          db.close();
          resolveClose();
        });
        server.closeAllConnections?.();
      });
    },
  };
}
