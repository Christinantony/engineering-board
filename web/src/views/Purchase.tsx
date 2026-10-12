
import {useState} from 'react';
import {useApp} from '../context.ts';
import {useQuery,invalidate} from '../lib/store.ts';
import {post,put} from '../lib/api.ts';
import {toast,toastError} from '../lib/toasts.ts';
import {Spinner,ErrorBox} from '../components/bits.tsx';
import {dateTime} from '../lib/format.ts';
type Vendor={id:number;name:string;phone:string;contact:string;email:string;process_notes:string;active:number};
type Item={id:number;project_name:string;name:string;quantity:number;unit:string;in_stock_at:string|null;vendor_id:number|null;po_ref:string|null;order_status:string|null;purchase_owner_id:number|null;version:number;next_action:string|null;next_due:string|null;latest_promise:string|null;};
type Data={items:Item[];vendors:Vendor[]};
export function Purchase(){
 const {me,users,user,meta}=useApp();
 const q=useQuery<Data>('/api/purchase/queue');
 const [id,setId]=useState<number|null>(null),[filter,setFilter]=useState('open'),[tab,setTab]=useState('orders');
 const [vendorName,setVendorName]=useState(''),[vendorPhone,setVendorPhone]=useState(''),[vendorContact,setVendorContact]=useState(''),[vendorNotes,setVendorNotes]=useState('');
 const [draft,setDraft]=useState({vendor_id:'',po_ref:'',order_status:'requested',purchase_owner_id:'',detail:''});
 const [call,setCall]=useState({outcome:'progress',note:'',next_due:''});
 const history=useQuery<{events:{id:number;at:string;user_id:number|null;detail:string;order_status:string|null}[]}>(id?'/api/purchase/items/'+id:null);
 const today=meta.today,selected=q.data?.items.find(x=>x.id===id);
 const items=(q.data?.items??[]).filter(x=>filter==='all'||(filter==='open'&&!x.in_stock_at)||(filter==='mine'&&!x.in_stock_at&&x.purchase_owner_id===me.id)||(filter==='overdue'&&!x.in_stock_at&&((!!x.next_due&&x.next_due<today)||(!!x.latest_promise&&x.latest_promise<today))));
 const open=(x:Item)=>{setId(id===x.id?null:x.id);setDraft({vendor_id:String(x.vendor_id??''),po_ref:x.po_ref??'',order_status:x.order_status??'requested',purchase_owner_id:String(x.purchase_owner_id??''),detail:''});setCall({outcome:'progress',note:'',next_due:''});};
 const save=async()=>{if(!selected)return;try{await put('/api/purchase/items/'+selected.id,{version:selected.version,vendor_id:draft.vendor_id?Number(draft.vendor_id):null,po_ref:draft.po_ref,order_status:draft.order_status,purchase_owner_id:draft.purchase_owner_id?Number(draft.purchase_owner_id):null,detail:draft.detail});setDraft(v=>({...v,detail:''}));invalidate('/api/purchase/queue');toast('Purchase record saved.',{kind:'success'});}catch(e){toastError(e);invalidate('/api/purchase/queue');}};
 const log=async()=>{if(!selected)return;try{await post('/api/procurement/items/'+selected.id+'/followups',{outcome:call.outcome,note:call.note,next_due:call.next_due||null});setCall(v=>({...v,note:''}));invalidate('/api/purchase/queue');toast('Vendor call recorded.',{kind:'success'});}catch(e){toastError(e);}};
 const addVendor=async()=>{try{await post('/api/purchase/vendors',{name:vendorName,phone:vendorPhone,contact:vendorContact,email:'',process_notes:vendorNotes});setVendorName('');setVendorPhone('');setVendorContact('');setVendorNotes('');invalidate('/api/purchase/queue');toast('Supplier added.',{kind:'success'});}catch(e){toastError(e);}};
 return <div className="proc-stack" data-testid="purchase-workspace">
  <h1>Purchase coordination</h1><p className="muted">One queue shared with Mechanical. Commercial details and vendor contacts are here; engineering jobs and drawing reviews remain private to their teams.</p>
  <div className="seg-tabs"><button className="btn" onClick={()=>setTab('orders')}>Purchase queue</button><button className="btn" onClick={()=>setTab('vendors')}>Suppliers</button></div>
  {q.error&&<ErrorBox message={q.error.message} retry={q.refresh}/>}
  {!q.data&&!q.error&&<Spinner/>}
  {tab==='orders'&&<>
   <p><strong>{(q.data?.items??[]).filter(x=>!x.in_stock_at).length}</strong> outstanding · <strong>{(q.data?.items??[]).filter(x=>x.next_due&&x.next_due<today&&!x.in_stock_at).length}</strong> overdue follow-ups</p>
   <label>Show <select className="field-input" value={filter} onChange={(e:any)=>setFilter(e.target.value)}><option value="open">Outstanding</option><option value="mine">Assigned to me</option><option value="overdue">Overdue</option><option value="all">All including received</option></select></label>
   {items.map(x=><section className="proc-group" key={x.id}>
    <button className="btn btn-quiet" aria-expanded={id===x.id} onClick={()=>open(x)}><strong>{x.name}</strong> · {x.project_name} · {x.order_status??'Requested'} · {x.po_ref||'No PO'}</button>
    <p className="muted">{x.quantity} {x.unit} · {x.next_action||'No next action'} · {x.next_due?'Follow up '+x.next_due:'No follow-up date'} {x.latest_promise?'· Vendor promised '+x.latest_promise:''}</p>
    {id===x.id&&<div className="proc-stack" data-testid="purchase-editor">
     <label>Supplier <select className="field-input" value={draft.vendor_id} onChange={(e:any)=>setDraft(v=>({...v,vendor_id:e.target.value}))}><option value="">Not chosen</option>{q.data?.vendors.filter(v=>v.active||v.id===x.vendor_id).map(v=><option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
     <label>Purchase owner <select className="field-input" value={draft.purchase_owner_id} onChange={(e:any)=>setDraft(v=>({...v,purchase_owner_id:e.target.value}))}><option value="">Unassigned</option>{users.filter(u=>u.role==='purchase'&&u.active).map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
     <label>Status <select className="field-input" value={draft.order_status} onChange={(e:any)=>setDraft(v=>({...v,order_status:e.target.value}))}>{[['requested','Requested'],['quoted','Quotation received'],['ordered','Ordered'],['part_received','Part received'],['closed','Closed']].map(([a,b])=><option key={a} value={a}>{b}</option>)}</select></label>
     <label>PO reference <input className="field-input" value={draft.po_ref} maxLength={100} onChange={(e:any)=>setDraft(v=>({...v,po_ref:e.target.value}))}/></label>
     <label>Update note <textarea className="field-input" aria-label="Purchase update note" rows={2} maxLength={700} value={draft.detail} onChange={(e:any)=>setDraft(v=>({...v,detail:e.target.value}))}/></label>
     <button className="btn btn-primary" disabled={!draft.detail.trim()} onClick={()=>void save()}>Save purchase update</button>
     <h3>Vendor contact</h3>
     <label>Outcome <select className="field-input" value={call.outcome} onChange={(e:any)=>setCall(v=>({...v,outcome:e.target.value}))}>{['progress','delayed','ready','unreachable','other'].map(s=><option key={s}>{s}</option>)}</select></label>
     <label>Notes <textarea className="field-input" aria-label="Vendor contact notes" rows={2} maxLength={1000} value={call.note} onChange={(e:any)=>setCall(v=>({...v,note:e.target.value}))}/></label>
     <label>Next contact date <input className="field-input" type="date" value={call.next_due} onChange={(e:any)=>setCall(v=>({...v,next_due:e.target.value}))}/></label>
     <button className="btn" disabled={!call.note.trim()} onClick={()=>void log()}>Record contact</button>
     <h3>Purchase history</h3>{history.data?.events.map(e=><p key={e.id}><strong>{dateTime(e.at)}</strong> · {e.order_status} · {e.detail} · {user(e.user_id)?.name??'Unknown'}</p>)}
    </div>}
   </section>)}
  </>}
  {tab==='vendors'&&<section className="proc-group">
   <h2>Supplier directory</h2>{q.data?.vendors.map(v=><p key={v.id}><strong>{v.name}</strong> · {v.contact} · {v.phone} · {v.process_notes}</p>)}
   <h3>Add supplier</h3>
   <label>Name <input className="field-input" value={vendorName} maxLength={100} onChange={(e:any)=>setVendorName(e.target.value)}/></label>
   <label>Contact <input className="field-input" value={vendorContact} onChange={(e:any)=>setVendorContact(e.target.value)}/></label>
   <label>Phone <input className="field-input" value={vendorPhone} onChange={(e:any)=>setVendorPhone(e.target.value)}/></label>
   <label>Typical processes <textarea className="field-input" rows={2} value={vendorNotes} onChange={(e:any)=>setVendorNotes(e.target.value)}/></label>
   <button className="btn btn-primary" disabled={!vendorName.trim()} onClick={()=>void addVendor()}>Add supplier</button>
  </section>}
 </div>;
}
