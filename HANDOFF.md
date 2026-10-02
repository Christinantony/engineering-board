# HANDOFF

Live coordination board. Edit this file freely (unlike `CHANGELOG.md` it is not append-only), but keep it current.

## Active claims
Add a row when you start working, remove it when you finish.

| Agent | Branch | Files / areas being touched | Started (IST) |
|---|---|---|---|
| ChatGPT + theme implementation/validation agents | chatgpt/board-themes | web/src/styles.css, web/src/App.tsx, web/src/main.tsx, web/src/lib/theme.ts, web/src/components/ThemePicker.tsx, web/index.html, scripts/build.mjs, e2e/board.e2e.mjs, package.json, server/src/app.ts, docs/USER-GUIDE.md, README.md, HANDOFF.md, CHANGELOG.md | 2026-10-02 10:23 IST |

## Open questions
Questions for Christin or another agent. Mark answered ones with the answer and date, and move them to "Resolved".

_(none)_

## Resolved
- [x] The application source was not in this repo yet. **Answer:** Claude imported the full source and its history (phases 2 to 7) on branch `claude/import-app-source`, 2026-10-02.

## Notes for the next agent
- **Where the project stands:** phases 1–9 are merged on main (baseline 1.0.0; PRs #3 and #4 are already merged). This branch proposes version 1.0.1 reliability fixes for Christin's review.
- **Releases:** `npm run package` writes `dist/EngineeringBoard-<version>.zip`. Bump `version` in `package.json` and `APP_VERSION` in `server/src/app.ts` together; `check:build` fails if they differ.
- **Guides:** edit the Markdown in `docs/`; the build turns them into the pages at `/guides/` and in the zip. `check:build` fails on a broken link between guides.
- **Windows scripts** (`scripts/windows/*.bat`) can't be run in CI. Keep echo lines that show `%~dp0` outside `( )` blocks and quoted: a folder path containing `)` or `&` breaks them otherwise.
- **Setup:** `npm install` installs the build and test tools (TypeScript, tsx, esbuild, React, Playwright). They are devDependencies only; the running board needs nothing but `node.exe` 22.16+ (decision #1).
- **No lockfile yet:** the environment that built phases 2 to 7 had no access to the npm registry, so there is no `package-lock.json`. The first agent that runs `npm install` with registry access should commit the lockfile in its own small PR.
- **No `@types/react`:** `web/src/types/react-shim.d.ts` declares only the parts of React the app uses, so it can be typechecked without the package. Replacing it with the real types is fine, as long as `npm run typecheck` still passes.
- **Checks:** `npm run typecheck`, `npm test` (120 backend tests), `npm run build`, `npm run check:build` (packages, then checks the zip and runs its server with plain node), `npm run e2e` (25 browser tests; build first).
- **New migrations:** add the matching `UNDO` entry in `server/test/migrations.test.ts`, or the upgrade test fails on purpose.
- **Reliability validation (1.0.1):** Node 22.16.0: typecheck, 120 backend tests, build, 14 package checks, 25 Playwright browser tests all passed. Separate implementation agents and an independent validation agent reviewed restore, upload and pagination; no remaining blockers. The browser suite used real Chromium through `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`; its default still uses Playwright's installed browser. No Windows `.bat` behavior was changed or newly validated.
- **Restore uploads:** `restoreUploadMaxMB` / `EB_RESTORE_UPLOAD_MAX_MB` defaults to 64 MiB (1–1024). Files stream only after admin authorization. Validations and activation rollback occur before returning success; API details are in `docs/API.md`.
- **Complete list protocol:** page responses include an opaque connection/write revision; Board and Workload load every page with matching totals/revisions and report retryable failures. Keep this check if list loading changes.
