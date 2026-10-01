// Database migrations. Each runs once, in order, inside a transaction.
// NEVER edit a migration that has shipped — add a new one instead.

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    id: 1,
    name: 'initial schema',
    sql: /* sql */ `
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE users (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL COLLATE NOCASE UNIQUE,
  initials   TEXT NOT NULL,
  color      TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'engineer' CHECK (role IN ('engineer','manager')),
  is_admin   INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0,1)),
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL
);

CREATE TABLE job_types (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL COLLATE NOCASE UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
);

CREATE TABLE tags (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE
);

CREATE TABLE tickets (
  id               INTEGER PRIMARY KEY,
  job_number       TEXT NOT NULL UNIQUE,
  title            TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description      TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'inbox'
                   CHECK (status IN ('inbox','claimed','in_progress','waiting','blocked','review','done','cancelled')),
  priority         TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('urgent','high','normal','low')),
  assigned_to      INTEGER REFERENCES users(id),
  created_by       INTEGER REFERENCES users(id),
  requester        TEXT NOT NULL DEFAULT '',
  job_type_id      INTEGER REFERENCES job_types(id),
  estimate_minutes INTEGER CHECK (estimate_minutes IS NULL OR estimate_minutes >= 0),
  actual_minutes   INTEGER CHECK (actual_minutes IS NULL OR actual_minutes >= 0),
  due_date         TEXT,
  due_time         TEXT,
  due_at           TEXT,
  reference        TEXT NOT NULL DEFAULT '',
  file_location    TEXT NOT NULL DEFAULT '',
  notes            TEXT NOT NULL DEFAULT '',
  waiting_for      TEXT NOT NULL DEFAULT '',
  parent_job_id    INTEGER REFERENCES tickets(id),
  board_rank       REAL NOT NULL DEFAULT 0,
  my_rank          REAL NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  claimed_at       TEXT,
  started_at       TEXT,
  completed_at     TEXT,
  archived         INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  is_demo          INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0,1)),
  version          INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_tickets_status   ON tickets(archived, status, board_rank);
CREATE INDEX idx_tickets_assignee ON tickets(assigned_to, status);
CREATE INDEX idx_tickets_due      ON tickets(due_at);
CREATE INDEX idx_tickets_created  ON tickets(created_at);
CREATE INDEX idx_tickets_done     ON tickets(completed_at);

CREATE TABLE ticket_tags (
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  tag_id    INTEGER NOT NULL REFERENCES tags(id),
  PRIMARY KEY (ticket_id, tag_id)
);
CREATE INDEX idx_ticket_tags_tag ON ticket_tags(tag_id);

-- Append-only history. Rows can never be changed; they can only be removed
-- together with a demo ticket.
CREATE TABLE activity (
  id         INTEGER PRIMARY KEY,
  ticket_id  INTEGER NOT NULL REFERENCES tickets(id),
  user_id    INTEGER REFERENCES users(id),
  at         TEXT NOT NULL,
  kind       TEXT NOT NULL,
  from_value TEXT,
  to_value   TEXT,
  body       TEXT
);
CREATE INDEX idx_activity_ticket ON activity(ticket_id, id);
CREATE INDEX idx_activity_at     ON activity(at);

CREATE TRIGGER activity_no_update BEFORE UPDATE ON activity
BEGIN
  SELECT RAISE(ABORT, 'activity history is append-only');
END;

CREATE TRIGGER activity_no_delete BEFORE DELETE ON activity
WHEN (SELECT is_demo FROM tickets WHERE id = OLD.ticket_id) IS NOT 1
BEGIN
  SELECT RAISE(ABORT, 'activity history is append-only');
END;

CREATE TRIGGER tickets_no_delete BEFORE DELETE ON tickets
WHEN OLD.is_demo IS NOT 1
BEGIN
  SELECT RAISE(ABORT, 'tickets cannot be deleted; archive them instead');
END;

-- Full-text search (trigram = substring matching, case-insensitive).
CREATE VIRTUAL TABLE tickets_fts USING fts5(
  job_number, title, body,
  tokenize = 'trigram'
);

CREATE TABLE idempotency (
  key        TEXT PRIMARY KEY,
  ticket_id  INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
`,
  },
  {
    id: 2,
    name: 'per-user notification state',
    sql: /* sql */ `
CREATE TABLE user_state (
  user_id          INTEGER PRIMARY KEY REFERENCES users(id),
  seen_activity_id INTEGER NOT NULL DEFAULT 0,
  updated_at       TEXT NOT NULL
);
`,
  },
  {
    id: 3,
    name: 'import log',
    sql: /* sql */ `
CREATE TABLE imports (
  id       INTEGER PRIMARY KEY,
  hash     TEXT NOT NULL,
  filename TEXT NOT NULL DEFAULT '',
  rows     INTEGER NOT NULL,
  user_id  INTEGER REFERENCES users(id),
  at       TEXT NOT NULL
);
CREATE INDEX idx_imports_hash ON imports(hash);
`,
  },
];
