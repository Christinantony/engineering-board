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
-- Reference data for the sheet calculator (decision #32): the Materials sheet
-- of the team's Sheet Requirement Calculator workbook, kept by the admin under
-- Admin → Tools. Materials are retired, not deleted, so old calculations keep
-- their names; sizes can be removed. A material may list several stock sizes.
CREATE TABLE materials (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(name) BETWEEN 1 AND 60),
  sort_order INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
);
CREATE TABLE sheet_sizes (
  id          INTEGER PRIMARY KEY,
  material_id INTEGER NOT NULL REFERENCES materials(id),
  length      REAL NOT NULL CHECK (length > 0),
  width       REAL NOT NULL CHECK (width > 0),
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  UNIQUE (material_id, length, width)
);
`,
  },
  {
    id: 11,
    name: 'drawing register: revision letters',
    sql: /* sql */ `
-- The drawing register (decision #35) lists every drawing number across jobs.
-- A drawing may carry its revision (A, B, C, 02…), entered when it is
-- submitted for board review; drawings from before 1.7.0 have none.
ALTER TABLE review_drawings ADD COLUMN revision TEXT CHECK (revision IS NULL OR length(revision) BETWEEN 1 AND 20);
CREATE INDEX idx_review_drawings_identifier ON review_drawings(identifier);
`,
  },
  {
    id: 12,
    name: 'release checklists',
    sql: /* sql */ `
-- Release checklists (decision #38): the admin lists what must be checked for
-- each job type before a job goes to Review or Done. "block" refuses the move
-- until every item is ticked; "warn" only asks.
ALTER TABLE job_types ADD COLUMN checklist_mode TEXT NOT NULL DEFAULT 'block' CHECK (checklist_mode IN ('block','warn'));
CREATE TABLE checklist_items (
  id          INTEGER PRIMARY KEY,
  job_type_id INTEGER NOT NULL REFERENCES job_types(id),
  text        TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 200),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
);
CREATE INDEX idx_checklist_items_type ON checklist_items(job_type_id, active, sort_order);
-- A tick on a job: who and when. Unticking deletes the row; the history keeps both.
CREATE TABLE ticket_checks (
  ticket_id  INTEGER NOT NULL REFERENCES tickets(id),
  item_id    INTEGER NOT NULL REFERENCES checklist_items(id),
  checked_by INTEGER REFERENCES users(id),
  checked_at TEXT NOT NULL,
  PRIMARY KEY (ticket_id, item_id)
);
`,
  },
  {
    id: 13,
    name: 'procurement tracker',
    sql: /* sql */ `
-- The procurement tracker (decision #39), per project: the master list is
-- the only place items are typed; the assembly checklist and the pending list
-- are views of it; the log records when each item came into stock.
CREATE TABLE procurement_items (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id),
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  discipline  TEXT NOT NULL DEFAULT '' CHECK (length(discipline) <= 40),
  category    TEXT NOT NULL DEFAULT '' CHECK (length(category) <= 40),
  means       TEXT NOT NULL DEFAULT 'bought_out' CHECK (means IN ('outsourced','in_house','bought_out','tools')),
  spec        TEXT NOT NULL DEFAULT '' CHECK (length(spec) <= 200),
  quantity    REAL NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit        TEXT NOT NULL DEFAULT 'pcs' CHECK (length(unit) BETWEEN 1 AND 12),
  notes       TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 500),
  sort_order  REAL NOT NULL DEFAULT 0,
  in_stock_at TEXT,
  in_stock_by INTEGER REFERENCES users(id),
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  removed_at  TEXT,
  version     INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_procurement_items_project ON procurement_items(project_id, removed_at, sort_order);
-- Append-only, like the activity history.
CREATE TABLE procurement_log (
  id         INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  item_id    INTEGER NOT NULL REFERENCES procurement_items(id),
  user_id    INTEGER REFERENCES users(id),
  at         TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('in_stock','not_in_stock','added','removed')),
  item_name  TEXT NOT NULL,
  item_spec  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_procurement_log_project ON procurement_log(project_id, id);
CREATE TRIGGER procurement_log_no_update BEFORE UPDATE ON procurement_log
BEGIN
  SELECT RAISE(ABORT, 'the procurement log is append-only');
END;
CREATE TRIGGER procurement_log_no_delete BEFORE DELETE ON procurement_log
WHEN (SELECT is_demo FROM projects WHERE id = OLD.project_id) IS NOT 1
BEGIN
  SELECT RAISE(ABORT, 'the procurement log is append-only');
END;
`,
  },
  {
    id: 14,
    name: 'procurement follow-up control',
    sql: /* sql */ `
CREATE TABLE procurement_followups (
 item_id INTEGER PRIMARY KEY REFERENCES procurement_items(id),
 owner_id INTEGER REFERENCES users(id),
 next_action TEXT NOT NULL DEFAULT '' CHECK(length(next_action) <= 300),
 next_due TEXT CHECK(next_due IS NULL OR length(next_due) = 10),
 updated_by INTEGER REFERENCES users(id),
 updated_at TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_procurement_followups_due ON procurement_followups(next_due, owner_id);
CREATE TABLE procurement_calls (
 id INTEGER PRIMARY KEY,
 item_id INTEGER NOT NULL REFERENCES procurement_items(id),
 user_id INTEGER REFERENCES users(id),
 at TEXT NOT NULL,
 outcome TEXT NOT NULL CHECK(outcome IN ('progress','delayed','ready','unreachable','other')),
 note TEXT NOT NULL CHECK(length(note) BETWEEN 1 AND 1000),
 next_due TEXT CHECK(next_due IS NULL OR length(next_due) = 10)
);
CREATE INDEX idx_procurement_calls_item ON procurement_calls(item_id, id);
CREATE TRIGGER procurement_calls_no_update BEFORE UPDATE ON procurement_calls
BEGIN SELECT RAISE(ABORT, 'follow-up history is append-only'); END;
CREATE TRIGGER procurement_calls_no_delete BEFORE DELETE ON procurement_calls
WHEN (SELECT p.is_demo FROM procurement_items i JOIN projects p ON p.id=i.project_id WHERE i.id=OLD.item_id) IS NOT 1
BEGIN SELECT RAISE(ABORT, 'follow-up history is append-only'); END;
`,
  },
  {
    id: 15,
    name: 'manufacturing progress and vendor commitments',
    sql: /* sql */ `
CREATE TABLE manufacturing_tracking (
 item_id INTEGER PRIMARY KEY REFERENCES procurement_items(id),
 stage TEXT NOT NULL DEFAULT 'planning' CHECK(stage IN ('planning','queued','fabrication','finishing','inspection','received')),
 in_process REAL NOT NULL DEFAULT 0 CHECK(in_process >= 0),
 received REAL NOT NULL DEFAULT 0 CHECK(received >= 0),
 accepted REAL NOT NULL DEFAULT 0 CHECK(accepted >= 0),
 rejected REAL NOT NULL DEFAULT 0 CHECK(rejected >= 0),
 escalation TEXT NOT NULL DEFAULT 'none' CHECK(escalation IN ('none','attention','critical')),
 updated_by INTEGER REFERENCES users(id),
 updated_at TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE manufacturing_events (
 id INTEGER PRIMARY KEY,
 item_id INTEGER NOT NULL REFERENCES procurement_items(id),
 user_id INTEGER REFERENCES users(id),
 at TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('progress','commitment')),
 detail TEXT NOT NULL,
 stage TEXT,
 in_process REAL,
 received REAL,
 accepted REAL,
 rejected REAL,
 escalation TEXT,
 promised_date TEXT
);
CREATE INDEX idx_manufacturing_events_item ON manufacturing_events(item_id,id);
CREATE TRIGGER manufacturing_events_no_update BEFORE UPDATE ON manufacturing_events
BEGIN SELECT RAISE(ABORT,'manufacturing history is append-only'); END;
CREATE TRIGGER manufacturing_events_no_delete BEFORE DELETE ON manufacturing_events
WHEN (SELECT p.is_demo FROM procurement_items i JOIN projects p ON p.id=i.project_id WHERE i.id=OLD.item_id) IS NOT 1
BEGIN SELECT RAISE(ABORT,'manufacturing history is append-only'); END;
CREATE TABLE manufacturing_stage_labels (
 means TEXT NOT NULL CHECK(means IN ('outsourced','in_house','bought_out','tools')),
 stage TEXT NOT NULL CHECK(stage IN ('planning','queued','fabrication','finishing','inspection','received')),
 label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 70),
 PRIMARY KEY(means,stage)
);
INSERT INTO manufacturing_stage_labels(means,stage,label)
WITH means_list(means) AS (VALUES ('outsourced'),('in_house'),('bought_out'),('tools')),
 stages(stage,label) AS (VALUES ('planning','Planning'),('queued','Queued / ordered'),('fabrication','Machining / fabrication'),('finishing','Surface finishing'),('inspection','Inspection'),('received','Received'))
SELECT means_list.means, stages.stage, stages.label FROM means_list CROSS JOIN stages;
`,
  },
  {
    id: 16,
    name: 'restricted purchase team and supplier coordination',
    rebuildsTables: true,
    sql: /* sql */ `
CREATE TABLE users_purchase (
 id INTEGER PRIMARY KEY,
 name TEXT NOT NULL COLLATE NOCASE UNIQUE,
 initials TEXT NOT NULL,
 color TEXT NOT NULL,
 role TEXT NOT NULL DEFAULT 'engineer' CHECK(role IN ('engineer','manager','reviewer','purchase')),
 is_admin INTEGER NOT NULL DEFAULT 0 CHECK(is_admin IN (0,1)),
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
 created_at TEXT NOT NULL,
 password_hash TEXT
);
INSERT INTO users_purchase SELECT id,name,initials,color,role,is_admin,active,created_at,password_hash FROM users;
DROP TABLE users;
ALTER TABLE users_purchase RENAME TO users;
CREATE TABLE purchase_vendors (
 id INTEGER PRIMARY KEY,
 name TEXT NOT NULL COLLATE NOCASE UNIQUE,
 contact TEXT NOT NULL DEFAULT '',
 phone TEXT NOT NULL DEFAULT '',
 email TEXT NOT NULL DEFAULT '',
 process_notes TEXT NOT NULL DEFAULT '',
 active INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE TABLE purchase_orders (
 item_id INTEGER PRIMARY KEY REFERENCES procurement_items(id),
 vendor_id INTEGER REFERENCES purchase_vendors(id),
 po_ref TEXT NOT NULL DEFAULT '',
 order_status TEXT NOT NULL DEFAULT 'requested' CHECK(order_status IN ('requested','quoted','ordered','part_received','closed')),
 purchase_owner_id INTEGER REFERENCES users(id),
 updated_by INTEGER REFERENCES users(id),
 updated_at TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_purchase_orders_owner ON purchase_orders(purchase_owner_id,order_status);
CREATE TABLE purchase_events (
 id INTEGER PRIMARY KEY,
 item_id INTEGER NOT NULL REFERENCES procurement_items(id),
 at TEXT NOT NULL,
 user_id INTEGER REFERENCES users(id),
 event TEXT NOT NULL CHECK(event IN ('order','note')),
 detail TEXT NOT NULL,
 order_status TEXT,
 vendor_id INTEGER,
 po_ref TEXT,
 purchase_owner_id INTEGER
);
CREATE INDEX idx_purchase_events_item ON purchase_events(item_id,id);
CREATE TRIGGER purchase_events_no_update BEFORE UPDATE ON purchase_events
BEGIN SELECT RAISE(ABORT,'purchase history is append-only'); END;
CREATE TRIGGER purchase_events_no_delete BEFORE DELETE ON purchase_events
WHEN (SELECT p.is_demo FROM procurement_items i JOIN projects p ON p.id=i.project_id WHERE i.id=OLD.item_id) IS NOT 1
BEGIN SELECT RAISE(ABORT,'purchase history is append-only'); END;
`,
  },
  {
    id: 17,
    name: 'procurement build quantities',
    sql: /* sql */ `
-- What a project builds (decision #45), as the inventory workbook's quantity
-- drivers: number of arrays, antennas per array and extra antennas (spares,
-- built as antennas but in no array). An item's quantity is then per antenna,
-- per array or the project's total, and its total quantity follows.
CREATE TABLE procurement_builds (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id),
  arrays     INTEGER NOT NULL DEFAULT 0 CHECK (arrays BETWEEN 0 AND 100000),
  per_array  INTEGER NOT NULL DEFAULT 0 CHECK (per_array BETWEEN 0 AND 10000),
  spares     INTEGER NOT NULL DEFAULT 0 CHECK (spares BETWEEN 0 AND 100000),
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1
);
-- Every change to the build, append-only like the procurement log.
CREATE TABLE procurement_build_log (
  id         INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  user_id    INTEGER REFERENCES users(id),
  at         TEXT NOT NULL,
  arrays     INTEGER NOT NULL,
  per_array  INTEGER NOT NULL,
  spares     INTEGER NOT NULL
);
CREATE INDEX idx_procurement_build_log_project ON procurement_build_log(project_id, id);
CREATE TRIGGER procurement_build_log_no_update BEFORE UPDATE ON procurement_build_log
BEGIN
  SELECT RAISE(ABORT, 'the build history is append-only');
END;
CREATE TRIGGER procurement_build_log_no_delete BEFORE DELETE ON procurement_build_log
WHEN (SELECT is_demo FROM projects WHERE id = OLD.project_id) IS NOT 1
BEGIN
  SELECT RAISE(ABORT, 'the build history is append-only');
END;
-- Items already on a list keep their quantity as the total needed.
ALTER TABLE procurement_items ADD COLUMN basis TEXT NOT NULL DEFAULT 'total' CHECK (basis IN ('total','antenna','array'));
-- The workbook's Material column, and its Inventory: a count (NIL is 0), or a
-- note such as "18 x 24 sheet - 1" when it isn't a plain count, which leaves
-- the quantity still to procure to be checked by hand.
ALTER TABLE procurement_items ADD COLUMN material TEXT NOT NULL DEFAULT '' CHECK (length(material) <= 80);
ALTER TABLE procurement_items ADD COLUMN inventory REAL CHECK (inventory IS NULL OR inventory >= 0);
ALTER TABLE procurement_items ADD COLUMN inventory_note TEXT NOT NULL DEFAULT '' CHECK (length(inventory_note) <= 80);
`,
  },
];
