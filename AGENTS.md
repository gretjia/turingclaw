# AGENTS.md

This repository keeps agent-facing project context in `.handover/` with a strict split:

- Shareable context and process docs go in `.handover/*.md`.
- Private local notes go in `.handover/local/` (git-ignored).

## Collaboration Rules

- Keep kernel changes minimal and auditable.
- Do not add hidden runtime state outside tape/workspace files.
- Prefer deterministic, testable behaviors over opaque autonomy.

## Handover Rules

- Update `.handover/AGENT_ENTRY.md` when architecture, runtime flags, or operational workflow changes.
- Keep instructions concise and executable.
- Never commit secrets, credentials, or machine-specific private notes.
