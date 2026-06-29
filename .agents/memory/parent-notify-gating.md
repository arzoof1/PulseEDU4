---
name: Parent notification toggles
description: How per-school parent-notification on/off switches are enforced and why the send-site read placement matters
---

- Per-school "turn off this automated parent email" switches must be enforced at the **server send site**, not just hidden in the admin panel — client gating is bypassable. The shared gate is `lib/parentNotify.ts` `isParentNotifyEnabled(schoolId, key)`.
- The helper returns `row?.v ?? true`. **Why:** the product rule is "default = today's behavior, no change until flipped." A missing/null column or row must mean ENABLED, so the `?? true` default is load-bearing — never flip it to `?? false`.
- Eligibility gating must wrap ONLY the parent-email branch (`if (parentEmail && notifyOn)`); coach / principal / AD / digest copies are separate audiences and stay unaffected.
- **Best-effort gate-read placement:** when a notification is fired *after* a row is already inserted (e.g. tardy POST), the `await isParentNotifyEnabled(...)` read must live INSIDE the existing try/catch, not in the `if` condition that guards it. **Why:** a settings-table read can throw; if it's outside the try it fails the request after the mutation already committed, breaking the route's best-effort non-fatal-notification contract. **How to apply:** any new send-site gate added to a fire-and-forget block goes inside that block's try.
- Reuse existing switches rather than minting new columns: HeartBEAT→`school_heartbeat_settings.allow_weekly_email`, Family Messages→`featureFamilyComm`, Store→`featureSchoolStoreNotify`, Tour→`tourFamilyNurtureEnabled`. Feature-flag-backed rows are dual-gated (admin + SuperUser tier) — lock them in the panel when the district tier is off.
