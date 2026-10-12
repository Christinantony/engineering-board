
import {describe,it,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {startHarness,type Harness} from './helpers.ts';
import {run} from '../src/db/connection.ts';
describe('v2 purchase department coordination',()=>{
 let h:Harness;let admin:Awaited<ReturnType<Harness['as']>>;let buyer:Awaited<ReturnType<Harness['as']>>;let engineer:Awaited<ReturnType<Harness['as']>>;let item:number;let vendor:number;
 before(async()=>{
  h=await startHarness();admin=await h.as('Christin');engineer=await h.as('Paul');
  await admin.post('/api/admin/unlock',{pin:'1234'});
  const created=await admin.post('/api/admin/users',{name:'Buyer Alpha',role:'purchase'});
  assert.equal(created.status,201,JSON.stringify(created.body));
  buyer=await h.as('Buyer Alpha');
  const project=(await engineer.post('/api/projects',{name:'Purchasing acceptance suite'})).body.project.id;
  item=(await engineer.post(`/api/projects/${project}/procurement/items`,{name:'Bracket batch',quantity:6})).body.item.id;
 });
 after(()=>h.close());
 it('blocks buyers from engineering board, drawings, job creation, admin and stock changes',async()=>{
  for(const path of ['/api/tickets','/api/projects','/api/reviews','/api/admin/users']) {
   const res=await buyer.get(path);
   assert.equal(res.status,403,path+' should be forbidden');
  }
  assert.equal((await buyer.post('/api/tickets',{title:'Unauthorized'})).status,403);
  assert.equal((await buyer.post(`/api/procurement/items/${item}/stock`,{in_stock:true})).status,403);
  assert.equal((await buyer.get('/api/purchase/queue')).status,200);
  assert.equal((await buyer.get('/api/review-files/invalid')).status,403);
  assert.equal((await buyer.get('/api/notifications')).status,403);
  assert.equal((await buyer.get('/api/manufacturing')).status,200);
  assert.equal((await buyer.get('/api/procurement/followups')).status,200);
 });
 it('lets Purchase maintain vendors and one versioned order linked to existing component',async()=>{
  const v=await buyer.post('/api/purchase/vendors',{name:'Local CNC Shop',phone:'12345',contact:'Vendor representative',email:'',process_notes:'CNC aluminium'});
  assert.equal(v.status,201,JSON.stringify(v.body));vendor=v.body.vendor.id;
  assert.equal((await buyer.post('/api/purchase/vendors',{name:'Local CNC Shop'})).status,409);
  assert.equal((await engineer.post('/api/purchase/vendors',{name:'Not allowed'})).status,403);
  const order={version:0,vendor_id:vendor,po_ref:'PO-212',order_status:'ordered',purchase_owner_id:(await buyer.get('/api/session')).body.user.id,detail:'PO sent to supplier'};
  let r=await buyer.put(`/api/purchase/items/${item}`,order);
  assert.equal(r.status,200,JSON.stringify(r.body));
  assert.equal(r.body.order.version,1);
  assert.equal((await buyer.put(`/api/purchase/items/${item}`,order)).status,409);
  assert.equal((await engineer.put(`/api/purchase/items/${item}`,{...order,version:1})).status,403);
  assert.equal((await buyer.put(`/api/purchase/items/${item}`,{...order,version:1,vendor_id:123456})).status,400);
  r=await buyer.get('/api/purchase/queue');
  const row=r.body.items.find((x:any)=>x.id===item);
  assert.equal(row.po_ref,'PO-212');assert.equal(row.vendor_id,vendor);assert.equal(row.in_stock_at,null);
  const history=(await buyer.get(`/api/purchase/items/${item}`)).body;
  assert.equal(history.events.length,1);
  assert.throws(()=>run(h.app.ctx.db,'UPDATE purchase_events SET detail=? WHERE id=?','tamper',history.events[0].id),/append-only/);
 });
 it('a buyer can log a vendor follow-up but cannot mark an item received',async()=>{
  const r=await buyer.post(`/api/procurement/items/${item}/followups`,{outcome:'ready',note:'Vendor promised dispatch',next_due:'2026-10-15'});
  assert.equal(r.status,201,JSON.stringify(r.body));
  const q=(await buyer.get('/api/purchase/queue')).body.items.find((x:any)=>x.id===item);
  assert.equal(q.in_stock_at,null);
 });
});
