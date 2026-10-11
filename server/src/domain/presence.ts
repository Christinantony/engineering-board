// Who is online and which job each person has open. Kept in memory only:
// it describes this moment, so there's nothing worth persisting.
//
// A person is "online" while at least one of their browser tabs holds the
// live-update connection. "Viewing" is refreshed by the browser every ~30 s
// while a job panel is open and expires after 90 s without a refresh.

import type { EventHub } from '../lib/core.ts';

const VIEW_TTL_MS = 90_000;

interface Entry {
  connections: number;
  views: Map<string, { jobId: number; at: number }>; // per browser tab
}

export class Presence {
  private users = new Map<number, Entry>();
  constructor(
    private events: EventHub,
    private now: () => number = Date.now,
  ) {}

  private entry(userId: number): Entry {
    let e = this.users.get(userId);
    if (!e) {
      e = { connections: 0, views: new Map() };
      this.users.set(userId, e);
    }
    return e;
  }

  private changed() {
    this.events.emit({ type: 'presence' });
    this.events.flush();
  }

  connect(userId: number): () => void {
    const e = this.entry(userId);
    e.connections++;
    if (e.connections === 1) this.changed();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      e.connections--;
      if (e.connections <= 0) {
        this.users.delete(userId);
        this.changed();
      }
    };
  }

  view(userId: number, tab: string, jobId: number | null) {
    const e = this.entry(userId);
    const before = e.views.get(tab)?.jobId ?? null;
    if (jobId == null) e.views.delete(tab);
    else e.views.set(tab, { jobId, at: this.now() });
    if (before !== jobId) this.changed();
  }

  snapshot(): { user_id: number; viewing: number[] }[] {
    const t = this.now();
    const out: { user_id: number; viewing: number[] }[] = [];
    for (const [userId, e] of this.users) {
      for (const [tab, v] of e.views) if (t - v.at > VIEW_TTL_MS) e.views.delete(tab);
      if (e.connections <= 0 && e.views.size === 0) continue;
      out.push({ user_id: userId, viewing: [...new Set([...e.views.values()].map((v) => v.jobId))] });
    }
    return out;
  }
}
