// Admin → Tools (decision #32): the reference data behind the engineers' tools.
// Today: the sheet calculator's Materials sheet (material → standard sheet
// sizes) and the defaults for its three inputs (kerf, edge margin, rotation).

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

export function ToolsDataSection() {
  const q = useQuery<Data>('/api/tools/sheet');
  if (!q.data) return <Spinner />;
  const { materials, sizes, settings } = q.data;
  return (
    <section className="admin-section">
      <h2>Tools</h2>
      <p className="muted">
        Reference data for the <strong>Tools</strong> page. The sheet calculator is the team's <em>Sheet Requirement Calculator</em> workbook as a board page; its
        Materials sheet is the list below. More tools will be added here over time.
      </p>
      <Materials materials={materials} />
      <Sizes materials={materials} sizes={sizes} />
      <Settings settings={settings} />
    </section>
  );
}

function Materials({ materials }: { materials: SheetMaterial[] }) {
  const [name, setName] = useState('');
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
      await post('/api/admin/materials', { name: name.trim() });
      setName('');
      refresh();
    } catch (err) {
      onAdminError(err);
    }
  };
  return (
    <>
      <h3>Materials</h3>
      <p className="muted small">The order here is the order in the calculator's menu. Retiring a material hides it from new calculations; it is never deleted.</p>
      <ul className="admin-list">
        {materials.map((m) => (
          <li key={m.id} className={m.active ? '' : 'row-inactive'}>
            <RenameInput value={m.name} label={`Name of ${m.name}`} onSave={(v) => save(m, { name: v })} />
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
        <button className="btn btn-primary" disabled={!name.trim()}>
          Add material
        </button>
      </form>
    </>
  );
}

function Sizes({ materials, sizes }: { materials: SheetMaterial[]; sizes: SheetSize[] }) {
  const active = materials.filter((m) => m.active);
  const [materialId, setMaterialId] = useState<string>(active[0] ? String(active[0].id) : '');
  const [length, setLength] = useState('');
  const [width, setWidth] = useState('');
  useEffect(() => {
    if (!materialId && active[0]) setMaterialId(String(active[0].id));
  }, [active.length]);
  const add = async (e: any) => {
    e.preventDefault();
    try {
      await post('/api/admin/sheet-sizes', { material_id: Number(materialId), length: Number(length), width: Number(width) });
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
      title: `Remove ${s.length} × ${s.width} mm for ${m?.name ?? 'this material'}?`,
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
        Sheet length × width in mm, per material: the workbook's Materials sheet. The list starts with its typical stock sizes; replace them with the sizes your
        supplier actually delivers. A material may have more than one size; the calculator then uses the one that needs the fewest sheets.
      </p>
      <table className="table admin-table sizes-table">
        <thead>
          <tr>
            <th>Material</th>
            <th>Sheet length × width (mm)</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {sizes.map((s) => {
            const m = materials.find((x) => x.id === s.material_id);
            return (
              <tr key={s.id} className={m?.active ? '' : 'row-inactive'}>
                <td>{m?.name ?? '?'}</td>
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
              <td colSpan={3} className="muted">
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
  const [kerf, setKerf] = useState(String(settings.kerf));
  const [margin, setMargin] = useState(String(settings.margin));
  const [rotate, setRotate] = useState(settings.rotate);
  useEffect(() => {
    setKerf(String(settings.kerf));
    setMargin(String(settings.margin));
    setRotate(settings.rotate);
  }, [settings.kerf, settings.margin, settings.rotate]);
  const save = async (e: any) => {
    e.preventDefault();
    try {
      await api('PUT', '/api/admin/tools/sheet-settings', { kerf: Number(kerf), margin: Number(margin), rotate });
      toast('Sheet calculator defaults saved', { kind: 'success' });
      refresh();
    } catch (err) {
      onAdminError(err);
    }
  };
  return (
    <>
      <h3>Sheet calculator defaults</h3>
      <p className="muted small">
        The workbook's three inputs, prefilled for every new calculation (people can still change them on the Tools page): the <strong>kerf</strong> left between
        adjacent parts, the <strong>edge margin</strong> unusable on every side of the sheet, and whether parts may be <strong>rotated</strong> by 90°.
      </p>
      <form className="inline-form" onSubmit={save}>
        <label>
          Spacing / kerf{' '}
          <input className="field-input narrow" type="number" min={0} max={100} step="any" value={kerf} aria-label="Default kerf (mm)" onChange={(e: any) => setKerf(e.target.value)} /> mm
        </label>
        <label>
          Edge margin{' '}
          <input className="field-input narrow" type="number" min={0} max={500} step="any" value={margin} aria-label="Default edge margin (mm)" onChange={(e: any) => setMargin(e.target.value)} /> mm
        </label>
        <label>
          <input type="checkbox" checked={rotate} aria-label="Allow rotation by 90 degrees by default" onChange={(e: any) => setRotate(e.target.checked)} /> Allow rotation by 90°
        </label>
        <button className="btn btn-primary" disabled={!(Number(kerf) >= 0) || !(Number(margin) >= 0)}>
          Save defaults
        </button>
      </form>
    </>
  );
}
