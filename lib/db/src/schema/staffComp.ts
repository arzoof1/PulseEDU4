import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
  boolean,
} from "drizzle-orm/pg-core";

// Comp Time (FLSA compensatory time) — non-exempt-only earn/use bank.
//
// Mirrors AST end-to-end (see lib/db/src/schema/staffAst.ts). Differences
// vs AST that are baked into the model here:
//
//   * Eligibility: non-exempt employees only. The route layer hard-blocks
//     submissions when staff.exempt_status != 'non_exempt'.
//   * Earn math: 1.5x hours worked over 40 per workweek (FLSA). The
//     request carries both hoursWorkedQh (raw) and computedCreditQh
//     (1.5x overflow), persisted at submit so audit history is intact
//     even if the workweek boundary later changes.
//   * Hard cap: 240 hours (960 quarter-hours). The route returns 409
//     "would exceed 240 h cap" on the offending submission.
//   * No annual lapse — comp time is contractually banked.
//   * Mid-year transfer: balance moves with the employee via paired
//     transfer_out / transfer_in ledger rows (same shape as AST).
//   * Payout: 'payout' ledger row zeroes the balance when an employee
//     flips to exempt OR separates. PDF receipt is generated elsewhere.
//   * Authorization form: each earn request must reference an uploaded
//     "Authorization to Accrue Comp Time" object key (re-uses the
//     existing /api/storage/* path with bindObjectToSchool). Mirrored
//     workflow: admin uploads a blank template in Settings → staff
//     downloads + signs → staff re-uploads signed copy on submit.
//
// State machine (identical to AST):
//
//   Earn:
//     pending_preapproval
//       ├─ admin approves → preapproved
//       │                     ├─ staff completes → pending_confirm
//       │                     │                      ├─ admin confirms → confirmed [+credit]
//       │                     │                      └─ admin denies   → denied
//       │                     └─ staff cancels    → cancelled
//       └─ admin denies → denied
//
//   Use:
//     pending_preapproval
//       ├─ admin approves → preapproved [-debit immediately]
//       ├─ admin denies   → denied
//       └─ staff cancels  → cancelled
//
// Storage unit: integer quarter-hours, matching AST so a future
// "unified time tracker" surface can sum across both without unit
// conversion.

export const staffCompRequestsTable = pgTable(
  "staff_comp_requests",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    staffId: integer("staff_id").notNull(),

    // 'earn' | 'use'
    kind: text("kind").notNull(),

    // Identical state set to AST.
    state: text("state").notNull().default("pending_preapproval"),

    // EARN: the workweek (Mon-Sun OR Sun-Sat depending on
    // school_settings.workweek_start) that produced the overflow,
    // anchored by `weekStartDate` (ISO YYYY-MM-DD, school-local).
    // The free-form `reason` mirrors AST: required at submit
    // ("Open House", "Storm cleanup", "Parent conferences").
    weekStartDate: text("week_start_date"),
    reason: text("reason"),

    // EARN math. Raw hours worked over 40 in the week (in quarter-hours)
    // and the 1.5x credit baked at submit time. Persisting both lets
    // an admin audit the math without re-deriving from a workweek
    // boundary that may have shifted.
    hoursWorkedQh: integer("hours_worked_qh"),
    computedCreditQh: integer("computed_credit_qh"),
    // Mirrors AST.quarter_hours_requested + .quarter_hours_actual so
    // shared rendering helpers can keep one shape. For EARN these
    // equal computedCreditQh at submit; staff resubmits actual at
    // completion (e.g. they ended up working different hours).
    quarterHoursRequested: integer("quarter_hours_requested").notNull(),
    quarterHoursActual: integer("quarter_hours_actual"),

    // USE window. Free-form start/end timestamps (ISO).
    useStartAt: timestamp("use_start_at", { withTimezone: true }),
    useEndAt: timestamp("use_end_at", { withTimezone: true }),

    // Authorization to Accrue Comp Time — signed form uploaded by
    // staff on each earn submit (required if school_settings.
    // comp_time_require_auth_form is true). Object key in
    // /api/storage/*, school-bound. Nullable so use-requests don't
    // carry it.
    authFormObjectKey: text("auth_form_object_key"),
    // Required acknowledgement: "I recorded these hours on my
    // timesheet" — kept as a boolean for audit, gated by the route.
    timesheetConfirmed: boolean("timesheet_confirmed")
      .notNull()
      .default(false),
    // Required acknowledgement: "I obtained prior supervisor approval
    // before working these hours." FLSA expectation; the form upload
    // is the paper trail, this flag is the staff attestation.
    priorSupervisorApprovalConfirmed: boolean(
      "prior_supervisor_approval_confirmed",
    )
      .notNull()
      .default(false),

    // Audit columns — identical naming to AST so a future "review my
    // requests" surface can share components.
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

    staffAcknowledgedAt: timestamp("staff_acknowledged_at", {
      withTimezone: true,
    }),
  },
  (t) => ({
    bySchoolStaff: index("staff_comp_requests_school_staff_idx").on(
      t.schoolId,
      t.staffId,
    ),
    bySchoolState: index("staff_comp_requests_school_state_idx").on(
      t.schoolId,
      t.state,
    ),
  }),
);

export type StaffCompRequestRow = typeof staffCompRequestsTable.$inferSelect;

// Append-only ledger. Same shape as AST so a future unified time
// tracker can sum across both with one helper.
//
// kind:
//   'earn_confirm'       — positive credit on admin confirm
//   'use_approval'       — negative debit when admin approves use
//   'transfer_in'        — positive credit on inter-school transfer
//   'transfer_out'       — negative debit on inter-school transfer
//   'payout'             — negative debit when staff flips to exempt
//                          OR separates (PDF receipt issued)
//   'admin_adjustment'   — manual +/- by an admin, with required note
//
// Hard cap (240 h = 960 qh) is enforced at the route layer on
// earn_confirm + admin_adjustment inserts; the column itself does
// not constrain.
export const staffCompLedgerTable = pgTable(
  "staff_comp_ledger",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    staffId: integer("staff_id").notNull(),

    deltaQuarterHours: integer("delta_quarter_hours").notNull(),

    kind: text("kind").notNull(),

    requestId: integer("request_id"),
    note: text("note"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdByStaffId: integer("created_by_staff_id"),
  },
  (t) => ({
    bySchoolStaff: index("staff_comp_ledger_school_staff_idx").on(
      t.schoolId,
      t.staffId,
    ),
  }),
);

export type StaffCompLedgerRow = typeof staffCompLedgerTable.$inferSelect;

// Hard FLSA cap — 240 hours = 960 quarter-hours.
export const COMP_TIME_MAX_QH = 240 * 4;
// FLSA multiplier on overflow hours, stored as numerator/denominator
// to keep integer-only quarter-hour math. credit = ceil(overflowQh * 3 / 2)
// at the application layer; constants live here so the route, tests,
// and any future client-side preview share one number.
export const COMP_TIME_MULTIPLIER_NUM = 3;
export const COMP_TIME_MULTIPLIER_DEN = 2;
// Workweek threshold above which overflow accrues (40 h → 160 qh).
export const COMP_TIME_WEEK_THRESHOLD_QH = 40 * 4;
