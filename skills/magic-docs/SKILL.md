---
name: magic-docs
description: "Discover a repository's own documentation before touching code: scan README, docs/, AGENTS.md, CONTRIBUTING, and package metadata, then summarize the build/run/test commands"
metadata:
  source: roycode-studio:server/magicDocs.ts
---

# Repository Documentation Discovery

Use when entering an unfamiliar repo, before modifying code, or when the user
asks "how do I build/test/run this?".

## Steps

1. **Top-level scan** — read `README.md`, `AGENTS.md`/`CLAUDE.md`,
   `CONTRIBUTING.md`, `package.json` (scripts), `Makefile`/taskfile,
   `docker-compose.yml`, `.github/workflows` (CI commands).
2. **docs/ tree** — if `docs/` or `doc/` exists, list it and read the
   getting-started / setup pages.
3. **Per-directory READMEs** — for larger repos, glob `**/README.md` and
   skim ones under the area being changed.
4. **Synthesize** — answer with the exact commands found (verbatim from the
   repo), noting where they came from. If docs are missing, say so instead of
   inventing commands.

## Rules

- Quote commands from the repo verbatim; do not guess flags.
- Prefer committed docs over model memory.
- If README is stale and the user fixes it, update the summary too.