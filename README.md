# Engineering Board

### The workboard for the mechanical design team

*Catalogue edition, version 1.0.2*

One shared board for every design job: who is on it, what it is waiting for, when it is due and how it ended. It runs on a single PC on the office network. Everyone else opens it in a web browser.

| | |
|---|---|
| **Runs on** | One host PC (Windows, or Linux), no admin rights needed |
| **Used from** | Any browser on the office network, including phones and tablets |
| **Needs** | `node.exe` 22.16 or newer. No internet, no database server, no npm |
| **Stores** | One SQLite file, `data\board.db`, plus daily backups |
| **Team size** | Built for a handful of people working at the same moment |
| **Cost to run** | Nothing to subscribe to, nothing to renew |

## Index

| Section | What you will find |
|---|---|
| [A. The pages](#a-the-pages) | Seven views, each with its shortcut key |
| [B. The job record](#b-the-job-record) | Every field a job carries, and how a job moves |
| [C. Working together](#c-working-together) | Claiming, live updates, edit merging, notifications |
| [D. Finding things](#d-finding-things) | Search, filters, export |
| [E. Administration](#e-administration) | Team, import, backups, restore, archive |
| [F. Appearance](#f-appearance) | Three themes, keyboard, phone and tablet |
| [G. Editions and installation](#g-editions-and-installation) | Windows, Linux, Docker |
| [H. Specifications](#h-specifications) | Settings, limits, checks |
| [J. Documentation](#j-documentation) | Guides, each with its reader |
| [K. Release history](#k-release-history) | What changed in each version |
| [L. Working on the code](#l-working-on-the-code) | For the people and agents who maintain it |

---

## A. The pages

Every page has a one-key shortcut. Press <kbd>?</kbd> anywhere for the full list.

| Item | Page | Key | What it shows | Use it when |
|---|---|---|---|---|
| **A1** | **Board** | <kbd>B</kbd> | Six columns: Inbox, Claimed, In progress, Waiting / blocked, Review, Done. Cards show the job number, title, owner, priority, due date and estimate. | You want to see everything at once and move work along. |
| **A2** | **Today** | <kbd>T</kbd> | Urgent, overdue, due today, unclaimed, being worked on, waiting, ready for review, finished since yesterday. | You open the board first thing in the morning. |
| **A3** | **My work** | <kbd>M</kbd> | One engineer's open jobs, in that engineer's own order. Any engineer's list can be viewed. | You are deciding what to do next. |
| **A4** | **Dashboard** | <kbd>D</kbd> | Six counts (unclaimed, in progress, waiting or blocked, due today, overdue, done today) and recent team activity. | You want the state of the team in ten seconds. |
| **A5** | **Workload** | <kbd>W</kbd> | Estimated hours per engineer for today, the next 3 days or this week, against an 8-hour reference day. Jobs with no estimate are counted, not guessed. | You are planning who can take more. |
| **A6** | **Reports** | <kbd>R</kbd> | Jobs completed per day, per engineer and per job type, plus how long jobs take. This and last week, this and last month, last 30 days. | You need numbers for a review meeting. |
| **A7** | **Team activity** | name menu | Every change to every job, newest first. History cannot be edited or deleted. | You want to know who did what, and when. |

## B. The job record

### B1. Fields

Only the title is required. Everything else can be added as the job develops.

| Field | Notes |
|---|---|
| **Job number** | Assigned automatically, never reused. |
| **Title** | Up to 200 characters. |
| **Description** and **notes** | Free text. Edits by two people are merged, see C3. |
| **Priority** | Urgent, high, normal or low. An urgent job notifies everyone. |
| **Estimate** | Eight buckets from under 15 minutes to over 2 days. |
| **Due date** | Optional. A date alone becomes overdue after local midnight; a time can be added. |
| **Owner** | One engineer, or nobody yet. |
| **Requester** | Who asked for the work. |
| **Job type** | Sixteen to start with: CAD Modification, New CAD Design, Drawing, Drawing Revision, STEP/IGES Cleanup, Geometry Repair, FEA, CFD, Design Calculation, Engineering Analysis, Manufacturing Support, BOM, Documentation, Prototype Support, Design Review, General. Admins can add and retire types. |
| **Tags** | Typed freely while editing a job. |
| **Reference** | A drawing number, purchase order, or anything people will search for. |
| **File location** | A folder or file path, with a **Copy path** button for pasting into File Explorer. |
| **Waiting for** | Required when a job moves to Waiting or Blocked. |
| **Comments** | Conversation on the job, signed with the author's name. |
| **History** | Every change: who, what, when. Append-only. |

### B2. How a job moves

```
 Inbox  →  Claimed  →  In progress  →  Review  →  Done
                            ↓
                  Waiting / blocked  (says what it is waiting for)
```

Drag a card, press <kbd>Shift</kbd>+<kbd>←</kbd> / <kbd>→</kbd>, or use the right-click menu. A dropped card can be undone from the message that appears. Done jobs leave the board after 7 days and stay searchable for ever. Jobs are never deleted: finished ones can be **archived**, and **restored** from their panel.

### B3. Who may do what

| | Create and edit | Comment | Claim and work | Assign to others |
|---|:---:|:---:|:---:|:---:|
| **Engineer** | yes | yes | yes | yes |
| **Manager** | yes | yes | no | yes |

## C. Working together

| Item | Feature | How it behaves |
|---|---|---|
| **C1** | **Live updates** | A change made on one screen appears on the others within moments. If the connection drops, a red banner appears after 6 seconds, the page reconnects by itself and catches up. |
| **C2** | **Claiming** | One click or <kbd>C</kbd>. If two people claim the same job in the same instant, one gets it and the other is told who has it. |
| **C3** | **Edit merging** | Two people editing different fields of one job both keep their changes. If both change the same field, the second is asked to keep yours, keep theirs, or keep both. |
| **C4** | **Presence** | Shows who is online and who else has a job open. |
| **C5** | **Notifications** | The bell shows what needs you: a new or raised urgent job, a job assigned to or taken from you, a job ready for review, a job you own or created moving to waiting or being commented on, a job you created being finished. It also reminds you of your own overdue and due-today jobs. |
| **C6** | **Safe retries** | A double-click or a retry after a network drop creates one job, not two. |
| **C7** | **Update prompt** | After the board is upgraded, open screens offer a reload instead of running old code against a new server. |
| **C8** | **Complete lists** | Board and Workload load every matching page of jobs. If loading fails, a message offers **Try again** and the last complete list stays visible. |

## D. Finding things

| Item | Feature | Notes |
|---|---|---|
| **D1** | **Search** | <kbd>F</kbd> or <kbd>/</kbd>. Matches any part of a word in the job number, title, description, notes, file location, reference and tags: `1042`, `housing` and `\\fileserver\proj` all work. Finished and archived jobs are included. |
| **D2** | **Filters** | On the board: person, priority, job type, tag, due date, created date. Remembered across reloads. |
| **D3** | **Export to CSV** | What a search shows, ready for Excel. Opens correctly with accents and guards against formula injection. |
| **D4** | **Full export** | **Admin → Export:** every job as CSV, or everything with full history as JSON. |

## E. Administration

Behind the admin PIN, unlocked per browser for 12 hours. The PIN starts as `1234`; change it on day one.

| Item | Task | Notes |
|---|---|---|
| **E1** | **Team** | Add people, set engineer or manager, choose a badge colour, mark who sees the Admin menu, deactivate leavers. People are never deleted, so history keeps its authors. |
| **E2** | **Job types and tags** | Reorder, retire and bring back job types. Rename tags; renaming to an existing tag merges them. |
| **E3** | **Import from Excel** | Save as CSV UTF-8, choose the file, read the preview, then import. Column names are recognised automatically. Nothing is created until you confirm; rows with errors are skipped and explained; a backup is taken first; the whole file goes in or none of it; importing the same file twice is caught. |
| **E4** | **Backups** | Automatic: daily, and before every import, restore and upgrade. Kept 30 days, newest 7 always. Each is a complete, verified SQLite file in `data\backups`. Point `backupDir` at a network share or OneDrive so a dead PC does not take them with it. |
| **E5** | **Restore** | From the list, or from an uploaded `.db` file (64 MiB by default, adjustable). The file is checked and prepared first; if anything fails the original data is put back. The current data is backed up before every restore, so a restore can itself be undone. Nobody is signed out. |
| **E6** | **Archive** | Hide jobs finished more than N days ago from lists and reports. Never deletes. |
| **E7** | **Admin PIN** | Change it. If it is forgotten, put an empty file named `RESET-ADMIN-PIN` next to `start.bat` and restart. |
| **E8** | **Demo data** | Twelve example jobs across every column, removable in one click without touching real jobs. |

## F. Appearance

### F1. Themes

Choose from the **Theme** selector at the top of the board, or on the name picker before signing in. Your browser remembers the choice for that board address and applies it before the page paints.

| Theme | Look |
|---|---|
| **Light** | The original appearance, and the default. |
| **Charcoal** | Neutral dark greys with blue controls. |
| **Midnight** | Near-black with teal controls. |

Text and badge contrast is checked for each theme, including counts, forms and dialogs.

### F2. Keyboard

The whole board works without a mouse: move between cards with the arrow keys, <kbd>Enter</kbd> to open, <kbd>C</kbd> to claim, <kbd>Shift</kbd>+arrows to move a card between and within columns, <kbd>N</kbd> for a new job, <kbd>Alt</kbd>+<kbd>↑</kbd> / <kbd>↓</kbd> to reorder My work. A skip link and named controls support screen readers.

### F3. Phone and tablet

Below 1180 px the navigation wraps onto its own row so nothing is cut off. On a phone the board columns scroll sideways. Long-press a card for the same menu as right-click.

## G. Editions and installation

| Edition | For | Start with |
|---|---|---|
| **Windows** | The usual case: a design PC as host | `start.bat` |
| **Windows, starts at sign-in** | A host that should come back by itself | `autostart-on.bat` |
| **Linux** | A server or a spare machine | `sh linux/start.sh`, or the systemd unit |
| **Docker** | A Linux server with Docker | `docker compose -f linux/docker-compose.yml up -d --build` |

### Windows in five steps

1. Unzip `EngineeringBoard-<version>.zip` to a folder you own, for example `C:\Users\<you>\EngineeringBoard`.
2. Download Node.js 22 LTS as **Windows Binary (.zip), x64** from <https://nodejs.org/en/download>. Copy just `node.exe` next to `start.bat`.
3. Double-click **`start.bat`** and keep its window open. Open <http://localhost:8080>, pick your name, and change the admin PIN.
4. Ask IT to allow the port once: run `for-IT\allow-board-port.bat` as administrator, or give them [For IT](docs/FOR-IT.md). Then share the "For your team" address the window shows, such as `http://CHRISTIN-PC:8080`.
5. Optional: run `autostart-on.bat` so the board starts whenever you sign in.

Updating is closing the window, replacing the `app` folder and starting again. Your `data`, `config.json` and `node.exe` are never in the zip, so they cannot be overwritten. Details, moving to another PC, Linux and Docker: **[Install, run and update](docs/INSTALL.md)**.

## H. Specifications

### H1. Settings

Copy `config.example.json` to `config.json` next to `start.bat`, edit it, restart. Mistakes are explained in the board's window.

| Setting | Environment variable | Default |
|---|---|---|
| `port` | `EB_PORT` | `8080` |
| `host` | `EB_HOST` | `0.0.0.0` (reachable on the LAN; `127.0.0.1` is this PC only) |
| `dataDir` | `EB_DATA_DIR` | `data` |
| `backupDir` | `EB_BACKUP_DIR` | `data/backups` |
| `backupKeepDays` | `EB_BACKUP_KEEP_DAYS` | `30` |
| `restoreUploadMaxMB` | `EB_RESTORE_UPLOAD_MAX_MB` | `64` (1 to 1024) |
| `timezone` | `EB_TIMEZONE` | `Asia/Kolkata` |
| `hoursPerDay` | | `8` (Workload reference line) |
| `workingDays` | | `[1,2,3,4,5,6]` (Monday to Saturday; 0 is Sunday) |

### H2. Built to last

| | |
|---|---|
| **Dependencies at runtime** | None. Node built-ins only: `node:http`, `node:sqlite`, `node:crypto`. |
| **History** | Append-only, enforced by database triggers. Jobs cannot be deleted. |
| **Concurrency** | Version-checked edits, atomic claiming, idempotent creation. |
| **Search** | SQLite full-text with trigram matching, so any three letters match. |
| **Upgrades** | Schema version 4. A backup is taken before a new version changes the database. A board refuses to start on data written by a newer version. |
| **Network** | LAN only; no outbound traffic. Name picker plus signed cookie; admin behind a hashed PIN. |
| **Checked by** | 120 backend tests, 31 browser tests, 14 package checks, and a typecheck. |

## J. Documentation

| Guide | Written for |
|---|---|
| [User guide](docs/USER-GUIDE.md) | Everyone. Also on the board itself: press <kbd>?</kbd>, then *Open the user guide*. |
| [Admin guide](docs/ADMIN-GUIDE.md) | Whoever looks after the board: team, import, backup and restore, settings. |
| [Install, run and update](docs/INSTALL.md) | Whoever sets up or updates the host PC. |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | Anyone, when something does not work. |
| [For IT](docs/FOR-IT.md) | IT: the firewall rule and what the board does on the network. |
| [API reference](docs/API.md) | Developers: every HTTP endpoint. |
| [Decisions](DECISIONS.md) | Maintainers: the architecture and why. |

## K. Release history

| Version | What it brought |
|---|---|
| **1.0.2** | Optional Charcoal and Midnight themes beside the original Light. |
| **1.0.1** | Safer restore (prepared and checked before it replaces live data, with rollback), streamed uploads with a configurable limit, and complete Board and Workload lists with a visible retry. |
| **1.0.0** | The full plan: board, tickets, claiming, workload, search, history, collaboration, Admin, import and export, backups, polish, tests, and the Windows, Linux and Docker packages with guides. |

## L. Working on the code

This repo is shared by several AI agents and Christin. Read [`00_START_HERE.md`](00_START_HERE.md) first: branch and pull request only, never straight to `main`; one `CHANGELOG.md` entry per change; `DECISIONS.md` is binding.

```bash
npm install            # build and test tools only; the running board needs no packages
npm run build          # dist/app/server.mjs + dist/app/web/ (including the guides)
npm run package        # dist/EngineeringBoard-<version>.zip, the release
npm start              # server from source on http://localhost:8080 (serves dist/app/web)
npm run dev:web        # rebuild the web app on change
npm test               # backend tests (node:test)
npm run check:build    # packages, then checks the zip and runs its server with plain node
npm run e2e            # browser tests (Playwright + Chromium; build first)
npm run typecheck      # server and web
npm run seed:demo      # add demo jobs  (…-- --clear to remove them)
```

The web app is React 19 bundled by esbuild. Small purpose-built replacements for a router, query cache, drag and drop and dialogs live in `web/src/lib/`. The guides in `docs/` become web pages at build time and the release zip is written by a small script, both without extra packages.

```
shared/src/      constants, API types, validators (used by server and web)
web/src/         React app: views, components, lib (api, store, router, theme…)
server/src/
  app.ts         routes, auth wrappers, HTTP server
  index.ts       entry point: config, startup banner, PIN reset, clean shutdown
  config.ts      config.json and environment variables, with plain-English errors
  http/          router, bodies, cookies, static files, error mapping
  db/            connection, transactions, migrations, seed data
  domain/        tickets, rank, search, views, users, job types, auth,
                 notifications, presence, backup, import and export
server/test/     node:test suites against a real server and a real SQLite file
e2e/             browser tests and the build and package check
scripts/         build, package, lib (markdown, zip, guides), windows/, linux/
docs/            the guides, also built into the app
```
