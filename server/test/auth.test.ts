// Password sign-in (decision #28): everyone creates a password at first sign-in,
// signs in with it afterwards, can change it, and an admin can reset a forgotten one.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.ts';
import { openDb, get, run } from '../src/db/connection.ts';
import { SIGN_IN_ATTEMPTS, SIGN_IN_PAUSE_MS } from '../src/domain/auth.ts';
import { startHarness, signIn, Client, TEST_PASSWORD, type Harness } from './helpers.ts';

describe('password sign-in', () => {
  let h: Harness;
  let paulId: number;
  let allenId: number;
  before(async () => {
    h = await startHarness();
    const users = (await new Client(h.base).get('/api/users')).body.users as { id: number; name: string }[];
    paulId = users.find((u) => u.name === 'Paul')!.id;
    allenId = users.find((u) => u.name === 'Allen')!.id;
  });
  after(() => h.close());

  it('a person without a password cannot sign in until they create one; the list says who has one', async () => {
    const c = new Client(h.base);
    const before = (await c.get('/api/users')).body.users.find((u: any) => u.id === paulId);
    assert.equal(before.has_password, false);
    const r = await c.post('/api/session', { user_id: paulId, password: 'anything' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'password_not_set');
    assert.equal((await c.get('/api/session')).body.user, null);

    const short = await c.post('/api/session/password', { user_id: paulId, password: 'abc' });
    assert.equal(short.status, 400, 'too short');
    const spaces = await c.post('/api/session/password', { user_id: paulId, password: '        ' });
    assert.equal(spaces.status, 400, 'only spaces');

    const made = await c.post('/api/session/password', { user_id: paulId, password: TEST_PASSWORD });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    assert.equal(made.body.user.name, 'Paul');
    assert.equal(made.body.user.has_password, true);
    assert.ok(c.cookies.has('eb_session'), 'creating the password signs the person in');
    assert.equal((await c.get('/api/session')).body.user.id, paulId);
    assert.equal((await c.get('/api/tickets')).status, 200);
    const after = (await new Client(h.base).get('/api/users')).body.users.find((u: any) => u.id === paulId);
    assert.equal(after.has_password, true);
  });

  it('once a password exists it cannot be created again, and signing in needs the right one', async () => {
    const c = new Client(h.base);
    const again = await c.post('/api/session/password', { user_id: paulId, password: 'another-one' });
    assert.equal(again.status, 409);
    assert.equal(again.body.error, 'password_already_set');
    assert.ok(!c.cookies.has('eb_session'));

    const wrong = await c.post('/api/session', { user_id: paulId, password: 'wrong-password' });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.body.error, 'wrong_password');
    assert.ok(!c.cookies.has('eb_session'));
    assert.equal((await c.get('/api/tickets')).status, 401);

    const right = await c.post('/api/session', { user_id: paulId, password: TEST_PASSWORD });
    assert.equal(right.status, 200);
    assert.equal((await c.get('/api/session')).body.user.name, 'Paul');
    // the password itself is never sent back
    assert.equal(JSON.stringify(right.body).includes(TEST_PASSWORD), false);
    assert.equal('password_hash' in right.body.user, false);
  });

  it('a password is a secret in the database: hashed with scrypt, never stored in clear', () => {
    const db = openDb(h.dbPath);
    try {
      const row = get<{ password_hash: string }>(db, 'SELECT password_hash FROM users WHERE id = ?', paulId)!;
      assert.match(row.password_hash, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
      assert.equal(row.password_hash.includes(TEST_PASSWORD), false);
    } finally {
      db.close();
    }
  });

  it('repeated wrong passwords pause sign-in for that person only, and the pause ends', async () => {
    const c = new Client(h.base);
    for (let i = 1; i < SIGN_IN_ATTEMPTS; i++) {
      assert.equal((await c.post('/api/session', { user_id: paulId, password: `guess-${i}` })).status, 403);
    }
    const paused = await c.post('/api/session', { user_id: paulId, password: 'guess-last' });
    assert.equal(paused.status, 429);
    assert.equal(paused.body.error, 'too_many_attempts');
    assert.equal(paused.body.retry_after_seconds, SIGN_IN_PAUSE_MS / 1000);
    // even the right password is refused while paused, so guessing cannot continue
    assert.equal((await c.post('/api/session', { user_id: paulId, password: TEST_PASSWORD })).status, 429);
    // someone else is unaffected
    assert.equal((await signIn(new Client(h.base), allenId)).status, 200);
    h.clock.advance(SIGN_IN_PAUSE_MS + 1000);
    const ok = await c.post('/api/session', { user_id: paulId, password: TEST_PASSWORD });
    assert.equal(ok.status, 200, 'the pause is over');
    // a successful sign-in forgets the earlier failures
    assert.equal((await c.post('/api/session', { user_id: paulId, password: 'guess-again' })).status, 403);
  });

  it('cookies from before passwords, forged cookies and inactive users are all refused', async () => {
    const anon = new Client(h.base);
    anon.cookies.set('eb_session', `u${paulId}.forged`);
    assert.equal((await anon.get('/api/tickets')).status, 401);
    // the pre-1.2 cookie format carried only the user id; it is no longer accepted even when correctly signed
    const db = openDb(h.dbPath);
    const secret = get<{ value: string }>(db, `SELECT value FROM settings WHERE key = 'cookie_secret'`)!.value;
    db.close();
    const { createHmac } = await import('node:crypto');
    const old = `u${paulId}`;
    anon.cookies.set('eb_session', `${old}.${createHmac('sha256', secret).update(old).digest('base64url')}`);
    assert.equal((await anon.get('/api/session')).body.user, null, 'an old-style cookie means signing in again, with a password');

    const paul = await h.as('Paul');
    const admin = await h.as('Christin');
    await admin.post('/api/admin/unlock', { pin: '1234' });
    assert.equal((await admin.patch(`/api/admin/users/${paulId}`, { active: false })).status, 200);
    assert.equal((await paul.get('/api/tickets')).status, 401, 'an inactive person is signed out');
    assert.equal((await new Client(h.base).post('/api/session', { user_id: paulId, password: TEST_PASSWORD })).status, 400, 'and cannot sign in');
    assert.equal((await admin.patch(`/api/admin/users/${paulId}`, { active: true })).status, 200);
    assert.equal((await paul.get('/api/tickets')).status, 200, 'made active again, the same password works');
  });

  it('changing your own password needs the current one and signs out your other browsers', async () => {
    const here = await h.as('Paul');
    const there = await h.as('Paul');
    const wrong = await here.post('/api/me/password', { current_password: 'not-it', new_password: 'new-secret-9' });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.body.error, 'wrong_password');
    assert.equal((await here.post('/api/me/password', { current_password: TEST_PASSWORD, new_password: 'short' })).status, 400);

    const changed = await here.post('/api/me/password', { current_password: TEST_PASSWORD, new_password: 'new-secret-9' });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal((await here.get('/api/session')).body.user.name, 'Paul', 'this browser stays signed in');
    assert.equal((await there.get('/api/session')).body.user, null, 'the other browser is signed out');
    assert.equal((await there.get('/api/tickets')).status, 401);
    assert.equal((await new Client(h.base).post('/api/session', { user_id: paulId, password: TEST_PASSWORD })).status, 403, 'the old password is gone');
    assert.equal((await signIn(there, paulId, 'new-secret-9')).status, 200);
    // put it back for the other tests
    assert.equal((await here.post('/api/me/password', { current_password: 'new-secret-9', new_password: TEST_PASSWORD })).status, 200);
  });

  it('an admin resets a forgotten password: the person is signed out and creates a new one next time', async () => {
    const paul = await h.as('Paul');
    const notAdmin = await h.as('Allen');
    assert.equal((await notAdmin.del(`/api/admin/users/${paulId}/password`)).status, 403, 'needs the admin PIN');

    const admin = await h.as('Christin');
    await admin.post('/api/admin/unlock', { pin: '1234' });
    const r = await admin.del(`/api/admin/users/${paulId}/password`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.user.has_password, false);
    assert.equal((await admin.del(`/api/admin/users/${paulId}/password`)).status, 409, 'nothing left to reset');
    assert.equal((await admin.del(`/api/admin/users/9999/password`)).status, 404);

    assert.equal((await paul.get('/api/session')).body.user, null, 'signed out everywhere');
    const fresh = new Client(h.base);
    assert.equal((await fresh.post('/api/session', { user_id: paulId, password: TEST_PASSWORD })).status, 409, 'the old password no longer works');
    assert.equal((await fresh.post('/api/session/password', { user_id: paulId, password: TEST_PASSWORD })).status, 200);
    assert.equal((await fresh.get('/api/tickets')).status, 200);
  });

  it('a person added by an admin creates their password at their first sign-in', async () => {
    const admin = await h.as('Christin');
    await admin.post('/api/admin/unlock', { pin: '1234' });
    const made = await admin.post('/api/admin/users', { name: 'Maya Joseph', role: 'reviewer' });
    assert.equal(made.status, 201);
    assert.equal(made.body.user.has_password, false);
    const maya = new Client(h.base);
    assert.equal((await maya.post('/api/session', { user_id: made.body.user.id, password: 'x' })).status, 409);
    assert.equal((await maya.post('/api/session/password', { user_id: made.body.user.id, password: 'mayas-phrase 2026' })).status, 200);
    assert.equal((await maya.get('/api/session')).body.user.name, 'Maya Joseph');
  });

  it('passwords survive a restart, and a RESET-PASSWORDS start clears every one', async () => {
    const paul = await h.as('Paul');
    const cookie = paul.cookies.get('eb_session')!;
    await h.restart(); // (a restart picks a new port, so clients are rebuilt with the same cookie)
    const back = new Client(h.base);
    back.cookies.set('eb_session', cookie);
    assert.equal((await back.get('/api/session')).body.user.name, 'Paul', 'still signed in after a restart');
    assert.equal((await signIn(new Client(h.base), paulId)).status, 200);

    await h.app.close();
    const dir = mkdtempSync(join(tmpdir(), 'eb-reset-'));
    try {
      const app = createApp({ dbPath: h.dbPath, tz: 'Asia/Kolkata', now: h.clock.now, resetPasswords: true });
      const base = `http://127.0.0.1:${await app.listen(0, '127.0.0.1')}`;
      const c = new Client(base);
      const users = (await c.get('/api/users')).body.users as { has_password: boolean }[];
      assert.ok(users.length >= 3);
      assert.ok(users.every((u) => !u.has_password), 'nobody has a password any more');
      const was = new Client(base);
      was.cookies.set('eb_session', cookie);
      assert.equal((await was.get('/api/session')).body.user, null, 'old sessions are gone');
      assert.equal((await signIn(c, paulId)).status, 200, 'and a new password can be created');
      await app.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    await h.restart();
    // a restart without the file changes nothing
    assert.equal((await new Client(h.base).post('/api/session', { user_id: paulId, password: TEST_PASSWORD })).status, 200);
  });

  it('the admin PIN is unchanged by passwords: admin still needs the PIN, and sign-in never needs it', async () => {
    const c = await h.as('Allen');
    assert.equal((await c.get('/api/admin/users')).status, 403);
    assert.equal((await c.post('/api/admin/unlock', { pin: '1234' })).status, 200);
    assert.equal((await c.get('/api/admin/users')).status, 200);
    const db = openDb(h.dbPath);
    try {
      assert.equal(get<{ value: string }>(db, `SELECT value FROM settings WHERE key = 'admin_pin_is_default'`)!.value, '1');
      run(db, 'SELECT 1');
    } finally {
      db.close();
    }
  });
});
