// Component manufacturing coordination, decision #41. The procurement master item is authoritative.
import {all,get,run,tx} from '../db/connection.ts';
import {badRequest,conflict,nowIso,type Ctx} from '../lib/core.ts';
import type {User} from '@board/shared';

const STAGES = ['planning','queued','fabrication','finishing','inspection','received'] as const;
const MEANS = ['outsourced','in_house','bought_out','tools'] as const;
const ESCALATIONS = ['none','attention','critical'] as const;
const DATE = /^\\d{4}-\\d{2}-\\d{2}$/;
type Stage = typeof STAGES[number];
type Escalation = typeof ESCALATIONS[number];
interface Tracking {item_id:number;stage:Stage;in_process:number;received:number;accepted:number;rejected:number;escalation:Escalation;version:number;updated_at:string;updated_by:number|null;}
function existing(ctx:Ctx,itemId:number){
 const row=get<{id:number;project_id:number;quantity:number;name:string;means:string;removed_at:string|null}>(ctx.db,'SELECT id,project_id,quantity,name,means,removed_at FROM procurement_items WHERE id=?',itemId);
 if(!row||row.removed_at)throw badRequest('Component not found in the active procurement list.');
 return row;
}
function validDate(v:unknown):string {
 if(typeof v!=='string'||!DATE.test(v)||Number.isNaN(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v)throw badRequest('Enter a valid YYYY-MM-DD promised date.');
 return v;
}
function nonnegative(v:unknown,key:string,max:number):number{
 if(typeof v!=='number'||!Number.isFinite(v)||v<0||v>max)throw badRequest(key+' must be between zero and the requested quantity.');
 return v;
}
function tracking(ctx:Ctx,id:number):Tracking|null {
 return get<Tracking>(ctx.db,'SELECT * FROM manufacturing_tracking WHERE item_id=?',id)??null;
}
export function manufacturingQueue(ctx:Ctx) {
 const items=all<any>(ctx.db,`SELECT i.id,i.project_id,p.name project_name,i.name,i.spec,i.means,i.quantity,i.unit,i.in_stock_at,
 t.stage,t.in_process,t.received,t.accepted,t.rejected,t.escalation,t.version,t.updated_at,
 (SELECT promised_date FROM manufacturing_events WHERE item_id=i.id AND kind='commitment' ORDER BY id ASC LIMIT 1) original_promise,
 (SELECT promised_date FROM manufacturing_events WHERE item_id=i.id AND kind='commitment' ORDER BY id DESC LIMIT 1) latest_promise
 FROM procurement_items i JOIN projects p ON p.id=i.project_id
 LEFT JOIN manufacturing_tracking t ON t.item_id=i.id
 WHERE i.removed_at IS NULL ORDER BY p.name,i.sort_order,i.id`);
 const labels=all<{means:string;stage:string;label:string}>(ctx.db,'SELECT means,stage,label FROM manufacturing_stage_labels ORDER BY means,rowid');
 return {items:items.map(i=>({...i,stage:i.stage??'planning',in_process:i.in_process??0,received:i.received??0,accepted:i.accepted??0,rejected:i.rejected??0,escalation:i.escalation??'none',version:i.version??0})),labels};
}
export function manufacturingHistory(ctx:Ctx,itemId:number){
 const item=existing(ctx,itemId);
 return {item, tracking:tracking(ctx,itemId),events:all<any>(ctx.db,'SELECT * FROM manufacturing_events WHERE item_id=? ORDER BY id DESC LIMIT 250',itemId)};
}
export function updateManufacturing(ctx:Ctx,actor:User,itemId:number,raw:unknown){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw badRequest('Invalid manufacturing progress.');
 const d=raw as Record<string,unknown>;
 if(typeof d.stage!=='string'||!STAGES.includes(d.stage as Stage))throw badRequest('Choose a manufacturing stage.');
 if(typeof d.escalation!=='string'||!ESCALATIONS.includes(d.escalation as Escalation))throw badRequest('Choose an escalation level.');
 if(typeof d.version!=='number'||!Number.isSafeInteger(d.version)||d.version<0)throw badRequest('Provide the current tracking version.');
 if(typeof d.detail!=='string'||!d.detail.trim()||d.detail.length>700)throw badRequest('Record a short progress note (1–700 characters).');
 return tx(ctx.db,()=>{
  const item=existing(ctx,itemId),old=tracking(ctx,itemId);
  if((old?.version??0)!==d.version)throw conflict('Someone else updated this component. Reload before saving.');
  const qty={in_process:nonnegative(d.in_process,'In process',item.quantity),received:nonnegative(d.received,'Received',item.quantity),accepted:nonnegative(d.accepted,'Accepted',item.quantity),rejected:nonnegative(d.rejected,'Rejected',item.quantity)};
  if(qty.accepted+qty.rejected>qty.received+0.0000001)throw badRequest('Accepted and rejected quantities together cannot exceed the received quantity.');
  const at=nowIso(ctx),stage=d.stage as Stage,escalation=d.escalation as Escalation,detail=(d.detail as string).trim();
  if(old)run(ctx.db,'UPDATE manufacturing_tracking SET stage=?,in_process=?,received=?,accepted=?,rejected=?,escalation=?,updated_by=?,updated_at=?,version=version+1 WHERE item_id=?',stage,qty.in_process,qty.received,qty.accepted,qty.rejected,escalation,actor.id,at,itemId);
  else run(ctx.db,'INSERT INTO manufacturing_tracking(item_id,stage,in_process,received,accepted,rejected,escalation,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',itemId,stage,qty.in_process,qty.received,qty.accepted,qty.rejected,escalation,actor.id,at);
  run(ctx.db,'INSERT INTO manufacturing_events(item_id,user_id,at,kind,detail,stage,in_process,received,accepted,rejected,escalation) VALUES(?,?,?,\'progress\',?,?,?,?,?,?,?)',itemId,actor.id,at,detail,stage,qty.in_process,qty.received,qty.accepted,qty.rejected,escalation);
  ctx.events.emit({type:'procurement',id:item.project_id});
  return tracking(ctx,itemId);
 });
}
export function recordCommitment(ctx:Ctx,actor:User,itemId:number,raw:unknown){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw badRequest('Invalid vendor promise.');
 const d=raw as Record<string,unknown>, promised=validDate(d.promised_date);
 if(typeof d.detail!=='string'||!d.detail.trim()||d.detail.length>700)throw badRequest('Explain the new vendor commitment (1–700 characters).');
 return tx(ctx.db,()=>{
  const item=existing(ctx,itemId),at=nowIso(ctx);
  const id=Number(run(ctx.db,'INSERT INTO manufacturing_events(item_id,user_id,at,kind,detail,promised_date) VALUES(?,?,?,\'commitment\',?,?)',itemId,actor.id,at,d.detail.trim(),promised).lastInsertRowid);
  ctx.events.emit({type:'procurement',id:item.project_id});
  return get<any>(ctx.db,'SELECT * FROM manufacturing_events WHERE id=?',id);
 });
}
export function setManufacturingLabels(ctx:Ctx,actor:User,raw:unknown){
 void actor;
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw badRequest('Invalid stage label.');
 const d=raw as Record<string,unknown>;
 if(typeof d.means!=='string'||!MEANS.includes(d.means as typeof MEANS[number])||typeof d.stage!=='string'||!STAGES.includes(d.stage as Stage)||typeof d.label!=='string'||!d.label.trim()||d.label.length>70)throw badRequest('Choose means, stage and a label (1–70 characters).');
 run(ctx.db,'UPDATE manufacturing_stage_labels SET label=? WHERE means=? AND stage=?',d.label.trim(),d.means,d.stage);
 ctx.events.emit({type:'procurement',id:0});
 return {ok:true};
}
