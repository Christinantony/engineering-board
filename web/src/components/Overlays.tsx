// Dialog host (reason / assign / confirm) and the toast stack.

import { useEffect, useRef, useState } from 'react';
import { useApp } from '../context.ts';
import { useDialog } from '../lib/dialogs.ts';
import { dismiss, useToasts } from '../lib/toasts.ts';
import { Badge } from './bits.tsx';
import { useFocusTrap } from '../lib/focus.ts';
import { SHORTCUTS } from '../lib/shortcuts.ts';

const SUGGESTIONS = ['Customer information', 'Dimensions', 'Material specification', 'Manufacturing feedback', 'Simulation result', 'Manager approval', 'Supplier response'];

export function DialogHost() {
  const d = useDialog();
  if (!d) return null;
  return <DialogFrame key={dialogKey(d.spec)} d={d} />;
}

// a stable key per opened dialog, so a new dialog starts fresh but re-renders keep what you typed
const keys = new WeakMap<object, number>();
let nextKey = 1;
function dialogKey(spec: object): number {
  if (!keys.has(spec)) keys.set(spec, nextKey++);
  return keys.get(spec)!;
}

function DialogFrame({ d }: { d: NonNullable<ReturnType<typeof useDialog>> }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useFocusTrap(ref);
  const close = () => d.resolve(null);
  return (
    <div className="dialog-backdrop" onMouseDown={(e: any) => e.target === e.currentTarget && close()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" ref={ref}>
        {d.spec.type === 'help' && <HelpDialog done={d.resolve} />}
        {d.spec.type === 'reason' && <ReasonDialog spec={d.spec} done={d.resolve} />}
        {d.spec.type === 'assign' && <AssignDialog spec={d.spec} done={d.resolve} />}
        {d.spec.type === 'confirm' && <ConfirmDialog spec={d.spec} done={d.resolve} />}
        {d.spec.type === 'conflict' && <ConflictDialog spec={d.spec} done={d.resolve} />}
      </div>
    </div>
  );
}

function useEscape(fn: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        fn();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [fn]);
}

function ReasonDialog({ spec, done }: { spec: any; done: (v: any) => void }) {
  const [reason, setReason] = useState(spec.initial ?? '');
  const [status, setStatus] = useState<'waiting' | 'blocked'>(spec.status);
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => ref.current?.focus(), []);
  useEscape(() => done(null));
  const ok = () => reason.trim() && done({ reason: reason.trim(), status });
  return (
    <form
      onSubmit={(e: any) => {
        e.preventDefault();
        ok();
      }}
    >
      <h2 className="dialog-title" id="dialog-title">
        {spec.ticket.job_number} is waiting for…
      </h2>
      <p className="muted dialog-sub">{spec.ticket.title}</p>
      <input
        ref={ref}
        className="field-input"
        value={reason}
        maxLength={500}
        list="waiting-suggestions"
        placeholder="e.g. Customer to confirm mounting dimensions"
        aria-label="Waiting for"
        onChange={(e: any) => setReason(e.target.value)}
      />
      <datalist id="waiting-suggestions">
        {SUGGESTIONS.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      <div className="seg" role="radiogroup" aria-label="Kind">
        <label className={status === 'waiting' ? 'on' : ''}>
          <input type="radio" name="kind" checked={status === 'waiting'} onChange={() => setStatus('waiting')} />
          Waiting on someone
        </label>
        <label className={status === 'blocked' ? 'on' : ''}>
          <input type="radio" name="kind" checked={status === 'blocked'} onChange={() => setStatus('blocked')} />
          Blocked
        </label>
      </div>
      <div className="dialog-buttons">
        <button type="button" className="btn btn-quiet" onClick={() => done(null)}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={!reason.trim()}>
          Move to {status === 'blocked' ? 'Blocked' : 'Waiting'}
        </button>
      </div>
    </form>
  );
}

function AssignDialog({ spec, done }: { spec: any; done: (v: any) => void }) {
  const { engineers } = useApp();
  useEscape(() => done(null));
  return (
    <div>
      <h2 className="dialog-title" id="dialog-title">{spec.title}</h2>
      <p className="muted dialog-sub">{spec.ticket.title}</p>
      <div className="assign-grid">
        {engineers
          .filter((u) => u.active)
          .map((u, i) => (
            <button key={u.id} className="assign-option" autoFocus={i === 0} onClick={() => done(u.id)}>
              <Badge user={u} size="lg" />
              <span>{u.name}</span>
            </button>
          ))}
      </div>
      <div className="dialog-buttons">
        <button className="btn btn-quiet" onClick={() => done(null)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function ConfirmDialog({ spec, done }: { spec: any; done: (v: any) => void }) {
  useEscape(() => done(null));
  return (
    <div>
      <h2 className="dialog-title" id="dialog-title">{spec.title}</h2>
      <p className="dialog-sub">{spec.body}</p>
      <div className="dialog-buttons">
        <button className="btn btn-quiet" autoFocus onClick={() => done(null)}>
          Keep it
        </button>
        <button className={`btn ${spec.danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => done(true)}>
          {spec.confirm}
        </button>
      </div>
    </div>
  );
}

function HelpDialog({ done }: { done: (v: any) => void }) {
  useEscape(() => done(true));
  return (
    <div className="help">
      <h2 className="dialog-title" id="dialog-title">
        Keyboard shortcuts
      </h2>
      <div className="help-grid">
        {SHORTCUTS.map((g) => (
          <section key={g.group}>
            <h3>{g.group}</h3>
            <dl>
              {g.items.map(([k, what]) => (
                <div key={k}>
                  <dt>
                    {k.split(/( or | \+ )/).map((part, i) =>
                      part === ' or ' || part === ' + ' ? (
                        <span key={i} className="muted">
                          {part}
                        </span>
                      ) : (
                        <kbd key={i}>{part}</kbd>
                      ),
                    )}
                  </dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <div className="dialog-buttons">
        <a className="btn btn-quiet" href="/guides/user-guide.html" target="_blank" rel="noopener">
          Open the user guide
        </a>
        <button className="btn btn-primary" autoFocus onClick={() => done(true)}>
          Got it
        </button>
      </div>
    </div>
  );
}

function ConflictDialog({ spec, done }: { spec: any; done: (v: any) => void }) {
  useEscape(() => done('theirs'));
  return (
    <div className="conflict">
      <h2 className="dialog-title" id="dialog-title">
        {spec.field} changed while you were editing
      </h2>
      <p className="dialog-sub">
        Someone else saved a change to the {spec.field.toLowerCase()} of {spec.jobNumber} while you were typing. Choose what to keep. Nothing is lost until you choose.
      </p>
      <div className="conflict-grid">
        <div>
          <div className="field-label">Their version (saved)</div>
          <pre className="conflict-text">{spec.theirs || '(empty)'}</pre>
        </div>
        <div>
          <div className="field-label">Your version</div>
          <pre className="conflict-text mine">{spec.mine || '(empty)'}</pre>
        </div>
      </div>
      <div className="dialog-buttons">
        <button className="btn btn-quiet" onClick={() => done('theirs')}>
          Keep theirs
        </button>
        {spec.canCombine && (
          <button className="btn" onClick={() => done('both')}>
            Keep both
          </button>
        )}
        <button className="btn btn-primary" autoFocus onClick={() => done('mine')}>
          Keep mine
        </button>
      </div>
    </div>
  );
}

export function Toasts() {
  const list = useToasts();
  return (
    <div className="toasts" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
          <span>{t.text}</span>
          {t.action && (
            <button
              className="toast-action"
              onClick={() => {
                t.action!.run();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="toast-close" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
