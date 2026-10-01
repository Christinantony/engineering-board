# Engineering Board

An internal workboard for the mechanical design team. It combines a Kanban board, lightweight job tickets and team workload, and runs on one PC on the office LAN.

> **Status: Phase 3 of 9.** The board is usable: Kanban with drag and drop, job panel, quick create, claiming, live updates.
> Today, My work, Dashboard and Workload pages arrive in Phase 4 (their APIs already exist).

## What it needs

| On the host PC | On everyone else's PC |
|---|---|
| `node.exe` 22.16 or newer (portable, no installer, no admin) | A web browser |

There are **no npm packages and no native add-ons at runtime**. The whole server is one JavaScript file, `app/server.mjs`, of about 90 KB. The database is Node's built-in SQLite (`node:sqlite`), so data lives in a single file, `data/board.db`.

## Try it on Windows (preview)

1. Unzip `EngineeringBoard-preview.zip` somewhere you can write to, for example `C:\Users\<you>\EngineeringBoard`.
2. Download Node.js 22 LTS as **Windows Binary (.zip), 64-bit** from nodejs.org. Copy only `node.exe` from it into that folder, next to `start.bat`.
3. Double-click `start.bat`. Open the address it prints, such as `http://localhost:8080`.

## Develop

```bash
npm run build          # → dist/app/server.mjs + dist/app/web/
npm start              # server from source on http://localhost:8080 (serves dist/app/web)
npm run dev:web        # rebuild the web app on change
npm test               # 42 backend tests (node:test)
npm run e2e            # 6 browser tests (needs Playwright + Chromium; run npm run build first)
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

See `docs/API.md` for every endpoint and `docs/ARCHITECTURE.md` for the design decisions.
