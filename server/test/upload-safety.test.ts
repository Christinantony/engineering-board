import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, readdirSync, rmSync, readFileSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createApp, type App } from '../src/app.ts';
import { Client, signIn } from './helpers.ts';
import { streamUpload, type Request } from '../src/http/http.ts';

const LIMIT = 1048576;
const sqliteHeader = Buffer.from('SQLite format 3\u0000', 'latin1');
const cookie = (c: Client) => [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
const uploadDirs = (dir: string) => readdirSync(dir).filter((n) => n.startsWith('.restore-upload-'));

// Deliberately never sends a body: the answer must arrive from headers alone.
function headersOnly(base: string, headers: Record<string, string>, method = 'POST') {
  return new Promise<{ status: number; continued: boolean }>((resolve, reject) => {
    let continued = false;
    const req = httpRequest(base + '/api/admin/restore/upload', { method, headers, agent: false });
    const timer = setTimeout(() => { req.destroy(); reject(new Error('The server waited for the upload body')); }, 2000);
    req.on('continue', () => { continued = true; });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.on('response', (res) => {
      res.resume();
      res.on('end', () => { clearTimeout(timer); req.destroy(); resolve({ status: res.statusCode!, continued }); });
    });
    req.flushHeaders();
  });
}

function chunked(base: string, auth: string, chunks: Buffer[]) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest(base + '/api/admin/restore/upload', { method: 'POST', headers: {
      cookie: auth, 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked',
    }, agent: false });
    const timer = setTimeout(() => { req.destroy(); reject(new Error('No upload response')); }, 5000);
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.on('response', (res) => {
      let body = '';
      res.setEncoding('utf8'); res.on('data', (c) => { body += c; });
      res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode!, body }); });
    });
    for (const c of chunks) req.write(c);
    req.end();
  });
}

async function eventually(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(check(), 'temporary upload files were cleaned');
}

describe('authorized streamed restore uploads', () => {
  let app: App, dir: string, base: string, admin: Client, locked: Client;
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'eb-upload-'));
    app = createApp({ dbPath: join(dir, 'board.db'), restoreUploadMaxMB: 1 });
    base = `http://127.0.0.1:${await app.listen(0, '127.0.0.1')}`;
    admin = new Client(base); locked = new Client(base);
    await signIn(admin, 1);
    await signIn(locked, 2);
    await admin.post('/api/admin/unlock', { pin: '1234' });
    await admin.create({ title: 'Live data survives bad uploads' });
  });
  after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

  it('rejects anonymous and locked uploads without reading a body or sending 100 Continue', async () => {
    const headers = { 'content-type': 'application/octet-stream', 'content-length': String(LIMIT * 2), expect: '100-continue' };
    assert.deepEqual(await headersOnly(base, headers), { status: 401, continued: false });
    assert.deepEqual(await headersOnly(base, { ...headers, cookie: cookie(locked) }), { status: 403, continued: false });
    assert.deepEqual(uploadDirs(dir), []);
  });

  it('rejects oversized advertised files, wrong content types and methods from headers alone', async () => {
    const headers = { cookie: cookie(admin), 'content-type': 'application/octet-stream', 'content-length': String(LIMIT + 1), expect: '100-continue' };
    assert.deepEqual(await headersOnly(base, headers), { status: 413, continued: false });
    assert.deepEqual(await headersOnly(base, { ...headers, 'content-type': 'application/json' }), { status: 415, continued: false });
    assert.deepEqual(await headersOnly(base, headers, 'PUT'), { status: 405, continued: false });
    assert.deepEqual(uploadDirs(dir), []);
  });

  it('restores a real backup through chunked transfer and removes the streamed file', async () => {
    const b = (await admin.post('/api/admin/backups')).body.backup.name;
    const data = readFileSync(join(app.ctx.backupDir, b));
    await admin.create({ title: 'Only after backup' });
    const chunks = Array.from({ length: Math.ceil(data.length / 4096) }, (_, i) => data.subarray(i * 4096, (i + 1) * 4096));
    const res = await chunked(base, cookie(admin), chunks);
    assert.equal(res.status, 200, res.body);
    assert.equal((await admin.get('/api/tickets?q=Only%20after')).body.total, 0);
    assert.equal((await admin.get('/api/admin/status')).body.unlocked, true);
    assert.deepEqual(uploadDirs(dir), []);
  });

  it('enforces the same byte limit on chunked uploads and returns readable 413', async () => {
    const res = await chunked(base, cookie(admin), [sqliteHeader, Buffer.alloc(LIMIT)]);
    assert.equal(res.status, 413, res.body);
    assert.match(JSON.parse(res.body).message, /limit 1 MB/);
    assert.deepEqual(uploadDirs(dir), []);
    assert.equal((await admin.get('/api/tickets?q=Live%20data')).body.total, 1);
  });

  it('rejects incomplete or invalid SQLite uploads without replacing data', async () => {
    for (const chunks of [[Buffer.from('junk')], [sqliteHeader, Buffer.alloc(100)]]) {
      const res = await chunked(base, cookie(admin), chunks);
      assert.equal(res.status, 400, res.body);
      assert.deepEqual(uploadDirs(dir), []);
    }
    assert.equal((await admin.get('/api/tickets?q=Live%20data')).body.total, 1);
  });

  it('cleans a partial disk file after the client aborts', async () => {
    const req = httpRequest(base + '/api/admin/restore/upload', { method: 'POST', headers: {
      cookie: cookie(admin), 'content-type': 'application/octet-stream', 'content-length': '65536',
    }, agent: false });
    req.on('error', () => {});
    req.write(Buffer.concat([sqliteHeader, Buffer.alloc(1024)]));
    await eventually(() => uploadDirs(dir).length === 1);
    req.destroy();
    await eventually(() => uploadDirs(dir).length === 0);
    assert.equal((await admin.get('/api/tickets?q=Live%20data')).body.total, 1);
  });

  it('streaming accepts exactly the byte limit and handles short disk writes', async () => {
    const seed = await open(join(dir, 'probe'), 'w');
    const proto = Object.getPrototypeOf(seed);
    const write = proto.write;
    await seed.close(); rmSync(join(dir, 'probe'));
    const spy = mock.method(proto, 'write', function (this: any, buf: Buffer, offset: number, length: number) {
      return write.call(this, buf, offset, Math.min(length, 8192));
    });
    const req = { raw: Readable.from([sqliteHeader, Buffer.alloc(LIMIT - 16)]), headers: { 'content-type': 'application/octet-stream' } } as unknown as Request;
    try {
      await streamUpload(req, dir, LIMIT);
      assert.equal(req.upload!.bytes, LIMIT);
      assert.equal(statSync(req.upload!.path).size, LIMIT);
      assert.ok(spy.mock.callCount() > 2, 'partial writes are completed');
    } finally { spy.mock.restore(); if (req.upload) rmSync(req.upload.dir, { recursive: true, force: true }); }
    assert.deepEqual(uploadDirs(dir), []);
  });

  it('cleans temporary files when a disk write fails', async () => {
    const seed = await open(join(dir, 'probe'), 'w');
    const proto = Object.getPrototypeOf(seed);
    await seed.close(); rmSync(join(dir, 'probe'));
    const spy = mock.method(proto, 'write', async () => { throw new Error('simulated disk failure'); });
    const req = { raw: Readable.from([sqliteHeader, Buffer.alloc(1024)]), headers: { 'content-type': 'application/octet-stream' } } as unknown as Request;
    try { await assert.rejects(streamUpload(req, dir, LIMIT), /simulated disk failure/); }
    finally { spy.mock.restore(); }
    assert.deepEqual(uploadDirs(dir), []);
    assert.equal((await admin.get('/api/tickets?q=Live%20data')).body.total, 1);
  });
});
