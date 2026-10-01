# Engineering Board

An internal workboard for the mechanical design team: a Kanban board, lightweight job tickets, claiming, workload, search, full history, automatic backups and live updates. It runs on **one PC on the office network**; everyone else uses a web browser.

- **No installer, no admin rights, no internet.** The whole program is `node.exe` plus one JavaScript file and a SQLite database file.
- **Nothing is ever lost.** Jobs can't be deleted (only archived), every change is in an append-only history, and the board backs itself up every day and before anything risky.
- **Built for a small team working at the same time:** live updates, safe simultaneous claiming, and field-by-field merging when two people edit one job.

> **Version 1.0.0.** All nine phases of the plan are complete.

## Install on Windows (5 minutes)

1. Get `EngineeringBoard-<version>.zip` (from the releases, or build it: see below) and unzip it to a folder you own, for example `C:\Users\<you>\EngineeringBoard`.
2. Download Node.js 22 LTS as **Windows Binary (.zip), x64** from <https://nodejs.org/en/download>. Copy just `node.exe` into the board folder, next to `start.bat`.
3. Double-click **`start.bat`** and keep its window open. Open <http://localhost:8080>, pick your name, and change the admin PIN (it starts as `1234`) in **Admin → Admin PIN**.
4. Ask IT to allow the port once: `for-IT\allow-board-port.bat` (run as administrator) or the one-line rule in [For IT](docs/FOR-IT.md). Then give colleagues the "For your team" address the window shows, such as `http://CHRISTIN-PC:8080`.
5. Optional: **`autostart-on.bat`** starts the board whenever you sign in. No admin rights needed.

Full details, including updating, moving to another PC, Linux and Docker: **[Install, run and update](docs/INSTALL.md)**.

## Install on Linux

Needs Node.js 22.16 or newer. Unzip the package, then `sh linux/start.sh`, or run it as a systemd service (`linux/engineering-board.service`) or with Docker: `docker compose -f linux/docker-compose.yml up -d --build`. See [Install → Linux](docs/INSTALL.md#linux).

## Guides

| Guide | For |
|---|---|
| [User guide](docs/USER-GUIDE.md) | Everyone. Also on the board itself: press <kbd>?</kbd> → *Open the user guide*. |
| [Admin guide](docs/ADMIN-GUIDE.md) | Whoever looks after the board: team, import and export, **backup and restore**, settings. |
| [Install, run and update](docs/INSTALL.md) | Installing, first run, the LAN address, start at sign-in, **updating**. |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | When something doesn't work. |
| [For IT](docs/FOR-IT.md) | The firewall rule, and what the board does and doesn't do on the network. |
| [API reference](docs/API.md) | Every HTTP endpoint. |
| [Decisions](DECISIONS.md) | The architecture and why it is the way it is. |

## Backups (short version)

Automatic: once a day, before every import, restore and upgrade. Kept 30 days, newest 7 always. Stored in `data\backups` as plain SQLite files. Point `backupDir` in `config.json` at a network share or OneDrive so a dead PC doesn't take them with it. Restore from **Admin → Backups and restore**; a restore is itself backed up first. Details: [Admin guide → Backups](docs/ADMIN-GUIDE.md#backups).

## Settings

Copy `config.example.json` to `config.json` next to `start.bat`, edit it, restart. Mistakes are explained in the board's window.

| Setting | Env var | Default |
|---|---|---|
| `port` | `EB_PORT` | `8080` |
| `host` | `EB_HOST` | `0.0.0.0` (reachable on the LAN; `127.0.0.1` = this PC only) |
| `dataDir` | `EB_DATA_DIR` | `data` |
| `backupDir` | `EB_BACKUP_DIR` | `data/backups` |
| `backupKeepDays` | `EB_BACKUP_KEEP_DAYS` | `30` |
| `timezone` | `EB_TIMEZONE` | `Asia/Kolkata` |
| `hoursPerDay` | | `8` (Workload reference line) |
| `workingDays` | | `[1,2,3,4,5,6]` (Monday to Saturday; 0 is Sunday) |

## Working on the code

This repo is shared by several AI agents and Christin. Read [`00_START_HERE.md`](00_START_HERE.md) first:
- branch and pull request only, never straight to `main`
- one `CHANGELOG.md` entry per change
- `DECISIONS.md` is binding

```bash
npm install            # build and test tools only; the running board needs no packages
npm run build          # → dist/app/server.mjs + dist/app/web/ (including web/guides/)
npm run package        # → dist/EngineeringBoard-<version>.zip, the release
npm start              # server from source on http://localhost:8080 (serves dist/app/web)
npm run dev:web        # rebuild the web app on change
npm test               # backend tests (node:test)
npm run check:build    # packages, then runs the zip's server with plain node, as the host PC will
npm run e2e            # browser tests (needs Playwright + Chromium; build first)
npm run typecheck      # server and web
npm run seed:demo      # add demo jobs  (…-- --clear to remove them)
```

The web app is React 19, bundled by esbuild. There is no Vite, Tailwind, dnd-kit or TanStack Query: the build machine had no package registry, and their small replacements live in `web/src/lib/`. The guides in `docs/` are turned into web pages at build time by `scripts/lib/markdown.mjs`, and the release zip is written by `scripts/lib/zip.mjs`. Neither needs an extra package.

## Layout

```
shared/src/      constants, API types, hand-written validators (used by server + web)
web/src/         React app: App shell, views, components, lib (api, store, router…)
server/src/
  app.ts         routes + auth wrappers + HTTP server
  index.ts       entry point: config, startup banner, RESET-ADMIN-PIN, clean shutdown
  config.ts      config.json + environment variables, with plain-English errors
  http/http.ts   tiny router, JSON bodies, cookies, static files, error mapping
  db/            connection + transactions, migrations, seed (team, job types, demo)
  domain/        tickets, rank, search, views, users, job types, auth, notifications,
                 presence, backup, import/export
server/test/     node:test suites against a real server + real SQLite file
e2e/             browser tests (Playwright) and the build/package check
scripts/         build.mjs, package.mjs, lib/ (markdown, zip, guides), windows/, linux/
docs/            guides (also built into the app), API reference
```
