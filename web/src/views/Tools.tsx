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
import { MixedSheets } from './tools/MixedSheets.tsx';

interface Data {
  materials: SheetMaterial[];
  sizes: SheetSize[];
  settings: SheetSettings;
}

const TOOLS = [
  {
    id: 'sheets',
    name: 'Sheet calculator',
    blurb: 'How many standard sheets a component needs (one part per sheet, as in the workbook), or several different parts nested together on one sheet, with the cutting layout, part positions and a DXF.',
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

/** The two ways of counting sheets: the workbook's (one part size per sheet) and mixed nesting (decision #43). */
export function SheetCalculator() {
  const { params } = useLocation();
  const mixed = params.get('mode') === 'mixed';
  const data = useQuery<Data>('/api/tools/sheet');
  const go = (m: 'one' | 'mixed') => {
    const p = new URLSearchParams(params);
    if (m === 'mixed') p.set('mode', 'mixed');
    else p.delete('mode');
    navigate(`/tools?${p}`);
  };
  return (
    <>
      <div className="seg-tabs sheet-modes" role="tablist" aria-label="How to count sheets">
        <button role="tab" aria-selected={!mixed} className={mixed ? '' : 'on'} onClick={() => go('one')}>
          One part per sheet (the workbook)
        </button>
        <button role="tab" aria-selected={mixed} className={mixed ? 'on' : ''} onClick={() => go('mixed')}>
          Mixed parts on one sheet
        </button>
      </div>
      {mixed ? (
        data.error && !data.data ? (
          <ErrorBox message={data.error.message} retry={data.refresh} />
        ) : !data.data ? (
          <Spinner />
        ) : (
          <MixedSheets materials={data.data.materials} sizes={data.data.sizes} defaults={data.data.settings} />
        )
      ) : (
        <WorkbookCalculator />
      )}
    </>
  );
}

function WorkbookCalculator() {
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
            straight grid (rows × columns) with the kerf between adjacent parts, in each orientation; sheets required is the number of parts divided by parts
            per sheet, rounded up. When rotation is allowed the board also tries blocks of parts turned each way beside each other (every block boundary a
            straight cut right across, so a saw can cut it too) and uses that when it fits more than either grid. On each sheet the parts are gathered at
            one end or one edge, whichever leaves the bigger offcut in one piece for later. Where a material has more than one stock size, each is tried and
            the one needing the fewest sheets is chosen.
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
          {o.per_sheet_mixed > Math.max(o.per_sheet_1, o.per_sheet_2) && (
            <div>
              <dt>Parts per sheet, some turned 90°</dt>
              <dd data-testid="per-sheet-mixed">{o.per_sheet_mixed}</dd>
            </div>
          )}
          <div>
            <dt>Parts per sheet (best)</dt>
            <dd>
              <strong data-testid="per-sheet">{o.per_sheet}</strong> ·{' '}
              {o.orientation === 'along' ? 'a along length' : o.orientation === 'rotated' ? 'b along length (rotated)' : 'some each way round'}
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

/**
 * The cutting layout, one sheet at a time, drawn to scale: numbered parts,
 * grey slots left unused on a part-used sheet, and the offcut that comes off
 * in one piece (decision #44).
 */
function Layout({ o, quantity }: { o: SizeResult; quantity: number }) {
  const [sheet, setSheet] = useState(1);
  const n = Math.min(Math.max(1, sheet), o.sheets);
  const isLast = n === o.sheets;
  const pat = (isLast ? o.last_sheet : o.full_sheet)!;
  const onThis = isLast ? o.last_sheet_parts : o.per_sheet;
  const first = (n - 1) * o.per_sheet;
  const W = 640;
  const scale = W / o.size.length;
  const H = o.size.width * scale;
  const margin = (o.size.length - o.usable_length) / 2;
  const turned = pat.parts.slice(0, onThis).filter((p) => p.rotated).length;
  const off = pat.offcut;
  return (
    <div className="sheet-layout">
      <div className="inline-form">
        <label>
          Sheet number to view{' '}
          <input className="field-input narrow" type="number" min={1} max={o.sheets} value={n} aria-label="Sheet number to view" onChange={(e: any) => setSheet(Number(e.target.value) || 1)} />{' '}
          of {o.sheets}
        </label>
        <span className="muted small" data-testid="sheet-layout-note">
          {onThis} parts on this sheet
          {turned && turned < onThis ? `, ${turned} of them turned 90°` : turned ? ', all turned 90°' : ''}
          {off
            ? ` · offcut left in one piece: ${fmt(off.length)} × ${fmt(off.width)} mm, ${off.side === 'end' ? `cut across at ${fmt(off.x)} mm along the length` : `cut along at ${fmt(off.y)} mm across the width`}`
            : ' · no offcut big enough to keep'}
        </span>
      </div>
      <svg className="sheet-svg" viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Cutting layout of sheet ${n}: ${onThis} parts`}>
        <rect x={0} y={0} width={W} height={H} className="sheet-svg-sheet" />
        <rect x={margin * scale} y={margin * scale} width={o.usable_length * scale} height={o.usable_width * scale} className="sheet-svg-usable" />
        {off && (
          <g className="sheet-svg-offcut" data-testid="sheet-offcut">
            <rect x={off.x * scale} y={off.y * scale} width={off.length * scale} height={off.width * scale} />
            {off.length * scale > 60 && off.width * scale > 16 && (
              <text x={(off.x + off.length / 2) * scale} y={(off.y + off.width / 2) * scale} textAnchor="middle" dominantBaseline="central">
                Offcut {fmt(off.length)} × {fmt(off.width)}
              </text>
            )}
          </g>
        )}
        {pat.parts.map((c, k) => {
          const used = k < onThis && first + k < quantity;
          const cw = c.length * scale;
          const ch = c.width * scale;
          // an unused slot inside the offcut is not drawn: that material is kept
          if (!used && off && c.x >= off.x - 1e-6 && c.y >= off.y - 1e-6) return null;
          return (
            <g key={k}>
              <rect x={c.x * scale} y={c.y * scale} width={cw} height={ch} className={used ? `sheet-svg-part${c.rotated ? ' sheet-svg-turned' : ''}` : 'sheet-svg-empty'} />
              {used && cw >= 22 && ch >= 12 && (
                <text x={c.x * scale + cw / 2} y={c.y * scale + ch / 2} className="sheet-svg-label" textAnchor="middle" dominantBaseline="central">
                  {first + k + 1}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
