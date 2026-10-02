# HANDOFF

Live coordination board. Edit this file freely (unlike `CHANGELOG.md` it is not append-only), but keep it current.

## Active claims
Add a row when you start working, remove it when you finish.

| Agent | Branch | Files / areas being touched | Started (IST) |
|---|---|---|---|
| Claude | `claude/readme-catalogue` | `README.md` only (rewritten as a catalogue), `CHANGELOG.md`, this row | 2026-10-02 |

## Open questions
Questions for Christin or another agent. Mark answered ones with the answer and date, and move them to "Resolved".

_(none)_

## Resolved
- [x] The application source was not in this repo yet. **Answer:** Claude imported the full source and its history (phases 2 to 7) on branch `claude/import-app-source`, 2026-10-02.

## Notes for the next agent
- **Where the project stands:** phases 1–9 and the 1.0.1 reliability fixes (PR #5) are merged on main. This branch proposes version 1.0.2 optional themes for Christin's review.
- **Releases:** `npm run package` writes `dist/EngineeringBoard-<version>.zip`. Bump `version` in `package.json` and `APP_VERSION` in `server/src/app.ts` together; `check:build` fails if they differ.
- **Guides:** edit the Markdown in `docs/`; the build turns them into the pages at `/guides/` and in the zip. `check:build` fails on a broken link between guides.
- **Windows scripts** (`scripts/windows/*.bat`) can't be run in CI. Keep echo lines that show `%~dp0` outside `( )` blocks and quoted: a folder path containing `)` or `&` breaks them otherwise.
- **Setup:** `npm install` installs the build and test tools (TypeScript, tsx, esbuild, React, Playwright). They are devDependencies only; the running board needs nothing but `node.exe` 22.16+ (decision #1).
- **No lockfile yet:** the environment that built phases 2 to 7 had no access to the npm registry, so there is no `package-lock.json`. The first agent that runs `npm install` with registry access should commit the lockfile in its own small PR.
- **No `@types/react`:** `web/src/types/react-shim.d.ts` declares only the parts of React the app uses, so it can be typechecked without the package. Replacing it with the real types is fine, as long as `npm run typecheck` still passes.
- **Checks:** `npm run typecheck`, `npm test` (120 backend tests), `npm run build`, `npm run check:build` (14 checks: packages, then checks the zip and runs its server with plain node), `npm run e2e` (31 browser tests; build first).
- **New migrations:** add the matching `UNDO` entry in `server/test/migrations.test.ts`, or the upgrade test fails on purpose.
- **Reliability validation (1.0.1):** Node 22.16.0: typecheck, 120 backend tests, build, 14 package checks, 25 Playwright browser tests all passed. Separate implementation agents and an independent validation agent reviewed restore, upload and pagination; no remaining blockers. The browser suite used real Chromium through `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`; its default still uses Playwright's installed browser. No Windows `.bat` behavior was changed or newly validated.
- **Restore uploads:** `restoreUploadMaxMB` / `EB_RESTORE_UPLOAD_MAX_MB` defaults to 64 MiB (1–1024). Files stream only after admin authorization. Validations and activation rollback occur before returning success; API details are in `docs/API.md`.
- **Complete list protocol:** page responses include an opaque connection/write revision; Board and Workload load every page with matching totals/revisions and report retryable failures. Keep this check if list loading changes.
- **Themes (1.0.2):** Light is the original default; Charcoal and Midnight are optional. The Theme selector is available before sign-in and in the top bar. The per-browser `engineering-board-theme` preference applies before first paint via the bundled external head script, tolerates unavailable storage and synchronizes between tabs. No database setting or dependency is involved. Preserve the semantic CSS tokens when adding UI states.
- **Theme validation:** Node 22.16.0: typecheck, 120 backend tests, build, 14 package checks and 31 browser tests all passed. Separate CSS/test agents and an independent reviewer checked persisted preferences, storage failures, startup/CSP, cross-tab behavior, keyboard controls, dark forms/panels/admin views and phone/desktop layouts. Pre-existing Light CSS values were independently verified identical. Low-contrast urgent/quiet dark section counts and native form placeholders found during review were fixed and covered by browser contrast checks. The count regression failed the old CSS and passed the new CSS; final dark placeholders exceed 7:1 contrast. Browser tests used actual Chromium 153 through the existing executable-path override; no Windows launcher behavior changed.
