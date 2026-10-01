import { useState } from 'react';
import { del, post, sendRaw } from '../../lib/api.ts';
import { ask } from '../../lib/dialogs.ts';
import { when } from '../../lib/format.ts';
import { invalidate, useQuery } from '../../lib/store.ts';
import { toast } from '../../lib/toasts.ts';
import { Spinner } from '../../components/bits.tsx';
import { onAdminError } from './Admin.tsx';
import { useApp } from '../../context.ts';

interface Info {
  db_path: string;
  db_size: number;
  backup_dir: string;
  keep_days: number;
  tickets: number;
  archived: number;
  activity: number;
  version: string;
  node: string;
  tz: string;
  backups: { name: string; kind: string; size: number; created_at: string }[];
}

const KIND: Record<string, string> = {
  daily: 'Daily',
  manual: 'Made by hand',
  'pre-restore': 'Before a restore',
  'pre-import': 'Before an import',
  shutdown: 'At shutdown',
};

const size = (b: number) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1048576).toFixed(1)} MB`);

function useInfo() {
  return useQuery<Info>('/api/admin/info');
}

export function ExportSection() {
  return (
    <section className="admin-section">
      <h2>Export</h2>
      <p className="muted">Anyone can export from the Search page too (it exports what the search shows). These export everything, archived jobs included.</p>
      <div className="export-grid">
        <a className="export-card" href="/api/export/tickets.csv" download>
          <strong>All jobs as CSV</strong>
          <span>Opens in Excel. One row per job; dates in local time.</span>
        </a>
        <a className="export-card" href="/api/export/tickets.json" download>
          <strong>Everything as JSON</strong>
          <span>Every job with its full history, plus the team and job types. For safekeeping or moving to another system.</span>
        </a>
      </div>
    </section>
  );
}

export function BackupSection() {
  const q = useInfo();
  const [busy, setBusy] = useState(false);
  if (!q.data) return <Spinner />;
  const d = q.data;

  const backupNow = async () => {
    setBusy(true);
    try {
      const r = await post<{ backup: { name: string } }>('/api/admin/backups');
      toast(`Backup saved: ${r.backup.name}`, { kind: 'success' });
      invalidate('/api/admin/info');
    } catch (e) {
      onAdminError(e);
    } finally {
      setBusy(false);
    }
  };

  const restore = async (name: string, label: string) => {
    const ok = await ask({
      type: 'confirm',
      title: 'Restore this backup?',
      body: `The board goes back to how it was at ${label}. Anything changed since then disappears from the board, but a backup of the current data is taken first, so this can be undone. Everyone's screens refresh.`,
      confirm: 'Restore',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await post<{ tickets: number; safety_backup: string }>('/api/admin/restore', { name });
      toast(`Restored (${r.tickets} jobs). The data from before is saved as ${r.safety_backup}.`, { kind: 'success', timeout: 15000 });
      invalidate();
    } catch (e) {
      onAdminError(e);
    } finally {
      setBusy(false);
    }
  };

  const restoreFile = async (file: File | null) => {
    if (!file) return;
    const ok = await ask({
      type: 'confirm',
      title: `Restore from ${file.name}?`,
      body: "The board's data is replaced by this file. A backup of the current data is taken first, so this can be undone.",
      confirm: 'Restore',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await sendRaw<{ tickets: number; safety_backup: string }>('POST', '/api/admin/restore/upload', file, 'application/octet-stream');
      toast(`Restored from ${file.name} (${r.tickets} jobs). The data from before is saved as ${r.safety_backup}.`, { kind: 'success', timeout: 15000 });
      invalidate();
    } catch (e) {
      onAdminError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="admin-section">
      <h2>Backups and restore</h2>
      <p className="muted">
        A backup is taken automatically once a day (the first hour the board is running that day), before every import and before every restore. Backups
        older than {d.keep_days} days are deleted, but the newest 7 are always kept.
      </p>
      <dl className="facts facts-inline">
        <div>
          <dt>Backup folder</dt>
          <dd>
            <code>{d.backup_dir}</code>
          </dd>
        </div>
        <div>
          <dt>Database</dt>
          <dd>
            {size(d.db_size)}, {d.tickets} jobs ({d.archived} archived), {d.activity} history entries
          </dd>
        </div>
      </dl>
      <p className="hint">
        Tip: the backups are only as safe as the PC they're on. Copy them to a network drive now and then, or set <code>backupDir</code> in config.json
        to a folder on a network share or OneDrive.
      </p>
      <div className="inline-form">
        <button className="btn btn-primary" disabled={busy} onClick={() => void backupNow()}>
          Back up now
        </button>
        <label className="btn file-btn">
          Restore from a file…
          <input type="file" accept=".db" onChange={(e: any) => void restoreFile(e.target.files?.[0] ?? null)} />
        </label>
      </div>
      {d.backups.length === 0 ? (
        <p className="vsection-empty">No backups yet. The first daily backup is taken once there are jobs on the board.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Taken</th>
              <th>Why</th>
              <th className="num">Size</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {d.backups.map((b) => (
              <tr key={b.name}>
                <td title={b.name}>{when(b.created_at)}</td>
                <td>{KIND[b.kind] ?? b.kind}</td>
                <td className="num">{size(b.size)}</td>
                <td className="row-actions">
                  <a className="btn btn-quiet" href={`/api/admin/backups/${b.name}`} download>
                    Download
                  </a>
                  <button className="btn btn-quiet danger" disabled={busy} onClick={() => void restore(b.name, when(b.created_at))}>
                    Restore…
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function ArchiveSection() {
  const [days, setDays] = useState(90);
  const archive = async () => {
    const ok = await ask({
      type: 'confirm',
      title: `Archive jobs finished more than ${days} days ago?`,
      body: 'They leave the board and the Done column but stay searchable, and any of them can be restored from its panel.',
      confirm: 'Archive',
    });
    if (!ok) return;
    try {
      const r = await post<{ archived: number }>('/api/admin/archive-old', { days });
      toast(r.archived ? `Archived ${r.archived} jobs` : 'Nothing to archive', { kind: 'success' });
      invalidate();
    } catch (e) {
      onAdminError(e);
    }
  };
  return (
    <section className="admin-section">
      <h2>Archive</h2>
      <p className="muted">
        Done jobs already leave the board after 7 days. Archiving also hides them from normal lists and reports of open work. Archived jobs are never
        deleted: find them with Search ("Include archived jobs").
      </p>
      <div className="inline-form">
        <label>
          Finished more than{' '}
          <input className="field-input narrow" type="number" min={1} max={3650} value={days} onChange={(e: any) => setDays(Number(e.target.value) || 1)} /> days
          ago
        </label>
        <button className="btn" onClick={() => void archive()}>
          Archive them
        </button>
      </div>
    </section>
  );
}

export function PinSection() {
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const mismatch = again.length > 0 && pin !== again;
  const save = async (e: any) => {
    e.preventDefault();
    try {
      await post('/api/admin/pin', { new_pin: pin });
      toast('Admin PIN changed. Share it only with people who should manage the board.', { kind: 'success' });
      setPin('');
      setAgain('');
      invalidate('/api/admin/status');
      invalidate('/api/meta');
    } catch (err) {
      onAdminError(err);
    }
  };
  return (
    <section className="admin-section">
      <h2>Admin PIN</h2>
      <p className="muted">At least 4 characters, no spaces. Numbers are easiest to share; anything works.</p>
      <form className="pin-form" onSubmit={save}>
        <input className="field-input" type="password" autoComplete="new-password" placeholder="New PIN" aria-label="New PIN" value={pin} onChange={(e: any) => setPin(e.target.value)} />
        <input
          className="field-input"
          type="password"
          autoComplete="new-password"
          placeholder="Type it again"
          aria-label="Confirm new PIN"
          aria-invalid={mismatch}
          value={again}
          onChange={(e: any) => setAgain(e.target.value)}
        />
        {mismatch && <p className="form-error">The two PINs don't match.</p>}
        <button className="btn btn-primary" disabled={pin.length < 4 || /\s/.test(pin) || pin !== again}>
          Change PIN
        </button>
      </form>
    </section>
  );
}

export function DemoSection() {
  const { meta } = useApp();
  const m = useQuery<{ demo_present: boolean }>('/api/meta');
  const present = m.data?.demo_present ?? meta.demo_present;
  const load = async () => {
    try {
      const r = await post<{ created: number }>('/api/admin/demo');
      toast(`Added ${r.created} demo jobs`, { kind: 'success' });
      invalidate();
    } catch (e) {
      onAdminError(e);
    }
  };
  const clear = async () => {
    const ok = await ask({ type: 'confirm', title: 'Remove the demo jobs?', body: 'Only demo jobs are removed. Real jobs are not touched.', confirm: 'Remove demo jobs', danger: true });
    if (!ok) return;
    try {
      const r = await del<{ removed: number }>('/api/admin/demo');
      toast(`Removed ${r.removed} demo jobs`, { kind: 'success' });
      invalidate();
    } catch (e) {
      onAdminError(e);
    }
  };
  return (
    <section className="admin-section">
      <h2>Demo data</h2>
      <p className="muted">Twelve example jobs across every column, for trying the board out or showing it to someone. They are marked as demo jobs and can be removed in one go without touching real ones.</p>
      {present ? (
        <button className="btn btn-danger" onClick={() => void clear()}>
          Remove demo jobs
        </button>
      ) : (
        <button className="btn" onClick={() => void load()}>
          Add demo jobs
        </button>
      )}
    </section>
  );
}

export function AboutSection() {
  const q = useInfo();
  if (!q.data) return <Spinner />;
  const d = q.data;
  return (
    <section className="admin-section">
      <h2>About this board</h2>
      <dl className="facts">
        <div>
          <dt>Version</dt>
          <dd>{d.version}</dd>
        </div>
        <div>
          <dt>Database file</dt>
          <dd>
            <code>{d.db_path}</code> ({size(d.db_size)})
          </dd>
        </div>
        <div>
          <dt>Backup folder</dt>
          <dd>
            <code>{d.backup_dir}</code>
          </dd>
        </div>
        <div>
          <dt>Time zone</dt>
          <dd>{d.tz}</dd>
        </div>
        <div>
          <dt>Node.js</dt>
          <dd>{d.node}</dd>
        </div>
      </dl>
      <p className="hint">Settings such as the port, time zone, working days and backup folder live in config.json next to start.bat.</p>
    </section>
  );
}
