# Admin guide

For whoever looks after the board. Installing and updating are in [Install, run and update](INSTALL.md).

Open **your name (top right) → Admin** and enter the admin PIN. The Admin area stays unlocked in that browser for 12 hours, or until you click **Lock admin**. The PIN starts as `1234`: change it on day one.

## Team

**Admin → Team** lists everyone who can pick their name.

- **Add a person** with a name, initials and badge colour, as an engineer or a manager. Engineers claim and do jobs; managers create, edit, assign and comment but can't claim.
- **Admin menu** (the tick box) shows the Admin entry to people who look after the board. It grants nothing by itself: the PIN does.
- **Active**: untick it for someone who leaves. Their name disappears from the pickers but stays on every job and in the history. People can't be deleted, so history never loses its author. Their open jobs keep them as owner until you reassign them; the Today and Workload pages make those easy to spot.

## Job types and tags

- **Job types** (CAD Modification, Drawing, FEA…) can be added, renamed and reordered (the order here is the order in every menu). **Retire** hides one from new jobs but keeps it on old ones; **Bring back** undoes that.
- **Tags** are created by people as they type them. Under **Admin → Tags** you can rename a tag; renaming it to an existing name merges the two. Only unused tags can be deleted.

## Import jobs from Excel

**Admin → Import from Excel** brings in an existing job list.

1. In Excel, **File → Save As → CSV UTF-8 (Comma delimited)**. The first row must be column names. Only a title column is required; the board recognises common names such as *Job*, *Task*, *Assigned To*, *Due Date*, *Est*, *Drawing No* and *Status*. **Download a template** shows every column it understands.
2. Choose the file and check the preview. **Nothing is created yet.** Each row shows where it will go, and any problems are explained: an unknown person, a date it couldn't read, and so on. Rows with errors are skipped; rows with warnings go in with the change described.
3. Pick how dates like `02/10/2026` should be read (day first is the default).
4. **Import.** A backup is taken first, and the whole file goes in at once or not at all. Importing the same file twice is caught and needs a deliberate tick.

## Export

- **Admin → Export → All jobs as CSV** opens in Excel: one row per job, archived jobs included.
- **Everything as JSON** is every job with its full history, plus the team and job types. Use it for safekeeping or for moving to another system.
- Anyone can export what a search shows, from the Search page.

## Backups

The board backs itself up. Each backup is a complete copy of the database, checked after it is made, saved as `board-YYYY-MM-DD_HHMMSS-<why>.db` in the backup folder.

| Backup | When |
|---|---|
| **Daily** | Once a day, the first hour the board is running that day (it skips an empty board). |
| **Before an import** | Every CSV import. |
| **Before a restore** | Every restore, so a restore can itself be undone. |
| **Before an upgrade** | When a new version is about to change the database. |
| **Made by hand** | **Admin → Backups and restore → Back up now.** |

Backups older than 30 days are deleted, but the newest 7 are always kept, so a long holiday never leaves you with nothing.

**Keep a copy somewhere else.** Backups in `data\backups` die with the PC. Either set `backupDir` in `config.json` to a network share or a OneDrive folder (see [Settings](#settings)), or now and then copy the newest backup somewhere safe. **Download** next to each backup saves it through the browser, from any PC.

**By hand, without the board running:** close the board, copy `data\board.db` (and `board.db-wal` if it exists), start the board again.

## Restore

**From the list:** **Admin → Backups and restore**, then **Restore…** next to a backup. The board goes back to exactly how it was when that backup was taken. A backup of the current data is taken first. Everyone's screens refresh; nobody is signed out, and the current admin PIN stays.

**From a file:** **Restore from a file…** and choose a `.db` backup, for example one kept on a network share. The file is checked first: a damaged file, something that isn't a board backup, or a backup from a newer version of the board is refused with a message, and nothing changes.

Uploads are limited to **64 MiB** by default. Set `restoreUploadMaxMB` in `config.json` (1–1024 MiB), or `EB_RESTORE_UPLOAD_MAX_MB`, then restart to change the limit. Larger backups already in the server's backup list can still be restored without a browser upload.

The board prepares and upgrades a separate candidate before replacing live data. If activation fails, it reopens the original database. The pre-restore safety backup remains available. A disk failure that prevents recovery is reported in the server window with the retained recovery-file location.

**When the board won't start at all:** close it, move `data\board.db` (and any `board.db-wal` and `board.db-shm`) somewhere aside, copy the backup you want to `data\board.db`, and start the board.

## Archive

Done jobs already leave the board after 7 days. **Admin → Archive** also hides jobs finished more than *N* days ago (90 by default) from lists and open-work reports. Archived jobs are never deleted: Search finds them with "Include archived jobs", and **Restore** in a job's panel brings one back.

## Admin PIN

**Admin → Admin PIN**: at least 4 characters, no spaces. Only people who should be able to change the team or restore old data need it. If it's forgotten, see [Troubleshooting](TROUBLESHOOTING.md#forgotten-admin-pin).

## Demo data

**Admin → Demo data** adds twelve example jobs across every column, marked as demo, for trying the board out or showing it to someone. **Remove demo jobs** deletes exactly those and nothing else.

## Settings

Settings live in `config.json` in the board folder (next to `start.bat`). It doesn't exist at first: copy `config.example.json` to `config.json`, edit it in Notepad, and restart the board. The board's window shows which settings file it read, and explains any mistake in it before starting.

| Setting | Default | What it does |
|---|---|---|
| `port` | `8080` | The port in the address. If you change it, IT must open the new one. |
| `host` | `"0.0.0.0"` | `0.0.0.0` lets the team connect. `127.0.0.1` allows only this PC. |
| `dataDir` | `"data"` | Folder for `board.db`. Relative paths start from the board folder. |
| `backupDir` | `dataDir` + `/backups` | Where backups go. A network share works: `"//fileserver/engineering/board-backups"`. |
| `backupKeepDays` | `30` | Backups older than this are deleted (the newest 7 are always kept). |
| `restoreUploadMaxMB` | `64` | Maximum browser backup upload, in MiB (1–1024). Also configurable with `EB_RESTORE_UPLOAD_MAX_MB`. |
| `timezone` | `"Asia/Kolkata"` | Decides "today" and when jobs become overdue. |
| `hoursPerDay` | `8` | The reference line on the Workload page. |
| `workingDays` | `[1,2,3,4,5,6]` | Monday to Saturday. `0` is Sunday. Used by the workload horizons. |

Write Windows paths with forward slashes (`"D:/Board/backups"`) or doubled backslashes (`"D:\\Board\\backups"`). A misspelt setting is reported in the board's window rather than silently ignored.

On Linux and in Docker the same settings can be given as environment variables, which win over `config.json`: `EB_PORT`, `EB_HOST`, `EB_DATA_DIR`, `EB_BACKUP_DIR`, `EB_BACKUP_KEEP_DAYS`, `EB_TIMEZONE`.

## Checking on the board

- **Admin → About this board** shows the version, database size, backup folder, time zone and Node.js version.
- `http://<host>:8080/api/health` answers `{"ok":true,…}` while the board is running: handy for a monitoring tool.
- The board's window prints a line for each daily backup and any error. Errors never show people's data.
