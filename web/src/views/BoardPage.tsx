import { useMemo } from 'react';
import type { Ticket } from '@board/shared';
import { activeCount, matches, readFilters, writeFilters } from '../lib/filters.ts';
import { localDate } from '../lib/format.ts';
import { replaceParams, useLocation } from '../lib/router.ts';
import { useTicketQuery } from '../lib/store.ts';
import { FilterBar } from '../components/FilterBar.tsx';
import { Board } from './Board.tsx';

export function BoardPage() {
  const { params } = useLocation();
  const filters = useMemo(() => readFilters(params), [params.toString()]);
  const q = useTicketQuery('/api/tickets?view=board');
  const on = activeCount(filters) > 0;
  const today = localDate();
  const filter = useMemo(() => (on ? (t: Ticket) => matches(t, filters, today) : undefined), [filters, on, today]);
  const total = q.data?.tickets.length ?? 0;
  const shown = filter ? (q.data?.tickets.filter(filter).length ?? 0) : total;
  return (
    <div className="board-page">
      <FilterBar value={filters} onChange={(f) => replaceParams(writeFilters(new URLSearchParams(location.search), f))} shown={shown} total={total} />
      <Board filter={filter} />
    </div>
  );
}
