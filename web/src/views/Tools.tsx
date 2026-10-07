// Tools (decision #32): small calculators for engineers and the manager. The
// first is the sheet calculator: how many standard sheets a list of flat
// components needs, per material and thickness. Reference data (materials,
// sheet sizes, settings) is kept by the admin under Admin → Tools.

import { useEffect, useMemo, useState } from 'react';
import { calculateSheets, type ComponentInput, type GroupResult, type SheetMaterial, type SheetSettings, type SheetSize } from '@board/shared';
import { useApp } from '../context.ts';
import { navigate, useLocation } from '../lib/router.ts';
import { useQuery } from '../lib/store.ts';
import { toast } from '../lib/toasts.ts';
import { ErrorBox, Spinner } from '../components/bits.tsx';

interface Data {
  materials: SheetMaterial[];
  sizes: SheetSize[];
  settings: SheetSettings;
}

const TOOLS = [
  {
    id: 'sheets',
    name: 'Sheet calculator',
    blurb: 'How many standard sheets a set of flat components needs, per material and thickness, with the best stock size and the sheet mass.',
  },
];

export function Tools() {
  const { params } = useLocation();
  const tool = TOOLS.find((t) => t.id === params.get('tool'));
  return (
    <div className="view tools-view">
      <header className="view-head">
        <div className="view-head-row">
          <h1>{tool ? tool.name : 'Tools'}</h1>
          <span className="spacer" />
          {tool && (
            <button className="btn btn-quiet" onClick={() => navigate('/tools')}>
              All tools
            </button>
          )}
        </div>
        <p className="view-lede">{tool ? tool.blurb : 'Calculators and helpers for the team. The reference data behind them is kept under Admin → Tools.'}</p>
      </header>
      {tool?.id === 'sheets' ? (
        <SheetCalculator />
      ) : (
        <div className="tools-grid">
          {TOOLS.map((t) => (
            <button key={t.id} className="tool-card" onClick={() => navigate(`/tools?tool=${t.id}`)}>
              <span className="tool-name">{t.name}</span>
              <span className="muted">{t.blurb}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- sheet calculator ----

const STORAGE_KEY = 'engineering-board-sheet-calc';
const EMPTY: ComponentInput = { name: '', material_id: null, thickness: null, length: null, width: null, quantity: 1 };

function loadRows(): ComponentInput[] | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const rows = raw ? JSON.parse(raw) : null;
    return Array.isArray(rows) && rows.length ? rows : null;
  } catch {
    return null;
  }
}
function saveRows(rows: ComponentInput[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
  } catch {
    /* storage may be unavailable; the list then lives for this page only */
  }
}

const num = (v: string): number | null => (v.trim() === '' ? null : Number(v));
const fmt = (n: number, d = 0) => n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
const m2 = (mm2: number) => `${fmt(mm2 / 1e6, 2)} m²`;

export function SheetCalculator() {
  const { me } = useApp();
  const data = useQuery<Data>('/api/tools/sheet');
  const [rows, setRows] = useState<ComponentInput[]>(() => loadRows() ?? [{ ...EMPTY }, { ...EMPTY }, { ...EMPTY }]);
  useEffect(() => saveRows(rows), [rows]);

  const materials = (data.data?.materials ?? []).filter((m) => m.active);
  const report = useMemo(
    () => (data.data ? calculateSheets(rows, data.data.materials, data.data.sizes, data.data.settings) : null),
    [rows, data.data],
  );

  if (data.error && !data.data) return <ErrorBox message={data.error.message} retry={data.refresh} />;
  if (!data.data || !report) return <Spinner />;
  const { settings } = data.data;

  const update = (i: number, patch: Partial<ComponentInput>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const remove = (i: number) => setRows(rows.length > 1 ? rows.filter((_, j) => j !== i) : [{ ...EMPTY }]);
  const add = () => {
    const last = rows[rows.length - 1];
    // a new row keeps the material and thickness of the one above: most lists are one material at a time
    setRows([...rows, { ...EMPTY, material_id: last?.material_id ?? null, thickness: last?.thickness ?? null }]);
  };
  const clear = () => {
    setRows([{ ...EMPTY }, { ...EMPTY }, { ...EMPTY }]);
    toast('Component list cleared');
  };
  const print = () => window.print();

  return (
    <div className="sheet-calc">
      <section className="sheet-inputs">
        <h2>Components</h2>
        <p className="muted small">
          Flat blank sizes in mm. Rows without a material or thickness are left out; rows without a size or quantity are listed as skipped. The list is remembered in this
          browser.
        </p>
        <table className="table sheet-table">
          <thead>
            <tr>
              <th>Component</th>
              <th>Material</th>
              <th>Thickness (mm)</th>
              <th>Length (mm)</th>
              <th>Width (mm)</th>
              <th>Qty</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>
                  <input className="field-input" value={r.name} placeholder={`Component ${i + 1}`} aria-label={`Component ${i + 1} name`} onChange={(e: any) => update(i, { name: e.target.value })} />
                </td>
                <td>
                  <select className="field-input" value={r.material_id ?? ''} aria-label={`Component ${i + 1} material`} onChange={(e: any) => update(i, { material_id: e.target.value === '' ? null : Number(e.target.value) })}>
                    <option value="">Material…</option>
                    {materials.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input className="field-input narrow" type="number" min={0.01} step="any" value={r.thickness ?? ''} aria-label={`Component ${i + 1} thickness (mm)`} onChange={(e: any) => update(i, { thickness: num(e.target.value) })} />
                </td>
                <td>
                  <input className="field-input narrow" type="number" min={1} step="any" value={r.length ?? ''} aria-label={`Component ${i + 1} length (mm)`} onChange={(e: any) => update(i, { length: num(e.target.value) })} />
                </td>
                <td>
                  <input className="field-input narrow" type="number" min={1} step="any" value={r.width ?? ''} aria-label={`Component ${i + 1} width (mm)`} onChange={(e: any) => update(i, { width: num(e.target.value) })} />
                </td>
                <td>
                  <input className="field-input narrow" type="number" min={1} step={1} value={r.quantity ?? ''} aria-label={`Component ${i + 1} quantity`} onChange={(e: any) => update(i, { quantity: num(e.target.value) })} />
                </td>
                <td>
                  <button className="icon-btn" aria-label={`Remove component ${i + 1}`} title="Remove" onClick={() => remove(i)}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="inline-form">
          <button className="btn btn-primary" onClick={add}>
            + Add component
          </button>
          <button className="btn btn-quiet" onClick={clear}>
            Clear list
          </button>
          <span className="spacer" />
          <button className="btn btn-quiet" onClick={print}>
            Print
          </button>
        </div>
      </section>

      <section className="sheet-results" aria-live="polite">
        <h2>
          Sheets required <span className="sheet-total" data-testid="sheet-total">{report.total_sheets}</span>
        </h2>
        <p className="muted small">
          Usable share of a sheet {Math.round(settings.utilisation * 100)}%, cut width {settings.kerf} mm.{' '}
          {me.is_admin ? (
            <button className="link-btn" onClick={() => navigate('/admin?s=tools')}>
              Change materials, sizes or settings
            </button>
          ) : (
            'Materials, sizes and settings are set under Admin → Tools.'
          )}
        </p>
        {!report.groups.length && <p className="muted">Fill in a material, thickness, size and quantity for at least one component.</p>}
        {report.groups.map((g) => (
          <Group key={`${g.material.id}:${g.thickness}`} g={g} />
        ))}
        {report.unplaced.length > 0 && (
          <p className="muted small">
            Not counted (no material or thickness): {report.unplaced.join(', ')}.
          </p>
        )}
        <details className="sheet-method">
          <summary>How this is counted</summary>
          <p className="muted small">
            Components are grouped by material and thickness. For each stock size, every component gets the number of pieces that fit on one sheet in a plain grid,
            in the better orientation, with the cut width added to each piece. <strong>Sheets by fit</strong> is the sum of quantity ÷ pieces per sheet, rounded
            up. <strong>Sheets by area</strong> is the total blank area ÷ (sheet area × usable share), rounded up. The required number is the larger of the two,
            and the stock size needing the fewest sheets is chosen. Treat it as a purchasing estimate: a nesting program will do better on mixed parts.
          </p>
        </details>
      </section>
    </div>
  );
}

function Group({ g }: { g: GroupResult }) {
  const best = g.best;
  return (
    <article className={`sheet-group${best ? '' : ' sheet-group-nofit'}`} data-testid="sheet-group">
      <header className="sheet-group-head">
        <h3>
          {g.material.name} · {g.thickness} mm
        </h3>
        {best ? (
          <span className="sheet-group-answer">
            <strong>{best.required}</strong> sheet{best.required === 1 ? '' : 's'} of {fmt(best.size.length)} × {fmt(best.size.width)}
            {g.mass_kg != null && <span className="muted"> · {fmt(g.mass_kg, 1)} kg</span>}
          </span>
        ) : (
          <span className="sheet-group-answer form-error">
            {g.options.length ? 'A component is larger than every stock sheet' : 'No stock sizes for this material and thickness (Admin → Tools)'}
          </span>
        )}
      </header>
      <table className="table sheet-detail">
        <thead>
          <tr>
            <th>Component</th>
            <th className="num">Blank (mm)</th>
            <th className="num">Qty</th>
            <th className="num">Area</th>
            <th className="num">Per sheet</th>
            <th className="num">Sheets</th>
          </tr>
        </thead>
        <tbody>
          {g.components.map((c, i) => (
            <tr key={i}>
              <td>{c.name.trim() || <span className="muted">Unnamed</span>}</td>
              <td className="num">
                {fmt(c.length!)} × {fmt(c.width!)}
              </td>
              <td className="num">{c.quantity}</td>
              <td className="num">{m2(c.area)}</td>
              <td className="num">{best ? c.per_sheet || <span className="form-error">doesn't fit</span> : '–'}</td>
              <td className="num">{best && c.per_sheet ? fmt(c.sheets, 2) : '–'}</td>
            </tr>
          ))}
          <tr className="sheet-sum">
            <td colSpan={3}>Total blank area</td>
            <td className="num">{m2(g.total_area)}</td>
            <td colSpan={2} className="num">
              {best ? `${Math.round(best.utilisation * 100)}% of ${best.required} sheet${best.required === 1 ? '' : 's'}` : ''}
            </td>
          </tr>
        </tbody>
      </table>
      {g.options.length > 1 && (
        <table className="table sheet-options">
          <thead>
            <tr>
              <th>Stock size</th>
              <th className="num">By fit</th>
              <th className="num">By area</th>
              <th className="num">Required</th>
              <th className="num">Used</th>
            </tr>
          </thead>
          <tbody>
            {g.options.map((o) => (
              <tr key={o.size.id} className={o === best ? 'sheet-best' : ''}>
                <td>
                  {fmt(o.size.length)} × {fmt(o.size.width)}
                  {o.size.thickness != null && <span className="muted"> ({o.size.thickness} mm)</span>}
                  {o === best && <span className="chip"> chosen</span>}
                </td>
                <td className="num">{o.misfits.length ? '–' : o.sheets_by_fit}</td>
                <td className="num">{o.misfits.length ? '–' : o.sheets_by_area}</td>
                <td className="num">{o.misfits.length ? <span className="form-error">{o.misfits.join(', ')} too large</span> : o.required}</td>
                <td className="num">{o.required ? `${Math.round(o.utilisation * 100)}%` : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {g.skipped.length > 0 && <p className="muted small">Skipped (size or quantity missing): {g.skipped.join(', ')}.</p>}
    </article>
  );
}
