# User guide

The Engineering Board is where the team's design jobs live: who is doing what, what's waiting, what's due and what's done. Open it in any browser at the address you were given (for example `http://CHRISTIN-PC:8080`) and bookmark it.

Press <kbd>?</kbd> on any page for the keyboard shortcuts.

## Getting started

The first time, pick your name. The browser remembers you. On a shared PC, use **your name (top right) → Switch user**.

Everyone can create jobs, edit them and comment. **Engineers** claim and do jobs. The **manager** can't claim, but can assign jobs to an engineer. Nothing is ever deleted: every change is kept in each job's history.

## The board

The board shows every open job in columns, left to right:

| Column | Means |
|---|---|
| **Inbox** | New jobs nobody has taken yet. |
| **Claimed** | Someone owns it but hasn't started. |
| **In progress** | Being worked on now. |
| **Waiting / blocked** | Can't continue. The card says what it's waiting for (a supplier, a decision, input from someone). |
| **Review** | Done and ready to be checked. Checking your own work is fine. |
| **Done** | Finished. Done jobs leave the board after 7 days but stay searchable for ever. |

Cards show the job number, title, owner, priority, due date and estimate. The due date is marked when a job is due today, and in red with a dot when it is overdue.

**Moving a job:** drag the card to another column. A short message offers **Undo** if you dropped it in the wrong place. Moving to *Waiting / blocked* asks what it is waiting for. Moving a job nobody owns into a working column makes it yours (or, for the manager, asks who should take it).

**Claiming:** on an Inbox card, click **Claim it** or press <kbd>C</kbd>. If two people claim the same job at the same moment, one gets it and the other is told who has it.

**More actions:** right-click a card (or press and hold on a tablet) to claim, assign, move it to any column, or copy a link to it.

**Order:** drag cards up and down within a column; everyone sees the same order.

**Filters:** the bar above the board narrows it down by person, priority, job type, tag, due date and created date. Filters are remembered when you reload the page. **Clear filters** removes them.

## Creating a job

Press <kbd>N</kbd> or click **+ New job**. Only the title is needed; everything else can be added later.

- <kbd>Enter</kbd> creates it in the Inbox. <kbd>Shift</kbd>+<kbd>Enter</kbd> creates it and claims it for you in one go.
- **Priority**: urgent, high, normal or low. A new urgent job notifies everyone.
- **Estimate**: a rough bucket such as "1–2 hr". It feeds the Workload page.
- **Due**: optional date, and optionally a time. Without a time, the job becomes overdue after midnight.

## A job's details

Click a card to open its panel on the right. Every field saves as you finish with it (press <kbd>Enter</kbd> on one-line fields, <kbd>Ctrl</kbd>+<kbd>Enter</kbd> in notes and the description, or just click elsewhere). <kbd>Esc</kbd> undoes the edit you're in.

- **File location**: paste a folder or file path, for example `\\fileserver\projects\P-1042\CAD`. **Copy path** puts it on the clipboard so you can paste it into File Explorer. (Browsers aren't allowed to open network folders directly.)
- **Reference**: a drawing number, PO or anything people will search for.
- **Requester**, **job type**, **tags** and **notes** help find and report on work later.
- **Comments** at the bottom are for conversation; they land in the job's history with your name.
- **History** lists every change: who, what and when. It can't be edited or deleted.

**Working on the same job as someone else:** you see who else has it open ("Also viewing"). If you both change *different* fields, both changes are kept with no fuss. If you both change the *same* field, you're asked which version to keep: yours, theirs, or both (for notes and descriptions).

**Release** gives a claimed job back to the Inbox. **Archive** (for done or cancelled jobs) hides it from normal lists; **Restore** brings it back.

## Other pages

| Page | Key | What it's for |
|---|---|---|
| **Today** | <kbd>T</kbd> | The team's day at a glance: urgent, overdue, due today, unclaimed, in progress, waiting, ready for review, and what was finished since yesterday. |
| **My work** | <kbd>M</kbd> | Your own jobs in your own order: drag them, or use <kbd>Alt</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd>. You can also look at another engineer's list. |
| **Dashboard** | <kbd>D</kbd> | Counts (unclaimed, in progress, waiting, due today, overdue, done today) and recent team activity. |
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
| | <kbd>B</kbd> <kbd>T</kbd> <kbd>M</kbd> <kbd>D</kbd> <kbd>W</kbd> <kbd>R</kbd> | Board, Today, My work, Dashboard, Workload, Reports |
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
