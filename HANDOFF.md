# HANDOFF

Live coordination board. Edit this file freely (unlike `CHANGELOG.md` it is not append-only), but keep it current.

## Active claims
Add a row when you start working, remove it when you finish.

| Agent | Branch | Files / areas being touched | Started (IST) |
|---|---|---|---|
| _(none)_ | | | |

## Open questions
Questions for Christin or another agent. Mark answered ones with the answer and date, and move them to "Resolved".

_(none)_

## Resolved
- [x] The application source was not in this repo yet. **Answer:** Claude imported the full source and its history (phases 2 to 7) on branch `claude/import-app-source`, 2026-10-02.

## Notes for the next agent
- **Where the project stands:** phases 1–9, 1.0.1 (reliability), 1.0.2 (themes) and 1.1.0 (drawing review) are on main. Branch `ccr-76842e6e-xbo8lh` proposes 1.2.0, password sign-in, for Christin's review.
- **Releases:** `npm run package` writes `dist/EngineeringBoard-<version>.zip`. Bump `version` in `package.json` and `APP_VERSION` in `server/src/app.ts` together; `check:build` fails if they differ.
- **README screenshots:** `assets/screenshots/` is written by `node scripts/screenshots.mjs` (build first; set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` if Playwright's own Chromium isn't installed). Re-run it after visible changes.
- **Guides:** edit the Markdown in `docs/`; the build turns them into the pages at `/guides/` and in the zip. `check:build` fails on a broken link between guides.
- **Windows scripts** (`scripts/windows/*.bat`) can't be run in CI. Keep echo lines that show `%~dp0` outside `( )` blocks and quoted: a folder path containing `)` or `&` breaks them otherwise.
- **Setup:** `npm install` installs the build and test tools (TypeScript, tsx, esbuild, React, Playwright). They are devDependencies only; the running board needs nothing but `node.exe` 22.16+ (decision #1).
- **Lockfile:** `package-lock.json` is committed (devDependencies only). Use `npm ci` for a clean install, and commit lockfile changes along with any devDependency change.
- **No `@types/react`:** `web/src/types/react-shim.d.ts` declares only the parts of React the app uses, so it can be typechecked without the package. Replacing it with the real types is fine, as long as `npm run typecheck` still passes.
- **Checks:** `npm run typecheck`, `npm test` (156 backend tests), `npm run build`, `npm run check:build` (15 checks: packages, then checks the zip and runs its server with plain node), `npm run e2e` (35 browser tests in `e2e/board.e2e.mjs` and `e2e/review.e2e.mjs`; build first). Chromium for the browser tests: set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` when Playwright's own download is unavailable.
- **Passwords (1.2.0):** decision #28, all in `server/src/domain/auth.ts`. Sessions are `u<id>:<tag>` where the tag derives from the password hash, so `sessionCookie` needs a user who has a password, and `readSession` reads the users table. Tests sign in through `signIn()` / `h.as()` in `server/test/helpers.ts`, which creates `TEST_PASSWORD` at first use; browser tests create `PASSWORD` for the seeded users in `before()`. Anything that signs in by raw API must send `password` (or use `/api/session/password` first). `restoreFrom` carries the running `password_hash` values into the restored database; keep that if restore changes.
- **New migrations:** add the matching `UNDO` entry in `server/test/migrations.test.ts`, or the upgrade test fails on purpose.
- **Reliability validation (1.0.1):** Node 22.16.0: typecheck, 120 backend tests, build, 14 package checks, 25 Playwright browser tests all passed. Separate implementation agents and an independent validation agent reviewed restore, upload and pagination; no remaining blockers. The browser suite used real Chromium through `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`; its default still uses Playwright's installed browser. No Windows `.bat` behavior was changed or newly validated.
- **Restore uploads:** `restoreUploadMaxMB` / `EB_RESTORE_UPLOAD_MAX_MB` defaults to 64 MiB (1–1024). Files stream only after admin authorization. Validations and activation rollback occur before returning success; API details are in `docs/API.md`.
- **Complete list protocol:** page responses include an opaque connection/write revision; Board and Workload load every page with matching totals/revisions and report retryable failures. Keep this check if list loading changes.
- **Themes (1.0.2):** Light is the original default; Charcoal and Midnight are optional. The Theme selector is available before sign-in and in the top bar. The per-browser `engineering-board-theme` preference applies before first paint via the bundled external head script, tolerates unavailable storage and synchronizes between tabs. No database setting or dependency is involved. Preserve the semantic CSS tokens when adding UI states.
- **Theme validation:** Node 22.16.0: typecheck, 120 backend tests, build, 14 package checks and 31 browser tests all passed. Separate CSS/test agents and an independent reviewer checked persisted preferences, storage failures, startup/CSP, cross-tab behavior, keyboard controls, dark forms/panels/admin views and phone/desktop layouts. Pre-existing Light CSS values were independently verified identical. Low-contrast urgent/quiet dark section counts and native form placeholders found during review were fixed and covered by browser contrast checks. The count regression failed the old CSS and passed the new CSS; final dark placeholders exceed 7:1 contrast. Browser tests used actual Chromium 153 through the existing executable-path override; no Windows launcher behavior changed.
- **Drawing review (1.1.0):** decisions #23–#27. Server: `domain/reviews.ts` (workflow), `reviewStore.ts` (content-addressed PDFs in `data/review-files`, backup store), `projectFolder.ts` (BoardReview copies, REVISION_LOG.md), `pdf.ts` (page counter, Node built-ins only). Web: `views/ReviewQueue.tsx`, `views/ReviewWorkspace.tsx`, `components/PdfViewer.tsx`, `lib/pdf.ts`. Test PDFs are generated by `e2e/fixtures/pdf.mjs` (plain and compressed object streams), so no binary fixtures live in the repo. pdf.js comes from the `pdfjs-dist` devDependency; `scripts/build.mjs` copies its legacy build into `app/web/assets/pdfjs-<version>/`. Keep the signed-scan protections (triggers in migration 6, `removeBlob`, the project-folder ownership checks) intact: they are the plan's non-negotiable rule.
- **After updating to 1.2.0** everyone signs in once more and creates their password (old cookies are refused on purpose). Tell the team before the update. A forgotten password is reset under Admin → Team; if everyone is locked out, a `RESET-PASSWORDS` file next to `start.bat` clears them all on the next start.
- **Not yet validated on the real setup:** writing to the team's UNC project shares from the host PC (Windows paths and permissions), real SolidWorks 2024 exports, and real scanner output (JBIG2/CCITT scans render through pdf.js; encrypted PDFs are refused). Christin needs to add the reviewers (Ebin, Rohith, Jins, Prabin, Hoxen, Shamina, Dolfin) under Admin → Team after updating.
