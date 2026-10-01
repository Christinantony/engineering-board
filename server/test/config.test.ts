// config.json is edited by hand in Notepad: every likely mistake gets a plain explanation.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config.ts';

describe('config.json', () => {
  const dirs: string[] = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const withConfig = (text: string | null, env: NodeJS.ProcessEnv = {}) => {
    const d = mkdtempSync(join(tmpdir(), 'eb-cfg-'));
    dirs.push(d);
    if (text !== null) writeFileSync(join(d, 'config.json'), text);
    return { dir: d, load: () => loadConfig(d, env) };
  };

  it('works with no config.json at all', () => {
    const { dir, load } = withConfig(null);
    const c = load();
    assert.equal(c.file, null);
    assert.equal(c.port, 8080);
    assert.equal(c.host, '0.0.0.0');
    assert.equal(c.dataDir, resolve(dir, 'data'));
    assert.equal(c.backupDir, resolve(dir, 'data', 'backups'));
    assert.deepEqual(c.workingDays, [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(c.warnings, []);
  });

  it('the shipped config.example.json is valid and matches the defaults', () => {
    const example = readFileSync('config.example.json', 'utf8');
    const c = withConfig(example).load();
    const d = withConfig(null).load();
    assert.deepEqual(c.warnings, [], 'no unknown settings in the example');
    for (const k of ['port', 'host', 'timezone', 'backupKeepDays', 'hoursPerDay', 'workingDays'] as const) assert.deepEqual(c[k], d[k], k);
  });

  it('accepts a file saved by Notepad with a byte-order mark, and "_comment" keys', () => {
    const c = withConfig('\uFEFF{ "_comment": "hello", "port": 9000 }').load();
    assert.equal(c.port, 9000);
    assert.deepEqual(c.warnings, []);
  });

  it('explains single backslashes in Windows paths', () => {
    const { load } = withConfig('{ "backupDir": "D:\\Board\\backups" }');
    assert.throws(load, /forward slashes .*double backslashes/s);
  });

  it('explains a missing or extra comma', () => {
    assert.throws(withConfig('{ "port": 9000 "host": "0.0.0.0" }').load, /missing comma/);
    assert.throws(withConfig('{ "port": 9000, }').load, /comma after the last one/);
  });

  it('lists every wrong value at once, in words', () => {
    const { load } = withConfig(JSON.stringify({ port: 80000, backupKeepDays: 0, hoursPerDay: 30, workingDays: [1, 9], timezone: 'India' }));
    assert.throws(load, (e: Error) => {
      for (const k of ['port', 'backupKeepDays', 'hoursPerDay', 'workingDays', 'timezone']) assert.match(e.message, new RegExp(`"${k}"`));
      return true;
    });
  });

  it('warns about misspelt settings instead of silently ignoring them', () => {
    const c = withConfig('{ "Port": 9000, "backupdir": "x", "colour": 1 }').load();
    assert.equal(c.port, 8080);
    assert.equal(c.warnings.length, 3);
    assert.match(c.warnings[0], /Did you mean "port"/);
    assert.match(c.warnings[1], /Did you mean "backupDir"/);
  });

  it('takes paths relative to the board folder, and environment variables win over the file', () => {
    const { dir, load } = withConfig('{ "dataDir": "../shared/board", "port": 9000 }');
    assert.equal(load().dataDir, resolve(dir, '../shared/board'));
    const env = withConfig('{ "port": 9000 }', { EB_PORT: '9100', EB_HOST: '127.0.0.1' });
    assert.equal(env.load().port, 9100);
    assert.equal(env.load().host, '127.0.0.1');
  });

  it('accepts working days in any order and drops duplicates', () => {
    assert.deepEqual(withConfig('{ "workingDays": [5, 1, 1, 3] }').load().workingDays, [1, 3, 5]);
  });
});
