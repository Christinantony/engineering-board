// Tiny HTTP framework on node:http: routing, JSON bodies, cookies, errors,
// static files. Kept deliberately small — about what Fastify gave us, minus
// the dependency.

import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { ValidationError } from '@board/shared';
import { HttpError } from '../lib/core.ts';

export interface Request {
  raw: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  cookies: Record<string, string>;
  body: unknown;
  rawBody: string;
  /** Present for application/octet-stream uploads (database restore). */
  binary?: Buffer;
  headers: IncomingMessage['headers'];
}

export class Reply {
  constructor(
    public status: number,
    public body: unknown,
    public headers: Record<string, string | string[]> = {},
  ) {}
}
/** Returned by handlers that take over the response (SSE, downloads). */
export const HANDLED = Symbol('handled');

export type Handler<A> = (req: Request, auth: A) => unknown | Promise<unknown>;

interface Route {
  method: string;
  parts: string[];
  handler: (req: Request) => unknown | Promise<unknown>;
}

export class Router {
  private routes: Route[] = [];
  add(method: string, pattern: string, handler: (req: Request) => unknown | Promise<unknown>) {
    this.routes.push({ method, parts: pattern.split('/').filter(Boolean), handler });
  }
  /** Every registered route, e.g. for tests that sweep the whole API. */
  list(): { method: string; path: string }[] {
    return this.routes.map((r) => ({ method: r.method, path: '/' + r.parts.join('/') }));
  }
  match(method: string, path: string): { route: Route; params: Record<string, string> } | 'method' | null {
    const segs = path.split('/').filter(Boolean);
    let methodMismatch = false;
    for (const route of this.routes) {
      if (route.parts.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < segs.length; i++) {
        const p = route.parts[i];
        if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(segs[i]);
        else if (p !== segs[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (route.method !== method) {
        methodMismatch = true;
        continue;
      }
      return { route, params };
    }
    return methodMismatch ? 'method' : null;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* ignore malformed cookie */
    }
  }
  return out;
}

export function cookie(name: string, value: string, opts: { maxAge?: number; httpOnly?: boolean } = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Strict'];
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  return parts.join('; ');
}

const MAX_BODY = 20 * 1024 * 1024; // JSON and CSV
const MAX_UPLOAD = 1024 * 1024 * 1024; // database files

function readBody(req: IncomingMessage, limit = MAX_BODY): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const tooLarge = () => new HttpError(413, 'too_large', `That file is too large (limit ${Math.round(limit / 1048576)} MB).`);
    // Past the limit, keep reading and throw the rest away, so the browser gets the
    // "too large" answer instead of a dropped connection. Only cut the connection if
    // the sender goes on far beyond the limit.
    const hardStop = limit * 2;
    let size = 0;
    let over = false;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > hardStop) {
        reject(tooLarge());
        req.destroy();
        return;
      }
      if (size > limit) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => (over ? reject(tooLarge()) : resolveBody(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

export function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}) {
  if (res.headersSent) return;
  const isText = typeof body === 'string';
  const payload = body === undefined ? '' : isText ? body : JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Cache-Control': 'no-store',
    'Content-Type': isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(payload);
}

export function errorToReply(err: unknown): Reply {
  if (err instanceof HttpError) return new Reply(err.status, { error: err.code, message: err.message, ...err.extra });
  if (err instanceof ValidationError) {
    return new Reply(400, { error: 'validation', message: `Please check: ${err.message}`, details: err.issues });
  }
  if (err instanceof SyntaxError) return new Reply(400, { error: 'bad_json', message: 'Request body is not valid JSON' });
  const msg = err instanceof Error ? err.message : String(err);
  if (/SQLITE_BUSY|database is locked/i.test(msg)) {
    return new Reply(503, { error: 'busy', message: 'The database is busy. Please try again in a moment.' });
  }
  if (/append-only|cannot be deleted/.test(msg)) return new Reply(409, { error: 'immutable', message: msg });
  console.error('[error]', err);
  return new Reply(500, { error: 'internal', message: 'Something went wrong on the server. Nothing was saved. Please try again.' });
}

export async function buildRequest(raw: IncomingMessage, res: ServerResponse): Promise<Request> {
  const url = new URL(raw.url ?? '/', 'http://localhost');
  const method = (raw.method ?? 'GET').toUpperCase();
  let rawBody = '';
  let binary: Buffer | undefined;
  let body: unknown = undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    const ct = String(raw.headers['content-type'] ?? '');
    if (ct.startsWith('application/octet-stream')) {
      // only the database-restore upload takes large binary bodies
      if (url.pathname !== '/api/admin/restore/upload') throw new HttpError(415, 'unsupported_media_type', 'Send JSON (Content-Type: application/json)');
      binary = await readBody(raw, MAX_UPLOAD);
    } else {
      rawBody = (await readBody(raw)).toString('utf8');
      if (rawBody.length) {
        if (ct.includes('application/json')) body = JSON.parse(rawBody);
        else if (!ct.startsWith('text/')) {
          throw new HttpError(415, 'unsupported_media_type', 'Send JSON (Content-Type: application/json)');
        }
      }
    }
  }
  return {
    raw,
    res,
    method,
    path: url.pathname,
    params: {},
    query: url.searchParams,
    cookies: parseCookies(raw.headers.cookie),
    body,
    rawBody,
    binary,
    headers: raw.headers,
  };
}

// ---------------------------------------------------------------------------
// Static files (built web app) with SPA fallback
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export function serveStatic(root: string, raw: IncomingMessage, res: ServerResponse, path: string): boolean {
  if (!existsSync(root)) return false;
  const base = resolve(root);
  let file = normalize(join(base, decodeURIComponent(path)));
  if (!file.startsWith(base + sep) && file !== base) return false; // path traversal
  if (!existsSync(file) || statSync(file).isDirectory()) {
    if (extname(path)) return false; // missing asset → 404
    file = join(base, 'index.html'); // SPA route
    if (!existsSync(file)) return false;
  }
  const isHtml = file.endsWith('.html');
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=31536000, immutable',
    ...(isHtml
      ? { 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'" }
      : {}),
  });
  if (raw.method === 'HEAD') res.end();
  else createReadStream(file).pipe(res);
  return true;
}
