// The workbook link (decision #47): a project's procurement list and the
// inventory workbook kept as one list by the workbook's macro. This tab makes
// the keys the macro signs in with, hands out the macro, and shows what the
// last syncs changed. The syncing itself is all in the workbook and on the
// server (server/src/domain/workbookSync.ts).

import { useState } from 'react';
import { useApp } from '../context.ts';
import { del, post } from '../lib/api.ts';
import { copyText } from '../lib/clipboard.ts';
import { ask } from '../lib/dialogs.ts';
import { dateTime, when } from '../lib/format.ts';
import { invalidate, useQuery } from '../lib/store.ts';
import { toast, toastError } from '../lib/toasts.ts';
import { ErrorBox, Spinner } from '../components/bits.tsx';

interface KeyRow {
  id: number;
  user_id: number;
  hint: string;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}
interface LogRow {
  id: number;
  user_id: number;
  at: string;
  added: number;
  changed: number;
  removed: number;
  stock: number;
  build: number;
  conflicts: number;
}
interface Link {
  keys: KeyRow[];
  log: LogRow[];
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
/** What one sync changed, in words: "2 parts added, 1 changed". */
function changes(l: LogRow): string {
  const parts = [
    l.added && `${plural(l.added, 'part')} added`,
    l.changed && `${plural(l.changed, 'part')} changed`,
    l.removed && `${plural(l.removed, 'part')} removed`,
    l.stock && `${plural(l.stock, 'stock tick')}`,
    l.build && 'what the project builds',
    l.conflicts && `${plural(l.conflicts, 'clash', 'clashes')} for the person to settle`,
  ].filter(Boolean);
  return parts.join(', ');
}

export function WorkbookLink({ project }: { project: { id: number; name: string } }) {
  const { me, user } = useApp();
  const path = `/api/projects/${project.id}/workbook-link`;
  const q = useQuery<Link>(path);
  const [fresh, setFresh] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const address = window.location.origin;

  const make = async () => {
    setBusy(true);
    try {
      const r = await post<{ key: string }>(`${path}/keys`, {});
      setFresh(r.key);
      invalidate(path);
    } catch (e) {
      toastError(e);
    }
    setBusy(false);
  };
  const revoke = async (k: KeyRow) => {
    const ok = await ask({
      type: 'confirm',
      title: 'Switch off this key?',
      body: `The workbook using the key ending ${k.hint} will stop syncing with ${project.name} until it is given a new key. Nothing already synced is lost.`,
      confirm: 'Switch off',
      danger: true,
    });
    if (!ok) return;
    try {
      await del(`/api/workbook-link/keys/${k.id}`);
      invalidate(path);
    } catch (e) {
      toastError(e);
    }
  };
  const copy = async (text: string, what: string) => toast((await copyText(text)) ? `${what} copied.` : `Could not copy: select the ${what.toLowerCase()} and copy it by hand.`);

  const live = q.data?.keys.filter((k) => !k.revoked_at) ?? [];
  const off = q.data?.keys.filter((k) => k.revoked_at) ?? [];

  return (
    <div className="proc-stack wb-link" data-testid="workbook-link">
      <section>
        <h2>Workbook link</h2>
        <p className="muted">
          The inventory workbook and this list are one list. A change typed in the workbook is saved here a moment later; a change made here is written into the
          workbook within half a minute while it is open, and when it is next opened. If the same cell is changed in both places, the workbook shows both values
          and asks which to keep.
        </p>
      </section>

      <section className="wb-section">
        <h3>1. Put the macro in the workbook (once)</h3>
        <ol className="wb-steps">
          <li>
            Download{' '}
            <a href="/api/workbook-link/macro/BoardSync.bas" download>
              BoardSync.bas
            </a>{' '}
            and{' '}
            <a href="/api/workbook-link/macro/ThisWorkbook.txt" download>
              ThisWorkbook.txt
            </a>
            .
          </li>
          <li>
            Open the workbook, press <kbd>Alt</kbd>+<kbd>F11</kbd>, then <strong>File → Import File…</strong> and choose <code>BoardSync.bas</code>.
          </li>
          <li>
            In the list on the left, double-click <strong>ThisWorkbook</strong> and paste in everything from <code>ThisWorkbook.txt</code>.
          </li>
          <li>Close the editor and save the workbook as a macro-enabled workbook (.xlsm).</li>
        </ol>
      </section>

      <section className="wb-section">
        <h3>2. Give the workbook a key</h3>
        <p className="muted">
          A key lets one person's workbook change this project's list, and nothing else on the board. What it changes is recorded under that person. Anyone who
          has the workbook file has its key, so switch a key off if a copy goes astray.
        </p>
        <p>
          <button className="btn btn-primary" disabled={busy} onClick={() => void make()}>
            Make a key for my workbook
          </button>
        </p>
        {fresh && (
          <div className="wb-fresh" data-testid="wb-fresh-key">
            <p>
              <strong>Copy this key now: it is not shown again.</strong> In the workbook, press <kbd>Alt</kbd>+<kbd>F8</kbd>, run <code>BoardSync_Setup</code>, and
              paste the board's address and this key when asked.
            </p>
            <label>
              Board address
              <span className="wb-copy">
                <input className="field-input" readOnly value={address} aria-label="Board address" onFocus={(e: any) => e.target.select()} />
                <button className="btn" onClick={() => void copy(address, 'Address')}>
                  Copy
                </button>
              </span>
            </label>
            <label>
              Key
              <span className="wb-copy">
                <input className="field-input" readOnly value={fresh} aria-label="New workbook key" onFocus={(e: any) => e.target.select()} />
                <button className="btn" onClick={() => void copy(fresh, 'Key')}>
                  Copy
                </button>
              </span>
            </label>
          </div>
        )}
        {q.error && <ErrorBox message={q.error.message} retry={q.refresh} />}
        {!q.data && !q.error && <Spinner />}
        {q.data && (
          <table className="table proc-table" data-testid="wb-keys">
            <thead>
              <tr>
                <th>Key</th>
                <th>Whose</th>
                <th>Made</th>
                <th>Last used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {!live.length && (
                <tr>
                  <td colSpan={5} className="muted">
                    No workbook is linked to this project yet.
                  </td>
                </tr>
              )}
              {live.map((k) => (
                <tr key={k.id}>
                  <td>
                    <code>…{k.hint}</code>
                  </td>
                  <td>{user(k.user_id)?.name ?? 'Unknown'}</td>
                  <td>{dateTime(k.created_at)}</td>
                  <td>{k.last_used_at ? when(k.last_used_at) : 'Not yet'}</td>
                  <td>
                    {(k.user_id === me.id || me.role === 'manager' || me.is_admin) && (
                      <button className="btn btn-quiet" onClick={() => void revoke(k)}>
                        Switch off
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {off.map((k) => (
                <tr key={k.id} className="muted">
                  <td>
                    <code>…{k.hint}</code>
                  </td>
                  <td>{user(k.user_id)?.name ?? 'Unknown'}</td>
                  <td>{dateTime(k.created_at)}</td>
                  <td colSpan={2}>Switched off {dateTime(k.revoked_at!)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="wb-section">
        <h3>What the workbook has changed</h3>
        {q.data && !q.data.log.length && <p className="muted">Nothing yet.</p>}
        {q.data && !!q.data.log.length && (
          <table className="table proc-table" data-testid="wb-log">
            <thead>
              <tr>
                <th>When</th>
                <th>Whose workbook</th>
                <th>What changed</th>
              </tr>
            </thead>
            <tbody>
              {q.data.log.map((l) => (
                <tr key={l.id}>
                  <td>{dateTime(l.at)}</td>
                  <td>{user(l.user_id)?.name ?? 'Unknown'}</td>
                  <td>{changes(l)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
