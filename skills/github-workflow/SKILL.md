---
name: github-workflow
description: "Drive a GitHub issue-to-PR loop with the mcp__github__* tools: triage issues, inspect PR comments, open a branch, commit, push, and open or update a pull request"
metadata:
  source: roycode-studio:server/github.ts
---

# GitHub Issue → PR Workflow

Use this when the user asks to work on a GitHub issue, review PR comments,
open a PR, or generally "take something on GitHub". It assumes the
`mcp__github__*` tools are connected (repo owner RoyDevCh).

## Flow

1. **Triage** — `mcp__github__list_issues` (filter: state, labels) or
   `mcp__github__get_issue` for one issue. Read the body and comments
   (`mcp__github__list_issue_comments` via `get_issue`/comments API).
2. **Understand the repo** — `mcp__github__get_file_contents` on
   README/AGENTS.md first; `mcp__github__search_code` when hunting a
   symbol across the repo.
3. **Branch** — `mcp__github__create_branch` from the default branch with a
   short kebab-case name (`fix/issue-12-timezone`).
4. **Change code locally** — use the local workspace tools (read/edit/pwsh).
   Keep changes small and focused on the issue.
5. **Open the PR** — `mcp__github__create_pull_request` with a title that
   names the issue and a body that explains what and why. Mention
   `Closes #<n>` when it fixes the issue.
6. **Iterate on review** — `mcp__github__get_pull_request_comments` /
   `get_pull_request_reviews` after pushes; reply and re-push changes.

## Rules

- Prefer reading the issue + related code before writing any code.
- One PR = one issue unless the user says otherwise.
- Check `mcp__github__get_pull_request_status` before claiming a PR is ready.
- Never guess repo/branch names — verify with list_* tools first.