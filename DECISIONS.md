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

## Drawing review (1.1.0)

Agreed with Christin on 2 October 2026, from the drawing review master plan.

| # | Decision | Why |
|---|---|---|
| 23 | **The review screen uses pdf.js, bundled into the web app.** `pdfjs-dist` is a devDependency (like React). The build copies its "legacy" browser build, the image decoders (`wasm/`), fonts and colour profiles into `app/web/assets/pdfjs-<version>/`. It runs only in the browser and loads only on review screens. The server still uses Node built-ins only, and nothing is fetched from the internet. The page's Content-Security-Policy adds `'wasm-unsafe-eval'` (WebAssembly image decoders for scanned drawings; it does not allow JavaScript `eval`) and `worker-src 'self'`. The PDF page count is checked on the server by a small reader written with Node built-ins (`server/src/domain/pdf.ts`). | Reviewers need independent page navigation, zoom, fit and 90° rotation in two viewers, plus a page number they can remember. The browser's built-in viewer offers none of these to a page. Decision #1 is about what runs on the host PC, and that is unchanged. |
| 24 | **A third role, Reviewer.** The manager and reviewers pass or return drawings, and sign the prints. Engineers never review. Reviewers can sign in, view everything (narrowed by #29 to the drawings handed to them), comment, review, and record signatures. They cannot create, claim, edit or move jobs, and they cannot be assigned work. Engineers submit drawings, mark handovers and record signatures. Migration 5 rebuilds the `users` table to allow the new role, with foreign-key checks off for the rebuild only, as SQLite documents. | Christin named the reviewers: the manager plus Ebin, Rohith, Jins, Prabin, Hoxen, Shamina and Dolfin. This replaces "review is self-review" for drawings only; the Kanban Review column still works as before for jobs without drawings. |
| 25 | **Review PDFs are stored once, by SHA-256, in `data/review-files/`, not in the database.** Each attempt and decision records the hash, so it is bound to the exact bytes reviewed. Backups copy the files into `<backupDir>/review-files/` (each file once) and list them in `<backup>.review-files.txt`. A restore puts back any listed file that is missing, and pruning keeps a file while any remaining backup lists it. | Merged signed scans can be tens of MB. Keeping them inside SQLite would multiply every daily backup. Content addressing makes "the reviewed bytes can't change" true by construction. |
| 26 | **Signed scans are never written, replaced or deleted.** They are uploaded as references and stored as protected files: database triggers refuse to mark them removed, unprotect them, change them or delete them. The board writes to a job's project folder (its File location) only under `BoardReview/<JOB>/` and to `REVISION_LOG.md`. It replaces or deletes only a file it wrote itself, and only while that file's content is still what the board wrote. Anything else with the same name is left alone and reported. Done needs every required drawing to be physically signed. When the last signature is recorded the job moves to Done by itself. | These are the plan's non-negotiable protections: board approval is internal, the signed scan is the official record, and Done means physically signed. |
| 27 | **Intermediate PDFs are removed only after a drawing passes, and only once the passed PDF verifies.** Clean-up runs after the decision commits and is retried until it succeeds. The attempt records (notes, comments, outcome, people, times) are kept forever, and the history shows "Intermediate PDF removed after board review". Uploads never submitted are forgotten after a day. | The plan asks for tidy project folders without losing history or the reviewed final, and for nothing half-done if a share is offline. |

## Passwords (1.2.0)

Asked for by Christin on 2 October 2026: password login for all users, current and new.

| # | Decision | Why |
|---|---|---|
| 28 | **Everyone signs in with a password, created by the person at their first sign-in.** The name picker stays; after picking a name the person enters their password, or creates one if they have none yet (`has_password` false: a team member from before 1.2.0, a newly added person, or someone whose password an admin reset). Passwords are 6 to 100 characters, stored as salted scrypt hashes next to the admin PIN's format, never shown to anyone. The session cookie is bound to the current password, so changing it (**your name → Change password**) or an admin resetting it (**Admin → Team → Reset**) signs that person out everywhere; cookies from before 1.2.0 are refused, so the upgrade itself asks everyone to sign in once. Five wrong passwords in a row pause sign-in for that person for 30 seconds. A `RESET-PASSWORDS` file next to `start.bat` clears every password on the next start, the way `RESET-ADMIN-PIN` resets the PIN (#22). Restores keep the running passwords, like the PIN and cookie secret. The admin PIN is unchanged and separate: it still unlocks Admin for anyone signed in who knows it (#10). Migration 7 adds the nullable `password_hash` column. | Decision #10 anticipated this ("so passwords can be added later") and is extended, not reversed: the picker, signed cookie and PIN all remain. Self-created passwords mean no admin ever knows or hands out anyone's password, and existing members are covered without a migration step for Christin. Binding the cookie to the password is what makes a reset or change actually take effect on other browsers. The host-PC file is the recovery of last resort for a team whose only admin forgets their password, keeping "access to the host PC is the right authority" (#22). |

## Reviewer access (1.3.0)

Asked for by Christin on 3 October 2026: engineers have full control of the jobs; reviewers get access only to what is handed to them for review, and cannot see the workload or anything else. She chose: the manager keeps today's access; the engineer picks the reviewers, several per drawing if wanted; a reviewer sees the drawings and their review, not the rest of the job.

| # | Decision | Why |
|---|---|---|
| 29 | **Engineers hand each drawing to one or more reviewers, and a reviewer sees only those drawings.** When submitting, the engineer ticks the reviewers (active reviewers or the manager) for the submission, or per drawing; a drawing new to the job can't be submitted without one, and a resubmission keeps its reviewers unless changed. Engineers can change a drawing's reviewers later (**Change**, or `PUT /api/review/drawings/:id/reviewers`). Any one of a drawing's reviewers may pass or return it; the one who passes it is reminded at handover and signs, and keeps seeing that drawing even if the reviewers change. A reviewer's whole board is the review queue and the workspaces of jobs with a drawing handed to them: they see the job number, title and status, those drawings (attempts, PDFs, notes, comments, history) and the job's signed reference scans, and nothing else. Every other route answers them 403 (board, job panel and job notes, Today, My work, Dashboard, Workload, Reports, search, team activity, presence, exports, Admin even with the PIN); other jobs, drawings and PDFs answer 404. Notifications and the live-update stream carry only their drawings. The manager and engineers see everything, as before. Migration 8 adds `review_drawing_reviewers` and hands drawings already in review to the reviewers who had worked on them; untouched ones show to the manager until an engineer picks their reviewers. | Engineers control the jobs, as decision #11 already gave them (claim, edit, move); this narrows #24's "reviewers can view everything and comment" to the drawings handed to them, and replaces "any reviewer can pass any drawing" with "the reviewers it was handed to". #11 (the manager) is unchanged at Christin's request. Several reviewers per drawing allow a second check without a new workflow; one decision still passes it, so the signature rule (#26) and the single handover reminder are unchanged. 404 for things not handed over avoids revealing which jobs exist. |

## Projects (1.4.0)

| # | Decision | Why |
|---|---|---|
| 30 | **Every job belongs to a project, and projects are added by the team when needed; none are preset.** Engineers and the manager add a project by name from the New job form (**+ Add a project…**) or the **Projects** page. A name can be used once (case and extra spaces don't count), and a repeated name chooses the existing project instead. A new job made on the board can't be saved without a project; a job can move to another project (recorded in its history) but never back to none. Jobs from before 1.4.0 show as **No project** until someone picks one; CSV imports take a **Project** column, adding new names unless that's switched off, and rows without one import without a project. The Projects page lists each project's open and total jobs, and all its jobs; the board and search can filter by project, and search matches project names. Projects are never deleted. The only change to a project is adding it, since Christin asked only for a way to add names. Reviewers don't see projects (#29). Migration 9 adds `projects` and a one-row-per-job `ticket_projects` link, leaving `tickets` unchanged so older backups still restore and upgrade. | Christin asked that every task be tracked to a project and every project to its tasks, with the project list managed separately and grown on demand from inside the board. |

## Known limits

- The host PC must be on for others to reach the board.
- **The Windows Firewall needs an inbound rule for the port.** Adding one needs admin rights, so ask IT once: `for-IT\allow-board-port.bat` or [`docs/FOR-IT.md`](docs/FOR-IT.md).
- The host PC must not sleep, and the board stops while its user is signed out (decision 20).
- The single process scales comfortably to this team's size: thousands of tickets and a handful of users.
- **Drawing review reads unencrypted PDFs only.** A PDF saved with a password or security settings is refused with a clear message: export or scan it again without security.
- **The PDF viewer needs a reasonably current browser.** The board ships pdf.js's "legacy" build, which adds support for older Edge and Chrome versions. A very old browser may not show PDFs.
