
import type {User} from '@board/shared';
import {all,get,run,tx} from '../db/connection.ts';
import {badRequest,conflict,notFound,nowIso,type Ctx} from '../lib/core.ts';
const statuses=['requested','quoted','ordered','part_received','closed'];
const txt=(v:unknown,k:string,n:number)=>{if(typeof v!=='string'||v.length>n)throw badRequest(k+' must be at most '+n+' characters');return v.trim();};
const item=(ctx:Ctx,id:number)=>{const x=get<{id:number;project_id:number;removed_at:string|null}>(ctx.db,'SELECT id,project_id,removed_at FROM procurement_items WHERE id=?',id);if(!x||x.removed_at)throw notFound('Item');return x;};
const notify=(ctx:Ctx,id:number)=>ctx.events.emit({type:'procurement',id});
export const vendorList=(ctx:Ctx)=>all<any>(ctx.db,'SELECT * FROM purchase_vendors ORDER BY active DESC,name');
export function createVendor(ctx:Ctx,u:User,raw:unknown){void u;if(!raw||typeof raw!=='object'||Array.isArray(raw))throw badRequest('Invalid vendor');
 const d=raw as Record<string,unknown>,name=txt(d.name,'Name',100);if(!name)throw badRequest('Name required');
 return tx(ctx.db,()=>{if(get(ctx.db,'SELECT 1 FROM purchase_vendors WHERE name=?',name))throw conflict('Vendor already exists');
 const now=nowIso(ctx),r=run(ctx.db,'INSERT INTO purchase_vendors(name,contact,phone,email,process_notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
 name,txt(d.contact??'','Contact',100),txt(d.phone??'','Phone',60),txt(d.email??'','Email',150),txt(d.process_notes??'','Notes',500),now,now);
 notify(ctx,0);return get(ctx.db,'SELECT * FROM purchase_vendors WHERE id=?',Number(r.lastInsertRowid));});}
export function updateVendor(ctx:Ctx,u:User,id:number,raw:unknown){void u;if(!raw||typeof raw!=='object'||Array.isArray(raw))throw badRequest('Invalid vendor');
 const d=raw as Record<string,unknown>,old=get<any>(ctx.db,'SELECT * FROM purchase_vendors WHERE id=?',id);if(!old)throw notFound('Vendor');
 const active=d.active===undefined?old.active:d.active===true?1:d.active===false?0:null;if(active===null)throw badRequest('Invalid active flag');
 run(ctx.db,'UPDATE purchase_vendors SET name=?,contact=?,phone=?,email=?,process_notes=?,active=?,updated_at=? WHERE id=?',
 txt(d.name??old.name,'Name',100),txt(d.contact??old.contact,'Contact',100),txt(d.phone??old.phone,'Phone',60),txt(d.email??old.email,'Email',150),txt(d.process_notes??old.process_notes,'Notes',500),active,nowIso(ctx),id);
 notify(ctx,0);return get(ctx.db,'SELECT * FROM purchase_vendors WHERE id=?',id);}
export function purchaseQueue(ctx:Ctx){
 const query='SELECT i.id,i.project_id,p.name project_name,i.name,i.spec,i.means,i.quantity,i.unit,i.in_stock_at,'+
 'o.vendor_id,o.po_ref,o.order_status,o.purchase_owner_id,COALESCE(o.version,0) version,'+
 'f.owner_id followup_owner_id,f.next_action,f.next_due,m.stage,m.received,m.accepted,m.escalation,'+
 "(SELECT promised_date FROM manufacturing_events WHERE item_id=i.id AND kind='commitment' ORDER BY id DESC LIMIT 1) latest_promise "+
 'FROM procurement_items i JOIN projects p ON p.id=i.project_id LEFT JOIN purchase_orders o ON o.item_id=i.id '+
 'LEFT JOIN procurement_followups f ON f.item_id=i.id LEFT JOIN manufacturing_tracking m ON m.item_id=i.id '+
 'WHERE i.removed_at IS NULL ORDER BY CASE WHEN i.in_stock_at IS NULL THEN 0 ELSE 1 END, f.next_due, p.name, i.id';
 return {items:all<any>(ctx.db,query),vendors:vendorList(ctx)};
}
export function purchaseHistory(ctx:Ctx,id:number){item(ctx,id);return {order:get<any>(ctx.db,'SELECT * FROM purchase_orders WHERE item_id=?',id)??null,
 events:all<any>(ctx.db,'SELECT * FROM purchase_events WHERE item_id=? ORDER BY id DESC LIMIT 250',id)};}
export function updatePurchase(ctx:Ctx,u:User,id:number,raw:unknown){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw badRequest('Invalid purchase update');
 const d=raw as Record<string,unknown>;
 if(typeof d.version!=='number'||!Number.isSafeInteger(d.version)||d.version<0)throw badRequest('Version required');
 if(typeof d.order_status!=='string'||!statuses.includes(d.order_status))throw badRequest('Invalid order status');
 const ref=txt(d.po_ref,'PO reference',100),detail=txt(d.detail,'Update note',700);if(!detail)throw badRequest('Update note required');
 return tx(ctx.db,()=>{
  const target=item(ctx,id),old=get<{version:number}>(ctx.db,'SELECT version FROM purchase_orders WHERE item_id=?',id);
  if((old?.version??0)!==d.version)throw conflict('Purchase item changed. Reload and try again');
  const vendor=d.vendor_id==null?null:d.vendor_id as number,owner=d.purchase_owner_id==null?null:d.purchase_owner_id as number;
  if(vendor!==null&&(!Number.isSafeInteger(vendor)||!get(ctx.db,'SELECT 1 FROM purchase_vendors WHERE id=? AND active=1',vendor)))throw badRequest('Choose an active vendor');
  if(owner!==null&&(!Number.isSafeInteger(owner)||!get(ctx.db,"SELECT 1 FROM users WHERE id=? AND role='purchase' AND active=1",owner)))throw badRequest('Choose an active purchase colleague');
  const now=nowIso(ctx),status=d.order_status as string;
  if(old)run(ctx.db,'UPDATE purchase_orders SET vendor_id=?,po_ref=?,order_status=?,purchase_owner_id=?,updated_by=?,updated_at=?,version=version+1 WHERE item_id=?',vendor,ref,status,owner,u.id,now,id);
  else run(ctx.db,'INSERT INTO purchase_orders(item_id,vendor_id,po_ref,order_status,purchase_owner_id,updated_by,updated_at) VALUES(?,?,?,?,?,?,?)',id,vendor,ref,status,owner,u.id,now);
  run(ctx.db,"INSERT INTO purchase_events(item_id,at,user_id,event,detail,order_status,vendor_id,po_ref,purchase_owner_id) VALUES(?,?,?,'order',?,?,?,?,?)",id,now,u.id,detail,status,vendor,ref,owner);
  notify(ctx,target.project_id);return get(ctx.db,'SELECT * FROM purchase_orders WHERE item_id=?',id);
 });
}
