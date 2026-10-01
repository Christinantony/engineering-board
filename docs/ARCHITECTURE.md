# Architecture and decisions

```
Host PC (Christin's, non-admin) ─ node.exe app/server.mjs ─ data/board.db (SQLite, WAL)
        ▲ http://<PC-NAME>:8080
  Paul · Allen · Jeffin  (browsers)
```

One process serves the web app, the REST API and a live-update stream. There are no external services and no internet access at runtime.

## Decisions

| # | Decision | Why |
|---|---|---|
| 1 | **Zero runtime dependencies.** We use `node:http`, `node:sqlite` and `node:crypto` instead of Fastify, better-sqlite3 and zod. | The build environment's package registry was blocked, and the host is a locked-down, non-admin PC. With no native add-on, there is nothing for antivirus or AppLocker to flag beyond `node.exe` itself, and nothing to compile. The trade-off is that `node:sqlite` is marked "experimental". We pin the Node version we ship with, so the API cannot change underneath us. |
| 2 | **SQLite in WAL mode, with synchronous transactions.** | Node is single-threaded and the driver is synchronous, so every request's transaction runs to completion before the next one starts. Races such as double-claims, duplicate job numbers and lost updates are therefore impossible inside one process. |
| 3 | **Trigram full-text search (FTS5).** | Any 3-character substring matches, which suits drawing numbers, UNC paths and `JOB-1042`. Shorter terms fall back to `LIKE`. Results are ranked by bm25, with the job number weighted above the title and the title above the body. |
| 4 | **The activity log is append-only and enforced by triggers.** | `UPDATE` is rejected, and so is `DELETE`, except for demo tickets. Tickets cannot be deleted either. They are archived, and only once done or cancelled. |
| 5 | **Optimistic concurrency.** | `version` is checked on field edits. `from_status` is checked on drags. Claim is an atomic "only if still unassigned" operation. Conflicts return 409 together with the fresh ticket. |
| 6 | **Idempotency keys on create.** | A double-click or a retry after a network drop returns the original ticket. |
| 7 | **Due dates are a local date with an optional local time.** `due_at` is derived in UTC. | A date-only due date becomes overdue after local midnight. The time zone is configurable and defaults to Asia/Kolkata. |
| 8 | **Ordering uses float ranks with midpoint insertion.** | Columns are renumbered automatically when the gaps run out. Waiting and Blocked share one board column. |
| 9 | **Workload counts jobs due by the end of the horizon, plus in-progress jobs with no due date.** | Waiting and blocked work is excluded from hours. Unestimated jobs are counted rather than guessed. |
| 10 | **Auth is a name picker, a signed cookie and an admin PIN** (scrypt hash, 12-hour unlock). | This fits a trusted LAN. The code lives in `domain/auth.ts`, so passwords can be added later. |
| 11 | **Roles:** engineers create, claim and do work. The manager creates, edits, assigns and comments, but cannot claim. | These are the team rules agreed in Phase 1. |
| 12 | **Live updates use Server-Sent Events.** Events are queued during a transaction and sent only after it commits. | Browsers never see a change that was rolled back. |

## Known limits

- The host PC must be on for others to reach the board.
- **The Windows Firewall needs an inbound rule for the port.** Adding one needs admin rights, so ask IT once. Phase 9 ships the exact rule.
- The single process scales comfortably to this team's size: thousands of tickets and a handful of users.
