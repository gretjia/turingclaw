# AGENTS.md

This repository keeps agent-facing project context in `.handover/` with a strict split:

- Shareable context and process docs go in `.handover/*.md`.
- Private local notes go in `.handover/local/` (git-ignored).

## Agent Routing

Single entrance point for this repository: `./.handover/ENTRYPOINT.md`.

All agents must start there before reading or applying any other project instructions.
If multiple docs disagree, follow `./.handover/ENTRYPOINT.md` unless the user gives direct chat instructions.

## Collaboration Rules

- Keep kernel changes minimal and auditable.
- Do not add hidden runtime state outside tape/workspace files.
- Prefer deterministic, testable behaviors over opaque autonomy.

## Handover Rules

- Update `.handover/AGENT_ENTRY.md` when architecture, runtime flags, or operational workflow changes.
- Keep instructions concise and executable.
- Never commit secrets, credentials, or machine-specific private notes.

## Gemini Invocation Policy

- For this repository, every Gemini CLI call must use:
  `gemini -y --model gemini-3.1-pro-preview`
- If you need extra arguments, append them after this fixed prefix.
