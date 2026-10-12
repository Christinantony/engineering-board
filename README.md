# Engineering Board

### The workboard for the mechanical design team

*Catalogue edition, version 2.0.0*

One shared board for every design job: who is on it, what it is waiting for, when it is due and how it ended. It runs on a single PC on the office network. Everyone else opens it in a web browser.

![The board: six columns from Inbox to Done, with the demo jobs](assets/screenshots/board.png)

*Every picture in this file is a real screenshot of version 1.7.0 running with its demo data, taken in Chromium by `scripts/screenshots.mjs`.*

| | |
|---|---|
| **Runs on** | One host PC (Windows, or Linux), no admin rights needed |
| **Used from** | Any browser on the office network, including phones and tablets |
| **Needs** | `node.exe` 22.16 or newer. No internet, no database server, no npm |
| **Stores** | One SQLite file, `data\board.db`, the drawing-review PDFs in `data\review-files`, plus daily backups |
| **Team size** | Built for a handful of people working at the same moment |
| **Cost to run** | Nothing to subscribe to, nothing to renew |

## Index

| Section | What you will find |
|---|---|
| [A. The pages](#a-the-pages) | Every page, with its shortcut key |
| [B. The job record](#b-the-job-record) | Every field a job carries, and how a job moves |
| [C. Working together](#c-working-together) | Claiming, live updates, edit merging, notifications |
| [D. Finding things](#d-finding-things) | Search, filters, export |
| [E. Administration](#e-administration) | Health, team, roles, release checklists, tools data, import, backups, restore, archive |
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
| **A1** | **Board** | <kbd>B</kbd> | Six columns: Inbox, Claimed, In progress, Waiting / blocked, Review, Done. Cards show the job number, title, owner, priority, due date, estimate and, where the job type has one, how much of the release checklist is ticked (☐ 2/4). | You want to see everything at once and move work along. |
| **A2** | **Today** | <kbd>T</kbd> | Urgent, overdue, due today, unclaimed, being worked on, waiting, ready for review, finished since yesterday. | You open the board first thing in the morning. |
| **A3** | **My work** | <kbd>M</kbd> | One engineer's open jobs, in that engineer's own order. Any engineer's list can be viewed. | You are deciding what to do next. |
| **A4** | **Dashboard** | <kbd>D</kbd> | Six counts (unclaimed, in progress, waiting or blocked, due today, overdue, done today) and recent team activity. | You want the state of the team in ten seconds. |
| **A5** | **Workload** | <kbd>W</kbd> | Estimated hours per engineer for today, the next 3 days or this week, against an 8-hour reference day. Jobs with no estimate are counted, not guessed. | You are planning who can take more. |
| **A6** | **Reports** | <kbd>R</kbd> | Jobs completed per day, per engineer and per job type, how long jobs take, and **estimates against actual time**: how many finished jobs took about what was estimated, longer or shorter, by job type and by person. This and last week, this and last month, last 30 days. | You need numbers for a review meeting, or want better estimates. |
| **A7** | **Team activity** | name menu | Every change to every job, newest first. History cannot be edited or deleted. | You want to know who did what, and when. |
| **A8** | **Drawing review** | <kbd>V</kbd> | Jobs with drawings in board review; a workspace per job with the signed reference and the submitted drawing side by side (independent page, zoom and rotation), revision notes, comments, pass or return, handover and signature. | You check drawings before they are printed and signed. |
| **A9** | **Projects** | <kbd>P</kbd> | Every project with its open and total jobs, and all of a project's jobs. Projects are added by the team when their first job comes in; none are preset. | You want everything for one project, or to add a new one. |
| **A10** | **Tools** | <kbd>O</kbd> | Calculators for the team. First: the **sheet calculator**, the team's Sheet Requirement Calculator workbook as a page: per component (material, length, width, number) the parts per sheet in a straight grid with kerf and edge margin, the sheets to buy, parts on the last sheet, utilisation and waste, with the cutting layout drawn to scale. Materials and stock sizes are kept under Admin → Tools. | You are ordering sheet for a job. |
| **A11** | **PDF tools** | <kbd>O</kbd> → PDF tools | The team's PDF scripts, one tab each: **Stamp** (a diagonal mark across every page, with a live preview of the first page while you adjust text, size, angle, opacity, position and colour), **Negative** (a vector PDF's colour negative, kept vector), **Combine by size** (A4 and A3 files merged into one PDF each) and **Word to PDF** (through Microsoft Word on the host PC). The first three run in your browser; results download singly or as one zip. | You are preparing drawings and documents to send out. |
| **A12** | **Drawing register** | <kbd>G</kbd>, or Review → Drawing register | Every drawing number that has been through board review, across all jobs: its latest signed revision (when, by whom, which job, the reviewed PDF), what is in review for it now, and its full history. Filters for signed, in review and never signed, by project or text. | Someone asks "what is the latest signed revision of BRK-023, and where is it?" |
| **A13** | **Weekly summary** | Reports → Weekly summary | One printable A4 page for the review meeting: the week's finished jobs by project and by person, and as of now what is overdue, what is waiting and on what, what is due next week, urgent work nobody has, and drawing review. Week by week. | You prepare the weekly review meeting. |
| **A14** | **Procurement and follow-ups** | Projects → a project → Procurement | The project's inventory and procurement list: one **master list** typed once (discipline, category, means, final size / spec, quantity, notes), the **assembly checklist** (components and tooling per discipline), **pending procurement**, and a **log** of when each item came into stock and who marked it. A shared Follow-up Control queue also shows outstanding components across projects, assigned next actions and immutable vendor-call notes. Copy another project's list to start; export to Excel. | You are buying and making the parts for a build. |

| | |
|---|---|
| ![Today: urgent, overdue, due today, unclaimed, being worked on, waiting, ready for review, finished](assets/screenshots/today.png) | ![Dashboard: six counts, team workload, jobs that need an owner, recent activity](assets/screenshots/dashboard.png) |
| **A2 Today** | **A4 Dashboard** |
| ![Workload: estimated hours per engineer against the 8-hour reference line](assets/screenshots/workload.png) | ![Reports: completed per day, per engineer and per job type](assets/screenshots/reports.png) |
| **A5 Workload** | **A6 Reports** |
| ![A job opened from the board: its release checklist at the top with two of four items ticked, its project in bold above the title on every card, and every field in the side panel](assets/screenshots/job-panel.png) | ![My work: one engineer's open jobs in their own order](assets/screenshots/my-work.png) |
| **A1 Board with a job open** | **A3 My work** |
| ![Projects: every project with its open and total jobs, and all the jobs of the chosen project](assets/screenshots/projects.png) | ![New job: a title and its project, with "+ Add a project…" for a new one](assets/screenshots/new-job.png) |
| **A9 Projects** | **New job, with its project** |
| ![Team activity: every change to every job, newest first, filterable by person](assets/screenshots/activity.png) | ![Admin → Roles: what engineers, managers and reviewers may do with jobs](assets/screenshots/admin-roles.png) |
| **A7 Team activity** | **E10 Admin → Roles** |

**A10 Tools: the sheet calculator.** The team's *Sheet Requirement Calculator* workbook as a page, giving the workbook's own answers. Below, its example (Mild Steel 2500 × 1250, 150 × 100 mm × 500, kerf 3, margin 5): 192 per sheet, 3 sheets, 116 on the last, 80% utilisation. A second component on Aluminium adds its own sheets, totalled per material.

![Sheet calculator: two components, the kerf, edge margin and rotation inputs, and the sheets required per component and per material](assets/screenshots/tools-sheet.png)

![The cutting layout: sheet 3 of 3 drawn to scale, 16 across × 12 down, parts numbered, unused slots in grey](assets/screenshots/tools-layout.png)

**A11 PDF tools.** The stamp with its live preview: the first page of the first file, stamped as it will be written, redrawn as each setting changes.

![PDF tools: two drawings chosen, the stamp settings, and the live preview of the first page](assets/screenshots/tools-pdf.png)

**A12 Drawing register.** One row per drawing number across jobs, here with SUP-011's history open: Rev A, signed by the reviewer, with its revision notes and the reviewed PDF. BRK-023 Rev C is still in review.

![Drawing register: each drawing number with its latest signed revision, what is in review now, and one drawing's history](assets/screenshots/drawing-register.png)

**A6 Reports: estimates against actual time.** Finished jobs whose actual time fell inside the estimate chosen, took longer or shorter, by job type and by person. The job panel shows what a type of job usually takes under its estimate, and asks for the time when you finish your own job.

![Estimates against actual time: within, longer and shorter by job type and by person, with the middle job's difference](assets/screenshots/reports-estimates.png)

**A13 Weekly summary.** Printed or saved as a PDF, it is the sheet alone on one A4 page.

![Weekly summary: the week's numbers, finished jobs by project, the team, overdue and waiting jobs](assets/screenshots/weekly-summary.png)

**A14 Procurement.** The master list (every cell saves as you leave it; **In stock** records the date, time and who) and the assembly checklist that follows from it.

![Procurement master list: items with discipline, category, means, final size or spec, quantity, in-stock time and notes](assets/screenshots/procurement.png)

![Assembly checklist: components and tooling per discipline, in stock or still to come](assets/screenshots/procurement-checklist.png)

**A8 Drawing review.** The queue, and the workspace with the signed reference on the left and the submitted drawing on the right, each with its own page, zoom and rotation. The open comment blocks **Pass board review** until it is resolved.

![Submitting drawings for board review: the signed reference scan, one single-page PDF per drawing, its number, revision, type and change notes](assets/screenshots/review-submit.png)

![Drawing review queue: counts, tabs, and a preview of the submission](assets/screenshots/review-queue.png)

![Drawing review workspace: signed reference and submitted drawing side by side, revision notes, reviewer comments](assets/screenshots/review-workspace.png)

## B. The job record

### B1. Fields

A job needs a title and a project. Everything else can be added as the job develops.

| Field | Notes |
|---|---|
| **Job number** | Assigned automatically, never reused. |
| **Title** | Up to 200 characters. |
| **Project** | Required for every new job. Chosen from the team's project list, or added there and then (**+ Add a project…**). Shown above the title on every card and job row in its own colour, so the project is read first. A job can move to another project; jobs from before 1.4.0 show as *No project* until one is picked. |
| **Description** and **notes** | Free text. Edits by two people are merged, see C3. |
| **Priority** | Urgent, high, normal or low. An urgent job notifies everyone. |
| **Estimate** | Eight buckets from under 15 minutes to over 2 days. Once three jobs of a type have recorded their time, the panel says what that type usually takes. |
| **Actual time** | Typed as you'd say it: `90`, `1.5h`, `3h 30m`, `1d`. Shown against the estimate (within, longer, shorter) and counted in Reports. Finishing your own job without one asks once. |
| **Release checklist** | When the admin gives the job type one (E13): the items to tick before Review or Done, each tick with its name and time, kept in the history. |
| **Due date** | Optional. A date alone becomes overdue after local midnight; a time can be added. |
| **Owner** | One person whose role may hold jobs (engineers out of the box; see E10), or nobody yet. |
| **Requester** | Who asked for the work. |
| **Job type** | Sixteen to start with: CAD Modification, New CAD Design, Drawing, Drawing Revision, STEP/IGES Cleanup, Geometry Repair, FEA, CFD, Design Calculation, Engineering Analysis, Manufacturing Support, BOM, Documentation, Prototype Support, Design Review, General. Admins can add and retire types. |
| **Tags** | Typed freely while editing a job. |
| **Reference** | A drawing number, purchase order, or anything people will search for. |
| **File location** | A folder or file path, with **Copy** for pasting into File Explorer and **Go to location**, which opens the folder in Explorer where the browser allows folder links (an Edge policy; see the For IT guide). |
| **Waiting for** | Required when a job moves to Waiting or Blocked. |
| **Comments** | Conversation on the job, signed with the author's name. |
| **History** | Every change: who, what, when. Append-only. |

### B2. How a job moves

```
 Inbox  →  Claimed  →  In progress  →  Review  →  Done
                            ↓
                  Waiting / blocked  (says what it is waiting for)
```

Drag a card, press <kbd>Shift</kbd>+<kbd>←</kbd> / <kbd>→</kbd>, or use the right-click menu. A job whose type has a release checklist can't go into Review or Done until it is ticked (or, if the admin chose so, the board asks first). A dropped card can be undone from the message that appears. Done jobs leave the board after 7 days and stay searchable for ever. Jobs are never deleted: finished ones can be **archived**, and **restored** from their panel.

### B3. Who may do what

These are the shipped rules. An admin can change the three job capabilities per role under **Admin → Roles** (E10); board review is not part of that setting and stays as described below.

| | Create jobs | Claim and be assigned jobs | Edit and move any job | Comment |
|---|:---:|:---:|:---:|:---:|
| **Engineer** | yes | yes | yes | yes |
| **Manager** | yes | no | yes | yes |
| **Reviewer** | no | no | no | drawings only |

*Create jobs* also lets a role add projects. *Edit and move any job* covers every field, column, assigning others and archiving. A role with *claim* but not *edit* works only on the jobs it holds.

Drawing review: engineers submit drawings, hand each one to one or more reviewers, mark prints handed over and record signatures; the manager and reviewers pass or return drawings (never their own submission) and record signatures. A reviewer sees only the drawings handed to them, with the job's number and title, and no other page of the board; the manager sees everything. Engineers can't review drawings. A job with drawings in board review is Done only when every drawing is physically signed.

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

![The bell: an overdue reminder, two urgent jobs raised by the manager, and a job sent for review](assets/screenshots/notifications.png)

## D. Finding things

| Item | Feature | Notes |
|---|---|---|
| **D1** | **Search** | <kbd>F</kbd> or <kbd>/</kbd>. Matches any part of a word in the job number, title, description, notes, file location, reference and tags: `1042`, `housing` and `\\fileserver\proj` all work. Finished and archived jobs are included. |
| **D2** | **Filters** | On the board: person, priority, job type, tag, due date, created date. Remembered across reloads. |
| **D3** | **Export to CSV** | What a search shows, ready for Excel. Opens correctly with accents and guards against formula injection. |
| **D4** | **Full export** | **Admin → Export:** every job as CSV, or everything with full history as JSON, procurement lists included. |

![Search for "housing": matches any part of a word, with the same filters as the board and an Export to CSV link](assets/screenshots/search.png)

## E. Administration

Behind the admin PIN, unlocked per browser for 12 hours. The PIN starts as `1234`; change it on day one. The PIN is separate from the sign-in passwords (E9): it unlocks Admin for anyone signed in who knows it.

| Item | Task | Notes |
|---|---|---|
| **E1** | **Team** | Add people, set engineer, manager or reviewer, choose a badge colour, mark who sees the Admin menu, deactivate leavers, reset a forgotten password. People are never deleted, so history keeps its authors. |
| **E2** | **Job types and tags** | Reorder, retire and bring back job types, and give each a release checklist (E13). Rename tags; renaming to an existing tag merges them. |
| **E3** | **Import from Excel** | Save as CSV UTF-8, choose the file, read the preview, then import. Column names are recognised automatically. Nothing is created until you confirm; rows with errors are skipped and explained; a backup is taken first; the whole file goes in or none of it; importing the same file twice is caught. |
| **E4** | **Backups** | Automatic: daily, and before every import, restore and upgrade. Kept 30 days, newest 7 always. Each is a complete, verified SQLite file in `data\backups`. Point `backupDir` at a network share or OneDrive so a dead PC does not take them with it. |
| **E5** | **Restore** | From the list, or from an uploaded `.db` file (64 MiB by default, adjustable). The file is checked and prepared first; if anything fails the original data is put back. The current data is backed up before every restore, so a restore can itself be undone. Nobody is signed out. |
| **E6** | **Archive** | Hide jobs finished more than N days ago from lists and reports. Never deletes. |
| **E7** | **Admin PIN** | Change it. If it is forgotten, put an empty file named `RESET-ADMIN-PIN` next to `start.bat` and restart. |
| **E8** | **Demo data** | Twelve example jobs across every column, removable in one click without touching real jobs. |
| **E9** | **Passwords** | Everyone signs in with their own password, created at their first sign-in and changeable from the account menu. Admins reset a forgotten one (the person creates a new one next time). If everyone is locked out, an empty file named `RESET-PASSWORDS` next to `start.bat` clears them all on the next start. |
| **E10** | **Roles** | What engineers, managers and reviewers may do with jobs: create, claim and be assigned, edit any job (see B3). Shipped rules: engineers everything, managers create and edit, reviewers nothing. Taking *claim* away from a role whose members still hold open jobs is refused until those jobs are reassigned. Board review is separate and unaffected. |
| **E11** | **Tools data** | The materials and standard sheet sizes behind the sheet calculator (the workbook's Materials sheet: ten materials with its typical sizes, to be replaced with the supplier's real ones), and the defaults for its kerf, edge margin and rotation inputs. Materials are retired, never deleted. |
| **E12** | **Health** | The host PC at a glance, each check OK, Check or Fix now: backups being made (and a failed daily backup, which used to show only in the console window), backups on another disk than the board, free disk space, the database's own check, and the admin PIN. Disk bars, versions, uptime and sizes below. A line at the top of every other Admin page links here while anything needs attention. |
| **E13** | **Release checklists** | Under **Job types → Checklist**: per job type, what must be ticked before a job goes to Review or Done (title block filled in, BOM checked…). Per type, refuse the move until all is ticked (the default) or ask first. Items are retired, never deleted. Demo data and Excel imports are not held back by them. |

![The sign-in screen: pick your name, then enter or create your password; the theme can be chosen before signing in](assets/screenshots/sign-in.png)

![Admin → Team: role, badge colour, admin menu, active, and password reset per person](assets/screenshots/admin.png)

![Admin → Tools: the materials and standard sheet sizes behind the sheet calculator](assets/screenshots/admin-tools.png)

![Admin → Health: backups, the backup disk, free space, the database check and the PIN, with disk space and details below](assets/screenshots/admin-health.png)

![Admin → Job types: CAD Modification's release checklist open, four items, refusing Review and Done until all are ticked](assets/screenshots/admin-checklists.png)

## F. Appearance

### F1. Themes

Choose from the **Theme** selector at the top of the board, or on the name picker before signing in. Your browser remembers the choice for that board address and applies it before the page paints.

| Theme | Look |
|---|---|
| **Light** | The original appearance, and the default. |
| **Charcoal** | Neutral dark greys with blue controls. |
| **Midnight** | Near-black with teal controls. |

Text and badge contrast is checked for each theme, including counts, forms and dialogs.

| | |
|---|---|
| ![The board in the Charcoal theme](assets/screenshots/board-charcoal.png) | ![The board in the Midnight theme](assets/screenshots/board-midnight.png) |
| **Charcoal** | **Midnight** |

### F2. Keyboard

The whole board works without a mouse: move between cards with the arrow keys, <kbd>Enter</kbd> to open, <kbd>C</kbd> to claim, <kbd>Shift</kbd>+arrows to move a card between and within columns, <kbd>N</kbd> for a new job, <kbd>Alt</kbd>+<kbd>↑</kbd> / <kbd>↓</kbd> to reorder My work. A skip link and named controls support screen readers.

### F3. Phone and tablet

Below 1180 px the navigation wraps onto its own row so nothing is cut off. On a phone the board columns scroll sideways. Long-press a card for the same menu as right-click.

| | |
|---|---|
| ![The board on a 390 px wide phone: columns scroll sideways](assets/screenshots/phone-board.png) | ![Today on a phone](assets/screenshots/phone-today.png) |

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
3. Double-click **`start.bat`** and keep its window open. Open <http://localhost:8080>, pick your name, create your password, and change the admin PIN.
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
| `reviewUploadMaxMB` | `EB_REVIEW_UPLOAD_MAX_MB` | `200` (1 to 2048; largest PDF for drawing review) |
| `timezone` | `EB_TIMEZONE` | `Asia/Kolkata` |
| `hoursPerDay` | | `8` (Workload reference line) |
| `workingDays` | | `[1,2,3,4,5,6]` (Monday to Saturday; 0 is Sunday) |

### H2. Built to last

| | |
|---|---|
| **Dependencies at runtime** | None on the server. Node built-ins only: `node:http`, `node:sqlite`, `node:crypto`, `node:zlib`. The review screen's PDF viewer (pdf.js) is built into the web files and served by the board itself. |
| **History** | Append-only, enforced by database triggers. Jobs cannot be deleted. |
| **Concurrency** | Version-checked edits, atomic claiming, idempotent creation. |
| **Search** | SQLite full-text with trigram matching, so any three letters match. |
| **Upgrades** | Schema version 15. A backup is taken before a new version changes the database. A board refuses to start on data written by a newer version. |
| **Network** | LAN only; no outbound traffic. Name picker plus a password (scrypt hash) and a signed cookie bound to it; admin behind a hashed PIN; five wrong passwords pause sign-in for 30 seconds. |
| **Checked by** | Automated backend and browser checks are provided; v1.8 results must be confirmed on the PR's validation workflow before release. Every database upgrade is tested from the version before it. The sheet calculator is checked against the workbook's own example. |

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
| **2.0.0** | Dedicated restricted Purchase role and shared cross-project procurement queue, supplier directory, PO status and follow-up ownership. |\n| **1.9.0** | Component manufacturing stages, partial receipt and inspection quantities, escalation status and vendor promised-date history. |\n| **1.8.0** | Procurement follow-up control across projects: accountable next actions, follow-up dates, colleague ownership and immutable vendor contact history; items drop from pending only when in stock. |\n| **1.7.0** | **Admin → Health** for the host PC. A **drawing register** across jobs, with a **revision** on every drawing. **Estimates against actual time** in Reports and the job panel. A printable **weekly summary**. **Release checklists** per job type, guarding Review and Done. A **procurement tracker** per project from the team's inventory workbook. Fixed: a reviewer recording a job's last signature was refused. |
| **1.6.0** | PDF tools on the Tools page: Stamp with a live preview, Negative, Combine by size and Word to PDF, from the team's four scripts. |
| **1.5.0** | The project name stands out on cards and job rows. Admin-set role capabilities (create, claim and be assigned, edit any job) for engineers, managers and reviewers, leaving board review untouched. **Go to location** beside a job's file path. A **Tools** page with the team's *Sheet Requirement Calculator* workbook as a page, formula for formula, with its cutting layout drawn to scale; its materials and sheet sizes editable by the admin. |
| **1.4.0** | Projects: every job belongs to a project, chosen or added from the New job form; a Projects page with each project's jobs; project filter, search, card and job-panel display; Project column in import and export. No preset list: projects are added as they are needed. |
| **1.3.0** | Reviewer access: engineers hand each drawing to one or more reviewers (and can change them later). A reviewer sees only the drawings handed to them, with the job number and title: no board, workload, reports, search, other jobs, team activity or Admin. The manager keeps full access. |
| **1.2.0** | Password sign-in for everyone, current and new: each person creates their own password at their first sign-in, changes it from the account menu, and an admin can reset a forgotten one. A `RESET-PASSWORDS` file on the host PC clears them all. Restores keep the current passwords. |
| **1.1.0** | Drawing review: submit single-page drawings with the signed reference scan, compare them in two independent viewers, remember the matching reference page, comment, pass or return per drawing, print, hand over (with a reminder for the reviewer) and record the physical signature before a job can be Done. Project-folder copies, REVISION_LOG.md and clean-up of intermediate PDFs. New Reviewer role. |
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
node scripts/screenshots.mjs   # the README screenshots, from a fresh board with demo data (build first)
```

The web app is React 19 bundled by esbuild. Small purpose-built replacements for a router, query cache, drag and drop and dialogs live in `web/src/lib/`. The guides in `docs/` become web pages at build time and the release zip is written by a small script, both without extra packages.

```
shared/src/      constants, API types, validators (used by server and web)
web/src/         React app: views, components, lib (api, store, router, theme…)
server/src/
  app.ts         routes, auth wrappers, HTTP server
  index.ts       entry point: config, startup banner, PIN and password resets, clean shutdown
  config.ts      config.json and environment variables, with plain-English errors
  http/          router, bodies, cookies, static files, error mapping
  db/            connection, transactions, migrations, seed data
  domain/        tickets, rank, search, views, reports, users, job types, auth,
                 permissions, projects, tools, notifications, presence,
                 backup, import and export (transfer), drawing review
                 (reviews, reviewStore, projectFolder, pdf, register),
                 health, estimates, weekly, checklists, procurement,
                 wordToPdf
server/test/     node:test suites against a real server and a real SQLite file
e2e/             browser tests and the build and package check
scripts/         build, package, lib (markdown, zip, guides), windows/, linux/
assets/          README screenshots (scripts/screenshots.mjs)
docs/            the guides, also built into the app; docs/tools/ holds the calculator's workbook
```
