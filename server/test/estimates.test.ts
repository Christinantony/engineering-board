// Estimates against actual time (decision #36).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { compareToEstimate, parseDuration } from '@board/shared';
import { startHarness, Client, type Harness } from './helpers.ts';

describe('reading a time as typed', () => {
  it('takes minutes, hours, days and mixtures', () => {
    const cases: [string, number | null][] = [
      ['90', 90],
      ['90 min', 90],
      ['45mins', 45],
      ['1.5h', 90],
      ['1,5 h', 90],
      ['3h 30m', 210],
      ['2 h 15', 135],
      ['1h30', 90],
      ['1 hour 5 minutes', 65],
      ['1d', 480],
      ['2 days', 960],
      ['0', 0],
      ['', null],
      ['abc', null],
      ['3h and a bit', null],
    ];
    for (const [s, want] of cases) assert.equal(parseDuration(s), want, s);
    assert.equal(parseDuration('1d', 9), 540, 'a day is the board\'s working day');
  });

  it('compares a time with the estimate bucket chosen', () => {
    assert.equal(compareToEstimate(180, 200), 'within', '2–4 hr, took 3 h 20');
    assert.equal(compareToEstimate(180, 240), 'within', 'the top of the bucket still counts');
    assert.equal(compareToEstimate(180, 241), 'longer');
    assert.equal(compareToEstimate(180, 100), 'shorter');
    assert.equal(compareToEstimate(1440, 5000), 'within', '> 2 days has no ceiling');
  });
});

describe('estimate accuracy', () => {
  let h: Harness;
  let paul: Client;
  let allen: Client;
  let types: Record<string, number>;
  before(async () => {
    h = await startHarness();
    paul = await h.as('Paul');
    allen = await h.as('Allen');
    types = Object.fromEntries((await paul.get('/api/job-types')).body.job_types.map((t: any) => [t.name, t.id]));
  });
  after(() => h.close());

  async function finished(c: Client, type: string, estimate: number, actual: number | null) {
    const t = await c.create({ title: `${type} ${estimate}/${actual}`, claim: true, job_type_id: types[type], estimate_minutes: estimate });
    let r = await c.post(`/api/tickets/${t.id}/move`, { status: 'done' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    if (actual != null) {
      r = await c.patch(`/api/tickets/${t.id}`, { version: r.body.ticket.version, actual_minutes: actual });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
  }

  it('reports how close estimates were, by job type and by person', async () => {
    await finished(paul, 'FEA', 360, 400); // within 4–8 hr
    await finished(paul, 'FEA', 360, 600); // longer
    await finished(allen, 'FEA', 360, 420); // within
    await finished(allen, 'Drawing', 90, 45); // shorter
    await finished(allen, 'Drawing', 90, null); // no actual time: not compared
    const today = '2026-10-01';
    const r = await paul.get(`/api/reports?from=${today}&to=${today}`);
    assert.equal(r.status, 200);
    const a = r.body.estimate_accuracy;
    assert.equal(a.done, 5);
    assert.equal(a.with_actual, 4);
    assert.equal(a.compared, 4);
    assert.deepEqual([a.overall.within, a.overall.longer, a.overall.shorter], [2, 1, 1]);
    const fea = a.by_type.find((x: any) => x.name === 'FEA');
    assert.equal(fea.jobs, 3);
    assert.equal(fea.within, 2);
    assert.equal(fea.longer, 1);
    assert.equal(fea.estimated_minutes, 1080);
    assert.equal(fea.actual_minutes, 1420);
    assert.equal(fea.median_ratio, 1.17, '420 ÷ 360');
    const allenRow = a.by_person.find((x: any) => x.name === 'Allen');
    assert.equal(allenRow.jobs, 2);
    assert.equal(allenRow.shorter, 1);
  });

  it('says what a type of job usually takes once three have recorded their time', async () => {
    const r = await paul.get('/api/estimates/typical');
    assert.equal(r.status, 200);
    const fea = r.body.typical.find((x: any) => x.job_type_id === types['FEA']);
    assert.ok(fea, 'three FEA jobs are enough');
    assert.equal(fea.jobs, 3);
    assert.equal(fea.median_minutes, 420);
    assert.equal(fea.label, '4–8 hr');
    assert.equal(r.body.typical.some((x: any) => x.job_type_id === types['Drawing']), false, 'one Drawing job is not enough');
  });

  it('forgets jobs finished more than 180 days ago', async () => {
    h.clock.advance(181 * 86_400_000);
    const c = await h.as('Paul');
    assert.deepEqual((await c.get('/api/estimates/typical')).body.typical, []);
  });
});
