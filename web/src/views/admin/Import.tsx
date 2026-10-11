// Import jobs from a spreadsheet saved as CSV: choose file → check the preview → import.

import { useState } from 'react';
import { ApiError, sendRaw } from '../../lib/api.ts';
import { invalidate } from '../../lib/store.ts';
import { toast } from '../../lib/toasts.ts';
import { onAdminError } from './Admin.tsx';

interface Preview {
  columns: { header: string; field: string | null }[];
  rows: {
    line: number;
    title: string;
    priority: string;
    assignee: string | null;
    due_date: string | null;
    estimate_minutes: number | null;
    job_type: string | null;
    status: string;
    warnings: string[];
    errors: string[];
  }[];
  counts: { total: number; valid: number; with_errors: number; with_warnings: number };
  new_job_types: string[];
  new_projects: string[];
  no_project_column: boolean;
  already_imported: { at: string; rows: number; filename: string; user: string | null } | null;
}

const FIELD_LABEL: Record<string, string> = {
  title: 'Title',
  description: 'Description',
  priority: 'Priority',
  assignee: 'Assigned to',
  due_date: 'Due date',
  due_time: 'Due time',
  estimate: 'Estimate',
  requester: 'Requester',
  job_type: 'Job type',
  tags: 'Tags',
  reference: 'Reference',
  file_location: 'File location',
  notes: 'Notes',
  status: 'Status',
  waiting_for: 'Waiting for',
};

/** Excel's "CSV (Comma delimited)" is Windows-1252, its "CSV UTF-8" is UTF-8. Accept both. */
async function readText(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

export function ImportSection() {
  const [file, setFile] = useState<File | null>(null);
  const [csv, setCsv] = useState('');
  const [dateOrder, setDateOrder] = useState<'DMY' | 'MDY'>('DMY');
  const [createTypes, setCreateTypes] = useState(true);
  const [createProjects, setCreateProjects] = useState(true);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ created: number; first: string; last: string; skipped: number } | null>(null);
  const [allowDup, setAllowDup] = useState(false);

  const qs = (extra = '') =>
    `date_order=${dateOrder}&create_job_types=${createTypes ? 1 : 0}&create_projects=${createProjects ? 1 : 0}&filename=${encodeURIComponent(file?.name ?? '')}${extra}`;

  const choose = async (f: File | null) => {
    setPreview(null);
    setResult(null);
    setAllowDup(false);
    setFile(f);
    if (!f) return;
    if (/\.xlsx?$/i.test(f.name)) {
      toast('That is an Excel workbook. In Excel choose File, Save As, "CSV UTF-8 (Comma delimited)", then choose that file here.', { kind: 'error', timeout: 15000 });
      setFile(null);
      return;
    }
    setCsv(await readText(f));
  };

  const check = async () => {
    setBusy(true);
    try {
      setPreview(await sendRaw<Preview>('POST', `/api/admin/import/preview?${qs()}`, csv, 'text/csv'));
    } catch (e) {
      onAdminError(e);
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const r = await sendRaw<{ created: number; first: string; last: string; skipped: number }>(
        'POST',
        `/api/admin/import/commit?${qs(`&skip_invalid=1${allowDup ? '&allow_duplicate=1' : ''}`)}`,
        csv,
        'text/csv',
      );
      setResult(r);
      setPreview(null);
      invalidate();
      toast(`Imported ${r.created} jobs`, { kind: 'success' });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setPreview((p) => p && { ...p, already_imported: e.body.already_imported });
      onAdminError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="admin-section">
      <h2>Import jobs from Excel</h2>
      <ol className="steps">
        <li>
          In Excel, save your sheet with <strong>File, Save As, CSV UTF-8 (Comma delimited)</strong>. The first row must be column names; only a title
          column is required. Common names are recognised (Job, Task, Assigned To, Due Date, Est, Drawing No…).{' '}
          <a href="/api/import/template.csv" download>
            Download a template
          </a>
          .
        </li>
        <li>Choose the file and check the preview. Nothing is created yet.</li>
        <li>Import. A backup is taken first, and the whole file goes in at once or not at all.</li>
      </ol>

      <div className="import-controls">
        <input type="file" accept=".csv,text/csv" aria-label="CSV file" onChange={(e: any) => void choose(e.target.files?.[0] ?? null)} />
        <label>
          Dates like 02/10/2026 mean{' '}
          <select className="field-input inline" value={dateOrder} onChange={(e: any) => setDateOrder(e.target.value)}>
            <option value="DMY">2 October (day first)</option>
            <option value="MDY">February 10 (month first)</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={createTypes} onChange={(e: any) => setCreateTypes(e.target.checked)} />
          Add job types that don't exist yet
        </label>
        <label className="check">
          <input type="checkbox" checked={createProjects} onChange={(e: any) => setCreateProjects(e.target.checked)} />
          Add projects that don't exist yet
        </label>
        <button className="btn btn-primary" disabled={!csv || busy} onClick={() => void check()}>
          {busy && !preview ? 'Checking…' : 'Check the file'}
        </button>
      </div>

      {result && (
        <div className="notice notice-ok">
          Imported {result.created} jobs ({result.first} to {result.last}).
          {result.skipped > 0 && ` ${result.skipped} rows with errors were skipped.`} A backup from just before the import is in Backups, if you need to undo
          it.
        </div>
      )}

      {preview && (
        <div className="import-preview">
          <p className="import-summary">
            <strong>{preview.counts.valid}</strong> of {preview.counts.total} rows are ready to import.
            {preview.counts.with_errors > 0 && <span className="bad"> {preview.counts.with_errors} have errors and will be skipped.</span>}
            {preview.counts.with_warnings > 0 && <span> {preview.counts.with_warnings} will be imported with small changes (see the notes).</span>}
          </p>
          <p className="muted">
            Columns:{' '}
            {preview.columns.map((c, i) => (
              <span key={i} className={`colmap${c.field ? '' : ' ignored'}`}>
                {c.header} → {c.field ? FIELD_LABEL[c.field] : 'ignored'}
              </span>
            ))}
          </p>
          {preview.new_job_types.length > 0 && <p className="muted">New job types will be added: {preview.new_job_types.join(', ')}.</p>}
          {preview.new_projects.length > 0 && <p className="muted">New projects will be added: {preview.new_projects.join(', ')}.</p>}
          {preview.no_project_column && (
            <p className="warn-note">
              This sheet has no Project column, so the jobs will be imported without a project. Add a "Project" column, or choose each job's project on
              the board afterwards (Projects → No project).
            </p>
          )}
          {preview.already_imported && (
            <div className="notice notice-warn">
              This exact file was already imported on {preview.already_imported.at.slice(0, 10)}
              {preview.already_imported.user ? ` by ${preview.already_imported.user}` : ''} ({preview.already_imported.rows} jobs). Importing it again would
              create duplicates.
              <label className="check">
                <input type="checkbox" checked={allowDup} onChange={(e: any) => setAllowDup(e.target.checked)} /> Import it again anyway
              </label>
            </div>
          )}
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Line</th>
                  <th>Title</th>
                  <th>Assigned</th>
                  <th>Priority</th>
                  <th>Due</th>
                  <th className="num">Est.</th>
                  <th>Type</th>
                  <th>Goes to</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.line} className={r.errors.length ? 'row-error' : r.warnings.length ? 'row-warn' : ''}>
                    <td className="num">{r.line}</td>
                    <td>{r.title || <em className="muted">(none)</em>}</td>
                    <td>{r.assignee ?? ''}</td>
                    <td>{r.priority}</td>
                    <td>{r.due_date ?? ''}</td>
                    <td className="num">{r.estimate_minutes ?? ''}</td>
                    <td>{r.job_type ?? ''}</td>
                    <td>{r.status.replace('_', ' ')}</td>
                    <td className="row-notes">{[...r.errors, ...r.warnings].join('. ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="dialog-buttons">
            <button className="btn btn-quiet" onClick={() => setPreview(null)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={busy || preview.counts.valid === 0 || (!!preview.already_imported && !allowDup)}
              onClick={() => void commit()}
            >
              {busy ? 'Importing…' : `Import ${preview.counts.valid} ${preview.counts.valid === 1 ? 'job' : 'jobs'}`}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
