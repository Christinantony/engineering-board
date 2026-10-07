// Admin → Tools (decision #32): the reference data behind the engineers' tools.
// Today: the sheet calculator's materials, standard sheet sizes and settings.

import { useEffect, useState } from 'react';
import type { SheetMaterial, SheetSettings, SheetSize } from '@board/shared';
import { api, del, patch, post } from '../../lib/api.ts';
import { ask } from '../../lib/dialogs.ts';
import { invalidate, useQuery } from '../../lib/store.ts';
import { toast } from '../../lib/toasts.ts';
import { Spinner } from '../../components/bits.tsx';
import { onAdminError } from './Admin.tsx';
import { RenameInput } from './Lists.tsx';

interface Data {
  materials: SheetMaterial[];
  sizes: SheetSize[];
  settings: SheetSettings;
}

const refresh = () => invalidate((k) => k.startsWith('/api/tools'));
const num = (v: string): number | null => (v.trim() === '' ? null : Number(v));

export function ToolsDataSection() {
  const q = useQuery<Data>('/api/tools/sheet');
  if (!q.data) return <Spinner />;
  const { materials, sizes, settings } = q.data;
  return (
    <section className="admin-section">
      <h2>Tools</h2>
      <p className="muted">
        Reference data for the <strong>Tools</strong> page. The sheet calculator uses the materials, their standard sheet sizes and the settings below. More tools
        will be added here over time.
      </p>
      <Materials materials={materials} />
      <Sizes materials={materials} sizes={sizes} />
      <Settings settings={settings} />
    </section>
  );
}

function Materials({ materials }: { materials: SheetMaterial[] }) {
  const [name, setName] = useState('');
  const [density, setDensity] = useState('');
  const active = materials.filter((m) => m.active);
  const save = async (m: SheetMaterial, fields: Partial<SheetMaterial>) => {
    try {
      await patch(`/api/admin/materials/${m.id}`, fields);
      refresh();
    } catch (e) {
      onAdminError(e);
    }
  };
  const move = async (m: SheetMaterial, dir: -1 | 1) => {
    const i = active.indexOf(m);
    const other = active[i + dir];
    if (!other) return;
    await save(m, { sort_order: other.sort_order });
    await save(other, { sort_order: m.sort_order });
  };
  const add = async (e: any) => {
    e.preventDefault();
    try {
      await post('/api/admin/materials', { name: name.trim(), density: num(density) });
      setName('');
      setDensity('');
      refresh();
    } catch (err) {
      onAdminError(err);
    }
  };
  return (
    <>
      <h3>Materials</h3>
      <p className="muted small">The order here is the order in the calculator's menus. Density (kg/m³) is optional; with it the calculator also shows the sheet mass. Retiring a material hides it from new calculations.</p>
      <ul className="admin-list materials-list">
        {materials.map((m) => (
          <li key={m.id} className={m.active ? '' : 'row-inactive'}>
            <RenameInput value={m.name} label={`Name of ${m.name}`} onSave={(v) => save(m, { name: v })} />
            <label className="density-field">
              <span className="muted small">kg/m³</span>
              <DensityInput value={m.density} label={`Density of ${m.name}`} onSave={(v) => save(m, { density: v })} />
            </label>
            {m.active && (
              <span className="order-btns">
                <button className="icon-btn" aria-label={`Move ${m.name} up`} disabled={active.indexOf(m) === 0} onClick={() => void move(m, -1)}>
                  ↑
                </button>
                <button className="icon-btn" aria-label={`Move ${m.name} down`} disabled={active.indexOf(m) === active.length - 1} onClick={() => void move(m, 1)}>
                  ↓
                </button>
              </span>
            )}
            <button className="btn btn-quiet" onClick={() => void save(m, { active: !m.active })}>
              {m.active ? 'Retire' : 'Bring back'}
            </button>
          </li>
        ))}
      </ul>
      <form className="inline-form" onSubmit={add}>
        <input className="field-input" value={name} maxLength={60} placeholder="New material" aria-label="New material" onChange={(e: any) => setName(e.target.value)} />
        <input className="field-input narrow" type="number" min={1} step="any" value={density} placeholder="kg/m³" aria-label="Density of the new material (kg/m³)" onChange={(e: any) => setDensity(e.target.value)} />
        <button className="btn btn-primary" disabled={!name.trim()}>
          Add material
        </button>
      </form>
    </>
  );
}

function DensityInput({ value, label, onSave }: { value: number | null; label: string; onSave: (v: number | null) => Promise<unknown> }) {
  const [v, setV] = useState(value == null ? '' : String(value));
  useEffect(() => setV(value == null ? '' : String(value)), [value]);
  return (
    <input
      className="field-input narrow"
      type="number"
      min={1}
      step="any"
      value={v}
      aria-label={label}
      onChange={(e: any) => setV(e.target.value)}
      onBlur={() => {
        const n = num(v);
        if (n !== value) void onSave(n);
      }}
      onKeyDown={(e: any) => e.key === 'Enter' && e.target.blur()}
    />
  );
}

function Sizes({ materials, sizes }: { materials: SheetMaterial[]; sizes: SheetSize[] }) {
  const active = materials.filter((m) => m.active);
  const [materialId, setMaterialId] = useState<string>(active[0] ? String(active[0].id) : '');
  const [thickness, setThickness] = useState('');
  const [length, setLength] = useState('');
  const [width, setWidth] = useState('');
  useEffect(() => {
    if (!materialId && active[0]) setMaterialId(String(active[0].id));
  }, [active.length]);
  const add = async (e: any) => {
    e.preventDefault();
    try {
      await post('/api/admin/sheet-sizes', { material_id: Number(materialId), thickness: num(thickness), length: Number(length), width: Number(width) });
      setLength('');
      setWidth('');
      refresh();
    } catch (err) {
      onAdminError(err);
    }
  };
  const remove = async (s: SheetSize, m: SheetMaterial | undefined) => {
    const ok = await ask({
      type: 'confirm',
      title: `Remove ${s.length} × ${s.width} mm${s.thickness != null ? ` (${s.thickness} mm)` : ''} for ${m?.name ?? 'this material'}?`,
      body: 'New calculations will no longer offer this size. Nothing else changes.',
      confirm: 'Remove size',
      danger: true,
    });
    if (!ok) return;
    try {
      await del(`/api/admin/sheet-sizes/${s.id}`);
      refresh();
    } catch (err) {
      onAdminError(err);
    }
  };
  return (
    <>
      <h3>Standard sheet sizes</h3>
      <p className="muted small">
        Length × width in mm, per material. Leave the thickness empty for a size stocked in every thickness; give it to list what is stocked per thickness (then
        components of that thickness use only those sizes). The calculator picks the size that needs the fewest sheets.
      </p>
      <table className="table admin-table sizes-table">
        <thead>
          <tr>
            <th>Material</th>
            <th>Thickness</th>
            <th>Length × width (mm)</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {sizes.map((s) => {
            const m = materials.find((x) => x.id === s.material_id);
            return (
              <tr key={s.id} className={m?.active ? '' : 'row-inactive'}>
                <td>{m?.name ?? '?'}</td>
                <td>{s.thickness != null ? `${s.thickness} mm` : <span className="muted">any</span>}</td>
                <td className="num">
                  {s.length} × {s.width}
                </td>
                <td>
                  <button className="btn btn-quiet btn-sm" onClick={() => void remove(s, m)} aria-label={`Remove ${s.length} × ${s.width} for ${m?.name ?? 'material'}`}>
                    Remove
                  </button>
                </td>
              </tr>
            );
          })}
          {!sizes.length && (
            <tr>
              <td colSpan={4} className="muted">
                No sizes yet. Add the sheets you buy below.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <form className="inline-form" onSubmit={add}>
        <select className="field-input" value={materialId} aria-label="Material of the new size" onChange={(e: any) => setMaterialId(e.target.value)}>
          {active.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <input className="field-input narrow" type="number" min={0.01} step="any" value={thickness} placeholder="Thickness (any)" aria-label="Thickness of the new size (mm, optional)" onChange={(e: any) => setThickness(e.target.value)} />
        <input className="field-input narrow" type="number" min={1} step="any" value={length} placeholder="Length" aria-label="Length of the new size (mm)" onChange={(e: any) => setLength(e.target.value)} />
        <span className="muted">×</span>
        <input className="field-input narrow" type="number" min={1} step="any" value={width} placeholder="Width" aria-label="Width of the new size (mm)" onChange={(e: any) => setWidth(e.target.value)} />
        <button className="btn btn-primary" disabled={!materialId || !(Number(length) > 0) || !(Number(width) > 0)}>
          Add size
        </button>
      </form>
    </>
  );
}

function Settings({ settings }: { settings: SheetSettings }) {
  const [util, setUtil] = useState(String(Math.round(settings.utilisation * 100)));
  const [kerf, setKerf] = useState(String(settings.kerf));
  useEffect(() => {
    setUtil(String(Math.round(settings.utilisation * 100)));
    setKerf(String(settings.kerf));
  }, [settings.utilisation, settings.kerf]);
  const save = async (e: any) => {
    e.preventDefault();
    try {
      await api('PUT', '/api/admin/tools/sheet-settings', { utilisation: Number(util) / 100, kerf: Number(kerf) });
      toast('Sheet calculator settings saved', { kind: 'success' });
      refresh();
    } catch (err) {
      onAdminError(err);
    }
  };
  return (
    <>
      <h3>Sheet calculator settings</h3>
      <form className="inline-form" onSubmit={save}>
        <label>
          Usable share of a sheet{' '}
          <input className="field-input narrow" type="number" min={10} max={100} value={util} aria-label="Usable share of a sheet (%)" onChange={(e: any) => setUtil(e.target.value)} /> %
        </label>
        <label>
          Cut width (kerf){' '}
          <input className="field-input narrow" type="number" min={0} max={50} step="any" value={kerf} aria-label="Cut width (mm)" onChange={(e: any) => setKerf(e.target.value)} /> mm
        </label>
        <button className="btn btn-primary" disabled={!(Number(util) >= 10 && Number(util) <= 100) || !(Number(kerf) >= 0)}>
          Save settings
        </button>
      </form>
      <p className="muted small">
        The usable share allows for scrap and offcuts when counting by area (85% means a 3000 × 1500 sheet yields 3.825 m² of parts). The cut width is added to every
        part when counting how many fit on a sheet in a grid.
      </p>
    </>
  );
}
