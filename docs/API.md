# API reference (v1.4)

All endpoints are under `/api` and use JSON. Mutating requests must send `Content-Type: application/json`, which together with `SameSite=Strict` cookies blocks cross-site form posts.

Errors look like this:

```json
{ "error": "<code>", "message": "<human sentence>", "details"?: [...], "current"?: {ticket} }
```

| Status | Meaning |
|---|---|
| 400 `validation` | Invalid input. `details` lists every bad field. |
| 400 `reason_required` | Moving to waiting or blocked needs a "Waiting for" reason. |
| 401 | Nobody is signed in on this browser. |
| 403 | Not allowed. Examples: a manager claiming, or the admin area is locked. |
| 403 `wrong_password` | The password doesn't match (sign-in, or the current password when changing it). |
| 409 `password_not_set` | This person has no password yet: create it with `POST /api/session/password`. |
| 409 `password_already_set` | A password already exists for this person; sign in with it instead. |
| 429 `too_many_attempts` | Five wrong passwords in a row: sign-in for that person pauses for 30 seconds (`retry_after_seconds`). The right password is refused too while paused. |
| 409 `conflict` | Someone else got there first. `current` holds the fresh ticket. |
| 409 `needs_assignee` | The manager moved an unassigned job to a working column. |
| 413 `too_large` | The body is over the limit: 20 MiB for JSON and CSV; restore uploads default to 64 MiB, configurable through `restoreUploadMaxMB` / `EB_RESTORE_UPLOAD_MAX_MB` (1–1024 MiB). |
| 415 | A binary body was sent to anything other than the restore upload or a review PDF upload. |
| 400 `not_single_page` | A drawing submitted for board review has more than one page. |
| 400 `bad_pdf` / `not_pdf` | The upload is not a readable PDF (damaged, encrypted, or not a PDF). |
| 409 `open_comments` | A drawing can't pass board review while it has unresolved comments. |
| 409 `signatures_pending` | A job with drawings in board review can't be Done until every required drawing is recorded as physically signed. |
| 410 `removed` | An intermediate review PDF was removed after its drawing passed board review. |
| 503 `busy` | The database is busy. Retry. |

## Session (sign in)

Everyone signs in with their own password (decision #28). A new person, or one whose password an admin has reset, has none yet (`has_password: false` in the user list) and creates it at their first sign-in. Passwords are 6 to 100 characters, spaces allowed, stored as salted scrypt hashes.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/users` | Active users, for the picker, each with `has_password`. Add `?all=1` to include inactive users. |
| GET/POST/DELETE | `/api/session` | POST `{user_id, password}` sets a signed cookie (1 year). The cookie is bound to the current password: changing or resetting it signs that person out everywhere. Cookies from versions before 1.2.0 are no longer accepted. |
| POST | `/api/session/password` | `{user_id, password}`: create the first password (409 if one exists) and sign in. |
| POST | `/api/me/password` | `{current_password, new_password}`: change your own password. This browser gets a new cookie; other browsers are signed out. |
| GET | `/api/meta` | Version, time zone, today's date, statuses, estimate buckets, whether the default PIN is still set, and `permissions`: what each role may do with jobs (`create`, `claim`, `edit` per role; Admin → Roles, decision #31). |
| GET | `/api/health` | Liveness check. |

## Projects

Every job created on the board belongs to a project (decision #30). Reviewers get 403 on both routes.

| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/projects` | `{projects: [{id, name, created_by, created_at, open, total}]}`, sorted by name. `open` counts jobs not done, cancelled or archived. |
| POST | `/api/projects` | `{name}` (1–100 characters; extra spaces are collapsed). Engineers and the manager. 201 `{project}`; a name that already exists (any case) answers 409 `project_exists` with the existing `project`. |

### Procurement follow-ups (decision #40)

The existing procurement items are the only master records. Pending items are searchable across all projects, and follow-up contact history is append-only. All four endpoints require a signed-in board user; reviewers receive 403. Mutation endpoints use the existing worker authorization.

| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/procurement/followups` | `{items}` where every pending item includes project name, action owner/date/version and latest contact summary. Stocked or removed items are excluded. |
| PUT | `/api/procurement/items/:id/followup` | `{version, owner_id: number or null, next_action, next_due: YYYY-MM-DD or null}`; absent state begins at version 0, stale writes return 409. |
| POST | `/api/procurement/items/:id/followups` | `{outcome: progress\|delayed\|ready\|unreachable\|other, note, next_due?}`; inserts immutable record, does **not** set stock or silently change assigned action. |
| GET | `/api/procurement/items/:id/followups` | `{calls}` most recent first, up to 100. |

### Procurement tracker (decision #39)

Board-wide: reviewers get 403. Live updates send `{type:'procurement', id: <project id>}`.

| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/projects/:id/procurement` | `{project, build, build_log[], items[], log[] (newest first, up to 500), totals: {items, in_stock, pending}, suggestions: {disciplines, categories, units, materials}, copy_from: [{id, name, items}]}`. `build`: `{arrays, per_array, spares, antennas, version, updated_by, updated_at}` (`antennas` = arrays × per_array + spares; `version` 0 until first saved). Items: `{id, project_id, name, discipline, category, means, spec, quantity, basis, required, unit, notes, material, inventory, inventory_note, to_procure, sort_order, in_stock_at, in_stock_by, created_by, created_at, updated_at, version}`; `means` is `outsourced`, `in_house`, `bought_out` or `tools`; `basis` is `antenna`, `array` or `total`, and `required` is `quantity` × the build's antennas, × its arrays, or × 1; `inventory` is a count or null, and `to_procure` is `required` − `inventory` (not below 0), or null when the inventory isn't counted. Log entries: `{id, item_id, user_id, at, kind: in_stock\|not_in_stock\|added\|removed, item_name, item_spec}`. |
| GET | `/api/projects/:id/procurement.csv` | The master list for Excel (UTF-8 with a BOM, formula-safe cells). |
| POST | `/api/projects/:id/procurement/items` | `{name, discipline?, category?, means? (default bought_out), spec?, quantity? (default 1), basis? (default total), unit? (default pcs), notes?, material?, inventory? (number or null), inventory_note?}`. 201 `{item}`. |
| PATCH | `/api/procurement/items/:id` | `{version, name?, discipline?, category?, means?, spec?, quantity?, basis?, unit?, notes?, material?, inventory?, inventory_note?, sort_order?}`. A stale `version` answers 409 with `current`. |
| POST | `/api/procurement/items/:id/stock` | `{in_stock}`: stamps or clears `in_stock_at` / `in_stock_by` and adds to the log. Repeating the same state changes nothing. |
| DELETE | `/api/procurement/items/:id` | Takes it off the list (kept for the log). |
| PUT | `/api/projects/:id/procurement/build` | `{version, arrays, per_array, spares}` (whole numbers ≥ 0): what the project builds. A stale `version` answers 409 with `current`; refused (400) if it would make a total smaller than manufacturing has already recorded. Every change goes into `build_log`. `{build}`. |
| POST | `/api/projects/:id/procurement/basis-from-category` | Counts each item by its category as the workbook does: "Single Antenna" per antenna, "Array" per array, "Tool" in total; others are left alone. `{changed}`. |
| POST | `/api/projects/:id/procurement/copy` | `{from_project_id}`: copies that project's items as pending, without notes, skipping name and spec already present. `{copied, skipped}`. |

The full JSON export carries `procurement: {items[], log[], builds[], build_log[]}` with project and people names.

Tickets carry `project_id` (null for jobs from before projects, or imported without one). `PATCH /api/tickets/:id` accepts `project_id` to move a job to another project; it can't be set back to null. Live updates send `{type:'projects'}` when one is added. CSV exports have a `project` column, JSON exports a `projects` list and each ticket's `project`. Import preview rows carry `project` and `project_is_new`, the preview has `new_projects` and `no_project_column`, and `create_projects=0` leaves unknown names blank.

## Tickets

| Method | Path | Body / query |
|---|---|---|
| GET | `/api/tickets` | Query: `view=board` (hides cancelled jobs and done jobs older than 7 days), `q`, `assignee=1,2,none`, `status`, `priority`, `job_type`, `project=1,2,none`, `tag`, `overdue=1`, `blocked=1`, `unassigned=1`, `due_from`/`due_to`, `created_from`/`created_to` (YYYY-MM-DD), `archived=exclude\|only\|include`, `limit`, `offset`. Returns `{tickets, total, revision}`. Default page size: 2000 for `view=board`, otherwise 100; explicit `limit` is capped at 2000. |
| POST | `/api/tickets` | `{title, project_id, description?, priority?, requester?, job_type_id?, estimate_minutes?, due_date?, due_time?, reference?, file_location?, notes?, tags?, parent_job_id?, claim?, assigned_to?}`. `project_id` is required (400 `validation` with path `project_id` otherwise). Send an `Idempotency-Key` header so retries never duplicate. Returns 201, or 200 with `replayed: true`. |
| GET | `/api/tickets/:id` | `{ticket, activity}` |
| PATCH | `/api/tickets/:id` | `{version, ...fields}`. A stale `version` returns 409 with `current`. |
| POST | `/api/tickets/:id/move` | `{status, from_status?, before_id?, after_id?, reason?}`. Handles drag and drop: status change plus position. Moving into Review or Done from another column answers 409 `checklist_incomplete` with `missing: [{id, text}]` while a blocking release checklist has unticked items (decision #38). |
| GET / PUT | `/api/tickets/:id/checklist` | GET `{checklist: {mode, items: [{id, text, checked_by, checked_at}]} \| null}`. PUT `{item_id, checked}` ticks or unticks one item (same permission as changing the job) and returns the checklist. Every ticket carries `checklist: {done, total, mode} \| null`. |
| POST | `/api/tickets/:id/claim` | Atomic. Exactly one engineer wins. |
| POST | `/api/tickets/:id/release` | Returns the job to the inbox, unassigned. |
| POST | `/api/tickets/:id/my-rank` | `{before_id?, after_id?}`. Reorders your own My Work list. |
| POST | `/api/tickets/:id/comments` | `{body}` |
| POST | `/api/tickets/:id/archive` and `/restore` | Only done or cancelled jobs can be archived. |
| GET | `/api/tickets/:id/activity` | The timeline, which is append-only. |

### Movement rules

- **Inbox:** the job is unassigned. Moving a job here releases it.
- **Claimed, In progress, Review:** the job needs an assignee. An engineer dragging an unassigned job auto-claims it. When the manager does it, they get `needs_assignee`.
- **Waiting, Blocked:** the job needs a reason. The reason is kept when switching between waiting and blocked, and cleared on leaving.
- **In progress:** sets `started_at` once.
- **Done:** sets `completed_at`. Reopening the job clears it.

### Loading complete ticket lists

Request pages with an explicit `limit` and successive `offset` values until the number loaded equals `total`. Every page must have the same opaque `revision` and `total`; restart from offset 0 if either changes. `revision` changes on database writes or connection replacement, including reorder-only operations. It is a consistency token, not a job version. The Board and Workload drill-down use this protocol and display a retryable error if a complete list cannot be loaded.

## Views

| GET | Returns |
|---|---|
| `/api/dashboard` | Counts (`unclaimed`, `in_progress`, `blocked`, `review`, `due_today`, `overdue`, `done_today`, `urgent`), today's workload, recent activity, and the unclaimed and urgent list. |
| `/api/today` | `urgent`, `overdue`, `due_today`, `active`, `blocked`, `review`, `unclaimed`, `recently_completed` |
| `/api/my-work[?user=id]` | `in_progress`, `waiting`, `review`, `up_next` (ordered by `my_rank`), `summary` |
| `/api/workload?horizon=today\|3days\|week` | Per engineer: `load_minutes`, `unestimated`, `backlog_minutes`, `in_progress`, `assigned_open`, `overdue`, `blocked`. Also `unclaimed`. |
| `/api/activity?limit&since` | The team activity feed. |
| `/api/reports?from&to` | For local dates, inclusive. Returns `completed` and `created`, `open_now` and `overdue_now`, `lead_time_hours` and `work_time_hours` (median and average), `estimate_vs_actual`, `estimate_accuracy`, `by_engineer`, `by_type` and `per_day`. `estimate_accuracy` (decision #36) is `{done, with_actual, compared, overall, by_type[], by_person[]}`, each row `{key, name, jobs, estimated_minutes, actual_minutes, within, longer, shorter, median_ratio}`: a job is `within` when its actual time falls in the estimate bucket chosen, and `median_ratio` is the middle job's actual ÷ estimate. |
| `/api/reports/weekly[?week=YYYY-MM-DD]` | The weekly summary (decision #37) for the Monday-to-Sunday week holding that date (default: this week): `{week: {from, to, is_current}, today, generated_at, numbers: {finished, created, open_now, unassigned_now, overdue_now, waiting_now, drawings_signed}, finished_by_project[], people[], overdue[] (with days_overdue in calendar days), waiting[] (waiting_for, since, days), due_next_week: {from, to, jobs[]}, unclaimed_urgent[], review: {signed[], awaiting_now, returned_now, signature_pending_now}}`. Finished, created and signed belong to the week; everything else is as of now. |
| `/api/estimates/typical` | `{typical: [{job_type_id, jobs, median_minutes, label}]}`: for each job type with at least 3 jobs finished in the last 180 days that recorded their time, the middle actual time and its estimate bucket. |
| `/api/job-types`, `/api/tags` | Reference data. |
| `/api/events` | Server-Sent Events: `{type:'ticket', id, version, by}`, `users`, `job_types`, `reload` |

## Collaboration

| Method | Path | Notes |
|---|---|---|
| GET | `/api/notifications` | Returns `{items[], unread, latest_activity_id, overdue_mine, due_today_mine}`. Items cover the last 14 days. Each item's kind is one of `urgent`, `assigned`, `review`, `waiting`, `comment`, `done`, `unassigned`, `review_submitted` (the manager, for every submission; a reviewer, once per drawing handed to them, with the drawing number in `detail`), `review_passed`, `review_returned`, `review_comment` or `signature` (the one reminder to the reviewer who passed a drawing, when its print is handed over; `detail` holds the reminder sentence). |
| POST | `/api/notifications/seen` | `{up_to}` marks everything up to that activity id as seen. It never moves backwards. |
| GET | `/api/presence` | Returns `{online: [{user_id, viewing: [ticket ids]}]}` |
| POST | `/api/presence` | `{job_id \| null, tab}` is the heartbeat while a job panel is open, sent every 30 seconds. It expires after 90 seconds. |
| GET | `/api/activity?limit&before&user` | The team feed, newest first. Page backwards with `before=<id>`. |

`/api/events` also emits `{type:'presence'}`, and its `hello` event carries the server `version`.

## Drawing review

Roles: engineers upload and submit, mark handovers and respond to comments; the manager and reviewers (`role: "reviewer"`) pass or return drawings, never their own submission. Engineers and reviewers can set the reference-page bookmark and record signatures.

**Reviewers see only the drawings handed to them** (decision #29). Every route outside this section answers a reviewer with 403, except sign-in, `/api/users`, `/api/meta`, `/api/job-types`, notifications and the live-update stream (which carries only events for jobs with a drawing handed to them). Within this section a reviewer gets 404 for a job with nothing handed to them and for any drawing or PDF not theirs; the queue and workspace list only their drawings, and the workspace's `ticket` carries only the job number, title and status (other fields are blank), with `sync.folder` blank. The manager is unaffected.

| Method | Path | Body / notes |
|---|---|---|
| POST | `/api/review/uploads?kind=drawing\|reference&name=<file name>` | Body: the PDF bytes (`application/octet-stream` or `application/pdf`). Engineers only. Streamed to disk and hashed (SHA-256) before anything else. `kind=drawing` must be one page. Returns 201 `{file: {sha256, filename, size, pages}}`. Default limit 200 MiB (`reviewUploadMaxMB`). |
| GET | `/api/review-files/:sha256` | The stored PDF, byte for byte. 410 for an intermediate removed after board review. Cached as immutable (the address is the content hash). |
| GET | `/api/reviews?tab=awaiting\|returned\|signature\|done\|all&q=` | The queue: `{rows: ReviewQueueRow[], counts}`. |
| GET | `/api/tickets/:id/review` | The workspace: `{ticket, submissions, references[], drawings[] (with attempts[] and comments[]), events[], sync, signatures_pending}`. |
| GET | `/api/tickets/:id/review/log` | The job's revision log as Markdown. |
| POST | `/api/tickets/:id/review/submissions` | `{references?: [{sha256, filename}], drawings: [{sha256, filename, identifier?, revision?, kind: "revision"\|"new", notes, ref_sha256?, ref_page?, reviewer_ids?}]}`. `revision` (1–20 letters, digits, dots or dashes; stored in capitals; `null` or empty for none) is kept by a resubmission that leaves it out. A drawing whose number matches an existing one becomes its next attempt. `reviewer_ids` (active reviewers or the manager) is required for a drawing new to the job; a resubmission keeps its reviewers when it is left out. Moves the job to Review. Returns 201 with the workspace. |
| POST | `/api/tickets/:id/review/references` | `{sha256, filename}`: attach another signed scan (it becomes protected). |
| POST | `/api/tickets/:id/review/sync` | Retry the project-folder copies now. |
| PUT | `/api/review/drawings/:id/reference-page` | `{reference_id, page}`, or both `null` to clear. |
| POST | `/api/review/drawings/:id/decision` | `{attempt_id, outcome: "passed"\|"returned", note?}`. Only the current, undecided attempt. Returning needs a note or an open comment. |
| POST | `/api/review/drawings/:id/handover` | Passed → handed over. Creates the reviewer's reminder once; a repeat is 409. |
| POST | `/api/review/drawings/:id/signed` | Handed over → signed. The last signature moves the job to Done. |
| POST | `/api/review/drawings/:id/withdraw` | `{body?}`: awaiting or returned drawings only; it no longer counts towards the job. |
| PATCH | `/api/review/drawings/:id` | `{identifier?, revision?}` (at least one): correct the drawing number or its revision (`null` clears it). Engineers only; 409 once signed. |
| PUT | `/api/review/drawings/:id/reviewers` | `{reviewer_ids: number[]}` (at least one): engineers change who a drawing is handed to. Not for signed or withdrawn drawings. Each drawing in the workspace lists its `reviewers`. |
| POST | `/api/review/drawings/:id/comments` | `{body, attempt_id?}` |
| POST | `/api/review/comments/:id/respond` | `{body}`: the engineer's correction response. |
| POST | `/api/review/comments/:id/resolve` | A reviewer, the manager, or the comment's author. |

### Drawing register (decision #35)

Board-wide reads: reviewers get 403.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/drawings?q=&project=&filter=all\|signed\|in_review\|never_signed` | `{drawings: [{identifier, latest_signed, in_review, projects, records, signed_count, last_change}], total}`, newest change first. One entry per drawing number (case-insensitive) across jobs; withdrawn drawings are left out. `latest_signed` and `in_review` are records: `{drawing_id, identifier, revision, kind, state, state_label, ticket_id, job_number, title, job_status, archived, project_id, project, created_at, updated_at, attempts, passed_by, passed_at, handover_at, signed_by, signed_at, file: {filename, sha256, notes, available} \| null}`. `q` matches the number, job numbers and titles, projects, revisions and revision notes. |
| GET | `/api/drawings/history?identifier=` | `{identifier, records[]}`: every record of that drawing number, withdrawn ones included, newest first. |

Every mutating review route returns the updated workspace. After it commits, the board removes intermediate PDFs (after a pass) and updates the project folder in the background; `sync.state` is `ok`, `pending`, `failed` (with `detail`) or `no_folder`.

## Role capabilities

What each role may do with jobs is a setting (decision #31): `{engineer, manager, reviewer}` each with `create`, `claim` and `edit`. `POST /api/tickets` and `POST /api/projects` need `create`; claiming, being assigned, releasing your own job and auto-claiming on a move need `claim`; changing a job (PATCH, move, archive, restore, release) needs `edit`, or `claim` when the job is assigned to you. A refusal is 403 with a message naming Admin → Roles. A reviewer whose role has any capability also passes the board-wide routes below (they see the board); their review visibility is unchanged. Comments need only board access.

## Tools

| Method | Path | Notes |
|---|---|---|
| GET | `/api/tools/pdf/status` | `{word_to_pdf: 'available' \| 'not_windows' \| 'no_word'}`: whether the host PC can convert Word documents. |
| POST | `/api/tools/word-to-pdf?name=<file.docx>` | Body: the document (`application/octet-stream`, up to `reviewUploadMaxMB`). Answers the PDF (`application/pdf`, `Content-Disposition: attachment`) or 400 `not_word` (not .doc/.docx), 501 `word_unavailable`, 500/504 `word_failed`. Conversions run one at a time. Stamp, negative and combine-by-size run in the browser and have no API. |
| GET | `/api/tools/sheet` | `{materials, sizes, settings}` for the sheet calculator: materials `{id, name, sort_order, active}`, sizes `{id, material_id, length, width, active}`, settings `{kerf, margin, rotate}` (the workbook's input defaults). Anyone with board access. The calculation runs in the browser (`shared/src/sheets.ts`, the workbook formula for formula). |

## Admin (unlock with the PIN first)

| Method | Path |
|---|---|
| GET | `/api/admin/status` |
| POST | `/api/admin/unlock` `{pin}` and `/api/admin/lock`. Unlocks for 12 hours. |
| POST | `/api/admin/pin` `{new_pin}` |
| GET/POST | `/api/admin/users`; PATCH `/api/admin/users/:id` `{name?, initials?, color?, role?, is_admin?, active?}`. `role` is `engineer`, `manager` or `reviewer`. |
| DELETE | `/api/admin/users/:id/password`: reset a forgotten password. The person is signed out everywhere and creates a new one at their next sign-in (409 if they have none). |
| GET/PUT | `/api/admin/permissions` `{engineer: {create, claim, edit}, manager: {…}, reviewer: {…}}`. PUT answers 409 when it would take `claim` from a role whose members hold open jobs. |
| POST/PATCH | `/api/admin/materials`, `/api/admin/materials/:id` `{name?, sort_order?, active?}` |
| POST/PATCH/DELETE | `/api/admin/sheet-sizes`, `/api/admin/sheet-sizes/:id` `{material_id, length, width}` |
| PUT | `/api/admin/tools/sheet-settings` `{kerf (mm), margin (mm), rotate}` |
| POST | `/api/admin/job-types`; PATCH `/api/admin/job-types/:id` `{name?, sort_order?, active?, checklist_mode?: "block"\|"warn"}`. Job types carry `checklist_mode` and `checklist: [{id, text, sort_order, active}]` (decision #38). |
| POST | `/api/admin/job-types/:id/checklist` `{text, sort_order?}`; PATCH `/api/admin/checklist-items/:id` `{text?, sort_order?, active?}`. Items are retired, never deleted. |
| POST/DELETE | `/api/admin/demo`: load or clear the demo jobs |
| GET | `/api/admin/info`: database size and counts, backup folder, list of backups |
| GET | `/api/admin/health`: `{level, checks: [{id, level, title, detail}], host, database, review_files, backups, disks}`. `level` is `ok`, `warn` or `bad`, the worst of the checks; check ids are `backups`, `backup_disk`, `disk_space`, `database`, `admin_pin`. `disks.same_disk` is null when it can't be told. |
| POST | `/api/admin/backups`: back up now. GET `/api/admin/backups/:name` downloads one. |
| POST | `/api/admin/restore` `{name}`, or `/api/admin/restore/upload` with an `application/octet-stream` body containing the `.db` file |
| POST | `/api/admin/import/preview` and `/api/admin/import/commit`. The body is CSV text (`text/csv`). Query: `filename`, `date_order=DMY\|MDY`, `create_job_types=0\|1`, `skip_invalid=1`, `allow_duplicate=1` |
| POST | `/api/admin/archive-old` `{days}` |
| GET / PATCH / DELETE | `/api/admin/tags[/:id]`. A rename to an existing name merges the two tags. Only unused tags can be deleted. |

## Export (any signed-in user)

| GET | |
|---|---|
| `/api/export/tickets.csv` | Accepts the same filters as `/api/tickets`. UTF-8 with a BOM, CRLF line endings, and cells that look like formulas are escaped. |
| `/api/export/tickets.json` | Every job with its history, plus the team and job types. Add `?activity=0` for jobs only. |
| `/api/import/template.csv` | A starter sheet for importing. |

### Restore upload handling

`POST /api/admin/restore/upload` requires an active name session and an unexpired admin unlock before any body is read or `100 Continue` is sent. Only `application/octet-stream` is accepted. Both advertised Content-Length and received bytes are checked against the configured limit. The file streams with backpressure to a unique private directory beside the database; rejected, interrupted and completed uploads are cleaned up. Authorization is checked again before activating the restored database.

Restore validates the source schema and references, migrates and initializes a staged candidate, then activates it while keeping the original database available for rollback. Activation failures reopen the original database; a pre-restore safety backup remains available. If disk or connection failure also prevents rollback, the original recovery files are retained and their location is logged.

### Manufacturing tracking (decision #41)

- `GET /api/manufacturing`: cross-project inventory items, stage-label configuration, tracked quantities, last/original promised dates and escalation status.
- `GET /api/manufacturing/items/:id`: the item's immutable manufacturing and vendor commitment history.
- `PUT /api/manufacturing/items/:id`: `{version, stage, in_process, received, accepted, rejected, escalation, detail}`; stale version returns 409, quantities are checked against the procurement item's requested quantity.
- `POST /api/manufacturing/items/:id/commitments`: `{promised_date, detail}`; append-only original and latest vendor dates.
- `PUT /api/admin/manufacturing/labels`: `{means,stage,label}`; administrator-only configurable stage label.

All item operations use the existing board permissions; reviewers cannot view manufacturing records.

### v2.0 Purchase coordination

Purchase users are restricted server-side to Purchase queues, supplier directory, follow-up history/actions, and manufacturing progress/commitments. They cannot read engineering jobs, PDFs, project internals, or the administration area.

| Method | Endpoint | Authorization |
|---|---|---|
| GET | `/api/purchase/queue` | Purchase, Engineer, Manager |
| GET | `/api/purchase/vendors` | Purchase, Engineer, Manager |
| POST | `/api/purchase/vendors` | Purchase, Manager |
| PUT | `/api/purchase/vendors/:id` | Purchase, Manager |
| GET | `/api/purchase/items/:id` | Purchase, Engineer, Manager |
| PUT | `/api/purchase/items/:id` | Purchase, Manager; requires version, vendor, owner, order status, PO ref and note |

Purchase users may also see and update follow-up and manufacturing records. All modifications to purchase orders are audited; a purchase status never marks a part as physically received or accepted.
