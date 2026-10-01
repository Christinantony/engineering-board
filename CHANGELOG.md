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
