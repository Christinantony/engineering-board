# Architecture and decisions

> Binding for all agents. Do not reverse a decision silently. To propose a change, add an item under "Open questions" in `HANDOFF.md`, and record the outcome in `CHANGELOG.md`.

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

## Collaboration (Phase 5)

| # | Decision | Why |
|---|---|---|
| 13 | **Notifications are derived from the activity log.** Only a per-person "seen up to" marker is stored, in the `user_state` table. | There is no second inbox to fall out of sync. Rules live in `domain/notifications.ts`, and people are never notified about their own actions. |
| 14 | **Edits are merged field by field.** The panel remembers each field's value when you start typing. When you save, any field that someone else changed in the meantime asks you to keep yours, keep theirs, or keep both (for notes and description). Fields nobody else touched save straight through. | Two engineers can work on the same job without silently overwriting each other, and without nagging when they edit different fields. |
| 15 | **Presence is held in memory** and comes from the live-update connections. Viewing a job is a heartbeat that expires after 90 seconds. | It describes this moment only, so a restart clearing it is correct. |
| 16 | **The live-update handshake carries the server version.** | Open browsers are told to reload after an upgrade, instead of running old code against a new API. |
| 17 | **Losing the connection shows a red banner after 6 seconds.** The page reconnects by itself and re-fetches everything it missed. | People never keep working while unaware that nothing is saving. |

## Deployment (Phase 9)

| # | Decision | Why |
|---|---|---|
| 18 | **The release is one zip** (`npm run package` → `EngineeringBoard-<version>.zip`) with a fixed layout: `app\` (replaced on update), launchers, `config.example.json`, `guides\`, `for-IT\`, `linux\`. It never contains `data\`, `config.json` or `node.exe`. | Updating is "replace the `app` folder", and unzipping a release over an install can never overwrite data or settings. |
| 19 | **`node.exe` is not bundled.** The installer downloads the official Node 22 LTS build. | It keeps the zip small and the executable verifiably official (antivirus and AppLocker trust it), and updating Node stays independent of updating the board. |
| 20 | **Starting at sign-in uses a shortcut in the user's own Startup folder**, not a Windows service or scheduled task. | It needs no admin rights (the host user isn't an admin), and the window stays visible for its messages. Linux uses systemd; Docker is offered for Linux servers only. |
| 21 | **The guides are Markdown in `docs/`, built into web pages** that the board serves at `/guides/` and the zip includes. | One source. Every colleague can open the user guide from the board without having the zip. |
| 22 | **A new version backs up the database before migrating it** and refuses data written by a newer version. A forgotten admin PIN is reset by a `RESET-ADMIN-PIN` file next to `start.bat`. | Updates and rollbacks can't lose data. Resetting the PIN needs access to the host PC, which is the right authority for this team. |

## Known limits

- The host PC must be on for others to reach the board.
- **The Windows Firewall needs an inbound rule for the port.** Adding one needs admin rights, so ask IT once: `for-IT\allow-board-port.bat` or [`docs/FOR-IT.md`](docs/FOR-IT.md).
- The host PC must not sleep, and the board stops while its user is signed out (decision 20).
- The single process scales comfortably to this team's size: thousands of tickets and a handful of users.
