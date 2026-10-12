import {describe,it,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {startHarness,type Harness} from './helpers.ts';
import {run} from '../src/db/connection.ts';
describe('manufacturing progress v1.9',()=>{
 let h:Harness;let paul:Awaited<ReturnType<Harness['as']>>;let allen:Awaited<ReturnType<Harness['as']>>;let id:number;
 before(async()=>{
  h=await startHarness();paul=await h.as('Paul');allen=await h.as('Allen');
  const project=(await paul.post('/api/projects',{name:'Production build'})).body.project.id;
  const result=await paul.post(`/api/projects/${project}/procurement/items`,{name:'Mounting bracket',quantity:20,means:'outsourced'});
  assert.equal(result.status,201);id=result.body.item.id;
 });
 after(()=>h.close());
 it('starts with zero tracking and offers stage labels for each means',async()=>{
  const r=await paul.get('/api/manufacturing');assert.equal(r.status,200);
  const row=r.body.items.find((x:any)=>x.id===id);
  assert.equal(row.version,0);assert.equal(row.received,0);assert.equal(row.stage,'planning');
  assert.ok(r.body.labels.some((x:any)=>x.means==='outsourced'&&x.stage==='fabrication'));
 });
 it('tracks partially received, accepted and rejected quantities; never mutates stock',async()=>{
  const p={version:0,stage:'inspection',in_process:16,received:8,accepted:5,rejected:2,escalation:'attention',detail:'Eight brackets delivered, one awaiting check'};
  let r=await paul.put(`/api/manufacturing/items/${id}`,p);
  assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.tracking.version,1);
  assert.equal(r.body.tracking.accepted,5);
  r=await allen.put(`/api/manufacturing/items/${id}`,p);assert.equal(r.status,409);
  r=await paul.put(`/api/manufacturing/items/${id}`,{...p,version:1,accepted:7,rejected:2});assert.equal(r.status,400);
  r=await paul.put(`/api/manufacturing/items/${id}`,{...p,version:1,received:21});assert.equal(r.status,400);
  const history=(await paul.get(`/api/manufacturing/items/${id}`)).body;
  assert.equal(history.events.length,1);assert.equal(history.events[0].kind,'progress');
  assert.throws(()=>run(h.app.ctx.db,'UPDATE manufacturing_events SET detail=? WHERE id=?','edited',history.events[0].id),/append-only/);
  const proc=(await paul.get('/api/manufacturing')).body.items.find((x:any)=>x.id===id);
  assert.equal(proc.in_stock_at,null);
 });
 it('keeps original and latest vendor commitments, with every change auditable',async()=>{
  let r=await allen.post(`/api/manufacturing/items/${id}/commitments`,{promised_date:'2026-10-13',detail:'Vendor original promise'});assert.equal(r.status,201,JSON.stringify(r.body));
  r=await allen.post(`/api/manufacturing/items/${id}/commitments`,{promised_date:'2026-10-17',detail:'Machine breakdown'});assert.equal(r.status,201);
  const row=(await paul.get('/api/manufacturing')).body.items.find((x:any)=>x.id===id);
  assert.equal(row.original_promise,'2026-10-13');assert.equal(row.latest_promise,'2026-10-17');
  assert.equal((await paul.post(`/api/manufacturing/items/${id}/commitments`,{promised_date:'2026-02-30',detail:'Invalid'})).status,400);
  const history=(await paul.get(`/api/manufacturing/items/${id}`)).body.events;
  assert.equal(history.filter((x:any)=>x.kind==='commitment').length,2);
 });
 it('protects records from reviewers and configures labels with admin access',async()=>{
  let r=await paul.put('/api/admin/manufacturing/labels',{means:'outsourced',stage:'fabrication',label:'CNC machining'});assert.equal(r.status,403);
  const admin=await h.as('Christin');await admin.post('/api/admin/unlock',{pin:'1234'});
  r=await admin.put('/api/admin/manufacturing/labels',{means:'outsourced',stage:'fabrication',label:'CNC machining'});
  assert.equal(r.status,200,JSON.stringify(r.body));
  assert.ok((await paul.get('/api/manufacturing')).body.labels.some((x:any)=>x.means==='outsourced'&&x.stage==='fabrication'&&x.label==='CNC machining'));
  await admin.post('/api/admin/users',{name:'MfgReviewer',role:'reviewer'});
  const review=await h.as('MfgReviewer');
  assert.equal((await review.get('/api/manufacturing')).status,403);
  assert.equal((await review.post(`/api/manufacturing/items/${id}/commitments`,{promised_date:'2026-10-19',detail:'Forbidden'})).status,403);
 });
});
