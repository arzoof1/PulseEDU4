---
name: Tours overdue parity
description: All tour-lead overdue surfaces must share one helper so they never disagree.
---
Tour-lead "overdue" is computed in three places: the pipeline list (GET /tours/requests),
the lead detail drawer (GET /tours/requests/:id), and the hourly escalation sweep
(runTourEscalations). They MUST all call the same exported `overdueFor(lead, firstContactHours, now)`
in `lib/tourReminders.ts`. Three branches: new+past first-contact window -> `first_contact`;
scheduled+tourScheduledAt<now -> `tour_not_logged`; deciding+followUpDueAt<now -> `follow_up`.

**Why:** an earlier build left the detail drawer on legacy hardcoded `status==="new" && >24h`
logic and the client badge on wrong reason keys (not_toured/deciding_follow_up), so the drawer
and list disagreed on who was overdue and the badge fell through to a generic label.

**How to apply:** any new surface that shows or acts on tour overdue state routes through
overdueFor(); the client overdueBadgeLabel switch keys must mirror the server reasons exactly.
The detail endpoint must load tourFirstContactHours from school_settings (it doesn't by default).
