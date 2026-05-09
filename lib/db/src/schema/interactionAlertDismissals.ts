import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Alert dismissals / snoozes. Alerts themselves are computed live (no
// alerts table); this small log lets the hub hide an alert that the
// Core Team explicitly dismissed or snoozed for N days.
//
// `subjectKey` is the rule-specific dedup key (e.g.
// "always-peripheral:14" or "frequency:14:5"). Combined with
// (school, rule, student) it identifies the exact alert instance.
export const interactionAlertDismissalsTable = pgTable(
  "interaction_alert_dismissals",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    // 'frequency' | 'always-peripheral' | 'co-occurrence' |
    // 'stale-statement' | 'loose-escalation'
    ruleKind: text("rule_kind").notNull(),
    // The student the alert is "about". For co-occurrence rules with
    // two subjects, we store one row per subject.
    subjectStudentId: text("subject_student_id").notNull(),
    subjectKey: text("subject_key").notNull().default(""),
    dismissedByStaffId: integer("dismissed_by_staff_id"),
    dismissedByName: text("dismissed_by_name").notNull().default(""),
    dismissReason: text("dismiss_reason").notNull().default(""),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // NULL = permanent dismiss; otherwise alert reappears after this time.
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => ({
    schoolIdx: index("interaction_alert_dismissals_school_idx").on(t.schoolId),
    activeIdx: uniqueIndex(
      "interaction_alert_dismissals_active_idx",
    ).on(t.schoolId, t.ruleKind, t.subjectStudentId, t.subjectKey),
  }),
);
export type InteractionAlertDismissalRow =
  typeof interactionAlertDismissalsTable.$inferSelect;
