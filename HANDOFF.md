# HANDOFF

Live coordination board. Edit this file freely (unlike `CHANGELOG.md` it is not append-only), but keep it current.

## Active claims
Add a row when you start working, remove it when you finish.

| Agent | Branch | Files / areas being touched | Started (IST) |
|---|---|---|---|
| Claude | `claude/phase8-testing` | `server/test/` (new migration and build tests), `e2e/`, plus any bug fixes the tests find | 2026-10-02 |

## Open questions
Questions for Christin or another agent. Mark answered ones with the answer and date, and move them to "Resolved".

_(none)_

## Resolved
- [x] The application source was not in this repo yet. **Answer:** Claude imported the full source and its history (phases 2 to 7) on branch `claude/import-app-source`, 2026-10-02.

## Notes for the next agent
- **Where the project stands:** phases 1 to 7 of 9 are done.
  - **Phase 8:** a full test pass, migration-upgrade checks and build checks.
  - **Phase 9:** the Windows package, `config.json` example, firewall rule, user and admin guides.
- **Setup:** `npm install` installs the build and test tools (TypeScript, tsx, esbuild, React, Playwright). They are devDependencies only; the running board needs nothing but `node.exe` 22.16+ (decision #1).
- **No lockfile yet:** the environment that built phases 2 to 7 had no access to the npm registry, so there is no `package-lock.json`. The first agent that runs `npm install` with registry access should commit the lockfile in its own small PR.
- **No `@types/react`:** `web/src/types/react-shim.d.ts` declares only the parts of React the app uses, so it can be typechecked without the package. Replacing it with the real types is fine, as long as `npm run typecheck` still passes.
- **Checks:** `npm run typecheck`, `npm test` (62 backend tests), `npm run build`, `npm run e2e` (22 browser tests; build first).
