// Admin area: team, job types, tags, import, export, backups, PIN.
// Unlocked with the admin PIN for 12 hours on this browser.

import { useState } from 'react';
import { post } from '../../lib/api.ts';
import { navigate, useLocation } from '../../lib/router.ts';
import { invalidate, useQuery } from '../../lib/store.ts';
import { toastError } from '../../lib/toasts.ts';
import { ErrorBox, Spinner } from '../../components/bits.tsx';
import { TeamSection } from './Team.tsx';
import { JobTypesSection, TagsSection } from './Lists.tsx';
import { ImportSection } from './Import.tsx';
import { BackupSection, ExportSection, ArchiveSection, PinSection, DemoSection, AboutSection } from './Data.tsx';

const SECTIONS = [
  { id: 'team', label: 'Team', C: TeamSection },
  { id: 'job-types', label: 'Job types', C: JobTypesSection },
  { id: 'tags', label: 'Tags', C: TagsSection },
  { id: 'import', label: 'Import from Excel', C: ImportSection },
  { id: 'export', label: 'Export', C: ExportSection },
  { id: 'backups', label: 'Backups and restore', C: BackupSection },
  { id: 'archive', label: 'Archive', C: ArchiveSection },
  { id: 'pin', label: 'Admin PIN', C: PinSection },
  { id: 'demo', label: 'Demo data', C: DemoSection },
  { id: 'about', label: 'About this board', C: AboutSection },
];

export function Admin() {
  const status = useQuery<{ unlocked: boolean; pin_is_default: boolean }>('/api/admin/status');
  const { params } = useLocation();
  const current = SECTIONS.find((s) => s.id === params.get('s')) ?? SECTIONS[0];

  if (status.error && !status.data) return <ErrorBox message={status.error.message} retry={status.refresh} />;
  if (!status.data) return <Spinner />;
  if (!status.data.unlocked) return <Unlock pinIsDefault={status.data.pin_is_default} />;

  const lock = async () => {
    try {
      await post('/api/admin/lock');
    } finally {
      invalidate('/api/admin');
    }
  };

  return (
    <div className="view">
      <header className="view-head view-head-row">
        <h1>Admin</h1>
        <button className="btn btn-quiet" onClick={() => void lock()}>
          Lock admin
        </button>
      </header>
      {status.data.pin_is_default && (
        <div className="notice notice-warn">
          The admin PIN is still the default (1234). Anyone on the network could change the team or restore old data.{' '}
          <button className="link-btn" onClick={() => navigate('/admin?s=pin')}>
            Change it now
          </button>
        </div>
      )}
      <div className="admin-grid">
        <nav className="admin-nav" aria-label="Admin sections">
          {SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`/admin?s=${s.id}`}
              className={s.id === current.id ? 'on' : ''}
              aria-current={s.id === current.id ? 'page' : undefined}
              onClick={(e: any) => {
                e.preventDefault();
                navigate(`/admin?s=${s.id}`);
              }}
            >
              {s.label}
            </a>
          ))}
        </nav>
        <div className="admin-body">
          <current.C />
        </div>
      </div>
    </div>
  );
}

function Unlock({ pinIsDefault }: { pinIsDefault: boolean }) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [wrong, setWrong] = useState(false);
  const submit = async (e: any) => {
    e.preventDefault();
    setBusy(true);
    setWrong(false);
    try {
      await post('/api/admin/unlock', { pin });
      invalidate('/api/admin');
    } catch (err: any) {
      if (err?.status === 403) setWrong(true);
      else toastError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="center-screen">
      <form className="who-card unlock" onSubmit={submit}>
        <h1 className="brand-big">Admin</h1>
        <p className="muted">Enter the admin PIN. It stays unlocked on this browser for 12 hours.</p>
        <input
          className="qc-title"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          autoFocus
          value={pin}
          aria-label="Admin PIN"
          aria-invalid={wrong}
          onChange={(e: any) => setPin(e.target.value)}
        />
        {wrong && <p className="form-error">That PIN isn't right.</p>}
        {pinIsDefault && <p className="muted">The PIN is still the default: 1234. Change it once you're in.</p>}
        <div className="dialog-buttons">
          <button className="btn btn-quiet" type="button" onClick={() => navigate('/board')}>
            Back to the board
          </button>
          <button className="btn btn-primary" type="submit" disabled={!pin || busy}>
            Unlock
          </button>
        </div>
      </form>
    </div>
  );
}

/** Admin calls fail with 403 admin_locked once the 12 hours are up: show the PIN screen again. */
export function onAdminError(err: any) {
  if (err?.code === 'admin_locked') invalidate('/api/admin/status');
  toastError(err);
}
