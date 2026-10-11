// Load a complete list without changing the API's per-request limit. Publish
// only complete, consistent collections; never a partly loaded board/workload.
import type { Ticket } from '@board/shared';
import { ApiError, get } from './api.ts';

export interface TicketPage {
  tickets: Ticket[];
  total: number;
  revision: string;
}

const PAGE_SIZE = 2000;
const ATTEMPTS = 3;
type FetchPage = (url: string) => Promise<TicketPage>;

export async function getAllTicketPages(path: string, fetchPage: FetchPage = get): Promise<TicketPage> {
  const [pathname, query = ''] = path.split('?');
  const params = new URLSearchParams(query);
  params.set('limit', String(PAGE_SIZE));
  // A database revision accompanies every page, so a concurrent edit/reorder,
  // restore, or changed membership cannot silently shift offset boundaries.
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const tickets: Ticket[] = [];
    const ids = new Set<number>();
    let total: number | undefined;
    let revision: string | undefined;
    let changed = false;
    do {
      params.set('offset', String(tickets.length));
      const page = await fetchPage(`${pathname}?${params}`);
      if (!Number.isSafeInteger(page.total) || page.total < 0 || !Array.isArray(page.tickets) || typeof page.revision !== 'string') {
        throw new ApiError(0, 'invalid_ticket_page', 'The server could not return a complete job list. Reload the board and try again.');
      }
      total ??= page.total;
      revision ??= page.revision;
      if (page.total !== total || page.revision !== revision ||
          page.tickets.length > PAGE_SIZE || tickets.length + page.tickets.length > total ||
          (page.tickets.length === 0 && tickets.length < total) ||
          page.tickets.some((t) => ids.has(t.id))) {
        changed = true;
        break;
      }
      for (const t of page.tickets) {
        // Also guard against duplicates within one response.
        if (ids.has(t.id)) { changed = true; break; }
        ids.add(t.id);
        tickets.push(t);
      }
    } while (!changed && tickets.length < total!);
    if (!changed) return { tickets, total: total!, revision: revision! };
  }
  throw new ApiError(409, 'ticket_list_changed', 'Jobs changed while the full list was loading. Try again to load every job.');
}
