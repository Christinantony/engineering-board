# API reference (v0.8)

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
| 409 `conflict` | Someone else got there first. `current` holds the fresh ticket. |
| 409 `needs_assignee` | The manager moved an unassigned job to a working column. |
| 413 `too_large` | The body is over the limit: 20 MB for JSON and CSV, 1 GB for a restore upload. |
| 415 | A binary body was sent to anything other than the restore upload. |
| 503 `busy` | The database is busy. Retry. |

## Session ("who are you?")

| Method | Path | Notes |
|---|---|---|
| GET | `/api/users` | Active users, for the picker. Add `?all=1` to include inactive users. |
| GET/POST/DELETE | `/api/session` | POST `{user_id}` sets a signed cookie (1 year). |
| GET | `/api/meta` | Version, time zone, today's date, statuses, estimate buckets, and whether the default PIN is still set. |
| GET | `/api/health` | Liveness check. |

## Tickets

| Method | Path | Body / query |
|---|---|---|
| GET | `/api/tickets` | Query: `view=board` (hides cancelled jobs and done jobs older than 7 days), `q`, `assignee=1,2,none`, `status`, `priority`, `job_type`, `tag`, `overdue=1`, `blocked=1`, `unassigned=1`, `due_from`/`due_to`, `created_from`/`created_to` (YYYY-MM-DD), `archived=exclude\|only\|include`, `limit`, `offset`. Returns `{tickets, total}`. |
| POST | `/api/tickets` | `{title, description?, priority?, requester?, job_type_id?, estimate_minutes?, due_date?, due_time?, reference?, file_location?, notes?, tags?, parent_job_id?, claim?, assigned_to?}`. Send an `Idempotency-Key` header so retries never duplicate. Returns 201, or 200 with `replayed: true`. |
| GET | `/api/tickets/:id` | `{ticket, activity}` |
| PATCH | `/api/tickets/:id` | `{version, ...fields}`. A stale `version` returns 409 with `current`. |
| POST | `/api/tickets/:id/move` | `{status, from_status?, before_id?, after_id?, reason?}`. Handles drag and drop: status change plus position. |
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

## Views

| GET | Returns |
|---|---|
| `/api/dashboard` | Counts (`unclaimed`, `in_progress`, `blocked`, `review`, `due_today`, `overdue`, `done_today`, `urgent`), today's workload, recent activity, and the unclaimed and urgent list. |
| `/api/today` | `urgent`, `overdue`, `due_today`, `active`, `blocked`, `review`, `unclaimed`, `recently_completed` |
| `/api/my-work[?user=id]` | `in_progress`, `waiting`, `review`, `up_next` (ordered by `my_rank`), `summary` |
| `/api/workload?horizon=today\|3days\|week` | Per engineer: `load_minutes`, `unestimated`, `backlog_minutes`, `in_progress`, `assigned_open`, `overdue`, `blocked`. Also `unclaimed`. |
| `/api/activity?limit&since` | The team activity feed. |
| `/api/reports?from&to` | For local dates, inclusive. Returns `completed` and `created`, `open_now` and `overdue_now`, `lead_time_hours` and `work_time_hours` (median and average), `estimate_vs_actual`, `by_engineer`, `by_type` and `per_day`. |
| `/api/job-types`, `/api/tags` | Reference data. |
| `/api/events` | Server-Sent Events: `{type:'ticket', id, version, by}`, `users`, `job_types`, `reload` |

## Collaboration

| Method | Path | Notes |
|---|---|---|
| GET | `/api/notifications` | Returns `{items[], unread, latest_activity_id, overdue_mine, due_today_mine}`. Items cover the last 14 days. Each item's kind is one of `urgent`, `assigned`, `review`, `waiting`, `comment`, `done` or `unassigned`. |
| POST | `/api/notifications/seen` | `{up_to}` marks everything up to that activity id as seen. It never moves backwards. |
| GET | `/api/presence` | Returns `{online: [{user_id, viewing: [ticket ids]}]}` |
| POST | `/api/presence` | `{job_id \| null, tab}` is the heartbeat while a job panel is open, sent every 30 seconds. It expires after 90 seconds. |
| GET | `/api/activity?limit&before&user` | The team feed, newest first. Page backwards with `before=<id>`. |

`/api/events` also emits `{type:'presence'}`, and its `hello` event carries the server `version`.

## Admin (unlock with the PIN first)

| Method | Path |
|---|---|
| GET | `/api/admin/status` |
| POST | `/api/admin/unlock` `{pin}` and `/api/admin/lock`. Unlocks for 12 hours. |
| POST | `/api/admin/pin` `{new_pin}` |
| GET/POST | `/api/admin/users`; PATCH `/api/admin/users/:id` `{name?, initials?, color?, role?, is_admin?, active?}` |
| POST | `/api/admin/job-types`; PATCH `/api/admin/job-types/:id` |
| POST/DELETE | `/api/admin/demo`: load or clear the demo jobs |
| GET | `/api/admin/info`: database size and counts, backup folder, list of backups |
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
