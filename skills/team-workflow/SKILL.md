---
name: team-workflow
description: Run multi-member collaboration with the team_* tools: create a team, dispatch named subagents per role, exchange findings through the shared inbox, and settle consensus into shared memory
metadata:
  source: roycode-studio:server/teams.ts
---

# Team Collaboration Workflow

Use when the user wants multiple perspectives, role-based review, or parallel
subagent work that should converge ("让 reviewer 和 security 一起审查", "分组
调研", "多角色评审").

## Pattern

1. **Setup** — team_create(name, description); team_add_member per role
   (reviewer, security, planner, docs...). New members start reading at the
   point they join.
2. **Dispatch** — for each role: run_subagent / subagent with the role prompt;
   after each result, team_message(team, from: role, text: findings).
3. **Exchange** — before starting a later role, team_inbox(team, member: role)
   to read earlier findings (markRead: true after reading).
4. **Converge** — read the full thread, synthesize, and
   team_memory_append the durable consensus (decisions, constraints, TODOs).
5. **Report** — summarize per-role findings + consensus to the user.

## Rules

- One team per task; team_delete after the task unless the user wants to keep it.
- Always team_inbox before a role starts; always team_message after it ends.
- Keep memory to durable consensus only (capped at 50; overflow archives).
- Use team_archive when a team's message log grows past ~200 entries.
- A single quick second opinion needs one subagent, not a team — teams are for
  real multi-role collaboration.
