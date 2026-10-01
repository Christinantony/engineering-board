# START HERE: rules for every agent (Claude, ChatGPT, Antigravity)

This repo is worked on by three AI agents plus the owner (Christin). The rules below stop us overwriting each other or drifting apart. Read this whole file before touching anything.

## The project in one paragraph
An internal engineering workboard (Kanban / ticketing) for a small mechanical design team. One Node process serves the web app, REST API and live-update stream, backed by SQLite. It runs on a locked-down, non-admin Windows PC on a trusted LAN with no internet at runtime. Full reasoning is in `DECISIONS.md`.

## Before you start any session (every time)
1. Read this file, `AGENTS.md`, `HANDOFF.md`, `DECISIONS.md`, and the last 20 entries of `CHANGELOG.md`.
2. `git pull` the latest `main`. Never start from stale code.
3. Claim your work in `HANDOFF.md`: your name, the files you will touch, the start time. If another agent has claimed the same files, stop and ask Christin.

## Working rules
- **Never commit directly to `main`.** Work on your own branch: `claude/<topic>`, `chatgpt/<topic>`, `antigravity/<topic>`. Merge only through a pull request that Christin reviews.
- **One change, one purpose.** Keep branches and PRs small.
- **Every PR must add an entry to `CHANGELOG.md`.** No changelog entry, no merge.
- **Decisions are numbered and live in `DECISIONS.md`.** Never silently reverse or work around one. If you think a decision is wrong, add an entry under "Open questions" in `HANDOFF.md` and wait for Christin.
- **Do not add runtime dependencies** (see decision #1). Use Node built-ins only. If you believe a dependency is essential, ask first.
- **Never overwrite or rewrite another agent's changelog entries.** The log is append-only.
- **Never commit secrets or data:** the admin PIN or its hash, the cookie signing key, `data/`, `*.db`, `*.db-wal`, `*.db-shm`. `.gitignore` covers these, but check your diff.
- **Do not guess.** If a requirement is unclear, record the question in `HANDOFF.md` rather than inventing an answer.

## Ending a session (every time)
1. Make sure the work runs and tests pass, if tests exist.
2. Add one entry to the bottom of `CHANGELOG.md` using the format in that file.
3. Release your claim in `HANDOFF.md` and note any unfinished work or open questions.
4. Push your branch and open a PR using the template.

## Getting access
- **Claude:** attach this repo to the session with push access.
- **ChatGPT:** turn on its GitHub connector and grant it this repo only.
- **Antigravity:** `git clone https://github.com/Christinantony/engineering-board`, then work on your own branch.
- Keep the repo **private**. Add collaborators only through Christin.

## Where things live
| File | Purpose |
|---|---|
| `AGENTS.md` | Short rules that agent tools read automatically |
| `CHANGELOG.md` | Append-only record of every change, who made it, and why |
| `HANDOFF.md` | Who is working on what right now, plus open questions |
| `DECISIONS.md` | Numbered architecture decisions and known limits |
