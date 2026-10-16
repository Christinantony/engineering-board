// The procurement tracker (decision #39): a project's inventory and
// procurement workbook as one page. The master list is the only place items
// are typed; the assembly checklist and the pending list are views of it; the
// log shows when each item came into stock.

import { useEffect, useMemo, useState } from 'react';
import { ManufacturingControl } from './ManufacturingControl.tsx';
import {
  PROCUREMENT_BASES,
  PROCUREMENT_BASIS_LABEL,
  PROCUREMENT_MEANS,
  PROCUREMENT_MEANS_LABEL,
  basisForCategory,
  type ProcurementBasis,
  type ProcurementBuild,
  type ProcurementItem,
  type ProcurementLogEntry,
  type ProcurementMeans,
} from '@board/shared';
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
  build: ProcurementBuild;
  build_log: { id: number; user_id: number | null; at: string; arrays: number; per_array: number; spares: number }[];
  items: ProcurementItem[];
  log: ProcurementLogEntry[];
  totals: { items: number; in_stock: number; pending: number };
  suggestions: { disciplines: string[]; categories: string[]; units: string[]; materials: string[] };
  copy_from: { id: number; name: string; items: number }[];
}

type Tab = 'master' | 'checklist' | 'pending' | 'log' | 'followups' | 'manufacturing';
const TABS: { id: Tab; label: string }[] = [
  { id: 'master', label: 'Master list' },
  { id: 'checklist', label: 'Assembly checklist' },
  { id: 'pending', label: 'Pending procurement' },
  { id: 'log', label: 'Procurement log' },
  { id: 'followups', label: 'Follow-up control' },
  { id: 'manufacturing', label: 'Manufacturing' },
];

const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/\.?0+$/, ''));
/** The total needed, and how it was worked out when it depends on the build: "64 pcs (2 per antenna)". */
const qty = (i: ProcurementItem) => `${num(i.required)} ${i.unit}${i.basis === 'total' ? '' : ` (${num(i.quantity)} ${PROCUREMENT_BASIS_LABEL[i.basis]})`}`;
/** The basis the workbook gives a category: Single Antenna per antenna, Array per array, anything else in total. */
const basisFor = (category: string): ProcurementBasis => basisForCategory(category) ?? 'total';
/** A total that depends on a build nobody has given yet: the workbook shows it amber. */
const unset = (i: ProcurementItem, b: ProcurementBuild) => (i.basis === 'antenna' && !b.antennas) || (i.basis === 'array' && !b.arrays);
/** What the inventory cell shows: the count, or the note typed instead. */
const invText = (i: ProcurementItem) => (i.inventory != null ? num(i.inventory) : i.inventory_note);
/** The workbook's "In procurement": what is still to get, or CHECK when the inventory isn't a count. */
function ToProcure({ i }: { i: ProcurementItem }) {
  if (i.to_procure == null)
    return (
      <span className="proc-check" title="The inventory isn't a count: check by hand">
        Check
      </span>
    );
  return <span className={i.to_procure > 0 ? 'proc-short' : 'proc-enough'}>{num(i.to_procure)}</span>;
}
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
  const followupMode = tab === 'followups' || tab === 'manufacturing';

  return (
    <div className="view procurement-view">
      <header className="view-head">
        <div className="view-head-row">
          <div>
            <h1>Procurement</h1>
            <p className="view-lede">
              One list per project: say what it builds, then type each item once in the master list, counted per antenna, per array or in total. The assembly
              checklist and the pending list follow from it, and the log records when each item came into stock.
            </p>
          </div>
          <div className="proc-head-buttons">
            <button className="btn btn-quiet" onClick={() => set('tab','followups')}>All follow-ups</button>
            <button className="btn btn-quiet" onClick={() => set('tab','manufacturing')}>Manufacturing</button>
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
        {d && !followupMode && <BuildBar d={d} />}
        {(d || followupMode) && (
          <div className="seg-tabs proc-tabs" role="tablist" aria-label="Procurement sheets">
            {TABS.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => set('tab', t.id === 'master' ? null : t.id)}>
                {t.label}
                {t.id === 'pending' && d?.totals.pending ? ` (${d.totals.pending})` : ''}
              </button>
            ))}
          </div>
        )}
      </header>

      {!projectId && !followupMode && <p className="muted proc-empty">Choose a project to see its procurement list.</p>}
      {q.error && !q.data && <ErrorBox message={q.error.message} retry={q.refresh} />}
      {projectId && !q.data && !q.error && !followupMode && <Spinner />}
      {tab === 'followups' && <FollowupControl />}
      {tab === 'manufacturing' && <ManufacturingControl />}
      {d && !followupMode && (
        <div className="proc-sheet" data-testid={`proc-${tab}`}>
          <h2 className="print-only">
            {d.project.name} · {TABS.find((t) => t.id === tab)!.label}
          </h2>
          {tab === 'master' && <MasterList d={d} />}
          {tab === 'checklist' && <AssemblyChecklist d={d} />}
          {tab === 'pending' && <Pending d={d} />}
          {tab === 'log' && <Log d={d} />}
        </div>
      )}
    </div>
  );
}

/**
 * What the project builds (decision #45): arrays, antennas in each, antennas
 * outside an array. Items counted per antenna or per array follow from it.
 */
function BuildBar({ d }: { d: Data }) {
  const { user } = useApp();
  const b = d.build;
  const [f, setF] = useState({ arrays: String(b.arrays), per_array: String(b.per_array), spares: String(b.spares) });
  const [history, setHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  // follow the board's numbers (someone else's change) unless they're being edited
  const saved = `${b.arrays}|${b.per_array}|${b.spares}`;
  const [base, setBase] = useState(saved);
  if (base !== saved) {
    setBase(saved);
    setF({ arrays: String(b.arrays), per_array: String(b.per_array), spares: String(b.spares) });
  }
  const val = (v: string) => (v.trim() === '' ? 0 : Number(v));
  const nums = { arrays: val(f.arrays), per_array: val(f.per_array), spares: val(f.spares) };
  const valid = Object.values(nums).every((x) => Number.isInteger(x) && x >= 0);
  const antennas = valid ? nums.arrays * nums.per_array + nums.spares : null;
  const dirty = valid && (nums.arrays !== b.arrays || nums.per_array !== b.per_array || nums.spares !== b.spares);
  const perUnit = d.items.filter((i) => i.basis !== 'total').length;
  const save = async (e: any) => {
    e.preventDefault();
    if (!dirty) return;
    setBusy(true);
    try {
      await put(`/api/projects/${d.project.id}/procurement/build`, { version: b.version, ...nums });
      toast(`Build saved: ${antennas} antenna${antennas === 1 ? '' : 's'}. Totals updated.`, { kind: 'success' });
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
      refresh(d.project.id);
    }
  };
  const field = (k: keyof typeof f, label: string, hint?: string) => (
    <label className="proc-build-field">
      <span>{label}</span>
      <input
        className="field-input narrow"
        type="number"
        min={0}
        step={1}
        value={f[k]}
        aria-label={label}
        title={hint}
        onChange={(e: any) => setF({ ...f, [k]: e.target.value })}
      />
    </label>
  );
  return (
    <form className="proc-build" data-testid="proc-build" onSubmit={save}>
      <strong className="proc-build-title">Quantity drivers</strong>
      {field('arrays', 'Number of arrays', 'Number of arrays (0 if the project has no arrays)')}
      <span className="proc-build-op">×</span>
      {field('per_array', 'Antennas per array')}
      <span className="proc-build-op">=</span>
      <span className="proc-build-field proc-build-calc">
        <span>Antennas for arrays</span>
        <strong data-testid="proc-for-arrays">{valid ? nums.arrays * nums.per_array : '–'}</strong>
      </span>
      <span className="proc-build-op">+</span>
      {field('spares', 'Extra antennas (spare)', 'Built as antennas but not part of any array')}
      <span className="proc-build-op">=</span>
      <span className="proc-build-field proc-build-calc proc-build-total">
        <span>Total antennas to build</span>
        <strong data-testid="proc-antennas">{antennas ?? '–'}</strong>
      </span>
      <button className="btn btn-primary btn-small no-print" disabled={!dirty || busy}>
        Save
      </button>
      {dirty && (
        <button type="button" className="link-btn no-print" onClick={() => setF({ arrays: String(b.arrays), per_array: String(b.per_array), spares: String(b.spares) })}>
          Undo
        </button>
      )}
      <span className="muted small proc-build-note">
        {!b.version
          ? perUnit
            ? `Fill these in to work out the total of the ${perUnit} item${perUnit === 1 ? '' : 's'} counted per antenna or per array.`
            : 'Total qty = qty / unit × total antennas to build (per antenna), × number of arrays (per array), or × 1 (in total).'
          : `Changed ${when(b.updated_at!)} by ${user(b.updated_by)?.name ?? 'someone'}.`}{' '}
        {d.build_log.length > 1 && (
          <button type="button" className="link-btn no-print" aria-expanded={history} onClick={() => setHistory(!history)}>
            {history ? 'Hide changes' : 'Earlier builds'}
          </button>
        )}
      </span>
      {history && (
        <ul className="proc-build-log">
          {d.build_log.map((l) => (
            <li key={l.id}>
              {dateTime(l.at)} · {user(l.user_id)?.name ?? ''}: {l.arrays} arrays × {l.per_array} + {l.spares} spare = {l.arrays * l.per_array + l.spares} antennas
            </li>
          ))}
        </ul>
      )}
    </form>
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
      // a new category brings the workbook's basis with it (Single Antenna per antenna, Array per array, Tool in total)
      const basis = field === 'category' ? basisForCategory(next) : null;
      await patch(`/api/procurement/items/${i.id}`, { version: i.version, [field]: type === 'number' ? Number(next) : next, ...(basis ? { basis } : {}) });
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

/** The workbook's inventory cell: a count, NIL for none, or a note when it isn't a plain count. */
export function parseInventory(text: string): { inventory: number | null; inventory_note: string } {
  const t = text.trim();
  if (!t) return { inventory: null, inventory_note: '' };
  if (/^nil$/i.test(t)) return { inventory: 0, inventory_note: '' };
  if (/^\d+(\.\d+)?$/.test(t)) return { inventory: Number(t), inventory_note: '' };
  return { inventory: null, inventory_note: t.slice(0, 80) };
}

function InventoryCell({ i }: { i: ProcurementItem }) {
  const value = invText(i);
  const [v, setV] = useState(value);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setV(value);
  }, [value, focused]);
  const save = async () => {
    setFocused(false);
    if (v.trim() === value) return;
    try {
      await patch(`/api/procurement/items/${i.id}`, { version: i.version, ...parseInventory(v) });
    } catch (e) {
      toastError(e);
      setV(value);
    }
    refresh(i.project_id);
  };
  return (
    <input
      className="field-input proc-cell proc-inv"
      value={v}
      placeholder="–"
      title="What is in hand: a number, NIL for none, or a note (then In procurement says Check)"
      aria-label={`Inventory of ${i.name}`}
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
  const blank = { name: '', discipline: '', category: '', means: 'bought_out' as ProcurementMeans, spec: '', quantity: '1', unit: 'pcs', basis: 'total' as ProcurementBasis, material: '', inventory: '' };
  const [n, setN] = useState(blank);
  // the basis follows the category until someone picks one
  const [basisPicked, setBasisPicked] = useState(false);
  const [from, setFrom] = useState('');
  const add = async (e: any) => {
    e.preventDefault();
    if (!n.name.trim()) return;
    try {
      const { inventory, ...rest } = n;
      await post(`/api/projects/${d.project.id}/procurement/items`, { ...rest, name: n.name.trim(), quantity: Number(n.quantity) || 1, ...parseInventory(inventory) });
      setN({ ...blank, discipline: n.discipline, category: n.category, means: n.means, unit: n.unit, basis: n.basis, material: n.material });
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
  // items whose category says per antenna or per array, but which are counted otherwise
  const mismatched = d.items.filter((i) => {
    const b = basisForCategory(i.category);
    return b && b !== i.basis;
  });
  const byCategory = async () => {
    try {
      const r = await post<{ changed: number }>(`/api/projects/${d.project.id}/procurement/basis-from-category`);
      toast(`${r.changed} item${r.changed === 1 ? '' : 's'} now counted by category.`, { kind: 'success' });
    } catch (e) {
      toastError(e);
    }
    refresh(d.project.id);
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
      <datalist id="proc-materials">
        {d.suggestions.materials.map((x) => (
          <option key={x} value={x} />
        ))}
      </datalist>
      {mismatched.length > 0 && (
        <div className="notice notice-warn proc-basis-notice no-print" data-testid="proc-basis-notice">
          {mismatched.length} item{mismatched.length === 1 ? "'s" : "s'"} category says {mismatched.length === 1 ? 'it is' : 'they are'} counted differently (
          {mismatched
            .slice(0, 3)
            .map((i) => `${i.name}: ${i.category}, now ${PROCUREMENT_BASIS_LABEL[i.basis]}`)
            .join('; ')}
          {mismatched.length > 3 ? ` and ${mismatched.length - 3} more` : ''}).{' '}
          <button className="btn btn-small" onClick={() => void byCategory()}>
            Count by category
          </button>{' '}
          <span className="muted small">Single Antenna per antenna, Array per array, Tool in total, as in the workbook.</span>
        </div>
      )}
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
              <th>Final size / spec</th>
              <th>Qty / unit</th>
              <th className="num">Total qty</th>
              <th>Inventory</th>
              <th className="num">In procurement</th>
              <th>Material</th>
              <th>Discipline</th>
              <th>Category</th>
              <th>Means</th>
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
                  <Cell i={i} field="spec" label="Final size / spec" wide />
                </td>
                <td className="proc-qty">
                  <Cell i={i} field="quantity" label="Quantity" type="number" />
                  <Cell i={i} field="unit" label="Unit" list="proc-units" />
                  <select
                    className="field-input proc-cell proc-basis"
                    value={i.basis}
                    aria-label={`Quantity of ${i.name} is`}
                    onChange={async (e: any) => {
                      try {
                        await patch(`/api/procurement/items/${i.id}`, { version: i.version, basis: e.target.value });
                      } catch (err) {
                        toastError(err);
                      }
                      refresh(i.project_id);
                    }}
                  >
                    {PROCUREMENT_BASES.map((b) => (
                      <option key={b} value={b}>
                        {PROCUREMENT_BASIS_LABEL[b]}
                      </option>
                    ))}
                  </select>
                </td>
                <td className={`num proc-need${unset(i, d.build) ? ' proc-due' : ''}`} data-testid="proc-need" title={i.basis === 'total' ? 'In total' : `${num(i.quantity)} ${PROCUREMENT_BASIS_LABEL[i.basis]} × ${i.basis === 'antenna' ? `${d.build.antennas} antennas to build` : `${d.build.arrays} arrays`}${unset(i, d.build) ? ': fill in the quantity drivers above' : ''}`}>
                  <strong>{num(i.required)}</strong> {i.unit}
                </td>
                <td>
                  <InventoryCell i={i} />
                </td>
                <td className="num" data-testid="proc-to-procure">
                  <ToProcure i={i} />
                </td>
                <td>
                  <Cell i={i} field="material" label="Material" list="proc-materials" wide />
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
              <td colSpan={13}>
                <form className="proc-add" onSubmit={add}>
                  <input className="field-input wide" value={n.name} maxLength={120} placeholder="Item" aria-label="New item" onChange={(e: any) => setN({ ...n, name: e.target.value })} />
                  <input className="field-input" value={n.discipline} maxLength={40} placeholder="Discipline" list="proc-disciplines" aria-label="New item's discipline" onChange={(e: any) => setN({ ...n, discipline: e.target.value })} />
                  <input className="field-input" value={n.category} maxLength={40} placeholder="Category" list="proc-categories" aria-label="New item's category" onChange={(e: any) => setN({ ...n, category: e.target.value, basis: basisPicked ? n.basis : basisFor(e.target.value) })} />
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
                  <select
                    className="field-input"
                    value={n.basis}
                    aria-label="New item's quantity is"
                    onChange={(e: any) => {
                      setBasisPicked(true);
                      setN({ ...n, basis: e.target.value });
                    }}
                  >
                    {PROCUREMENT_BASES.map((b) => (
                      <option key={b} value={b}>
                        {PROCUREMENT_BASIS_LABEL[b]}
                      </option>
                    ))}
                  </select>
                  <input className="field-input" value={n.inventory} maxLength={80} placeholder="Inventory" aria-label="New item's inventory" onChange={(e: any) => setN({ ...n, inventory: e.target.value })} />
                  <input className="field-input" value={n.material} maxLength={80} placeholder="Material" list="proc-materials" aria-label="New item's material" onChange={(e: any) => setN({ ...n, material: e.target.value })} />
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
                          {[i.category, i.spec, qty(i), i.material, PROCUREMENT_MEANS_LABEL[i.means]].filter(Boolean).join(' · ')}
                        </span>
                        <span className="proc-checkqty small">
                          In inventory {invText(i) || '–'} · short <ToProcure i={i} />
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
                  <th>Material</th>
                  <th>Total qty</th>
                  <th>Inventory</th>
                  <th className="num">In procurement</th>
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
                    <td>{i.material}</td>
                    <td>{qty(i)}</td>
                    <td>{invText(i)}</td>
                    <td className="num">
                      <ToProcure i={i} />
                    </td>
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
