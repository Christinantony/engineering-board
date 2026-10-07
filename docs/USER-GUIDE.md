# User guide

The Engineering Board is where the team's design jobs live: who is doing what, what's waiting, what's due and what's done. Open it in any browser at the address you were given (for example `http://CHRISTIN-PC:8080`) and bookmark it.

Press <kbd>?</kbd> on any page for the keyboard shortcuts.

## Getting started

Pick your name, then enter your password. The browser remembers you, so you won't be asked again on this computer. On a shared PC, use **your name (top right) → Sign out** when you leave.

**Your first sign-in:** you don't have a password yet, so the board asks you to create one (at least 6 characters; a short phrase with spaces is fine). Only you should know it: nobody else, not even the admin, can see it. To change it later, use **your name → Change password**; other browsers signed in as you are asked to sign in again. If you forget it, ask whoever looks after the board to reset it under Admin → Team, then sign in and create a new one.

Out of the box, engineers and the manager create jobs, edit them and comment; **engineers** claim and do jobs; the **manager** can't claim, but assigns jobs to an engineer. **Reviewers** check the drawings an engineer hands to them in [drawing review](#drawing-review). A reviewer sees only those drawings, with the job's number and title: not the board, Today, My work, the dashboard, workload, reports, search or any other job. Whoever looks after the board can change what each role may do with jobs (create, claim and be assigned, edit any job) under **Admin → Roles**, for example so that jobs can be created for the manager or a reviewer too; a reviewer given such a capability also sees the board. Drawing review itself never changes with those settings. Nothing is ever deleted: every change is kept in each job's history.

## Themes

Use **Theme** at the top of the board (or on the sign-in screen) to choose **Light**, **Charcoal** or **Midnight**. Light is the original appearance and the default. Charcoal uses neutral dark greys with blue controls; Midnight uses a near-black background with teal controls.

Your choice applies to every app page, job panel, form, menu and dialog. It is saved in this browser for this board address, including after a reload or switching users. Other browsers can choose their own theme. If browser storage is disabled, you can still change themes for the current page, but the choice may not survive a reload.

## The board

The board shows every open job in columns, left to right:

| Column | Means |
|---|---|
| **Inbox** | New jobs nobody has taken yet. |
| **Claimed** | Someone owns it but hasn't started. |
| **In progress** | Being worked on now. |
| **Waiting / blocked** | Can't continue. The card says what it's waiting for (a supplier, a decision, input from someone). |
| **Review** | Done and ready to be checked. Checking your own work is fine, except for drawings submitted for board review: those are checked by the manager or a reviewer (see [Drawing review](#drawing-review)). |
| **Done** | Finished. Done jobs leave the board after 7 days but stay searchable for ever. |

Cards show the job number, title, owner, priority, due date and estimate. The due date is marked when a job is due today, and in red with a dot when it is overdue.

**Moving a job:** drag the card to another column. A short message offers **Undo** if you dropped it in the wrong place. Moving to *Waiting / blocked* asks what it is waiting for. Moving a job nobody owns into a working column makes it yours (or, for the manager, asks who should take it).

**Claiming:** on an Inbox card, click **Claim it** or press <kbd>C</kbd>. If two people claim the same job at the same moment, one gets it and the other is told who has it.

**More actions:** right-click a card (or press and hold on a tablet) to claim, assign, move it to any column, or copy a link to it.

**Order:** drag cards up and down within a column; everyone sees the same order.

**Filters:** the bar above the board narrows it down by person, priority, job type, tag, due date and created date. Filters are remembered when you reload the page. **Clear filters** removes them.

## Creating a job

Press <kbd>N</kbd> or click **+ New job**. A job needs a title and its **project**; everything else can be added later.

- **Project**: every job belongs to a project. Choose it from the list. If it's a new project, choose **+ Add a project…** and type its name: it's added to the list for everyone, and chosen for this job. The board offers the project you used last; from a project's page, **+ New job in this project** fills it in.

- <kbd>Enter</kbd> creates it in the Inbox. <kbd>Shift</kbd>+<kbd>Enter</kbd> creates it and claims it for you in one go.
- **Priority**: urgent, high, normal or low. A new urgent job notifies everyone.
- **Estimate**: a rough bucket such as "1–2 hr". It feeds the Workload page.
- **Due**: optional date, and optionally a time. Without a time, the job becomes overdue after midnight.

## A job's details

Click a card to open its panel on the right. Every field saves as you finish with it (press <kbd>Enter</kbd> on one-line fields, <kbd>Ctrl</kbd>+<kbd>Enter</kbd> in notes and the description, or just click elsewhere). <kbd>Esc</kbd> undoes the edit you're in.

- **File location**: paste a folder or file path, for example `\\fileserver\projects\P-1042\CAD`. **Copy** puts it on the clipboard so you can paste it into File Explorer. **Go to location** opens the folder in File Explorer, if your browser is allowed to open folder links from the board: browsers block them unless IT turns that on (Edge has a setting for it; see the [For IT](FOR-IT.md#opening-folders-from-the-board) guide). If nothing happens when you press it, use Copy.
- **Reference**: a drawing number, PO or anything people will search for.
- **Requester**, **job type**, **tags** and **notes** help find and report on work later.
- **Comments** at the bottom are for conversation; they land in the job's history with your name.
- **History** lists every change: who, what and when. It can't be edited or deleted.

**Working on the same job as someone else:** you see who else has it open ("Also viewing"). If you both change *different* fields, both changes are kept with no fuss. If you both change the *same* field, you're asked which version to keep: yours, theirs, or both (for notes and descriptions).

**Release** gives a claimed job back to the Inbox. **Archive** (for done or cancelled jobs) hides it from normal lists; **Restore** brings it back.

## Projects

**Projects** in the top bar (<kbd>P</kbd>) lists every project with its open and total jobs. Choose one to see all of its jobs, open ones first, then done, cancelled and archived ones. From there, **Show on the board** filters the board to that project, and **+ New job in this project** starts a job in it.

- **Adding a project:** **+ Add project** here, or **+ Add a project…** in the New job form or a job's Project field. There is no preset list: add each project when its first job comes in. A name can only be used once, so typing an existing name (in any capitals) just chooses that project.
- **A job's project** shows on its card, in lists, and at the top of its details, where you can move it to another project (the change is kept in its history) and open **All its jobs**.
- **Filter by project** with **Project** on the board's and search's filter bar. Searching for a project's name finds its jobs.
- **No project:** jobs from before projects existed, or imported without one, are listed under **No project** on the Projects page until someone picks their project.

Projects can't be renamed or deleted, so check the name before adding it.

## Drawing review

Drawings are checked on the board before they are printed and signed. **Board review is an internal check, not official approval.** The physically signed drawing is the approved record, and the signed scans you attach are never changed, replaced or deleted by the board.

**Who does what**

| | Engineers | Manager and reviewers |
|---|:---:|:---:|
| Submit drawings and signed scans, and choose who reviews them | yes | no |
| See a drawing | yes | the manager: every drawing; a reviewer: only the ones handed to them |
| Comment | yes | yes |
| Pass or return a drawing | no | yes (not their own submission; a reviewer only on drawings handed to them) |
| Mark a print handed over | yes | no |
| Record the physical signature | yes | yes |

### 1. Submit

Open the job and press **Submit for board review…** (or **Review → the job → Submit drawings…**).

- **Signed reference scan**: for a revision, attach the signed, scanned set of the previous revision. It is usually one merged PDF for the whole set. Attach the file from the project folder: the board keeps its own copy and never touches yours.
- **Drawings**: attach each drawing as **its own single-page PDF**, named with its part number (for example `BRK-023.pdf`). The file name becomes the drawing number; correct it in the form if needed. A PDF with more than one page is refused: export each sheet on its own.
- For each drawing, say **what changed and why** (or, for a new drawing, its purpose), and choose **Revision** or **New drawing**. A revision needs a signed reference scan on the job.
- **Hand to reviewers**: tick everyone who should review these drawings; one or several. Only they (and the manager) see them. To send one drawing to different people, press **Choose for this drawing** under it. A corrected drawing goes back to the same reviewers unless you change them.

The job moves to the Review column. Each reviewer is told about the drawings handed to them, and the manager about every submission. To change who reviews a drawing later (someone on leave, a second opinion), press **Change** next to **Reviewers** in the review screen.

### 2. Review

**Review** in the top bar lists the jobs waiting for board review (press <kbd>V</kbd>). A reviewer's list holds only the drawings handed to them, and **Review** is the only page they have. Open a job to see:

- **Drawing set** on the left: every drawing with its state. A drawing can pass while others are still being corrected.
- **Two viewers**: the signed reference on the left, the submitted drawing on the right. Each has its own page, zoom (**−**, **+**, **Fit page**, **Fit width**) and rotation (**↺**, **↻**, **Reset**). Rotating or zooming only changes what you see, never the PDF.
- **Finding the matching page**: page through the merged signed scan in the left viewer until it shows the old revision of this drawing, then press **Remember page N**. The board saves that page for this drawing and opens it there next time, for everyone. Anyone can change it later. The board never guesses the page.
- **Compare with**: switch the left viewer to **Previous attempt** to compare a corrected drawing with the one that was returned, or choose **Drawing only**.
- **Revision notes** and **Reviewer comments** on the right. Engineers can **Respond** to a comment; the reviewer (or the comment's author) **Resolves** it.

The manager, or a reviewer it was handed to, then either:

- **Return for correction**, with a note or open comments. The engineer submits a corrected PDF as a new **attempt**: the drawing's engineering revision doesn't change (it can stay Rev C through attempts 1, 2 and 3). Only the drawings that need changes are resubmitted.
- **Pass board review**. It can't be passed while comments are open. The status then reads **Board review passed — signature pending**.

A drawing can't be reviewed by the person who submitted it.

### 3. Print, hand over, sign

1. Print **the exact PDF that passed** (**Open reviewed PDF to print**).
2. Take it to the reviewer who passed it and press **Mark handed over for signature**. That reviewer gets one reminder in the board: "*BRK-023.pdf was approved by you in the board on 2 Oct 2026. The printed drawing has now been handed over for your signature.*" Pressing it again sends no second reminder.
3. Once it is signed, press **Record physical signature**. Nothing needs uploading.

**The job becomes Done by itself when every drawing is recorded as signed**, and it can't be moved to Done before that. If a PDF changes after it passed, it needs a new board review decision and a new print: the earlier handover doesn't carry over.

### Project folder copies and the revision log

If the job's **File location** is its project folder, the board keeps there:

- `BoardReview\<JOB>\<drawing>\attempt N.pdf`: drawings under review.
- `BoardReview\<JOB>\<drawing> - board reviewed (attempt N).pdf`: the exact PDF that passed (an internally reviewed copy, not an officially approved one).
- `REVISION_LOG.md`: every drawing and attempt, with what changed, comments and responses, the outcome, who and when, handover and signature, and clean-up.

After a drawing passes, the board removes the earlier attempts' PDFs (the history keeps their notes, comments and decisions, and says *Intermediate PDF removed after board review*). It never touches signed scans, CAD files or anything it didn't write. If the share can't be reached, the review screen says so and the board keeps trying; its own copies stay viewable. **Revision log** on the review screen shows the log for one job at any time.

## Tools

**Tools** (<kbd>O</kbd>) holds small calculators for the team. The first is the **sheet calculator**: list the flat components you need (name, material, thickness, blank length and width, quantity) and it tells you, per material and thickness, how many standard sheets to buy, which stock size needs the fewest, how many of each part fit on a sheet, how much of each sheet becomes parts, and the sheet mass when the material's density is known. Rows missing a material or thickness are left out and listed; a part larger than every stock sheet is flagged. The list is remembered in your browser; **Print** gives a copy for the purchase request.

The materials, their standard sheet sizes, the usable share of a sheet and the cut width come from **Admin → Tools**, so the list reflects what the team actually buys. **How this is counted**, under the results, explains the method.

## Other pages

| Page | Key | What it's for |
|---|---|---|
| **Today** | <kbd>T</kbd> | The team's day at a glance: urgent, overdue, due today, unclaimed, in progress, waiting, ready for review, and what was finished since yesterday. |
| **My work** | <kbd>M</kbd> | Your own jobs in your own order: drag them, or use <kbd>Alt</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd>. You can also look at another engineer's list. |
| **Dashboard** | <kbd>D</kbd> | Counts (unclaimed, in progress, waiting, due today, overdue, done today) and recent team activity. |
| <kbd>V</kbd> | Drawing review |
| **Workload** | <kbd>W</kbd> | Estimated hours per engineer for today, the next 3 days or this week, against an 8-hour day. It's a planning aid, not a limit. Jobs without an estimate are counted separately, not guessed. |
| **Reports** | <kbd>R</kbd> | Jobs completed per day, per engineer and per job type, and how long jobs take, for this or last week or month. |
| **Team activity** | your name menu | Every change to every job, newest first. |

## Search

Press <kbd>F</kbd> or <kbd>/</kbd> and type. Search finds any part of a word in the job number, title, description, notes, file location, reference and tags: `1042`, `housing`, `\\fileserver\proj` all work. Press <kbd>Enter</kbd> for the full search page, which includes finished jobs and has filters (and an "Include archived jobs" option). **Export these to CSV** downloads exactly what the search shows, ready for Excel.

## Notifications

The bell (top right) shows things that need you, done by someone else:

- a new urgent job, or a job raised to urgent (everyone)
- a job assigned to you, or taken off you
- a job ready for review (engineers)
- a job you own or created moved to waiting or blocked, or commented on
- a job you created being finished

It also reminds you of your own jobs that are overdue or due today. Opening the bell marks them as read.

## When something goes wrong

- **Red banner "Can't reach the board server":** the host PC is off, asleep or restarting. Anything you change now isn't saved. Wait; the page reconnects by itself and catches up.
- **"The board has been updated on the server":** click **Reload** to get the new version.
- **"Someone else changed this":** another person saved first. The panel shows their version; make your change again if it's still needed.
- Anything else: tell whoever looks after the board. The [Troubleshooting](TROUBLESHOOTING.md) page has more.

## Keyboard shortcuts

| Where | Keys | Does |
|---|---|---|
| Anywhere | <kbd>N</kbd> | New job |
| | <kbd>F</kbd> or <kbd>/</kbd> | Search |
| | <kbd>B</kbd> <kbd>T</kbd> <kbd>M</kbd> <kbd>P</kbd> <kbd>D</kbd> <kbd>W</kbd> <kbd>R</kbd> | Board, Today, My work, Projects, Dashboard, Workload, Reports |
| | <kbd>?</kbd> | List of shortcuts |
| | <kbd>Esc</kbd> | Close the panel, dialog or menu |
| Board, with a card selected | <kbd>Tab</kbd> or arrow keys | Move between cards |
| | <kbd>Enter</kbd> | Open the job |
| | <kbd>C</kbd> | Claim it |
| | <kbd>Shift</kbd>+<kbd>←</kbd>/<kbd>→</kbd> | Move it to the previous or next column |
| | <kbd>Shift</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd> | Move it up or down |
| | <kbd>Shift</kbd>+<kbd>F10</kbd> | More actions |
| New job form | <kbd>Enter</kbd> / <kbd>Shift</kbd>+<kbd>Enter</kbd> | Create / create and claim |
| Job panel | <kbd>Ctrl</kbd>+<kbd>Enter</kbd> | Save notes or description, or add a comment |
| My work | <kbd>Alt</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd> | Reorder your jobs |

## Large job lists

The Board and an engineer's Workload job list load all matching pages. If loading fails, a message offers **Try again**. During a failed refresh, the last complete list remains visible and is marked as such; a partial page never replaces it.
