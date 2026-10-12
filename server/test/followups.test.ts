import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness } from './helpers.ts';
import { get, run } from '../src/db/connection.ts';

describe('vendor follow-up control', () => {
 let h: Harness;
 let a: Awaited<ReturnType<Harness['as']>>;
 let b: Awaited<ReturnType<Harness['as']>>;
 let item: number;
 before(async()=>{
  h=await startHarness();
  a=await h.as('Paul');
  b=await h.as('Allen');
  const project=(await a.post('/api/projects',{name:'Followup regression test'})).body.project.id;
  item=(await a.post(`/api/projects/${project}/procurement/items`,{name:'Housing',means:'outsourced'})).body.item.id;
 });
 after(()=>h.close());
 it('queues new pending items; saves owner and next action with version protection',async()=>{
  const initial=(await a.get('/api/procurement/followups')).body.items.find((x:any)=>x.id===item);
  assert.equal(initial.followup_version,0);
  const owner=(await b.get('/api/session')).body.user.id;
  const body={version:0,owner_id:owner,next_action:'Call machining vendor',next_due:'2026-10-15'};
  const r=await a.put(`/api/procurement/items/${item}/followup`,body);
  assert.equal(r.status,200,JSON.stringify(r.body));
  assert.equal(r.body.followup.version,1);
  assert.equal((await b.put(`/api/procurement/items/${item}/followup`,body)).status,409);
  const q=(await b.get('/api/procurement/followups')).body.items.find((x:any)=>x.id===item);
  assert.equal(q.owner_id,owner);assert.equal(q.next_due,'2026-10-15');
  assert.equal((await a.put(`/api/procurement/items/${item}/followup`,{...body,version:1,next_due:'2026-02-30'})).status,400);
 });
 it('preserves an immutable vendor-contact history without automatically marking in stock',async()=>{
  const r=await a.post(`/api/procurement/items/${item}/followups`,{outcome:'ready',note:'Vendor says ready; collection not verified',next_due:'2026-10-16'});
  assert.equal(r.status,201,JSON.stringify(r.body));
  assert.equal((await a.post(`/api/procurement/items/${item}/followups`,{outcome:'unknown',note:'oops'})).status,400);
  const history=(await b.get(`/api/procurement/items/${item}/followups`)).body.calls;
  assert.equal(history.length,1);assert.equal(history[0].outcome,'ready');
  assert.throws(()=>run(h.app.ctx.db,'UPDATE procurement_calls SET note=? WHERE id=?','altered',history[0].id),/append-only/);
  assert.ok((await a.get('/api/procurement/followups')).body.items.some((x:any)=>x.id===item));
  await a.post(`/api/procurement/items/${item}/stock`,{in_stock:true});
  assert.equal((await b.get('/api/procurement/followups')).body.items.some((x:any)=>x.id===item),false);
  assert.equal((await a.get(`/api/procurement/items/${item}/followups`)).body.calls.length,1);
 });
 it('rejects reviewers',async()=>{
  const admin=await h.as('Christin');
  await admin.post('/api/admin/unlock',{pin:'1234'});
  await admin.post('/api/admin/users',{name:'ReviewOnly',role:'reviewer'});
  const reviewer=await h.as('ReviewOnly');
  assert.equal((await reviewer.get('/api/procurement/followups')).status,403);
  assert.equal((await reviewer.post(`/api/procurement/items/${item}/followups`,{outcome:'progress',note:'test'})).status,403);
 });
});
