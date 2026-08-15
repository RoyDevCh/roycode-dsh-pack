---
name: scheduled-prompts
description: Set up durable reminders and recurring prompts with schedule_create/schedule_list/schedule_delete (after_seconds, at, or every_seconds) when the user asks for a reminder, a daily/weekly task, or "wake me later"
metadata:
  source: roycode-studio:server/cron.ts
---

# Scheduled Prompts

Use when the user asks for a timed reminder, a recurring prompt ("每天 9 点
总结", "半小时后提醒我"), or a scheduled follow-up.

## Tools

- `schedule_create` — one of:
  - `after_seconds`: positive safe integer (delay)
  - `at`: RFC3339 UTC instant or { date, time, time_zone }
  - `every_seconds`: fixed-rate repeat, at least 300
- `schedule_list` — active records with state scheduled/overdue
- `schedule_delete` — by id

## Flow

1. Ask for the exact target if ambiguous (relative delay vs absolute time vs
   interval; which timezone).
2. Create with the strictest matching selector. Absolute local times require
   an explicit IANA time_zone.
3. Confirm with `schedule_list` and report the id.

## Rules

- Never guess a timezone; ask or use UTC.
- `every` intervals below 300 seconds are rejected — propose 300+.
- Reminders fire as a later turn in the same session; they do not interrupt
  the current conversation.
- If the schedule tools are unavailable in this session, say so and offer a
  cron alternative or a one-shot sleep-based approach instead.
