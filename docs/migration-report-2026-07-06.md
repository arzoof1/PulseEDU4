# Migration Report — 2026-07-06 → present

Audience: developer migrating these changes to the **live/production** environment.
Scope: every schema, DB, and server-logic change since 2026-07-06. Purely
client-side (UI) changes are listed for completeness but need no DB work.

Source commits (oldest → newest):

| Commit  | Summary                                                        | DB change? |
|---------|---------------------------------------------------------------|-----------|
| d6ee390b | Allow teachers to send Family Messages to their own students | **YES** (1 new column) |
| 5bc60d83 | Sidebar navigation restructure (Family / Family (Admin) split, Pullout Notifications → Student Support) | No |
| f495d427 | Behavior Specialists auto-included in pullout notifications   | No |

---

## 1. DATABASE CHANGES (action required)

### 1.1 New column — `school_settings.teacher_family_messaging_enabled`

- **Commit:** d6ee390b
- **Table:** `school_settings`
- **Column:** `teacher_family_messaging_enabled BOOLEAN NOT NULL DEFAULT FALSE`
- **Why:** Gates whether non-Core-Team classroom teachers may send Family
  Messages to families on their own roster. **OFF by default** — an admin must
  opt in per school. Existing behavior is unchanged until a school flips it on.

**DDL to run against production:**

```sql
ALTER TABLE school_settings
  ADD COLUMN IF NOT EXISTS teacher_family_messaging_enabled BOOLEAN NOT NULL DEFAULT FALSE;
```

**Auto-migration note (important):** this project already applies additive
`school_settings` flags at server boot. On startup the API server runs
`ensureSchoolSettingsFeatureFlagsSchema()` (in `artifacts/api-server/src/seed.ts`),
which executes the exact `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...` above.
So if you deploy the new server build and let it boot against the live DB, the
column is created automatically. The manual DDL is provided only if you prefer
to run migrations explicitly ahead of the deploy. The statement is idempotent
(`IF NOT EXISTS`) and safe to run either way.

- **Drizzle source of truth:** `lib/db/src/schema/schoolSettings.ts`
  (`teacherFamilyMessagingEnabled` field).
- **No data backfill required** — the `DEFAULT FALSE` preserves current
  behavior for every existing school.
- **No indexes, constraints, enums, or FKs** were added or altered.

> This is the **only** schema/DB change in the entire date range.

---

## 2. SERVER LOGIC CHANGES (deploy the API build)

These ship with the server bundle — no DB step, but they must be deployed.

### 2.1 Teacher-scoped Family Messages (commit d6ee390b)
- `artifacts/api-server/src/routes/parentMessages.ts` — teachers whose school
  has `teacher_family_messaging_enabled = true` may compose messages to families
  of **one of their own class periods** or **hand-picked students from their own
  roster**. The server **re-enforces** own-periods / own-students scope on every
  send; the flag only decides *whether* a teacher may send. Core Team broadcast
  behavior is unchanged and does not depend on the flag.
- `artifacts/api-server/src/routes/schoolSettings.ts` — GET/PUT now read/write
  the new flag (admin-gated).
- `artifacts/api-server/src/seed.ts` — registers the new column in the boot
  migration (see §1.1).

### 2.2 Behavior Specialists in pullout notifications (commit f495d427)
- `artifacts/api-server/src/lib/pulloutEmail.ts` — Behavior Specialists
  (`staff.is_behavior_specialist = true`) are now included in the **default**
  pullout dispatch recipient set (email + SMS), alongside Admins, Deans, MTSS
  Coordinators, and ISS Teachers. Recipients remain de-duped and school-scoped.
- `artifacts/api-server/src/routes/pullouts.ts` — the notify-config UI now
  labels Behavior Specialists as auto-recipients so the displayed list matches
  who actually receives.
- **No DB change** — relies on the existing `staff.is_behavior_specialist`
  column.

---

## 3. CLIENT-ONLY CHANGES (no DB / no server; deploy the web build)

### 3.1 Navigation restructure (commit 5bc60d83)
- `artifacts/client/src/App.tsx` — split the "Family" sidebar group into
  **Family** (Student, Family Messages) and **Family (Admin)** (PulseDNA Studio,
  Call Campaign, Data Chats, Parent Access, Parent Notifications); moved
  **Pullout Notifications** into the **Student Support** group.

### 3.2 Family Messages UI (commit d6ee390b, client portion)
- `artifacts/client/src/App.tsx` and
  `artifacts/client/src/components/FamilyMessagesHub.tsx` — teacher composer UI +
  the new admin toggle wiring for `teacherFamilyMessagingEnabled`. (UI gating is
  convenience only; §2.1 server checks are authoritative.)

---

## 4. Migration checklist for production

1. **Schema:** run the DDL in §1.1 (or rely on the boot auto-migration — the
   API server applies it on startup). Idempotent; safe to run first.
2. **Deploy API server** build (includes §1 + §2).
3. **Deploy web client** build (includes §3).
4. **Verify:**
   - `school_settings.teacher_family_messaging_enabled` exists and defaults to
     `FALSE` for all schools.
   - A Behavior-Specialist-only staffer appears as an auto-recipient on the
     Pullout Notifications config page and receives a dispatch on the next
     pullout.
   - No behavior change for teacher messaging until an admin opts a school in.
5. **Rollback:** all changes are additive. The new column can remain in place if
   you roll back code (it is simply unused). No destructive migration to undo.

---

_Environment note: this workspace and the live host use separate databases.
Confirm the DDL / boot migration ran against the **production** DB specifically —
verifying it in the workspace does not confirm it in prod._
