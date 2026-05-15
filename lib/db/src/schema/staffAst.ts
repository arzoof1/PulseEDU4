import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// Alternate Schedule Time (AST) per HCTA contract.
//
// State machine
// =============
// Earn:
//   pending_preapproval
//     ├─ admin approves → preapproved
//     │                     ├─ staff completes → pending_confirm
//     │                     │                      ├─ admin confirms → confirmed [+credit]
//     │                     │                      └─ admin denies   → denied
//     │                     └─ staff cancels    → cancelled
//     └─ admin denies → denied
//
// Use:
//   pending_preapproval
//     ├─ admin approves → preapproved [-debit immediately]
//     ├─ admin denies   → denied (notes box prompts re-request)
//     └─ staff cancels  → cancelled
//
// Quarter-hours
// =============
// Stored as INTEGER count of ¼-hour units to avoid float drift. Display
// converts: 5 = 1.25 hr, 13 = 3.25 hr. Server enforces n > 0 on submit
// and (sum of confirmed - sum of approved-use) >= 0 on every use approval.
//
// Audit
// =====
// Every state transition stamps an actor + timestamp + optional note onto
// the request row. The ledger is append-only — credits and debits both
// reference the originating request. Year-end lapse and voluntary
// mid-year transfer post a single negative-balance ledger row with
// `kind = 'year_end_lapse'` / `'transfer_lapse'` (request_id NULL).
export const staffAstRequestsTable = pgTable(
  "staff_ast_requests",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    staffId: integer("staff_id").notNull(),

    // 'earn' | 'use'
    kind: text("kind").notNull(),

    // 'pending_preapproval' | 'preapproved' | 'denied'
    //   | 'pending_completion' (earn only — currently unused: we go straight
    //     from preapproved to pending_confirm when staff submits completion)
    //   | 'pending_confirm'    (earn only — completion submitted, awaiting admin)
    //   | 'confirmed'          (earn only — credit posted)
    //   | 'cancelled'
    state: text("state").notNull().default("pending_preapproval"),

    // EARN: the date/event the staff is requesting to work extra. Free-form
    // text reason is required at submit time ("Open House", "Parent
    // conference", "Extended faculty meeting"). Date is ISO YYYY-MM-DD.
    eventDate: text("event_date"),
    reason: text("reason"),

    // EARN requested vs actual. Both in quarter-hour units.
    quarterHoursRequested: integer("quarter_hours_requested").notNull(),
    quarterHoursActual: integer("quarter_hours_actual"),

    // USE: free-form start / end timestamps (ISO). No date enforcement —
    // staff picks their own start/end, admin uses the deny notes box if
    // the times are off. Duration in quarter-hours is computed at submit
    // and stored in quarterHoursRequested above so the queries don't
    // have to recompute.
    useStartAt: timestamp("use_start_at", { withTimezone: true }),
    useEndAt: timestamp("use_end_at", { withTimezone: true }),

    // Audit columns. Every transition writes the actor + timestamp + note.
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    preapprovedAt: timestamp("preapproved_at", { withTimezone: true }),
    preapprovedByStaffId: integer("preapproved_by_staff_id"),
    preapprovalNote: text("preapproval_note"),
    completionSubmittedAt: timestamp("completion_submitted_at", {
      withTimezone: true,
    }),
    completionNote: text("completion_note"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    confirmedByStaffId: integer("confirmed_by_staff_id"),
    confirmNote: text("confirm_note"),
    deniedAt: timestamp("denied_at", { withTimezone: true }),
    deniedByStaffId: integer("denied_by_staff_id"),
    denyNote: text("deny_note"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelNote: text("cancel_note"),
  },
  (t) => ({
    bySchoolStaff: index("staff_ast_requests_school_staff_idx").on(
      t.schoolId,
      t.staffId,
    ),
    bySchoolState: index("staff_ast_requests_school_state_idx").on(
      t.schoolId,
      t.state,
    ),
  }),
);

export type StaffAstRequestRow =
  typeof staffAstRequestsTable.$inferSelect;

// Append-only ledger. Bank balance for a staff = SUM(delta_quarter_hours)
// over rows where school_id = X and staff_id = Y. Never delete rows; the
// year-end lapse posts a negative-balance row to bring the bank back to
// zero so history is preserved.
export const staffAstLedgerTable = pgTable(
  "staff_ast_ledger",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    staffId: integer("staff_id").notNull(),

    // Positive on earn-confirm, negative on use-approval / lapse / transfer.
    deltaQuarterHours: integer("delta_quarter_hours").notNull(),

    // 'earn_confirm' | 'use_approval' | 'year_end_lapse' | 'transfer_lapse'
    //   | 'admin_adjustment'
    kind: text("kind").notNull(),

    // Originating request, null for system-posted rows (lapse, transfer,
    // manual admin adjustment).
    requestId: integer("request_id"),
    note: text("note"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdByStaffId: integer("created_by_staff_id"),
  },
  (t) => ({
    bySchoolStaff: index("staff_ast_ledger_school_staff_idx").on(
      t.schoolId,
      t.staffId,
    ),
  }),
);

export type StaffAstLedgerRow = typeof staffAstLedgerTable.$inferSelect;
