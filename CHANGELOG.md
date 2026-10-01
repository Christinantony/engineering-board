# CHANGELOG

**Append-only.** Add your entry at the **bottom**. Never edit or delete an existing entry. If an earlier entry was wrong, add a new entry that corrects it and refers to the old one.

## Entry format

```
### YYYY-MM-DD HH:MM IST | <Agent: Claude / ChatGPT / Antigravity / Christin> | branch: <branch-name>
- **What:** what changed, in one or two lines
- **Why:** the reason or the requirement behind it
- **Files:** paths touched
- **Decisions affected:** numbers from DECISIONS.md, or "none"
- **Follow-ups / open issues:** anything unfinished or that the next agent must know, or "none"
```

---

### 2026-10-01 23:45 IST | Claude | branch: claude/bootstrap-collab-protocol
- **What:** Added the multi-agent collaboration protocol: `00_START_HERE.md`, `AGENTS.md`, `CHANGELOG.md`, `HANDOFF.md`, `DECISIONS.md` (copied from the project's `ARCHITECTURE.md`), `.gitignore`, and a pull request template.
- **Why:** Claude, ChatGPT and Antigravity will all work on this project, and every change needs to be traceable so the agents stay in sync.
- **Files:** `00_START_HERE.md`, `AGENTS.md`, `CHANGELOG.md`, `HANDOFF.md`, `DECISIONS.md`, `.gitignore`, `.github/pull_request_template.md`
- **Decisions affected:** none. `DECISIONS.md` is a verbatim copy of the existing architecture doc, plus a header.
- **Follow-ups / open issues:** The application source (`app/`, `domain/`) is not in the repo yet. It exists on Christin's machine only and must be committed in a separate PR before any agent can change code. See `HANDOFF.md`.

### 2026-10-02 00:05 IST | Claude | branch: claude/import-app-source
- **What:** Imported the application source with its full git history (phases 2 to 7: database and API, board UI, operational views, collaboration, admin/import/export/backups, polish), merged onto `main`'s collaboration files. Declared the build and test tools as devDependencies. Replaced `docs/ARCHITECTURE.md` with a pointer to `DECISIONS.md`. Corrected the project layout in `AGENTS.md`, resolved the open question in `HANDOFF.md`, and added `dist/` to `.gitignore`.
- **Why:** The code only existed in Claude's workspace and in zip files. Every agent needs it in the repo before any code work can start.
- **Files:** `server/`, `web/`, `shared/`, `e2e/`, `scripts/`, `docs/`, `package.json`, `tsconfig.json`, `README.md`, `.gitignore`, `AGENTS.md`, `HANDOFF.md`, `CHANGELOG.md`
- **Decisions affected:** none. The code implements decisions 1 to 17 as written.
- **Follow-ups / open issues:**
  - There is no `package-lock.json` yet, because the build environment had no npm registry access. See `HANDOFF.md`.
  - Phase 8 (testing) and Phase 9 (deployment package and guides) are still to do.
