// Top-bar search: results appear as you type (job number, title, notes, paths,
// people, tags, job type). Enter on a result opens it; Enter on the text opens
// the full search page.

import { useEffect, useRef, useState } from 'react';
import { STATUS_LABEL, type Ticket } from '@board/shared';
import { useApp } from '../context.ts';
import { get } from '../lib/api.ts';
import { navigate } from '../lib/router.ts';
import { Badge } from './bits.tsx';

export function SearchBox() {
  const { user, openJob } = useApp();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Ticket[] | null>(null);
  const [total, setTotal] = useState(0);
  const [sel, setSel] = useState(-1);
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  const seq = useRef(0);

  // F or / focuses search (not while typing elsewhere)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, select, [contenteditable="true"]') || document.querySelector('.dialog-backdrop')) return;
      if (e.key === '/' || e.key.toLowerCase() === 'f') {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const text = q.trim();
    if (!text) {
      setResults(null);
      return;
    }
    const my = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const r = await get<{ tickets: Ticket[]; total: number }>(`/api/tickets?q=${encodeURIComponent(text)}&limit=8&archived=include`);
        if (my !== seq.current) return; // a newer search is on its way
        setResults(r.tickets);
        setTotal(r.total);
        setSel(-1);
      } catch {
        if (my === seq.current) setResults([]);
      }
    }, 120);
    return () => clearTimeout(t);
  }, [q]);

  const go = (t: Ticket) => {
    openJob(t.id);
    setOpen(false);
    input.current?.blur();
  };
  const all = () => {
    navigate(`/search?q=${encodeURIComponent(q.trim())}`);
    setOpen(false);
    input.current?.blur();
  };

  return (
    <div className="search" role="search">
      <input
        ref={input}
        className="search-input"
        type="search"
        value={q}
        placeholder="Search jobs  (F)"
        aria-label="Search jobs"
        aria-expanded={open && !!results}
        aria-controls="search-results"
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e: any) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e: any) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSel((s) => Math.min(s + 1, (results?.length ?? 0) - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSel((s) => Math.max(s - 1, -1));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            if (results && sel >= 0 && results[sel]) go(results[sel]);
            else if (q.trim()) all();
          } else if (e.key === 'Escape') {
            setQ('');
            e.target.blur();
          }
        }}
      />
      {open && results && (
        <div className="search-pop" id="search-results" role="listbox">
          {results.length === 0 && <p className="search-empty">No jobs match “{q.trim()}”.</p>}
          {results.map((t, i) => (
            <button
              key={t.id}
              className={`search-row${i === sel ? ' sel' : ''}`}
              role="option"
              aria-selected={i === sel}
              onMouseDown={(e: any) => e.preventDefault()}
              onClick={() => go(t)}
            >
              <span className="jobno">{t.job_number}</span>
              <span className="search-title">{t.title}</span>
              <span className={`status-pill sm st-${t.status}`}>{t.archived ? 'Archived' : STATUS_LABEL[t.status]}</span>
              <Badge user={user(t.assigned_to)} size="sm" />
            </button>
          ))}
          {results.length > 0 && (
            <button className="search-all" onMouseDown={(e: any) => e.preventDefault()} onClick={all}>
              {total > results.length ? `See all ${total} results` : 'Open in search with filters'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
