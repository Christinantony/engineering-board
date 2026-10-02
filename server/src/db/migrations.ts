// Database migrations. Each runs once, in order, inside a transaction.
// NEVER edit a migration that has shipped — add a new one instead.

export interface Migration {
  id: number;
  name: string;
  sql: string;
  /**
   * Rebuilding a table that other tables reference needs foreign-key
   * enforcement off for the duration (SQLite's documented procedure). The
   * runner switches it off outside the transaction, checks every reference
   * before committing, and switches it back on.
   */
  rebuildsTables?: boolean;
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
  {
    id: 4,
    name: 'readable default colours',
    sql: /* sql */ `
-- Darken the original default badge colours so white initials meet WCAG AA.
-- Only exact old defaults change; colours people picked themselves are untouched.
UPDATE users SET color = '#047857' WHERE color = '#059669';
UPDATE users SET color = '#b45309' WHERE color = '#d97706';
UPDATE users SET color = '#be185d' WHERE color = '#db2777';
UPDATE users SET color = '#0e7490' WHERE color = '#0891b2';
UPDATE users SET color = '#4d7c0f' WHERE color = '#65a30d';
`,
  },
  {
    id: 5,
    name: 'reviewer role',
    rebuildsTables: true,
    sql: /* sql */ `
-- Reviewers pass or return drawings in board review and sign the printed
-- drawings; they don't create, claim or edit jobs. SQLite can't change a CHECK
-- constraint in place, so the users table is rebuilt with the same rows.
CREATE TABLE users_new (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL COLLATE NOCASE UNIQUE,
  initials   TEXT NOT NULL,
  color      TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'engineer' CHECK (role IN ('engineer','manager','reviewer')),
  is_admin   INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0,1)),
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL
);
INSERT INTO users_new (id, name, initials, color, role, is_admin, active, created_at)
  SELECT id, name, initials, color, role, is_admin, active, created_at FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
`,
  },
  {
    id: 6,
    name: 'drawing review',
    sql: /* sql */ `
-- Every PDF the board holds, stored once by content (SHA-256) in the
-- review-files folder next to the database. A signed scan is "protected": it
-- can never be marked removed or unprotected, so no clean-up can delete it.
CREATE TABLE review_files (
  sha256     TEXT PRIMARY KEY CHECK (length(sha256) = 64),
  size       INTEGER NOT NULL CHECK (size > 0),
  pages      INTEGER NOT NULL CHECK (pages > 0),
  protected  INTEGER NOT NULL DEFAULT 0 CHECK (protected IN (0,1)),
  created_at TEXT NOT NULL,
  removed_at TEXT
);
CREATE TRIGGER review_files_keep_protected BEFORE UPDATE ON review_files
WHEN OLD.protected = 1 AND (NEW.protected = 0 OR NEW.removed_at IS NOT NULL OR NEW.sha256 <> OLD.sha256)
BEGIN
  SELECT RAISE(ABORT, 'signed reference scans are never removed or changed');
END;
CREATE TRIGGER review_files_no_delete_protected BEFORE DELETE ON review_files
WHEN OLD.protected = 1
BEGIN
  SELECT RAISE(ABORT, 'signed reference scans are never removed or changed');
END;

-- Signed, scanned reference PDFs attached to a job (usually one merged file).
CREATE TABLE review_references (
  id          INTEGER PRIMARY KEY,
  ticket_id   INTEGER NOT NULL REFERENCES tickets(id),
  filename    TEXT NOT NULL,
  sha256      TEXT NOT NULL REFERENCES review_files(sha256),
  pages       INTEGER NOT NULL,
  attached_by INTEGER REFERENCES users(id),
  attached_at TEXT NOT NULL,
  UNIQUE (ticket_id, sha256)
);
CREATE TRIGGER review_references_immutable BEFORE UPDATE ON review_references
BEGIN
  SELECT RAISE(ABORT, 'signed reference scans are never removed or changed');
END;

-- One "Submit for board review" press: the drawings sent together.
CREATE TABLE review_submissions (
  id           INTEGER PRIMARY KEY,
  ticket_id    INTEGER NOT NULL REFERENCES tickets(id),
  number       INTEGER NOT NULL,
  submitted_by INTEGER REFERENCES users(id),
  submitted_at TEXT NOT NULL,
  UNIQUE (ticket_id, number)
);

-- A drawing under board review, identified by its file name (part number).
CREATE TABLE review_drawings (
  id                 INTEGER PRIMARY KEY,
  ticket_id          INTEGER NOT NULL REFERENCES tickets(id),
  identifier         TEXT NOT NULL COLLATE NOCASE,
  kind               TEXT NOT NULL CHECK (kind IN ('revision','new')),
  state              TEXT NOT NULL DEFAULT 'awaiting'
                     CHECK (state IN ('awaiting','returned','passed','handed_over','signed','withdrawn')),
  required           INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0,1)),
  ref_reference_id   INTEGER REFERENCES review_references(id),
  ref_page           INTEGER CHECK (ref_page IS NULL OR ref_page > 0),
  current_attempt_id INTEGER,
  passed_attempt_id  INTEGER,
  passed_by          INTEGER REFERENCES users(id),
  passed_at          TEXT,
  handover_by        INTEGER REFERENCES users(id),
  handover_at        TEXT,
  signed_by          INTEGER REFERENCES users(id),
  signed_at          TEXT,
  cleanup            TEXT NOT NULL DEFAULT 'none' CHECK (cleanup IN ('none','pending','done','failed')),
  cleanup_detail     TEXT,
  created_by         INTEGER REFERENCES users(id),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  version            INTEGER NOT NULL DEFAULT 1,
  UNIQUE (ticket_id, identifier)
);
CREATE INDEX idx_review_drawings_state ON review_drawings(state, ticket_id);

-- Each submitted single-page PDF of a drawing. The bytes are fixed by sha256.
CREATE TABLE review_attempts (
  id              INTEGER PRIMARY KEY,
  drawing_id      INTEGER NOT NULL REFERENCES review_drawings(id),
  submission_id   INTEGER NOT NULL REFERENCES review_submissions(id),
  number          INTEGER NOT NULL,
  filename        TEXT NOT NULL,
  sha256          TEXT NOT NULL REFERENCES review_files(sha256),
  notes           TEXT NOT NULL,
  submitted_by    INTEGER REFERENCES users(id),
  submitted_at    TEXT NOT NULL,
  outcome         TEXT CHECK (outcome IS NULL OR outcome IN ('returned','passed','superseded')),
  decided_by      INTEGER REFERENCES users(id),
  decided_at      TEXT,
  decision_note   TEXT,
  file_removed_at TEXT,
  UNIQUE (drawing_id, number)
);
CREATE INDEX idx_review_attempts_sha ON review_attempts(sha256);
CREATE TRIGGER review_attempts_bytes_fixed BEFORE UPDATE OF sha256, filename, notes, number, drawing_id ON review_attempts
BEGIN
  SELECT RAISE(ABORT, 'a submitted review attempt cannot be changed');
END;

CREATE TABLE review_comments (
  id          INTEGER PRIMARY KEY,
  drawing_id  INTEGER NOT NULL REFERENCES review_drawings(id),
  attempt_id  INTEGER REFERENCES review_attempts(id),
  user_id     INTEGER REFERENCES users(id),
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  response    TEXT,
  response_by INTEGER REFERENCES users(id),
  response_at TEXT,
  resolved_by INTEGER REFERENCES users(id),
  resolved_at TEXT
);
CREATE INDEX idx_review_comments_drawing ON review_comments(drawing_id);

-- Structured review history (the changelog). Append-only like activity.
CREATE TABLE review_events (
  id         INTEGER PRIMARY KEY,
  ticket_id  INTEGER NOT NULL REFERENCES tickets(id),
  drawing_id INTEGER REFERENCES review_drawings(id),
  attempt_id INTEGER REFERENCES review_attempts(id),
  user_id    INTEGER REFERENCES users(id),
  at         TEXT NOT NULL,
  kind       TEXT NOT NULL,
  detail     TEXT
);
CREATE INDEX idx_review_events_ticket ON review_events(ticket_id, id);
CREATE TRIGGER review_events_no_update BEFORE UPDATE ON review_events
BEGIN
  SELECT RAISE(ABORT, 'review history is append-only');
END;
CREATE TRIGGER review_events_no_delete BEFORE DELETE ON review_events
WHEN (SELECT is_demo FROM tickets WHERE id = OLD.ticket_id) IS NOT 1
BEGIN
  SELECT RAISE(ABORT, 'review history is append-only');
END;

-- Files the board itself wrote into project folders. The board only ever
-- replaces or deletes a file listed here whose content is still what it wrote.
CREATE TABLE project_files (
  id         INTEGER PRIMARY KEY,
  folder     TEXT NOT NULL,
  path       TEXT NOT NULL,
  ticket_id  INTEGER REFERENCES tickets(id),
  sha256     TEXT NOT NULL,
  written_at TEXT NOT NULL,
  removed_at TEXT,
  UNIQUE (folder, path)
);

-- Whether a job's project-folder copies are up to date.
CREATE TABLE review_sync (
  ticket_id  INTEGER PRIMARY KEY REFERENCES tickets(id),
  state      TEXT NOT NULL CHECK (state IN ('ok','pending','failed','no_folder')),
  detail     TEXT,
  updated_at TEXT NOT NULL
);
`,
  },
];
