// Full search: every job ever created (including done and archived), with filters.

import { useEffect, useMemo, useState } from 'react';
import type { Ticket } from '@board/shared';
import { get } from '../lib/api.ts';
import { readFilters, toQuery, writeFilters, activeCount } from '../lib/filters.ts';
import { replaceParams, useLocation } from '../lib/router.ts';
import { useQuery } from '../lib/store.ts';
import { ErrorBox, Spinner } from '../components/bits.tsx';
import { FilterBar } from '../components/FilterBar.tsx';
import { JobRow } from '../components/JobRow.tsx';
import { toastError } from '../lib/toasts.ts';

const PAGE = 50;

export function Search() {
  const { params } = useLocation();
  const filters = useMemo(() => readFilters(params), [params.toString()]);
  const qText = params.get('q') ?? '';
  const archived = params.get('arch') === '1';
  const [draft, setDraft] = useState(qText);
  useEffect(() => setDraft(qText), [qText]);

  // debounce typing into the URL
  useEffect(() => {
    if (draft === qText) return;
    const t = setTimeout(() => {
      const p = new URLSearchParams(location.search);
      if (draft.trim()) p.set('q', draft);
      else p.delete('q');
      replaceParams(p);
    }, 200);
    return () => clearTimeout(t);
  }, [draft]);

  const api = toQuery(filters);
  if (qText.trim()) api.set('q', qText.trim());
  api.set('archived', archived || qText.trim() ? 'include' : 'exclude');
  api.set('limit', String(PAGE));
  const key = `/api/tickets?${api.toString()}`;
  const q = useQuery<{ tickets: Ticket[]; total: number }>(key);
  const [more, setMore] = useState<Ticket[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => setMore([]), [key]);
  const tickets = [...(q.data?.tickets ?? []), ...more];

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const p = new URLSearchParams(api);
      p.set('offset', String(tickets.length));
      const r = await get<{ tickets: Ticket[] }>(`/api/tickets?${p}`);
      setMore((m) => [...m, ...r.tickets]);
    } catch (e) {
      toastError(e);
    } finally {
      setLoadingMore(false);
    }
  };

  const nothingAsked = !qText.trim() && activeCount(filters) === 0;

  return (
    <div className="view">
      <header className="view-head">
        <h1>Search</h1>
        <div className="search-big">
          <input
            className="qc-title"
            type="search"
            value={draft}
            autoFocus
            placeholder="Job number, words from the title or notes, a drawing number, a path, a person…"
            aria-label="Search text"
            onChange={(e: any) => setDraft(e.target.value)}
          />
          <label className="check">
            <input
              type="checkbox"
              checked={archived || !!qText.trim()}
              disabled={!!qText.trim()}
              onChange={(e: any) => {
                const p = new URLSearchParams(location.search);
                if (e.target.checked) p.set('arch', '1');
                else p.delete('arch');
                replaceParams(p);
              }}
            />
            Include archived jobs{qText.trim() ? ' (always, when searching text)' : ''}
          </label>
        </div>
      </header>
      <FilterBar value={filters} onChange={(f) => replaceParams(writeFilters(new URLSearchParams(location.search), f))} showStatus />
      {q.error && !q.data ? (
        <ErrorBox message={q.error.message} retry={q.refresh} />
      ) : !q.data ? (
        <Spinner label="Searching" />
      ) : (
        <section className="vsection">
          <header className="vsection-head">
            <h2>{nothingAsked ? 'Recently updated' : q.data.total === 1 ? '1 job' : `${q.data.total} jobs`}</h2>
          </header>
          {tickets.length === 0 ? (
            <p className="vsection-empty">No jobs match. Try fewer words or clear a filter.</p>
          ) : (
            <div className="vsection-list">
              {tickets.map((t) => (
                <JobRow key={t.id} t={t} showUpdated />
              ))}
            </div>
          )}
          {tickets.length < q.data.total && (
            <button className="btn load-more" onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore ? 'Loading…' : `Show ${Math.min(PAGE, q.data.total - tickets.length)} more`}
            </button>
          )}
        </section>
      )}
    </div>
  );
}
