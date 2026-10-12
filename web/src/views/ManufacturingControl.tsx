import {useState,useEffect} from 'react';
import {useQuery,invalidate} from '../lib/store.ts';
import {put,post} from '../lib/api.ts';
import {useApp} from '../context.ts';
import {toast,toastError} from '../lib/toasts.ts';
import {ErrorBox,Spinner} from '../components/bits.tsx';
import {dateTime} from '../lib/format.ts';

type Stage='planning'|'queued'|'fabrication'|'finishing'|'inspection'|'received';
type Escalation='none'|'attention'|'critical';
interface Item {
 id:number;project_id:number;project_name:string;name:string;spec:string;means:string;quantity:number;unit:string;in_stock_at:string|null;
 stage:Stage;in_process:number;received:number;accepted:number;rejected:number;escalation:Escalation;version:number;original_promise:string|null;latest_promise:string|null;
}
interface Event {id:number;user_id:number|null;at:string;kind:string;detail:string;stage:string|null;promised_date:string|null;received:number|null;accepted:number|null;rejected:number|null}
interface Data {items:Item[];labels:{means:string;stage:string;label:string}[]}
const STAGES:Stage[]=['planning','queued','fabrication','finishing','inspection','received'];
export function ManufacturingControl(){
 const {user,meta}=useApp();
 const q=useQuery<Data>('/api/manufacturing');
 const [opened,setOpened]=useState<number|null>(null);
 const [filter,setFilter]=useState<'all'|'late'|'escalated'>('all');
 const [edit,setEdit]=useState<{stage:Stage;in_process:string;received:string;accepted:string;rejected:string;escalation:Escalation;detail:string}>({stage:'planning',in_process:'0',received:'0',accepted:'0',rejected:'0',escalation:'none',detail:''});
 const [promise,setPromise]=useState(''),[promiseNote,setPromiseNote]=useState('');
 const history=useQuery<{events:Event[]}>(opened===null?null:`/api/manufacturing/items/${opened}`);
 const today=meta.today;
 const items=q.data?.items??[];
 const visible=items.filter(i=>filter==='all'||(filter==='late'&&!!i.latest_promise&&i.latest_promise<today&&!i.in_stock_at)||(filter==='escalated'&&i.escalation!=='none'));
 const open=(i:Item)=>{setOpened(opened===i.id?null:i.id);setEdit({stage:i.stage,in_process:String(i.in_process),received:String(i.received),accepted:String(i.accepted),rejected:String(i.rejected),escalation:i.escalation,detail:''});setPromise('');setPromiseNote('');};
 const save=async(i:Item)=>{
  try{
   await put(`/api/manufacturing/items/${i.id}`,{version:i.version,stage:edit.stage,in_process:Number(edit.in_process),received:Number(edit.received),accepted:Number(edit.accepted),rejected:Number(edit.rejected),escalation:edit.escalation,detail:edit.detail});
   invalidate(k=>k.startsWith('/api/manufacturing'));toast('Manufacturing progress saved.',{kind:'success'});setEdit(v=>({...v,detail:''}));
  }catch(e){toastError(e);invalidate('/api/manufacturing');}
 };
 const savePromise=async(i:Item)=>{
  try{
   await post(`/api/manufacturing/items/${i.id}/commitments`,{promised_date:promise,detail:promiseNote});
   invalidate('/api/manufacturing');setPromise('');setPromiseNote('');toast('Vendor commitment recorded.',{kind:'success'});
  }catch(e){toastError(e);}
 };
 const label=(i:Item,stage:Stage)=>q.data?.labels.find(x=>x.means===i.means&&x.stage===stage)?.label??stage;
 return <div className="proc-stack" data-testid="manufacturing-control">
  <h2>Manufacturing and receipts</h2>
  <p className="muted">Track individual components across projects. A vendor commitment or progress update never automatically marks an item in stock.</p>
  <p><strong>{items.length}</strong> components · <strong>{items.filter(i=>i.latest_promise&&i.latest_promise<today&&!i.in_stock_at).length}</strong> past vendor commitment · <strong>{items.filter(i=>i.escalation!=='none').length}</strong> escalated</p>
  <label>Show <select className="field-input" value={filter} onChange={(e:any)=>setFilter(e.target.value)}><option value="all">All components</option><option value="late">Overdue vendor promises</option><option value="escalated">Escalated items</option></select></label>
  {q.error&&<ErrorBox message={q.error.message} retry={q.refresh}/>}
  {!q.data&&!q.error&&<Spinner/>}
  {visible.map(i=><section className="proc-group" key={i.id}>
   <button className="btn btn-quiet" aria-expanded={opened===i.id} onClick={()=>open(i)}><strong>{i.name}</strong> — {i.project_name} · {label(i,i.stage)} · {i.accepted}/{i.quantity} {i.unit} accepted {i.escalation!=='none'?'· '+i.escalation.toUpperCase():''}</button>
   <p className="muted">{i.latest_promise?'Promised '+i.latest_promise:'No vendor date'}{i.original_promise&&i.original_promise!==i.latest_promise?' (originally '+i.original_promise+')':''} · {i.in_stock_at?'Marked in stock':'Stock pending'}</p>
   {opened===i.id&&<div className="proc-stack" data-testid="manufacturing-editor">
    <label>Manufacturing stage <select className="field-input" value={edit.stage} onChange={(e:any)=>setEdit(v=>({...v,stage:e.target.value}))}>{STAGES.map(s=><option key={s} value={s}>{label(i,s)}</option>)}</select></label>
    <p className="muted">Requested: {i.quantity} {i.unit}. In-process, received, accepted and rejected are separately verified cumulative quantities.</p>
    <div className="proc-bar">{(['in_process','received','accepted','rejected'] as const).map(k=><label key={k}>{k.replace('_',' ')} <input aria-label={k} className="field-input" type="number" min={0} max={i.quantity} step="any" value={edit[k]} onChange={(e:any)=>setEdit(v=>({...v,[k]:e.target.value}))}/></label>)}</div>
    <label>Escalation <select className="field-input" value={edit.escalation} onChange={(e:any)=>setEdit(v=>({...v,escalation:e.target.value}))}><option value="none">None</option><option value="attention">Attention</option><option value="critical">Critical</option></select></label>
    <label>Progress note <textarea aria-label="Manufacturing progress note" className="field-input" rows={2} maxLength={700} value={edit.detail} onChange={(e:any)=>setEdit(v=>({...v,detail:e.target.value}))}/></label>
    <button className="btn btn-primary" disabled={!edit.detail.trim()} onClick={()=>void save(i)}>Save manufacturing progress</button>
    <h3>Record vendor promise</h3>
    <label>Committed delivery date <input aria-label="Committed delivery date" type="date" className="field-input" value={promise} onChange={(e:any)=>setPromise(e.target.value)}/></label>
    <label>What did the vendor confirm? <textarea aria-label="Vendor commitment note" className="field-input" maxLength={700} rows={2} value={promiseNote} onChange={(e:any)=>setPromiseNote(e.target.value)}/></label>
    <button className="btn" disabled={!promise||!promiseNote.trim()} onClick={()=>void savePromise(i)}>Record promise</button>
    <h3>Immutable progress and commitment history</h3>
    {history.error&&<ErrorBox message={history.error.message} retry={history.refresh}/>}
    {history.data?.events.map(e=><p key={e.id}><strong>{dateTime(e.at)}</strong> · {e.kind==='commitment'?'Vendor promised '+e.promised_date:'Progress: '+e.stage} · {e.detail} · {user(e.user_id)?.name??'Unknown'}</p>)}
   </div>}
  </section>)}
 </div>;
}
