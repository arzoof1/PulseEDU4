---
name: Data Chat follow-up auto-complete guard
description: How logging a chat decides whether to complete vs preserve a pending follow-up
---

Logging ANY chat auto-completes the teacher+student's pending follow-up, EXCEPT
a follow-up the teacher deliberately scheduled/rescheduled **today for a future
date** (the schedule-next-then-log flow).

**Why:** A teacher often logs a chat and immediately schedules the NEXT
follow-up in the same modal session — completing it would erase the plan they
just made. But a follow-up **snoozed** earlier the same day must still complete
when the chat actually happens, or it lingers as a stale reminder.

**How to apply:** The discriminator is `snoozeCount === 0`: schedule and
reschedule reset the counter, snooze increments it. So the skip condition is
`updatedAt is today (school tz) AND dueDate > today AND snoozeCount === 0`.
Don't replace this with a plain "touched today" check — that silently breaks
the snoozed-then-chatted case. Any new write path on `data_chat_followups`
must keep the counter semantics (reset on schedule/reschedule, increment on
snooze) or the guard misfires.
