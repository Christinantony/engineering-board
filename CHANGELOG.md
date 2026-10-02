# CHANGELOG

**Append-only.** Add your entry at the **bottom**. Never edit or delete an existing entry. If an earlier entry was wrong, add a new entry that corrects it and refers to the old one.

## Entry format

```
### YYYY-MM-DD HH:MM IST | <Agent: Claude / ChatGPT / Antigravity / Christin> | branch: <branch-name>
- **What:** what changed, in one or two lines
- **Why:** the reason or the requirement behind it
- **Files:** paths touched
- **Decisions affected:** numbers from DECISIONS.md, or "none"
- **Follow-ups / open issues:** anything unfinished or that the next agent must know, or "none"
```

---

### 2026-10-01 23:45 IST | Claude | branch: claude/bootstrap-collab-protocol
- **What:** Added the multi-agent collaboration protocol: `00_START_HERE.md`, `AGENTS.md`, `CHANGELOG.md`, `HANDOFF.md`, `DECISIONS.md` (copied from the project's `ARCHITECTURE.md`), `.gitignore`, and a pull request template.
- **Why:** Claude, ChatGPT and Antigravity will all work on this project, and every change needs to be traceable so the agents stay in sync.
- **Files:** `00_START_HERE.md`, `AGENTS.md`, `CHANGELOG.md`, `HANDOFF.md`, `DECISIONS.md`, `.gitignore`, `.github/pull_request_template.md`
- **Decisions affected:** none. `DECISIONS.md` is a verbatim copy of the existing architecture doc, plus a header.
- **Follow-ups / open issues:** The application source (`app/`, `domain/`) is not in the repo yet. It exists on Christin's machine only and must be committed in a separate PR before any agent can change code. See `HANDOFF.md`.

### 2026-10-02 00:05 IST | Claude | branch: claude/import-app-source
- **What:** Imported the application source with its full git history (phases 2 to 7: database and API, board UI, operational views, collaboration, admin/import/export/backups, polish), merged onto `main`'s collaboration files. Declared the build and test tools as devDependencies. Replaced `docs/ARCHITECTURE.md` with a pointer to `DECISIONS.md`. Corrected the project layout in `AGENTS.md`, resolved the open question in `HANDOFF.md`, and added `dist/` to `.gitignore`.
- **Why:** The code only existed in Claude's workspace and in zip files. Every agent needs it in the repo before any code work can start.
- **Files:** `server/`, `web/`, `shared/`, `e2e/`, `scripts/`, `docs/`, `package.json`, `tsconfig.json`, `README.md`, `.gitignore`, `AGENTS.md`, `HANDOFF.md`, `CHANGELOG.md`
- **Decisions affected:** none. The code implements decisions 1 to 17 as written.
- **Follow-ups / open issues:**
  - There is no `package-lock.json` yet, because the build environment had no npm registry access. See `HANDOFF.md`.
  - Phase 8 (testing) and Phase 9 (deployment package and guides) are still to do.

### 2026-10-02 00:25 IST | Claude | branch: claude/phase8-testing
- **What:** Phase 8 test pass, version 0.8.0.
  - New tests: upgrading a board that was in use at every older database version (1, 2, 3), restoring an old backup, refusing data from a newer version (`migrations.test.ts`); card order through 500 drops including forced renumbering (`rank.test.ts`); the whole team acting at once and 600 jobs (`load.test.ts`); junk input on every API route (`robustness.test.ts`).
  - New `npm run check:build` (`e2e/build.check.mjs`): runs the built `app/server.mjs` with plain node, the way the host PC does.
  - Browser tests now fail on any page or console error. Two new browser tests: the server going down and coming back, and the "board has been updated" reload prompt.
  - Fixes the tests found:
    - The board now takes a `pre-upgrade` backup before a new version changes the database, and refuses to start on data written by a newer version (it used to run on it).
    - Uploads over the size limit now get a readable 413 instead of a dropped connection.
    - `app.close()` is safe to call twice, and a failed start no longer leaves the database file open.
    - Node's "SQLite is an experimental feature" warning no longer shows in the server window, however the server is started.
    - A node.exe with SQLite switched off gets its own clear message.
- **Why:** Phase 8 of the plan: unit, integration and UI tests, migration and build checks before the deployment package.
- **Files:** `server/src/app.ts`, `server/src/db/connection.ts`, `server/src/domain/backup.ts`, `server/src/http/http.ts`, `web/src/views/admin/Data.tsx`, `server/test/{migrations,rank,load,robustness}.test.ts`, `e2e/build.check.mjs`, `e2e/board.e2e.mjs`, `package.json`, `README.md`, `docs/API.md`, `AGENTS.md`, `HANDOFF.md`
- **Decisions affected:** none. The pre-upgrade backup extends the backup rules without changing them.
- **Follow-ups / open issues:**
  - Phase 9: the deployment package and the guides.
  - The lockfile is still missing (see `HANDOFF.md`).

### 2026-10-02 00:50 IST | Claude | branch: claude/phase9-deployment
- **What:** Phase 9: the deployment package and guides. Version 1.0.0.
  - `npm run package` builds `dist/EngineeringBoard-<version>.zip`. It contains `app\`, `start.bat`, `autostart-on/off.bat` (a Startup-folder shortcut, no admin), `config.example.json`, `README-FIRST.txt`, `guides\`, `for-IT\` (a firewall-rule script for IT, plus instructions), and `linux\` (`start.sh`, a systemd unit, a Dockerfile, docker-compose).
  - Guides in `docs/`: INSTALL (install, first run, LAN address and finding the IP, start at sign-in, update, move, Linux, Docker, uninstall), USER-GUIDE, ADMIN-GUIDE (team, import/export, backup/restore, archive, settings), TROUBLESHOOTING, FOR-IT. The build turns them into web pages served at `/guides/` and linked from the `?` dialog and the name menu.
  - `config.json` is now forgiving and explains mistakes: it accepts a BOM and `_comment` keys, explains single-backslash Windows paths and comma mistakes, lists every bad value at once, and warns about misspelt settings.
  - The startup banner shows the settings file, the guide address, and a correct "For your team" line for a `127.0.0.1` host or a container.
  - A forgotten admin PIN is reset by a `RESET-ADMIN-PIN` file next to `start.bat`.
  - `start.bat` survives folder paths containing `)` or `&`.
  - `check:build` now also checks the zip: its layout, that it ships no data, settings or node.exe, line endings, links between guides, running from the unzipped folder with `start.sh`, config errors, and the PIN reset.
  - Docker Compose was tested from the unzipped package: build, healthcheck, data on the host, update by replacing `app`, clean stop.
- **Why:** Phase 9 of the plan: deployment configuration, plus installation, first-run, backup, update and troubleshooting instructions, and the user and admin guides.
- **Files:** `scripts/package.mjs`, `scripts/lib/{markdown,zip,guides}.mjs`, `scripts/build.mjs`, `scripts/windows/*`, `scripts/linux/*`, `config.example.json`, `.gitattributes`, `docs/{INSTALL,USER-GUIDE,ADMIN-GUIDE,TROUBLESHOOTING,FOR-IT}.md`, `docs/API.md`, `server/src/{config,index,app}.ts`, `server/src/domain/auth.ts`, `server/test/config.test.ts`, `web/src/App.tsx`, `web/src/components/Overlays.tsx`, `e2e/build.check.mjs`, `e2e/board.e2e.mjs`, `package.json`, `README.md`, `DECISIONS.md`, `HANDOFF.md`
- **Decisions affected:** new decisions 18 to 22 (the deployment section). No existing decision changed.
- **Follow-ups / open issues:**
  - This branch is based on `claude/phase8-testing` (PR #3); merge #3 first.
  - The `.bat` scripts were reviewed but can only be run on Windows; they need testing on the host PC.
  - The lockfile is still missing (see `HANDOFF.md`).

### 2026-10-02 01:25 IST | ChatGPT | branch: chatgpt/restore-upload-list-reliability
- **What:** Version 1.0.1: prepare and validate database restores before activation, roll back every activation failure, stream authorized backup uploads to disk with a configurable 64 MiB default, and load all Board/Workload pages with revision checks and visible retry errors.
- **Why:** Invalid restore candidates could replace live data, uploads were buffered before admin authorization, and large job views silently omitted jobs.
- **Files:** `server/src/{domain/backup,domain/tickets,db/connection,http/http,app,config,index}.ts`, `server/test/{restore-safety,upload-safety,list-completeness,config}.test.ts`, `web/src/lib/{store,ticketPages}.ts`, `web/src/views/{Board,BoardPage,Workload}.tsx`, `e2e/board.e2e.mjs`, `package.json`, `config.example.json`, `README.md`, `docs/{API,ADMIN-GUIDE,USER-GUIDE,INSTALL}.md`, `HANDOFF.md`, `CHANGELOG.md`.
- **Decisions affected:** none. Zero runtime dependencies and the existing LAN auth, backup, deployment and workload rules remain intact.
- **Validation:** On Node 22.16.0: typecheck, all 120 backend tests, build, all 14 package checks, and all 25 browser tests passed. Independent validation separately passed 41 targeted tests on Node 22.16.0, 7 migration tests, and real socket probes for early auth/size rejection and interruption cleanup; no remaining blockers. Browser tests used real Chromium via an optional executable-path environment override.
- **Supporting fixes:** Close failed SQLite opens; avoid startup failure when listing LAN interfaces is unavailable; run backend tests via `node --import tsx` without the tsx CLI IPC server. Version bump prompts already-open browsers to reload after deployment.
- **Follow-ups / open issues:** no outstanding issue in this scope. Existing real-Windows launcher/LAN testing, missing lockfile and CI remain separate follow-ups; no Windows launcher changes were made.

### 2026-10-02 10:35 IST | ChatGPT | branch: chatgpt/board-themes
- **What:** Version 1.0.2 adds optional Charcoal (neutral dark grey/blue) and Midnight (near-black/teal) themes alongside the unchanged Light default, selectable before sign-in and throughout the app. The browser remembers the choice, applies it before first paint and synchronizes it between tabs. Forms, panels, dialogs, menus, operational/admin views and native controls share semantic theme colors; the phone header accommodates the selector.
- **Why:** Christin chose mockup options 1 and 3 and requested them as theme options alongside the existing board, with agentic validation before a PR.
- **Files:** `web/src/{App,components/ThemePicker}.tsx`, `web/src/{lib/theme,theme-init}.ts`, `web/src/styles.css`, `web/index.html`, `scripts/build.mjs`, `e2e/{board.e2e,build.check}.mjs`, `package.json`, `server/src/app.ts`, `README.md`, `docs/{USER-GUIDE,INSTALL}.md`, `HANDOFF.md`, `CHANGELOG.md`.
- **Decisions affected:** none. No runtime dependency, database schema, authentication or workflow change; the version bump preserves the existing upgrade/reload handshake.
- **Validation:** Node 22.16.0: typecheck, all 120 backend tests, build, all 14 package checks and all 31 browser tests passed. Separate CSS/test agents and an independent reviewer checked startup/CSP, preferences across reload/user switching/tabs, corrupt or blocked storage, dark operational/admin screens, forms/panels/dialogs, keyboard selection and phone/desktop layouts. Original Light CSS values were independently verified unchanged. Review found low-contrast urgent/quiet dark count badges and native form placeholders; these were fixed and covered by browser contrast checks. Count checks reproduced the old failure and passed the corrected CSS; dark placeholders now exceed 7:1 contrast. Browser tests ran real Chromium 153 without skips.
- **Follow-ups / open issues:** none in the requested theme scope. Existing real-Windows launcher/LAN testing, lockfile and CI remain separate follow-ups; no Windows launcher changes were made.

### 2026-10-02 11:15 IST | Claude | branch: claude/readme-catalogue
- **What:** Rewrote `README.md` as a catalogue of the board, version 1.0.2: an at-a-glance sheet, an index, and lettered sections with item codes (pages, the job record, working together, finding things, administration, appearance, editions and installation, specifications, documentation, release history, working on the code). It now covers the 1.0.1 restore and complete-list changes and the 1.0.2 themes, and keeps the install steps, settings table and developer commands.
- **Why:** Christin asked for a scan of what the other agents changed, and a README that reads like a catalogue for the engineering board.
- **Files:** `README.md`, `HANDOFF.md`, `CHANGELOG.md`
- **Decisions affected:** none. Documentation only; no code, tests or version change.
- **Follow-ups / open issues:** The README quotes 120 backend tests, 31 browser tests and 14 package checks (checked against `npm test` and `HANDOFF.md` on 2026-10-02). Update the counts when they change.

### 2026-10-02 12:25 IST | Claude | branch: claude/lockfile
- **What:** Added `package-lock.json`, generated by `npm install` with registry access on Node 22.22.0. No dependency was added or changed.
- **Why:** `HANDOFF.md` asked the first agent with registry access to commit the lockfile in its own small PR, so every agent installs the same build and test tools.
- **Files:** `package-lock.json`, `HANDOFF.md`, `CHANGELOG.md`
- **Decisions affected:** none. The lockfile covers devDependencies only; the running board still needs nothing but `node.exe` (decision #1).
- **Validation:** typecheck and all 120 backend tests passed after a clean install.
- **Follow-ups / open issues:** none.

### 2026-10-02 13:20 IST | Claude | branch: claude/drawing-review
- **What:** Version 1.1.0, drawing review, built from Christin's "Drawing Review Master Plan" (2 Oct 2026).
  - **Review page** (<kbd>V</kbd>): a queue of jobs with drawings in board review, with counts, tabs (awaiting, returned, signature pending, signed, all), search by job, drawing or folder, and a preview with thumbnails and revision notes.
  - **Submitting:** from a job, an engineer attaches the merged signed scan (as a protected reference) and one single-page PDF per drawing. The file name becomes the drawing number, which can be corrected. Each drawing gets change notes (or the purpose of a new drawing). Multi-page, damaged and encrypted PDFs are refused with a clear message. Submitting moves the job to Review. A resubmitted drawing becomes a new attempt; its engineering revision is unchanged.
  - **Workspace:** the drawing set; the signed reference and the submitted drawing in two pdf.js viewers, each with its own page, zoom, fit page, fit width and rotation (view only); a reference-file selector; **Remember page N**, a manual per-drawing bookmark that engineers and reviewers can change; comparison with the previous attempt; revision notes, attempt history, and comments with engineer responses and resolution.
  - **Decisions per drawing:** the manager or a reviewer passes or returns each drawing, never their own submission. Open comments block a pass. Labels say "Board review passed — signature pending", never "approved".
  - **Print and signature:** open the exact reviewed PDF to print. **Mark handed over** creates one in-board reminder for the reviewer who passed it ("… was approved by you in the board on … handed over for your signature"); a repeat press is refused. **Record physical signature** needs no upload. A job can't be Done until every required drawing is signed, and it becomes Done by itself when the last one is.
  - **Files:** review PDFs are stored once by SHA-256 in `data/review-files`; decisions are bound to those bytes. After a pass, and once the reviewed PDF verifies, earlier attempts' PDFs are removed. Their history is kept ("Intermediate PDF removed after board review"), and clean-up retries on failure. Signed scans are protected by database triggers and code, and are never written, replaced or deleted.
  - **Project folder** (the job's File location): copies under `BoardReview/<JOB>/`, the reviewed final as `<drawing> - board reviewed (attempt N).pdf`, and a generated `REVISION_LOG.md`. The board changes or deletes only files it wrote and that are unchanged since; anything else is reported and left alone. If the share is offline, the screen shows it and the board retries every 5 minutes. **Revision log** also opens per job.
  - **Backups** copy review PDFs into `<backupDir>/review-files` (deduplicated) with a per-backup list; restore puts back missing files; pruning keeps files any remaining backup needs.
  - **New Reviewer role** (Admin → Team). Reviewers view, comment, review and sign, but can't create or change jobs. Notifications cover submissions (to reviewers), pass, return, comments and the signature reminder. Drawing numbers are searchable.
  - New setting `reviewUploadMaxMB` (default 200 MiB, `EB_REVIEW_UPLOAD_MAX_MB`).
- **Why:** Christin asked for the drawing review master plan to be implemented. She chose a bundled pdf.js viewer, the job's File location as the project folder, review by the manager plus named reviewers (not engineers), and open comments blocking a pass.
- **Files:** `server/src/domain/{reviews,reviewStore,projectFolder,pdf}.ts` (new), `server/src/{app,config,index}.ts`, `server/src/http/http.ts`, `server/src/db/{migrations,connection,seed}.ts`, `server/src/domain/{tickets,users,notifications,search,backup}.ts`, `shared/src/{constants,validate}.ts`, `web/src/views/{ReviewQueue,ReviewWorkspace}.tsx` (new), `web/src/components/PdfViewer.tsx` (new), `web/src/lib/{pdf,review}.ts` (new), `web/src/types/globals.d.ts` (new), `web/src/{App.tsx,styles.css}`, `web/src/components/{TicketPanel,Collab,Overlays}.tsx`, `web/src/views/{Dashboard.tsx,admin/Team.tsx}`, `web/src/lib/{dialogs,store,shortcuts}.ts`, `scripts/build.mjs`, `server/test/review.test.ts` (new), `server/test/{helpers,migrations.test,restore-safety.test,platform.test,config.test}.ts`, `e2e/review.e2e.mjs` and `e2e/fixtures/pdf.{mjs,d.mts}` (new), `package.json`, `package-lock.json`, `config.example.json`, `DECISIONS.md`, `README.md`, `docs/{USER-GUIDE,ADMIN-GUIDE,API,TROUBLESHOOTING,FOR-IT}.md`, `HANDOFF.md`, `CHANGELOG.md`
- **Decisions affected:** new decisions #23–#27. #1 still holds for the server: pdf.js is a devDependency built into the browser files, as React is. "Review is self-review" (Phase 1) no longer applies to drawings in board review (#24); it is unchanged for other jobs. Migrations 5 (users table rebuilt for the reviewer role, using a new `rebuildsTables` migration flag) and 6 (review tables), each with `UNDO` entries.
- **Validation:** On Node 22.22.0: typecheck; 145 backend tests, including 23 new review tests covering every acceptance check in plan §9; build; 14 package checks; 34 browser tests, including 3 new review tests in real Chromium (submit with a refused multi-page PDF, independent page, zoom and rotation with the bytes unchanged, a remembered page surviving reload, comment-blocked pass, handover reminder, signatures leading to Done). The PDF reader was also checked against qpdf-made object-stream, linearized, encrypted, merged and damaged-xref files. Screens were checked in Light, Charcoal and Midnight at 1600, 1280 and 390 px.
- **Follow-ups / open issues:** merge PR #8 (lockfile) first. Still to try on the real setup: UNC project shares from the host PC, real SolidWorks exports and scanner PDFs. Christin adds the reviewers under Admin → Team after updating. JSON export doesn't include review records yet.
