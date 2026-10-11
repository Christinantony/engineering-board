// Admin → Health (decision #34): the PC the board runs on, in one place.

import { useState } from 'react';
import { post } from '../../lib/api.ts';
import { when } from '../../lib/format.ts';
import { navigate } from '../../lib/router.ts';
import { invalidate, useQuery } from '../../lib/store.ts';
import { toast } from '../../lib/toasts.ts';
import { ErrorBox, Spinner } from '../../components/bits.tsx';
import { onAdminError } from './Admin.tsx';

type Level = 'ok' | 'warn' | 'bad';
interface Disk {
  path: string;
  free: number;
  total: number;
}
export interface HostHealth {
  level: Level;
  checks: { id: string; level: Level; title: string; detail: string }[];
  host: { name: string; platform: string; node: string; version: string; started_at: string; uptime_seconds: number };
  database: { path: string; size: number; wal_size: number; tickets: number; activity: number; schema: number };
  review_files: { path: string; count: number; size: number };
  backups: { dir: string; count: number; size: number; newest: { name: string; kind: string; created_at: string } | null; last_daily: string | null; keep_days: number };
  disks: { database: Disk | null; backups: Disk | null; same_disk: boolean | null };
}

export const useHealth = () => useQuery<HostHealth>('/api/admin/health');

const bytes = (b: number) =>
  b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(b ? 1 : 0, Math.round(b / 1024))} KB`;

function uptime(s: number) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}

const LEVEL_LABEL: Record<Level, string> = { ok: 'OK', warn: 'Check', bad: 'Fix now' };

function DiskBar({ label, d }: { label: string; d: Disk | null }) {
  if (!d || !d.total) return null;
  const used = 1 - d.free / d.total;
  return (
    <div className="health-disk">
      <div className="health-disk-head">
        <strong>{label}</strong>
        <span className="muted small">
          {bytes(d.free)} free of {bytes(d.total)}
        </span>
      </div>
      <div className="health-disk-bar" role="img" aria-label={`${label}: ${Math.round(used * 100)}% used`}>
        <span style={{ width: `${Math.min(100, Math.max(0, used * 100)).toFixed(1)}%` }} />
      </div>
      <code className="small">{d.path}</code>
    </div>
  );
}

export function HealthSection() {
  const q = useHealth();
  const [busy, setBusy] = useState(false);
  if (q.error && !q.data) return <ErrorBox message={q.error.message} retry={q.refresh} />;
  if (!q.data) return <Spinner />;
  const d = q.data;

  const backupNow = async () => {
    setBusy(true);
    try {
      const r = await post<{ backup: { name: string } }>('/api/admin/backups');
      toast(`Backup saved: ${r.backup.name}`, { kind: 'success' });
      invalidate('/api/admin');
    } catch (e) {
      onAdminError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="admin-section">
      <div className="view-head-row">
        <h2>Health</h2>
        <span className="spacer" />
        <button className="btn btn-quiet" onClick={() => q.refresh()}>
          Check again
        </button>
      </div>
      <p className="muted">
        The PC the board runs on: whether backups are being made and kept somewhere safe, whether there is room on the disk, and whether the database reads back
        cleanly.
      </p>

      <ul className="health-checks" data-testid="health-checks">
        {d.checks.map((c) => (
          <li key={c.id} className={`health-check health-${c.level}`} data-check={c.id}>
            <span className="health-badge">{LEVEL_LABEL[c.level]}</span>
            <div>
              <strong>{c.title}</strong>
              <p>{c.detail}</p>
              {c.id === 'backups' && c.level !== 'ok' && (
                <button className="btn btn-primary btn-small" disabled={busy} onClick={() => void backupNow()}>
                  Back up now
                </button>
              )}
              {c.id === 'admin_pin' && c.level !== 'ok' && (
                <button className="link-btn" onClick={() => navigate('/admin?s=pin')}>
                  Change the PIN
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>

      <h3>Disk space</h3>
      <div className="health-disks">
        <DiskBar label="Board data" d={d.disks.database} />
        {d.disks.same_disk ? null : <DiskBar label="Backups" d={d.disks.backups} />}
      </div>

      <h3>Details</h3>
      <dl className="facts facts-grid">
        <div>
          <dt>Host PC</dt>
          <dd>
            {d.host.name} · {d.host.platform}
          </dd>
        </div>
        <div>
          <dt>Board version</dt>
          <dd>
            {d.host.version} on Node.js {d.host.node}
          </dd>
        </div>
        <div>
          <dt>Running since</dt>
          <dd>
            {when(d.host.started_at)} ({uptime(d.host.uptime_seconds)})
          </dd>
        </div>
        <div>
          <dt>Database</dt>
          <dd>
            {bytes(d.database.size + d.database.wal_size)} · {d.database.tickets} jobs · {d.database.activity} history entries · schema {d.database.schema}
          </dd>
        </div>
        <div>
          <dt>Drawing-review PDFs</dt>
          <dd>
            {d.review_files.count} files, {bytes(d.review_files.size)}
          </dd>
        </div>
        <div>
          <dt>Backups</dt>
          <dd>
            {d.backups.count} kept ({bytes(d.backups.size)}), {d.backups.keep_days} days
            {d.backups.newest ? `; newest ${when(d.backups.newest.created_at)}` : ''}
          </dd>
        </div>
        <div>
          <dt>Backup folder</dt>
          <dd>
            <code>{d.backups.dir}</code>
          </dd>
        </div>
      </dl>
      <p className="hint">The backup folder is set by "backupDir" in config.json next to start.bat. A network share or a OneDrive folder keeps backups safe if this PC fails.</p>
    </section>
  );
}

/** A line at the top of Admin when something on the Health page needs attention. */
export function HealthNotice({ onHealthPage }: { onHealthPage: boolean }) {
  const q = useHealth();
  if (onHealthPage || !q.data || q.data.level === 'ok') return null;
  const first = q.data.checks.find((c) => c.level === q.data!.level)!;
  return (
    <div className={`notice ${q.data.level === 'bad' ? 'notice-bad' : 'notice-warn'}`} data-testid="health-notice">
      <strong>{first.title}.</strong>{' '}
      <button className="link-btn" onClick={() => navigate('/admin?s=health')}>
        Open Health
      </button>
    </div>
  );
}
