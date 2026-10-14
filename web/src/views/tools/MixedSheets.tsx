// Mixed parts on one sheet (decision #43): several different parts nested
// together onto sheets of one size, with the cutting layout drawn to scale,
// every part's position, and a DXF for the cutting machine. The workbook's
// one-part-per-sheet method stays as the sheet calculator's other mode.

import { useEffect, useMemo, useState } from 'react';
import {
  NEST_MAX_PIECES,
  checkSheet,
  nestParts,
  nestingDxf,
  partLetter,
  type CutMode,
  type NestPart,
  type NestResult,
  type SheetMaterial,
  type SheetSettings,
  type SheetSize,
} from '@board/shared';
import { toast } from '../../lib/toasts.ts';

const STORAGE_KEY = 'engineering-board-sheet-mix';

interface Row {
  name: string;
  length: number | null;
  width: number | null;
  quantity: number | null;
}
interface Saved {
  rows: Row[];
  /** a stock size id, or "custom" */
  sheet: string;
  custom: { length: number | null; width: number | null };
  settings: SheetSettings | null;
  cut: CutMode;
}

const EMPTY: Row = { name: '', length: null, width: null, quantity: null };

function load(): Partial<Saved> {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}
function store(v: Saved) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
  } catch {
    /* the list then lives for this page only */
  }
}

const num = (v: string): number | null => (v.trim() === '' ? null : Number(v));
const fmt = (n: number, d = 0) => n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
const m2 = (n: number) => `${fmt(n / 1e6, 3)} m²`;
const pct = (n: number) => `${fmt(n * 100, 1)}%`;
const COLOURS = 8;

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function MixedSheets({ materials, sizes, defaults }: { materials: SheetMaterial[]; sizes: SheetSize[]; defaults: SheetSettings }) {
  const [saved] = useState(load);
  const [rows, setRows] = useState<Row[]>(saved.rows?.length ? saved.rows : [{ ...EMPTY }]);
  const [sheet, setSheet] = useState<string>(saved.sheet ?? 'custom');
  const [custom, setCustom] = useState<Saved['custom']>(saved.custom ?? { length: 2400, width: 1200 });
  const [own, setOwn] = useState<SheetSettings | null>(saved.settings ?? null);
  const [cut, setCut] = useState<CutMode>(saved.cut ?? 'any');
  const settings = own ?? defaults;
  useEffect(() => store({ rows, sheet, custom, settings: own, cut }), [rows, sheet, custom, own, cut]);

  const stock = sizes
    .filter((z) => z.active)
    .map((z) => ({ ...z, material: materials.find((m) => m.id === z.material_id) }))
    .filter((z) => z.material?.active)
    .sort((a, b) => a.material!.sort_order - b.material!.sort_order || a.material!.name.localeCompare(b.material!.name) || b.length - a.length);
  const chosen = sheet === 'custom' ? null : stock.find((z) => String(z.id) === sheet) ?? null;
  const size = chosen ? { length: chosen.length, width: chosen.width } : custom.length && custom.width && custom.length > 0 && custom.width > 0 ? { length: custom.length, width: custom.width } : null;

  const parts: (NestPart & { row: number })[] = rows
    .map((r, row) => ({ row, name: r.name.trim() || `Part ${partLetter(row)}`, length: r.length ?? 0, width: r.width ?? 0, quantity: Math.floor(r.quantity ?? 0) }))
    .filter((p) => p.length > 0 && p.width > 0 && p.quantity > 0);
  const pieces = parts.reduce((t, p) => t + p.quantity, 0);
  // a part keeps the letter of its row in the list, even when a row above is left empty
  const letters = parts.map((p) => partLetter(p.row));
  const tooMany = pieces > NEST_MAX_PIECES;

  const result = useMemo<NestResult | null>(() => {
    if (!size || !parts.length || tooMany) return null;
    return nestParts(parts, size, { ...settings, cut });
  }, [JSON.stringify(parts), size?.length, size?.width, settings.kerf, settings.margin, settings.rotate, cut]);

  const update = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const remove = (i: number) => setRows(rows.length > 1 ? rows.filter((_, j) => j !== i) : [{ ...EMPTY }]);
  const setSetting = (patch: Partial<SheetSettings>) => setOwn({ ...settings, ...patch });
  const usingDefaults = own == null || (own.kerf === defaults.kerf && own.margin === defaults.margin && own.rotate === defaults.rotate);
  const sheetName = size ? `${fmt(size.length)} × ${fmt(size.width)}` : '';
  const fileBase = `nesting ${size ? `${size.length}x${size.width}` : ''}`.trim();

  const exportDxf = () => {
    if (!result) return;
    download(`${fileBase}.dxf`, nestingDxf(result, parts, settings, letters), 'application/dxf');
    toast('DXF saved: one outline per part, sheets one below the other (mm).', { kind: 'success' });
  };
  const exportCsv = () => {
    if (!result) return;
    const head = 'Sheet,Label,Part,Length along sheet (mm),Width along sheet (mm),X (mm),Y (mm),Rotated';
    const lines = result.sheets.flatMap((s, k) =>
      s.parts.map((p) => [k + 1, `${letters[p.part]}${p.n}`, `"${parts[p.part].name.replace(/"/g, '""')}"`, p.length, p.width, p.x, p.y, p.rotated ? 'yes' : 'no'].join(',')),
    );
    download(`${fileBase}.csv`, '﻿' + [head, ...lines].join('\r\n') + '\r\n', 'text/csv');
  };

  return (
    <div className="sheet-calc">
      <section className="sheet-inputs">
        <h2>Inputs</h2>
        <p className="muted small">
          Different parts nested together on sheets of one size. The parts can share a sheet, turn by 90° if allowed, and keep the kerf between each other and the
          edge margin from the sheet's edge. The list is remembered in this browser.
        </p>
        <div className="inline-form mix-sheet">
          <label>
            Sheet{' '}
            <select className="field-input" value={sheet} aria-label="Sheet to cut from" onChange={(e: any) => setSheet(e.target.value)}>
              {stock.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.material!.name} · {fmt(z.length)} × {fmt(z.width)} mm
                </option>
              ))}
              <option value="custom">Another size…</option>
            </select>
          </label>
          {sheet === 'custom' && (
            <>
              <label>
                Length{' '}
                <input className="field-input narrow" type="number" min={1} step="any" value={custom.length ?? ''} aria-label="Sheet length (mm)" onChange={(e: any) => setCustom({ ...custom, length: num(e.target.value) })} /> mm
              </label>
              <label>
                Width{' '}
                <input className="field-input narrow" type="number" min={1} step="any" value={custom.width ?? ''} aria-label="Sheet width (mm)" onChange={(e: any) => setCustom({ ...custom, width: num(e.target.value) })} /> mm
              </label>
            </>
          )}
        </div>
        <table className="table sheet-table">
          <thead>
            <tr>
              <th></th>
              <th>Part</th>
              <th>Length (mm)</th>
              <th>Width (mm)</th>
              <th>Number</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>
                  <span className={`mix-key mix-c${i % COLOURS}`}>{partLetter(i)}</span>
                </td>
                <td>
                  <input className="field-input" value={r.name} placeholder={`Part ${partLetter(i)}`} aria-label={`Part ${i + 1} name`} onChange={(e: any) => update(i, { name: e.target.value })} />
                </td>
                <td>
                  <input className="field-input narrow" type="number" min={0.01} step="any" value={r.length ?? ''} aria-label={`Part ${i + 1} length (mm)`} onChange={(e: any) => update(i, { length: num(e.target.value) })} />
                </td>
                <td>
                  <input className="field-input narrow" type="number" min={0.01} step="any" value={r.width ?? ''} aria-label={`Part ${i + 1} width (mm)`} onChange={(e: any) => update(i, { width: num(e.target.value) })} />
                </td>
                <td>
                  <input className="field-input narrow" type="number" min={1} step={1} value={r.quantity ?? ''} aria-label={`Part ${i + 1} number`} onChange={(e: any) => update(i, { quantity: num(e.target.value) })} />
                </td>
                <td>
                  <button className="icon-btn" aria-label={`Remove part ${i + 1}`} title="Remove" onClick={() => remove(i)}>
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
            <input className="field-input narrow" type="number" min={0} step="any" value={settings.kerf} aria-label="Spacing / kerf between parts (mm)" onChange={(e: any) => setSetting({ kerf: Math.max(0, Number(e.target.value) || 0) })} /> mm
          </label>
          <label>
            Edge margin on sheet{' '}
            <input className="field-input narrow" type="number" min={0} step="any" value={settings.margin} aria-label="Edge margin on sheet (mm)" onChange={(e: any) => setSetting({ margin: Math.max(0, Number(e.target.value) || 0) })} /> mm
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
        <div className="inline-form mix-cut" role="radiogroup" aria-label="How the sheet is cut">
          <label>
            <input type="radio" name="mix-cut" checked={cut === 'any'} onChange={() => setCut('any')} /> Any order (laser, plasma, waterjet, CNC)
          </label>
          <label>
            <input type="radio" name="mix-cut" checked={cut === 'guillotine'} onChange={() => setCut('guillotine')} /> Straight cuts right across (panel saw, shear)
          </label>
        </div>
        <div className="inline-form">
          <button className="btn btn-primary" onClick={() => setRows([...rows, { ...EMPTY }])}>
            + Add part
          </button>
          <button
            className="btn btn-quiet"
            onClick={() => {
              setRows([{ ...EMPTY }]);
              toast('Part list cleared');
            }}
          >
            Clear list
          </button>
          <span className="spacer" />
          <button className="btn btn-quiet" disabled={!result?.sheets.length} onClick={exportCsv}>
            Positions (CSV)
          </button>
          <button className="btn btn-quiet" disabled={!result?.sheets.length} onClick={exportDxf}>
            Download DXF
          </button>
          <button className="btn btn-quiet" onClick={() => window.print()}>
            Print
          </button>
        </div>
      </section>

      <section className="sheet-results" aria-live="polite">
        <h2>
          Sheets required <span className="sheet-total" data-testid="mix-total">{result ? result.sheets.length : '–'}</span>
          {result && size && <span className="muted small mix-of"> of {sheetName} mm</span>}
        </h2>
        {!size && <p className="muted">Enter the sheet's length and width.</p>}
        {size && !parts.length && <p className="muted">Fill in a length, width and number for at least one part.</p>}
        {tooMany && (
          <p className="form-error">
            {fmt(pieces)} pieces is more than this page nests at once ({fmt(NEST_MAX_PIECES)}). Split the list, or use "One part per sheet".
          </p>
        )}
        {result && (
          <>
            {!!result.unplaced.length && (
              <p className="form-error" data-testid="mix-unplaced">
                Too big for the sheet{settings.rotate ? '' : ' (rotation is off)'}: {result.unplaced.map((u) => `${parts[u.part].name} × ${u.count}`).join(', ')}.
              </p>
            )}
            <dl className="sheet-facts mix-facts">
              <div>
                <dt>Usable sheet (mm)</dt>
                <dd>
                  {fmt(result.usable_length)} × {fmt(result.usable_width)}
                </dd>
              </div>
              <div>
                <dt>Parts</dt>
                <dd>{fmt(pieces - result.unplaced.reduce((t, u) => t + u.count, 0))}</dd>
              </div>
              <div>
                <dt>Total area of parts</dt>
                <dd>{m2(result.parts_area)}</dd>
              </div>
              <div>
                <dt>Sheet area purchased</dt>
                <dd>{m2(result.purchased_area)}</dd>
              </div>
              <div>
                <dt>Material utilisation</dt>
                <dd>{pct(result.utilisation)}</dd>
              </div>
              <div>
                <dt>Waste / offcut area</dt>
                <dd>{m2(result.waste_area)}</dd>
              </div>
            </dl>
            <ul className="mix-legend">
              {parts.map((p, i) => (
                <li key={p.row}>
                  <span className={`mix-key mix-c${p.row % COLOURS}`}>{letters[i]}</span> {p.name} · {fmt(p.length)} × {fmt(p.width)} mm × {p.quantity}
                </li>
              ))}
            </ul>
            {result.sheets.map((s, k) => (
              <MixedLayout key={k} r={result} sheet={k} parts={parts} letters={letters} settings={settings} />
            ))}
            <details className="sheet-method">
              <summary>How this is nested</summary>
              <p className="muted small">
                Each part is a rectangle grown by the kerf, packed into the sheet less its edge margin. <strong>Any order</strong> uses maximal-rectangles
                packing: a part can sit in any free space, for cutters that follow each outline. <strong>Straight cuts right across</strong> only makes layouts
                that can be cut with one straight cut through each piece after another, for a panel saw or shear. Several part orders and placement rules are
                tried; the one using the fewest sheets wins, then the one leaving the last sheet's offcut in one piece. Every result is checked: each part inside
                the margin, and at least one kerf from every other part. It is a good, fast layout rather than a proven optimum: for very large jobs a nesting
                program may save a little more.
              </p>
            </details>
          </>
        )}
      </section>
    </div>
  );
}

function MixedLayout({ r, sheet, parts, letters, settings }: { r: NestResult; sheet: number; parts: (NestPart & { row: number })[]; letters: string[]; settings: SheetSettings }) {
  const s = r.sheets[sheet];
  const [table, setTable] = useState(false);
  const problems = useMemo(() => checkSheet(s, r.sheet, settings), [s]);
  const W = 640;
  const scale = W / r.sheet.length;
  const H = r.sheet.width * scale;
  const freeL = r.sheet.length - settings.margin - s.reach_length;
  const freeW = r.sheet.width - settings.margin - s.reach_width;
  return (
    <article className="sheet-group mix-sheet-card" data-testid="mix-sheet">
      <header className="sheet-group-head">
        <h3>
          Sheet {sheet + 1} of {r.sheets.length}
        </h3>
        <span className="sheet-group-answer">
          <strong>{s.parts.length}</strong> parts · {pct(s.utilisation)} used
        </span>
      </header>
      <p className="muted small">
        Parts reach {fmt(s.reach_length)} mm along the length and {fmt(s.reach_width)} mm along the width
        {freeL > 1 || freeW > 1
          ? `. Left whole: ${[freeL > 1 ? `${fmt(freeL)} mm across the far end` : '', freeW > 1 ? `${fmt(freeW)} mm along the bottom edge` : ''].filter(Boolean).join(' and ')}.`
          : '.'}
      </p>
      {problems.length > 0 && <p className="form-error">Layout check failed: {problems.join('; ')}. Please report this.</p>}
      <svg className="sheet-svg mix-svg" viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Cutting layout of sheet ${sheet + 1}: ${s.parts.length} parts`}>
        <rect x={0} y={0} width={W} height={H} className="sheet-svg-sheet" />
        {settings.margin > 0 && <rect x={settings.margin * scale} y={settings.margin * scale} width={r.usable_length * scale} height={r.usable_width * scale} className="sheet-svg-usable" />}
        {s.parts.map((p) => {
          const w = p.length * scale;
          const h = p.width * scale;
          const label = `${letters[p.part]}${p.n}`;
          const big = w >= 26 && h >= 13;
          return (
            <g key={`${p.part}-${p.n}`} data-part={label}>
              <rect x={p.x * scale} y={p.y * scale} width={w} height={h} className={`mix-part mix-c${parts[p.part].row % COLOURS}`}>
                <title>
                  {label} {parts[p.part].name}: {fmt(p.length)} × {fmt(p.width)} mm at X {fmt(p.x, 1)}, Y {fmt(p.y, 1)}
                  {p.rotated ? ' (turned 90°)' : ''}
                </title>
              </rect>
              {big && (
                <text x={p.x * scale + w / 2} y={p.y * scale + h / 2} className="sheet-svg-label" textAnchor="middle" dominantBaseline="central">
                  {label}
                </text>
              )}
            </g>
          );
        })}
        <text x={4} y={H - 4} className="mix-axis">
          X →
        </text>
        <text x={4} y={12} className="mix-axis">
          0,0
        </text>
      </svg>
      <button type="button" className="link-btn" aria-expanded={table} onClick={() => setTable(!table)}>
        {table ? 'Hide part positions' : 'Show part positions'}
      </button>
      {table && (
        <table className="table mix-table">
          <thead>
            <tr>
              <th>Label</th>
              <th>Part</th>
              <th className="num">Along length (mm)</th>
              <th className="num">Along width (mm)</th>
              <th className="num">X (mm)</th>
              <th className="num">Y (mm)</th>
              <th>Turned</th>
            </tr>
          </thead>
          <tbody>
            {s.parts.map((p) => (
              <tr key={`${p.part}-${p.n}`}>
                <td>
                  <span className={`mix-key mix-c${parts[p.part].row % COLOURS}`}>
                    {letters[p.part]}
                    {p.n}
                  </span>
                </td>
                <td>{parts[p.part].name}</td>
                <td className="num">{fmt(p.length, 1)}</td>
                <td className="num">{fmt(p.width, 1)}</td>
                <td className="num">{fmt(p.x, 1)}</td>
                <td className="num">{fmt(p.y, 1)}</td>
                <td>{p.rotated ? '90°' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </article>
  );
}
