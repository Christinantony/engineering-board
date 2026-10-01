# Engineering Board

An internal workboard for the mechanical design team. It combines a Kanban board, lightweight job tickets and team workload, and runs on one PC on the office LAN.

> **Status: Phase 7 of 9.** Everything a team needs day to day works: the board, every view, search, collaboration, and the Admin area.
> Phase 7 polish added:
> - A full keyboard path, including moving cards without a mouse.
> - A right-click card menu.
> - A `?` shortcut list.
> - Colours that meet WCAG AA contrast.
> - Focus handling in dialogs.
> - Layouts for tablets and phones.
> - Friendlier empty, loading and error states.
>
> The Admin area covers:
> - Team, job types and tags.
> - CSV import with a preview.
> - CSV and JSON export.
> - Daily automatic backups, with one-click restore.
> - Archiving and the admin PIN.

## Backups (short version)

- **Automatic:** one backup per day (the first hour the board runs that day), plus one before every import and every restore. Backups are kept for 30 days, and the newest 7 are always kept.
- **Location:** backups go in `data/backups` as `board-YYYY-MM-DD_HHMMSS-<why>.db`. Each is a complete SQLite database. Point `backupDir` in `config.json` at a network share or OneDrive folder so a dead PC doesn't take the backups with it.
- **Restore:** use Admin, Backups and restore, then pick a backup and choose **Restore…**, or upload a `.db` file. The current data is backed up first, so a restore can itself be undone. Nobody gets signed out.
- **By hand:** stop the board, copy `data/board.db` (and `board.db-wal` if present), then start it again.

## What it needs

| On the host PC | On everyone else's PC |
|---|---|
| `node.exe` 22.16 or newer (portable, no installer, no admin) | A web browser |

There are **no npm packages and no native add-ons at runtime**. The whole server is one JavaScript file, `app/server.mjs`, of about 90 KB. The database is Node's built-in SQLite (`node:sqlite`), so data lives in a single file, `data/board.db`.

## Try it on Windows (preview)

1. Unzip `EngineeringBoard-preview.zip` somewhere you can write to, for example `C:\Users\<you>\EngineeringBoard`.
2. Download Node.js 22 LTS as **Windows Binary (.zip), 64-bit** from nodejs.org. Copy only `node.exe` from it into that folder, next to `start.bat`.
3. Double-click `start.bat`. Open the address it prints, such as `http://localhost:8080`.

## Working on the code

This repo is shared by several AI agents and Christin. Read [`00_START_HERE.md`](00_START_HERE.md) first. The rules are:
- branch and pull request only, never straight to `main`
- one `CHANGELOG.md` entry per change
- `DECISIONS.md` is binding

```bash
npm install            # build and test tools only; the running board needs no packages
npm run build          # → dist/app/server.mjs + dist/app/web/
npm start              # server from source on http://localhost:8080 (serves dist/app/web)
npm run dev:web        # rebuild the web app on change
npm test               # 62 backend tests (node:test)
npm run e2e            # 22 browser tests (needs Playwright + Chromium; run npm run build first)
npm run typecheck      # server and web
npm run seed:demo      # add demo jobs  (…-- --clear to remove them)
```

The web app is React 19, bundled by esbuild. No Vite, Tailwind, dnd-kit or TanStack Query are used; the build machine had no package registry. Their replacements are small and live in `web/src/lib/`:
- `store.ts` is the query cache and live updates.
- `actions.ts` holds the mutations, toasts and undo.
- `views/Board.tsx` does pointer-based drag and drop.

Configuration comes from `config.json` next to the `app` folder, or from environment variables:

| Setting | Env var | Default |
|---|---|---|
| `port` | `EB_PORT` | `8080` |
| `host` | `EB_HOST` | `0.0.0.0` (reachable on the LAN) |
| `dataDir` | `EB_DATA_DIR` | `./data` |
| `timezone` | `EB_TIMEZONE` | `Asia/Kolkata` |
| `hoursPerDay` | n/a | `8`: the reference line on the Workload page |
| `workingDays` | n/a | `[1,2,3,4,5,6]`: Monday to Saturday (0 is Sunday) |
| `backupDir` | `EB_BACKUP_DIR` | `data/backups` |
| `backupKeepDays` | `EB_BACKUP_KEEP_DAYS` | `30` |

## Layout

```
shared/src/      constants, API types, hand-written validators (used by server + web)
web/src/         React app: App shell, views/Board, components (card, panel, quick create, dialogs), lib (api, store, router…)
e2e/             browser tests (Playwright)
server/src/
  app.ts         routes + auth wrappers + HTTP server
  http/http.ts   tiny router, JSON bodies, cookies, static files, error mapping
  db/            connection + transactions, migrations, seed (team, job types, demo)
  domain/        tickets, rank (card ordering), search (FTS), views, users, job types, auth
  lib/           time-zone helpers, errors, event hub (live updates)
server/test/     node:test suites against a real server + real SQLite file
scripts/         build.mjs, windows/start.bat
docs/            API reference, architecture notes
```

See `docs/API.md` for every endpoint and [`DECISIONS.md`](DECISIONS.md) for the design decisions.
