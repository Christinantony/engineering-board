// The procurement tracker (decision #39): a project's inventory and
// procurement workbook as one page. The master list is the only place items
// are typed; the assembly checklist and the pending list are views of it; the
// log shows when each item came into stock.

import { useEffect, useMemo, useState } from 'react';
import { PROCUREMENT_MEANS, PROCUREMENT_MEANS_LABEL, type ProcurementItem, type ProcurementLogEntry, type ProcurementMeans } from '@board/shared';
import { useApp } from '../context.ts';
import { del, patch, post, put } from '../lib/api.ts';
import { ask } from '../lib/dialogs.ts';
import { dateTime, when } from '../lib/format.ts';
import { navigate, replaceParams, useLocation } from '../lib/router.ts';
import { invalidate, useQuery } from '../lib/store.ts';
import { toast, toastError } from '../lib/toasts.ts';
import { ErrorBox, Spinner } from '../components/bits.tsx';

interface Data {
  project: { id: number; name: string };
  items: ProcurementItem[];
  log: ProcurementLogEntry[];
  totals: { items: number; in_stock: number; pending: number };
  suggestions: { disciplines: string[]; categories: string[]; units: string[] };
  copy_from: { id: number; name: string; items: number }[];
}

type Tab = 'master' | 'checklist' | 'pending' | 'log' | 'followups';
const TABS: { id: Tab; label: string }[] = [
  { id: 'master', label: 'Master list' },
  { id: 'checklist', label: 'Assembly checklist' },
  { id: 'pending', label: 'Pending procurement' },
  { id: 'log', label: 'Procurement log' },
  { id: 'followups', label: 'Follow-up control' },
];

const qty = (i: ProcurementItem) => `${Number.isInteger(i.quantity) ? i.quantity : i.quantity.toFixed(2).replace(/0+$/, '')} ${i.unit}`;
const refresh = (projectId: number) => invalidate((k) => k.startsWith(`/api/projects/${projectId}/procurement`));
/** Tooling, as the workbook splits the assembly checklist: the Tools means, or a "Tool" category. */
const isTooling = (i: ProcurementItem) => i.means === 'tools' || /^tool/i.test(i.category);

export function Procurement() {
  const { projects } = useApp();
  const { params } = useLocation();
  const projectId = Number(params.get('project')) || null;
  const tab = (TABS.some((t) => t.id === params.get('tab')) ? params.get('tab') : 'master') as Tab;
  const q = useQuery<Data>(projectId ? `/api/projects/${projectId}/procurement` : null);
  const set = (k: string, v: string | null) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    replaceParams(p);
  };
  const d = q.data;

  return (
    <div className="view procurement-view">
      <header className="view-head">
        <div className="view-head-row">
          <div>
            <h1>Procurement</h1>
            <p className="view-lede">
              One list per project: type each item once in the master list. The assembly checklist and the pending list follow from it, and the log records when
              each item came into stock.
            </p>
          </div>
          <div className="proc-head-buttons">
            {projectId && (
              <button className="btn btn-quiet" onClick={() => navigate(`/projects?project=${projectId}`)}>
                Project jobs
              </button>
            )}
            {d && (
              <>
                <a className="btn" href={`/api/projects/${d.project.id}/procurement.csv`} download>
                  Export to Excel (CSV)
                </a>
                <button className="btn" onClick={() => window.print()}>
                  Print
                </button>
              </>
            )}
          </div>
        </div>
        <div className="proc-bar">
          <select className="field-input proc-project" value={projectId ?? ''} aria-label="Project" onChange={(e: any) => set('project', e.target.value || null)}>
            <option value="">Choose a project…</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {d && (
            <span className="proc-totals" data-testid="proc-totals">
              <strong>{d.totals.items}</strong> items · <strong className="proc-ok">{d.totals.in_stock}</strong> in stock · <strong className={d.totals.pending ? 'proc-due' : ''}>{d.totals.pending}</strong> pending
            </span>
          )}
        </div>
        {d && (
          <div className="seg-tabs proc-tabs" role="tablist" aria-label="Procurement sheets">
            {TABS.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => set('tab', t.id === 'master' ? null : t.id)}>
                {t.label}
                {t.id === 'pending' && d.totals.pending ? ` (${d.totals.pending})` : ''}
              </button>
            ))}
          </div>
        )}
      </header>

      {!projectId && <p className="muted proc-empty">Choose a project to see its procurement list.</p>}
      {q.error && !q.data && <ErrorBox message={q.error.message} retry={q.refresh} />}
      {projectId && !q.data && !q.error && <Spinner />}
      {d && (
        <div className="proc-sheet" data-testid={`proc-${tab}`}>
          <h2 className="print-only">
            {d.project.name} · {TABS.find((t) => t.id === tab)!.label}
          </h2>
          {tab === 'master' && <MasterList d={d} />}
          {tab === 'checklist' && <AssemblyChecklist d={d} />}
          {tab === 'pending' && <Pending d={d} />}
          {tab === 'log' && <Log d={d} />}
          {tab === 'followups' && <FollowupControl />}
        </div>
      )}
    </div>
  );
}

async function setStock(i: ProcurementItem, inStock: boolean) {
  try {
    await post(`/api/procurement/items/${i.id}/stock`, { in_stock: inStock });
    refresh(i.project_id);
  } catch (e) {
    toastError(e);
  }
}

/** The in-stock tick: shows the change at once, then follows the board's answer. */
function StockBox({ i }: { i: ProcurementItem }) {
  const [shown, setShown] = useState<boolean | null>(null);
  useEffect(() => setShown(null), [i.in_stock_at]);
  const checked = shown ?? !!i.in_stock_at;
  return (
    <input
      type="checkbox"
      checked={checked}
      aria-label={`${i.name} in stock`}
      onChange={(e: any) => {
        const next = e.target.checked;
        setShown(next);
        void setStock(i, next).finally(() => setTimeout(() => setShown(null), 2000));
      }}
    />
  );
}

/** A cell of the master list that saves when you leave it (with the item's version, so nobody overwrites anybody). */
function Cell({ i, field, label, list, type = 'text', wide }: { i: ProcurementItem; field: keyof ProcurementItem; label: string; list?: string; type?: string; wide?: boolean }) {
  const value = String(i[field] ?? '');
  const [v, setV] = useState(value);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setV(value);
  }, [value, focused]);
  const save = async () => {
    setFocused(false);
    const next = v.trim();
    if (next === value) return;
    if (field === 'name' && !next) return setV(value);
    try {
      await patch(`/api/procurement/items/${i.id}`, { version: i.version, [field]: type === 'number' ? Number(next) : next });
    } catch (e) {
      toastError(e);
      setV(value);
    }
    refresh(i.project_id);
  };
  return (
    <input
      className={`field-input proc-cell${wide ? ' wide' : ''}`}
      value={v}
      type={type}
      step={type === 'number' ? 'any' : undefined}
      min={type === 'number' ? 0 : undefined}
      list={list}
      aria-label={`${label} of ${i.name}`}
      onFocus={() => setFocused(true)}
      onChange={(e: any) => setV(e.target.value)}
      onBlur={() => void save()}
      onKeyDown={(e: any) => {
        if (e.key === 'Enter') e.target.blur();
        if (e.key === 'Escape') {
          setV(value);
          setTimeout(() => e.target.blur());
        }
      }}
    />
  );
}

function MasterList({ d }: { d: Data }) {
  const { user } = useApp();
  const blank = { name: '', discipline: '', category: '', means: 'bought_out' as ProcurementMeans, spec: '', quantity: '1', unit: 'pcs' };
  const [n, setN] = useState(blank);
  const [from, setFrom] = useState('');
  const add = async (e: any) => {
    e.preventDefault();
    if (!n.name.trim()) return;
    try {
      await post(`/api/projects/${d.project.id}/procurement/items`, { ...n, name: n.name.trim(), quantity: Number(n.quantity) || 1 });
      setN({ ...blank, discipline: n.discipline, category: n.category, means: n.means, unit: n.unit });
      refresh(d.project.id);
      setTimeout(() => (document.querySelector('input[aria-label="New item"]') as HTMLInputElement | null)?.focus());
    } catch (err) {
      toastError(err);
    }
  };
  const remove = async (i: ProcurementItem) => {
    const ok = await ask({
      type: 'confirm',
      title: `Remove ${i.name}?`,
      body: 'It comes off the master list, the checklist and the pending list. The procurement log keeps what happened to it.',
      confirm: 'Remove',
      danger: true,
    });
    if (!ok) return;
    try {
      await del(`/api/procurement/items/${i.id}`);
      refresh(d.project.id);
    } catch (e) {
      toastError(e);
    }
  };
  const copy = async () => {
    const source = d.copy_from.find((p) => String(p.id) === from);
    if (!source) return;
    try {
      const r = await post<{ copied: number; skipped: number }>(`/api/projects/${d.project.id}/procurement/copy`, { from_project_id: source.id });
      toast(`Copied ${r.copied} item${r.copied === 1 ? '' : 's'} from ${source.name}, all pending${r.skipped ? ` (${r.skipped} already on the list)` : ''}.`, { kind: 'success' });
      setFrom('');
      refresh(d.project.id);
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <>
      <datalist id="proc-disciplines">
        {d.suggestions.disciplines.map((x) => (
          <option key={x} value={x} />
        ))}
      </datalist>
      <datalist id="proc-categories">
        {d.suggestions.categories.map((x) => (
          <option key={x} value={x} />
        ))}
      </datalist>
      <datalist id="proc-units">
        {d.suggestions.units.map((x) => (
          <option key={x} value={x} />
        ))}
      </datalist>
      <div className="proc-scroll">
        <table className="table proc-table" data-testid="master-list">
          <thead>
            <tr>
              <th className="num">No.</th>
              <th>Item</th>
              <th>Discipline</th>
              <th>Category</th>
              <th>Means</th>
              <th>Final size / spec</th>
              <th>Quantity</th>
              <th>In stock</th>
              <th>Notes (PO, supplier…)</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {d.items.map((i, k) => (
              <tr key={i.id} className={i.in_stock_at ? 'proc-in' : ''} data-item={i.name}>
                <td className="num muted">{k + 1}</td>
                <td>
                  <Cell i={i} field="name" label="Item" wide />
                </td>
                <td>
                  <Cell i={i} field="discipline" label="Discipline" list="proc-disciplines" />
                </td>
                <td>
                  <Cell i={i} field="category" label="Category" list="proc-categories" />
                </td>
                <td>
                  <select
                    className="field-input proc-cell proc-means"
                    value={i.means}
                    aria-label={`Means of ${i.name}`}
                    onChange={async (e: any) => {
                      try {
                        await patch(`/api/procurement/items/${i.id}`, { version: i.version, means: e.target.value });
                      } catch (err) {
                        toastError(err);
                      }
                      refresh(i.project_id);
                    }}
                  >
                    {PROCUREMENT_MEANS.map((m) => (
                      <option key={m} value={m}>
                        {PROCUREMENT_MEANS_LABEL[m]}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <Cell i={i} field="spec" label="Final size / spec" wide />
                </td>
                <td className="proc-qty">
                  <Cell i={i} field="quantity" label="Quantity" type="number" />
                  <Cell i={i} field="unit" label="Unit" list="proc-units" />
                </td>
                <td>
                  <label className="proc-stock">
                    <StockBox i={i} />
                    {i.in_stock_at ? (
                      <span className="small" title={`Marked by ${user(i.in_stock_by)?.name ?? 'someone'}`}>
                        {when(i.in_stock_at)}
                      </span>
                    ) : (
                      <span className="muted small">Pending</span>
                    )}
                  </label>
                </td>
                <td>
                  <Cell i={i} field="notes" label="Notes" wide />
                </td>
                <td>
                  <button className="icon-btn" aria-label={`Remove ${i.name}`} title="Remove" onClick={() => void remove(i)}>
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="no-print">
            <tr>
              <td className="num muted">{d.items.length + 1}</td>
              <td colSpan={9}>
                <form className="proc-add" onSubmit={add}>
                  <input className="field-input wide" value={n.name} maxLength={120} placeholder="Item" aria-label="New item" onChange={(e: any) => setN({ ...n, name: e.target.value })} />
                  <input className="field-input" value={n.discipline} maxLength={40} placeholder="Discipline" list="proc-disciplines" aria-label="New item's discipline" onChange={(e: any) => setN({ ...n, discipline: e.target.value })} />
                  <input className="field-input" value={n.category} maxLength={40} placeholder="Category" list="proc-categories" aria-label="New item's category" onChange={(e: any) => setN({ ...n, category: e.target.value })} />
                  <select className="field-input" value={n.means} aria-label="New item's means" onChange={(e: any) => setN({ ...n, means: e.target.value })}>
                    {PROCUREMENT_MEANS.map((m) => (
                      <option key={m} value={m}>
                        {PROCUREMENT_MEANS_LABEL[m]}
                      </option>
                    ))}
                  </select>
                  <input className="field-input wide" value={n.spec} maxLength={200} placeholder="Final size / spec" aria-label="New item's final size or spec" onChange={(e: any) => setN({ ...n, spec: e.target.value })} />
                  <input className="field-input narrow" type="number" min={0} step="any" value={n.quantity} aria-label="New item's quantity" onChange={(e: any) => setN({ ...n, quantity: e.target.value })} />
                  <input className="field-input narrow" value={n.unit} maxLength={12} list="proc-units" aria-label="New item's unit" onChange={(e: any) => setN({ ...n, unit: e.target.value })} />
                  <button className="btn btn-primary" disabled={!n.name.trim()}>
                    Add item
                  </button>
                </form>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      {!!d.copy_from.length && (
        <div className="proc-copy no-print">
          <span>{d.items.length ? "Add another project's items:" : "Start from another project's list:"}</span>
          <select className="field-input" value={from} aria-label="Copy the list of" onChange={(e: any) => setFrom(e.target.value)}>
            <option value="">Choose a project…</option>
            {d.copy_from.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.items} items)
              </option>
            ))}
          </select>
          <button className="btn" disabled={!from} onClick={() => void copy()}>
            Copy its items
          </button>
          <span className="muted small">Copied items start as pending, without notes. Items already on this list are skipped.</span>
        </div>
      )}
    </>
  );
}

function AssemblyChecklist({ d }: { d: Data }) {
  const groups = useMemo(() => {
    const byDiscipline = new Map<string, { components: ProcurementItem[]; tooling: ProcurementItem[] }>();
    for (const i of d.items) {
      const k = i.discipline || 'Other';
      if (!byDiscipline.has(k)) byDiscipline.set(k, { components: [], tooling: [] });
      byDiscipline.get(k)![isTooling(i) ? 'tooling' : 'components'].push(i);
    }
    return [...byDiscipline.entries()].sort(([a], [b]) => (a === 'Other' ? 1 : b === 'Other' ? -1 : a.localeCompare(b)));
  }, [d.items]);
  if (!d.items.length) return <p className="muted">Nothing on the master list yet.</p>;
  const ready = d.totals.in_stock === d.totals.items;
  return (
    <>
      <p className={`proc-ready${ready ? ' ok' : ''}`} data-testid="proc-ready">
        {ready ? 'Everything is in stock: ready to assemble.' : `${d.totals.pending} of ${d.totals.items} items still to come before assembly.`}
      </p>
      <div className="proc-groups">
        {groups.map(([discipline, g]) =>
          (['components', 'tooling'] as const)
            .filter((kind) => g[kind].length)
            .map((kind) => {
              const list = g[kind];
              const have = list.filter((i) => i.in_stock_at).length;
              return (
                <section key={`${discipline}-${kind}`} className="proc-group" data-group={`${discipline} ${kind}`}>
                  <h3>
                    {discipline} · {kind === 'components' ? 'Components' : 'Tooling'}
                    <span className={`proc-count${have === list.length ? ' ok' : ''}`}>
                      {have} of {list.length} in stock
                    </span>
                  </h3>
                  <ul>
                    {list.map((i) => (
                      <li key={i.id} className={i.in_stock_at ? 'in' : ''}>
                        <span className="proc-mark" aria-label={i.in_stock_at ? 'In stock' : 'Pending'}>
                          {i.in_stock_at ? '✓' : '○'}
                        </span>
                        <span className="proc-name">{i.name}</span>
                        <span className="muted small">
                          {[i.category, i.spec, qty(i), PROCUREMENT_MEANS_LABEL[i.means]].filter(Boolean).join(' · ')}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            }),
        )}
      </div>
    </>
  );
}

function Pending({ d }: { d: Data }) {
  const pending = d.items.filter((i) => !i.in_stock_at);
  if (!d.items.length) return <p className="muted">Nothing on the master list yet.</p>;
  if (!pending.length) return <p className="proc-ready ok">Nothing pending: every item is in stock.</p>;
  return (
    <div className="proc-stack">
      {PROCUREMENT_MEANS.map((m) => {
        const list = pending.filter((i) => i.means === m);
        if (!list.length) return null;
        return (
          <section key={m} className="proc-group" data-group={m}>
            <h3>
              {PROCUREMENT_MEANS_LABEL[m]} <span className="proc-count">{list.length}</span>
            </h3>
            <table className="table proc-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Discipline</th>
                  <th>Final size / spec</th>
                  <th>Quantity</th>
                  <th>Notes (PO, supplier…)</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((i) => (
                  <tr key={i.id} data-item={i.name}>
                    <td>{i.name}</td>
                    <td>{i.discipline}</td>
                    <td>{i.spec}</td>
                    <td>{qty(i)}</td>
                    <td>
                      <Cell i={i} field="notes" label="Notes" wide />
                    </td>
                    <td className="no-print">
                      <button className="btn btn-small btn-primary" onClick={() => void setStock(i, true)}>
                        Mark in stock
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })}
    </div>
  );
}

const LOG_LABEL: Record<ProcurementLogEntry['kind'], string> = {
  in_stock: 'In stock',
  not_in_stock: 'Back to pending',
  added: 'Added to the list',
  removed: 'Removed from the list',
};

function Log({ d }: { d: Data }) {
  const { user } = useApp();
  const [all, setAll] = useState(false);
  const rows = d.log.filter((l) => all || l.kind === 'in_stock' || l.kind === 'not_in_stock');
  return (
    <>
      <label className="proc-log-all no-print">
        <input type="checkbox" checked={all} onChange={(e: any) => setAll(e.target.checked)} /> Also show items added and removed
      </label>
      {!rows.length ? (
        <p className="muted">Nothing has been marked in stock yet.</p>
      ) : (
        <table className="table proc-table" data-testid="proc-log">
          <thead>
            <tr>
              <th>Date and time</th>
              <th>What</th>
              <th>Item</th>
              <th>Final size / spec</th>
              <th>By</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l.id} className={`log-${l.kind}`}>
                <td>{dateTime(l.at)}</td>
                <td>{LOG_LABEL[l.kind]}</td>
                <td>{l.item_name}</td>
                <td>{l.item_spec}</td>
                <td>{user(l.user_id)?.name ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}


interface FollowupItem extends ProcurementItem {
 project_name: string; owner_id: number | null; next_action: string; next_due: string | null;
 followup_version: number; last_called_at: string | null; last_outcome: string | null;
}
interface CallRecord {id:number;user_id:number|null;at:string;outcome:string;note:string;next_due:string|null}
function FollowupControl() {
 const q = useQuery<{items:FollowupItem[]}>('/api/procurement/followups');
 const { user, users, meta } = useApp();
 const [opened,setOpened] = useState<number|null>(null);
 const [owner,setOwner] = useState('');
 const [action,setAction] = useState('');
 const [due,setDue] = useState('');
 const [outcome,setOutcome] = useState('progress');
 const [notes,setNotes] = useState('');
 const [callDate,setCallDate] = useState('');
 const history = useQuery<{calls:CallRecord[]}>(opened ? `/api/procurement/items/${opened}/followups` : null);
 const items = q.data?.items ?? [];
 const today = meta.today;
 const sorted = items;
 const choose = (i:FollowupItem) => {setOpened(i.id);setOwner(i.owner_id == null?'':String(i.owner_id));setAction(i.next_action);setDue(i.next_due??'');setOutcome('progress');setNotes('');setCallDate(i.next_due??'');};
 const save = async(i:FollowupItem) => {try {
   await put(`/api/procurement/items/${i.id}/followup`,{version:i.followup_version,owner_id:owner ? Number(owner) : null,next_action:action,next_due:due||null});
   invalidate(k=>k.startsWith('/api/procurement/followups'));toast('Next follow-up saved.',{kind:'success'});
 }catch(e){toastError(e);invalidate(k=>k.startsWith('/api/procurement/followups'));}};
 const log = async(i:FollowupItem) => {try {
   await post(`/api/procurement/items/${i.id}/followups`,{outcome,note:notes,next_due:callDate||null});
   setNotes('');invalidate(k=>k.startsWith('/api/procurement/followups')||k.includes('/followups'));toast('Call recorded. Update the next action separately if it changed.',{kind:'success'});
 }catch(e){toastError(e);}};
 return <div className="proc-stack" data-testid="proc-followups">
   <h2>Follow-up control</h2>
   <p className="muted">All outstanding components across projects. An item stays here until it is marked in stock. Every vendor call is kept in its history.</p>
   <p><strong>{items.filter(i=>i.next_due&&i.next_due<today).length}</strong> overdue · <strong>{items.filter(i=>i.next_due===today).length}</strong> due today · <strong>{items.filter(i=>!i.next_due).length}</strong> without a date</p>
   {q.error&&<ErrorBox message={q.error.message} retry={q.refresh}/>}
   {!q.data&&!q.error&&<Spinner/>}
   {sorted.map(i=><section className="proc-group" key={i.id}>
     <button className="btn btn-quiet" aria-expanded={opened===i.id} onClick={()=>opened===i.id?setOpened(null):choose(i)}>
       <strong>{i.name}</strong> · {i.project_name} · {i.next_due ? (i.next_due<today?'Overdue: ': 'Follow up: ')+i.next_due : 'Unscheduled'}
     </button>
     <p className="muted">{i.next_action||'No next action assigned'} · {i.last_called_at ? 'Last contact '+dateTime(i.last_called_at):'No contact logged'}</p>
     {opened===i.id&&<div className="proc-stack">
       <label>Responsible colleague <select className="field-input" value={owner} onChange={(e:any)=>setOwner(e.target.value)}><option value="">Unassigned</option>{users.filter(u=>u.active).map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
       <label>Next action <input className="field-input" maxLength={300} value={action} onChange={(e:any)=>setAction(e.target.value)}/></label>
       <label>Next follow-up <input className="field-input" type="date" value={due} onChange={(e:any)=>setDue(e.target.value)}/></label>
       <button className="btn btn-primary" onClick={()=>void save(i)}>Save next action</button>
       <h3>Log a contact</h3>
       <label>Outcome <select className="field-input" value={outcome} onChange={(e:any)=>setOutcome(e.target.value)}>{[['progress','Progressing'],['delayed','Delayed'],['ready','Vendor says ready'],['unreachable','Not reachable'],['other','Other']].map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
       <label>Notes <textarea className="field-input" rows={2} value={notes} maxLength={1000} onChange={(e:any)=>setNotes(e.target.value)}/></label>
       <label>Next contact date (as reported) <input className="field-input" type="date" value={callDate} onChange={(e:any)=>setCallDate(e.target.value)}/></label>
       <button className="btn" disabled={!notes.trim()} onClick={()=>void log(i)}>Record contact</button>
       <h3>Contact history</h3>
       {history.data?.calls.map(c=><p key={c.id}><strong>{dateTime(c.at)} — {c.outcome}</strong>: {c.note} {c.next_due ? '(next '+c.next_due+')':''} · {user(c.user_id)?.name??'Unknown'}</p>)}
     </div>}
   </section>)}
 </div>;
}
