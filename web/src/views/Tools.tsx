// Tools (decision #32): small calculators for engineers and the manager. The
// first is the sheet calculator: the team's Sheet Requirement Calculator
// workbook (docs/tools/) as a page. Its Calculator sheet is each row below,
// its Layout sheet is the drawing under a row, its Materials sheet is kept by
// the admin under Admin → Tools.

import { useEffect, useMemo, useState } from 'react';
import { calculateSheets, type ComponentInput, type ComponentResult, type SheetMaterial, type SheetSettings, type SheetSize, type SizeResult } from '@board/shared';
import { useApp } from '../context.ts';
import { navigate, useLocation } from '../lib/router.ts';
import { useQuery } from '../lib/store.ts';
import { toast } from '../lib/toasts.ts';
import { ErrorBox, Spinner } from '../components/bits.tsx';
import { PdfTools } from './tools/PdfTools.tsx';

interface Data {
  materials: SheetMaterial[];
  sizes: SheetSize[];
  settings: SheetSettings;
}

const TOOLS = [
  {
    id: 'sheets',
    name: 'Sheet calculator',
    blurb: 'How many standard sheets a component needs: parts per sheet in a straight grid with kerf and edge margin, sheets to buy, parts on the last sheet, utilisation, waste, and the cutting layout.',
  },
  {
    id: 'pdf',
    name: 'PDF tools',
    blurb: 'Stamp drawings with a diagonal mark, turn a vector PDF into its colour negative, combine PDFs by page size (A4, A3), and convert Word documents to PDF with the host PC\'s Word.',
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
      ) : tool?.id === 'pdf' ? (
        <PdfTools />
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
const EMPTY: ComponentInput = { name: '', material_id: null, length: null, width: null, quantity: null };

interface Saved {
  rows: ComponentInput[];
  /** the three workbook inputs as last used here; null = the admin's defaults */
  settings: SheetSettings | null;
}

function loadSaved(): Saved | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && Array.isArray(v.rows) && v.rows.length ? { rows: v.rows, settings: v.settings ?? null } : null;
  } catch {
    return null;
  }
}
function save(v: Saved) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
  } catch {
    /* storage may be unavailable; the list then lives for this page only */
  }
}

const num = (v: string): number | null => (v.trim() === '' ? null : Number(v));
const fmt = (n: number, d = 0) => n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
const m2 = (n: number) => `${fmt(n, 3)} m²`;
const pct = (n: number) => `${fmt(n * 100, 1)}%`;

export function SheetCalculator() {
  const { me } = useApp();
  const data = useQuery<Data>('/api/tools/sheet');
  const [saved] = useState(loadSaved);
  const [rows, setRows] = useState<ComponentInput[]>(saved?.rows ?? [{ ...EMPTY }]);
  const [own, setOwn] = useState<SheetSettings | null>(saved?.settings ?? null);
  const settings = own ?? data.data?.settings ?? null;
  useEffect(() => save({ rows, settings: own }), [rows, own]);

  const materials = (data.data?.materials ?? []).filter((m) => m.active);
  const report = useMemo(() => (data.data && settings ? calculateSheets(rows, data.data.materials, data.data.sizes, settings) : null), [rows, data.data, settings]);

  if (data.error && !data.data) return <ErrorBox message={data.error.message} retry={data.refresh} />;
  if (!data.data || !report || !settings) return <Spinner />;

  const update = (i: number, patch: Partial<ComponentInput>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const remove = (i: number) => setRows(rows.length > 1 ? rows.filter((_, j) => j !== i) : [{ ...EMPTY }]);
  const add = () => setRows([...rows, { ...EMPTY, material_id: rows[rows.length - 1]?.material_id ?? null }]);
  const clear = () => {
    setRows([{ ...EMPTY }]);
    toast('Component list cleared');
  };
  const setSetting = (patch: Partial<SheetSettings>) => setOwn({ ...settings, ...patch });
  const usingDefaults = own == null || (own.kerf === data.data.settings.kerf && own.margin === data.data.settings.margin && own.rotate === data.data.settings.rotate);

  return (
    <div className="sheet-calc">
      <section className="sheet-inputs">
        <h2>Inputs</h2>
        <p className="muted small">
          As in the workbook: one component per row, with its material, length <em>a</em>, width <em>b</em> and number <em>n</em>; the kerf, edge margin and
          rotation apply to every row. The list is remembered in this browser.
        </p>
        <table className="table sheet-table">
          <thead>
            <tr>
              <th>Component</th>
              <th>Material</th>
              <th>Length a (mm)</th>
              <th>Width b (mm)</th>
              <th>Number n</th>
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
                  <input className="field-input narrow" type="number" min={0.01} step="any" value={r.length ?? ''} aria-label={`Component ${i + 1} length (mm)`} onChange={(e: any) => update(i, { length: num(e.target.value) })} />
                </td>
                <td>
                  <input className="field-input narrow" type="number" min={0.01} step="any" value={r.width ?? ''} aria-label={`Component ${i + 1} width (mm)`} onChange={(e: any) => update(i, { width: num(e.target.value) })} />
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
        <div className="inline-form sheet-params">
          <label>
            Spacing / kerf between parts{' '}
            <input className="field-input narrow" type="number" min={0} step="any" value={settings.kerf} aria-label="Spacing / kerf between parts (mm)" onChange={(e: any) => setSetting({ kerf: Number(e.target.value) || 0 })} /> mm
          </label>
          <label>
            Edge margin on sheet{' '}
            <input className="field-input narrow" type="number" min={0} step="any" value={settings.margin} aria-label="Edge margin on sheet (mm)" onChange={(e: any) => setSetting({ margin: Number(e.target.value) || 0 })} /> mm
          </label>
          <label>
            <input type="checkbox" checked={settings.rotate} aria-label="Allow rotation by 90 degrees" onChange={(e: any) => setSetting({ rotate: e.target.checked })} /> Allow rotation by 90°
          </label>
          {!usingDefaults && (
            <button type="button" className="link-btn" onClick={() => setOwn(null)}>
              Back to the defaults
            </button>
          )}
        </div>
        <div className="inline-form">
          <button className="btn btn-primary" onClick={add}>
            + Add component
          </button>
          <button className="btn btn-quiet" onClick={clear}>
            Clear list
          </button>
          <span className="spacer" />
          <button className="btn btn-quiet" onClick={() => window.print()}>
            Print
          </button>
        </div>
      </section>

      <section className="sheet-results" aria-live="polite">
        <h2>
          Sheets required <span className="sheet-total" data-testid="sheet-total">{report.total_sheets}</span>
        </h2>
        {report.by_material.length > 1 && (
          <p className="sheet-by-material">
            {report.by_material.map((t) => (
              <span key={t.material.id} className="chip">
                {t.material.name}: {t.sheets}
              </span>
            ))}
          </p>
        )}
        <p className="muted small">
          {me.is_admin ? (
            <button className="link-btn" onClick={() => navigate('/admin?s=tools')}>
              Materials, sheet sizes and defaults are kept under Admin → Tools
            </button>
          ) : (
            'Materials, sheet sizes and defaults are kept under Admin → Tools.'
          )}
        </p>
        {!report.rows.length && <p className="muted">Fill in a material, length, width and number for at least one component.</p>}
        {report.rows.map((r, i) => (
          <Result key={i} r={r} />
        ))}
        {report.skipped.length > 0 && (
          <p className="muted small">Not counted: {report.skipped.map((s) => `${s.name} (${s.reason})`).join('; ')}.</p>
        )}
        <details className="sheet-method">
          <summary>How this is counted</summary>
          <p className="muted small">
            Exactly as the team's Sheet Requirement Calculator workbook: the edge margin is removed from all four sides of the sheet; parts are laid out in a
            straight grid (rows × columns) with the kerf between adjacent parts, in each orientation, and the better one is used when rotation is allowed; sheets
            required is the number of parts divided by parts per sheet, rounded up. This is a straight-grid estimate: mixed-orientation nesting may save a little
            more. Where a material has more than one stock size, each is tried and the one needing the fewest sheets is chosen.
          </p>
        </details>
      </section>
    </div>
  );
}

function Result({ r }: { r: ComponentResult }) {
  const [showLayout, setShowLayout] = useState(false);
  const best = r.best;
  const o = best;
  return (
    <article className={`sheet-group${best ? '' : ' sheet-group-nofit'}`} data-testid="sheet-group">
      <header className="sheet-group-head">
        <h3>
          {r.name.trim() || 'Component'} · {r.material.name} · {fmt(r.length!)} × {fmt(r.width!)} mm × {r.quantity}
        </h3>
        {o ? (
          <span className="sheet-group-answer">
            <strong>{o.sheets}</strong> sheet{o.sheets === 1 ? '' : 's'} of {fmt(o.size.length)} × {fmt(o.size.width)} mm
          </span>
        ) : (
          <span className="sheet-group-answer form-error">{r.options.length ? 'Part does not fit any stock sheet' : 'No stock sizes for this material (Admin → Tools)'}</span>
        )}
      </header>
      {o && (
        <dl className="sheet-facts">
          <div>
            <dt>Usable sheet (mm)</dt>
            <dd>
              {fmt(o.usable_length)} × {fmt(o.usable_width)}
            </dd>
          </div>
          <div>
            <dt>Parts per sheet, a along length</dt>
            <dd>{o.per_sheet_1}</dd>
          </div>
          <div>
            <dt>Parts per sheet, b along length</dt>
            <dd>{o.per_sheet_2}</dd>
          </div>
          <div>
            <dt>Parts per sheet (best)</dt>
            <dd>
              <strong data-testid="per-sheet">{o.per_sheet}</strong> · {o.orientation === 'along' ? 'a along length' : 'b along length (rotated)'}
            </dd>
          </div>
          <div>
            <dt>Parts on last sheet</dt>
            <dd>{o.last_sheet_parts}</dd>
          </div>
          <div>
            <dt>Total area of parts</dt>
            <dd>{m2(o.parts_area)}</dd>
          </div>
          <div>
            <dt>Sheet area purchased</dt>
            <dd>{m2(o.purchased_area)}</dd>
          </div>
          <div>
            <dt>Material utilisation</dt>
            <dd>{pct(o.utilisation)}</dd>
          </div>
          <div>
            <dt>Waste / offcut area</dt>
            <dd>{m2(o.waste_area)}</dd>
          </div>
        </dl>
      )}
      {r.options.length > 1 && (
        <table className="table sheet-options">
          <thead>
            <tr>
              <th>Stock size</th>
              <th className="num">Per sheet</th>
              <th className="num">Sheets</th>
              <th className="num">Utilisation</th>
            </tr>
          </thead>
          <tbody>
            {r.options.map((x) => (
              <tr key={x.size.id} className={x === best ? 'sheet-best' : ''}>
                <td>
                  {fmt(x.size.length)} × {fmt(x.size.width)}
                  {x === best && <span className="chip"> chosen</span>}
                </td>
                <td className="num">{x.per_sheet || <span className="form-error">does not fit</span>}</td>
                <td className="num">{x.per_sheet ? x.sheets : '–'}</td>
                <td className="num">{x.per_sheet ? pct(x.utilisation) : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {o?.layout && (
        <div className="sheet-layout-wrap">
          <button type="button" className="link-btn" onClick={() => setShowLayout(!showLayout)} aria-expanded={showLayout}>
            {showLayout ? 'Hide cutting layout' : 'Show cutting layout'}
          </button>
          {showLayout && <Layout o={o} quantity={r.quantity!} />}
        </div>
      )}
    </article>
  );
}

/** The workbook's Layout sheet: one sheet at a time, numbered parts, grey unused slots, drawn to scale. */
function Layout({ o, quantity }: { o: SizeResult; quantity: number }) {
  const [sheet, setSheet] = useState(1);
  const n = Math.min(Math.max(1, sheet), o.sheets);
  const L = o.layout!;
  const onThis = n === o.sheets ? o.last_sheet_parts : o.per_sheet;
  const first = (n - 1) * o.per_sheet;
  const W = 640;
  const scale = W / o.size.length;
  const H = o.size.width * scale;
  const margin = (o.size.length - o.usable_length) / 2;
  const kerf = L.across > 1 ? (L.usable_length - L.across * L.part_length) / (L.across - 1) : 0;
  const cells: { x: number; y: number; k: number }[] = [];
  for (let row = 0; row < L.down; row++) for (let col = 0; col < L.across; col++) cells.push({ x: margin + col * (L.part_length + kerf), y: margin + row * (L.part_width + kerf), k: row * L.across + col + 1 });
  const cellW = L.part_length * scale;
  const cellH = L.part_width * scale;
  const label = cellW >= 22 && cellH >= 12;
  return (
    <div className="sheet-layout">
      <div className="inline-form">
        <label>
          Sheet number to view{' '}
          <input className="field-input narrow" type="number" min={1} max={o.sheets} value={n} aria-label="Sheet number to view" onChange={(e: any) => setSheet(Number(e.target.value) || 1)} />{' '}
          of {o.sheets}
        </label>
        <span className="muted small">
          {onThis} parts on this sheet · {L.across} across × {L.down} down · part {fmt(L.part_length)} × {fmt(L.part_width)} mm along length × width · unused strip{' '}
          {fmt(L.strip_length)} mm along length, {fmt(L.strip_width)} mm along width
        </span>
      </div>
      <svg className="sheet-svg" viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Cutting layout of sheet ${n}: ${onThis} parts, ${L.across} across by ${L.down} down`}>
        <rect x={0} y={0} width={W} height={H} className="sheet-svg-sheet" />
        <rect x={margin * scale} y={margin * scale} width={o.usable_length * scale} height={o.usable_width * scale} className="sheet-svg-usable" />
        {cells.map((c) => {
          const used = first + c.k <= quantity && c.k <= onThis;
          return (
            <g key={c.k}>
              <rect x={c.x * scale} y={c.y * scale} width={cellW} height={cellH} className={used ? 'sheet-svg-part' : 'sheet-svg-empty'} />
              {label && used && (
                <text x={c.x * scale + cellW / 2} y={c.y * scale + cellH / 2} className="sheet-svg-label" textAnchor="middle" dominantBaseline="central">
                  {first + c.k}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
