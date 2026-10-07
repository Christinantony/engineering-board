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
  {
    id: 7,
    name: 'passwords',
    sql: /* sql */ `
-- Everyone signs in with a password. It is stored as a salted scrypt hash, like
-- the admin PIN. NULL means the person has not created one yet: existing team
-- members (and people added later) create theirs the first time they sign in.
ALTER TABLE users ADD COLUMN password_hash TEXT;
`,
  },
  {
    id: 8,
    name: 'drawing reviewers',
    sql: /* sql */ `
-- The engineer hands each drawing to one or more reviewers (decision #29).
-- A reviewer sees and decides only the drawings handed to them; the manager
-- still sees and decides every drawing.
CREATE TABLE review_drawing_reviewers (
  drawing_id  INTEGER NOT NULL REFERENCES review_drawings(id),
  user_id     INTEGER NOT NULL REFERENCES users(id),
  assigned_by INTEGER REFERENCES users(id),
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (drawing_id, user_id)
) WITHOUT ROWID;
CREATE INDEX idx_review_drawing_reviewers_user ON review_drawing_reviewers(user_id, drawing_id);

-- Drawings already in review: hand them to the reviewers who have already
-- worked on them (passed, decided or commented), so nothing in flight is lost.
-- Drawings nobody has touched yet show to the manager, and an engineer picks
-- their reviewers with "Change reviewers".
INSERT OR IGNORE INTO review_drawing_reviewers (drawing_id, user_id, assigned_by, assigned_at)
  SELECT d.id, x.user_id, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM review_drawings d
  JOIN (
    SELECT id AS drawing_id, passed_by AS user_id FROM review_drawings WHERE passed_by IS NOT NULL
    UNION SELECT drawing_id, decided_by FROM review_attempts WHERE decided_by IS NOT NULL
    UNION SELECT drawing_id, user_id FROM review_comments
  ) x ON x.drawing_id = d.id
  JOIN users u ON u.id = x.user_id AND u.role = 'reviewer';
`,
  },
  {
    id: 9,
    name: 'projects',
    sql: /* sql */ `
-- Projects are added by the team as each one is needed (none are preset), and
-- every new job belongs to one (decision #30). A separate link table keeps the
-- tickets table unchanged, so older backups still restore.
CREATE TABLE projects (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(name) BETWEEN 1 AND 100),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  is_demo    INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0,1))
);
CREATE TRIGGER projects_no_delete BEFORE DELETE ON projects
WHEN OLD.is_demo IS NOT 1
BEGIN
  SELECT RAISE(ABORT, 'projects cannot be deleted');
END;

-- One project per job.
CREATE TABLE ticket_projects (
  ticket_id  INTEGER PRIMARY KEY REFERENCES tickets(id),
  project_id INTEGER NOT NULL REFERENCES projects(id)
);
CREATE INDEX idx_ticket_projects_project ON ticket_projects(project_id);
`,
  },
  {
    id: 10,
    name: 'tools: materials and sheet sizes',
    sql: /* sql */ `
-- Reference data for the sheet calculator (decision #32), kept by the admin
-- under Admin → Tools. Materials are retired, not deleted, so old
-- calculations keep their names; sizes can be removed.
CREATE TABLE materials (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(name) BETWEEN 1 AND 60),
  density    REAL CHECK (density IS NULL OR density > 0),
  sort_order INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
);
CREATE TABLE sheet_sizes (
  id          INTEGER PRIMARY KEY,
  material_id INTEGER NOT NULL REFERENCES materials(id),
  thickness   REAL CHECK (thickness IS NULL OR thickness > 0),
  length      REAL NOT NULL CHECK (length > 0),
  width       REAL NOT NULL CHECK (width > 0),
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  UNIQUE (material_id, thickness, length, width)
);
`,
  },
];
