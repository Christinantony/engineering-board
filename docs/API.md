# API reference (v0.2)

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
| `/api/job-types`, `/api/tags` | Reference data. |
| `/api/events` | Server-Sent Events: `{type:'ticket', id, version, by}`, `users`, `job_types`, `reload` |

## Admin (unlock with the PIN first)

| Method | Path |
|---|---|
| GET | `/api/admin/status` |
| POST | `/api/admin/unlock` `{pin}` and `/api/admin/lock`. Unlocks for 12 hours. |
| POST | `/api/admin/pin` `{new_pin}` |
| GET/POST | `/api/admin/users`; PATCH `/api/admin/users/:id` `{name?, initials?, color?, role?, is_admin?, active?}` |
| POST | `/api/admin/job-types`; PATCH `/api/admin/job-types/:id` |
| POST/DELETE | `/api/admin/demo`: load or clear the demo jobs |
