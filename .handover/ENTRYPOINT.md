# Agent Entrypoint

Status: active
Last updated: 2026-02-24
Scope: entire repository

This is the single entrance point for coding agents in this repo.
If other docs conflict with this file, follow this file unless the user gives direct chat instructions.

## 1. Mission

Work on TuringClaw, a deterministic tape-based agent engine.
Preserve the core execution model in `server/engine.ts`:
- File-backed registers (`.reg_q`, `.reg_d`)
- Strict XML delta actions (`<STATE>`, `<GOTO>`, `<WRITE>`, `<ERASE>`, `<REPLACE>`, `<EXEC>`)
- Single-loop deterministic control flow

## 2. Boot Sequence

1. Read this file fully.
2. Read `README.md`.
3. Read `package.json`, then `server/engine.ts`.
4. Read touched interface surfaces:
- CLI: `cli.ts`
- HTTP/Web: `server.ts`, `src/App.tsx`
- Harnesses: `tests/*.ts`
5. Run `git status --short` before edits and do not revert unrelated changes.

## 3. Source of Truth

- Core engine: `server/engine.ts`
- CLI: `cli.ts`
- API/WebSocket: `server.ts`
- UI: `src/App.tsx`, `src/main.tsx`, `src/index.css`
- Scripts: `package.json`, `turing_prompt.sh`
- Primary docs: `README.md`
- Runtime artifacts (non-canonical source): `workspace/`, `omega/`

## 4. Rules

1. Keep changes minimal and request-scoped.
2. Do not add heavy abstractions around the core loop unless requested.
3. Maintain deterministic transition behavior.
4. Keep persistence file-based; do not replace registers with memory-only state.

## 5. Validation

For TS/app changes run:
- `npm run lint`

For runtime behavior changes run a matching harness in `tests/`.
If verification is skipped, state exactly why.

## 6. Merge Mechanism for Multi-Machine `.handover`

Shared, versioned files:
- `.handover/ENTRYPOINT.md`
- Any other files under `.handover/` except `local/`

Local-only (ignored) files:
- `.handover/local/`

Recommended workflow when syncing two machines:
1. `git pull --rebase`
2. Compare local notes to shared docs: `git diff -- .handover`
3. Promote only useful parts from `.handover/local/*` into shared files.
4. Commit only shared files.

This keeps machine-private notes out of Git while allowing collaborative improvement of shared handover docs.

## 7. Handoff Output

Before finishing, report:
1. What changed and why.
2. Files touched.
3. Commands run and key outcomes.
4. Residual risks or skipped checks.

