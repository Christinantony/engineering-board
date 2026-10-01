# AGENTS.md

Instructions for any AI coding agent working in this repo (Claude, ChatGPT/Codex, Antigravity, others).

**Read `00_START_HERE.md` first.** It has the full rules. The essentials:

1. `git pull` before you start. Read `HANDOFF.md` and the last 20 entries of `CHANGELOG.md`.
2. Claim your files in `HANDOFF.md` before editing. Do not touch files another agent has claimed.
3. Never commit to `main`. Use a branch named `<agent>/<topic>` (for example `claude/fix-claim-race`) and open a pull request.
4. Every PR adds one entry to the bottom of `CHANGELOG.md`. The log is append-only: never edit or delete older entries.
5. Decisions in `DECISIONS.md` are binding. Do not reverse them silently. Raise questions in `HANDOFF.md` under "Open questions".
6. Zero runtime dependencies: Node built-ins only (`node:http`, `node:sqlite`, `node:crypto`). Do not add npm packages.
7. Never commit secrets, the database, or anything under `data/`.
8. If something is unclear, ask in `HANDOFF.md`. Do not guess.

## Project layout
- `server/src/`: the server (TypeScript). `app.ts` holds the routes; `domain/` holds the business rules (tickets, search, notifications, backup, import/export, auth); `db/` holds the connection, migrations and seed data.
- `web/src/`: the React app (views, components, `lib/` for the API client, live updates, actions).
- `shared/src/`: constants, API types and validators used by both.
- `server/test/`: backend tests (`npm test`). `e2e/`: browser tests (`npm run e2e`, needs Playwright).
- `scripts/build.mjs` bundles everything into `dist/app/` (`server.mjs` plus `web/`). That folder plus `node.exe` and `start.bat` is what runs on the host PC.
- Runtime data lives in `data/` (`board.db`, `backups/`) and is never committed.

## Before you open a PR
`npm run typecheck`, `npm test` and `npm run build` must all pass. Run `npm run e2e` too when you change anything in `web/`.
