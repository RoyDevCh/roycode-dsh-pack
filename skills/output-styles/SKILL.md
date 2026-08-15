---
name: output-styles
description: Apply a named output style to answers — explanatory, learning, or concise — when the user asks for a particular tone or depth of explanation
metadata:
  source: roycode-studio:server/outputStyles.ts
---

# Output Styles

Pick a style when the user asks for a specific tone ("解释一下", "教教我",
"简短一点") or when the task benefits from one.

## Styles

- **explanatory** — explain implementation choices and codebase patterns
  while completing the task. Brief educational notes before/after meaningful
  changes; do not turn every answer into a tutorial.
- **learning** — act like a collaborative coding mentor: explain the reasoning
  behind changes, prefer small concrete teaching moments, still finish the
  work instead of stopping for homework.
- **concise** — minimal prose; answer, code, done. Default when the user asks
  for brevity or when the task is mechanical.

## Rules

- Default: concise for mechanical work, explanatory for design decisions.
- Switch styles mid-task only when the user asks.
- Never let style reduce correctness: full commands, exact paths, real code.
