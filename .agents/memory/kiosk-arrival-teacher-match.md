---
name: Kiosk arrival matching (teacher-named destinations)
description: Why a kiosk must match inbound passes by teacher displayName, not only the activated room string, and the lockstep rule.
---

# Kiosk "Heading here" / check-in matching

A kiosk activation is BOTH a physical room (free-text `room`, e.g. "203")
AND the teacher who activated it (`staffId`). In schools that name hall-pass
destinations after the teacher (e.g. `"Amy Brown - Math G7"`), the destination
string never equals the activated room string, so the old
`destination === act.room` match silently dropped every inbound pass — the
student never appeared on the destination kiosk and couldn't self-check-in.

**Rule:** a pass is "heading to" a kiosk when
`destination === act.room` **OR** `destination === <displayName of act.staffId>`.
Centralized in `passHeadsToKiosk` (`lib/oneWayPass.ts`).

**Why not match `destinationTeacher`:** that column is currently never
populated, and matching it would let a pass whose `destination` is some OTHER
location check in at this kiosk. Destination already carries the teacher
identity, so the `destinationTeacher` branch was deliberately dropped.

**Lockstep invariant:** the queue's `arrivalsToHere` list
(`hallPassQueue.ts GET /kiosk/queue/:token`) and the check-in guard
(`kiosk.ts POST .../arrive`) MUST use the same matcher, or the chip shows but
tapping 403s (or vice-versa). Both also exclude restroom destinations
(restroom passes are round-trip — student taps "I'm back" at their own room,
never a destination check-in).

**Known limitation (accepted):** a kiosk activated by a non-destination person
(sub / front desk) only catches that activating person's inbound passes.
Duplicate teacher displayNames within a school are ambiguous — but that
ambiguity already lives in the destination model (destinations ARE displayName
strings), not introduced here.

**Why:** mirrors the already-shipped staff-app "Heading to me" displayName
match, so the kiosk and the teacher's staff view agree on who is inbound.
