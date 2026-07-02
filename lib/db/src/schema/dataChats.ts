import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Data Chat / Check-In campaign engine.
//
// Templates are the reusable blueprints (one built-in "FAST Data Chat" per
// school, kind='fast_data', non-deletable; admins can add custom kinds for
// special initiatives). Campaigns are a template launched at a teacher set
// with a deadline — the checklist, goal chips, and family-share flag are
// SNAPSHOTTED onto the campaign row so later template edits never rewrite
// history and past deployments stay comparable.
//
// Assignment modes:
//   subject_teachers -> FAST campaigns; pairs come from class_sections whose
//                       course name infers to the campaign subject (ela|math|
//                       both), joined to section_roster (teacher of record).
//   selected         -> custom campaigns; admin picks teachers; each
//                       teacher's students at responsiblePeriod (Call
//                       Campaign convention, default period 1).
export const dataChatTemplatesTable = pgTable(
  "data_chat_templates",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    name: text("name").notNull(),
    // 'fast_data' (built-in, shows the PM data panel + data-driven goal
    // chips) | 'custom' (admin-built checklist + optional written chips).
    kind: text("kind").notNull().default("custom"),
    builtIn: boolean("built_in").notNull().default(false),
    // JSON array of { id: string, label: string }.
    checklistJson: text("checklist_json").notNull().default("[]"),
    // JSON array of strings (suggested goal chips for custom templates;
    // fast_data campaigns also auto-generate chips from the student's data).
    goalChipsJson: text("goal_chips_json").notNull().default("[]"),
    // Whether logs from campaigns of this template appear on the family
    // HeartBEAT (topics + goal). Teacher drawer clearly labels the mode.
    shareWithFamilies: boolean("share_with_families").notNull().default(true),
    archived: boolean("archived").notNull().default(false),
    createdByStaffId: integer("created_by_staff_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    schoolIdx: index("data_chat_templates_school_idx").on(
      t.schoolId,
      t.archived,
    ),
  }),
);

export const dataChatCampaignsTable = pgTable(
  "data_chat_campaigns",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    templateId: integer("template_id").notNull(),
    name: text("name").notNull(),
    // Snapshot of template.kind at launch.
    kind: text("kind").notNull().default("custom"),
    // fast_data campaigns only: 'ela' | 'math' | 'both'.
    subject: text("subject"),
    // 'subject_teachers' | 'selected'
    assignmentMode: text("assignment_mode").notNull().default("selected"),
    // JSON array of staff ids (selected mode only).
    selectedTeacherIdsJson: text("selected_teacher_ids_json")
      .notNull()
      .default("[]"),
    responsiblePeriod: integer("responsible_period").notNull().default(1),
    // Snapshots (see header comment).
    checklistJson: text("checklist_json").notNull().default("[]"),
    goalChipsJson: text("goal_chips_json").notNull().default("[]"),
    shareWithFamilies: boolean("share_with_families").notNull().default(true),
    startDate: text("start_date").notNull(), // YYYY-MM-DD school-local
    deadline: text("deadline").notNull(), // YYYY-MM-DD school-local
    active: boolean("active").notNull().default(true),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdByStaffId: integer("created_by_staff_id"),
    createdByName: text("created_by_name"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    schoolActiveIdx: index("data_chat_campaigns_school_active_idx").on(
      t.schoolId,
      t.active,
    ),
  }),
);

// One row per (campaign, teacher, student) — a student with different ELA
// and Math teachers in a 'both' campaign is chatted (and logged) by each.
export const dataChatLogsTable = pgTable(
  "data_chat_logs",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    campaignId: integer("campaign_id").notNull(),
    studentId: text("student_id").notNull(),
    teacherStaffId: integer("teacher_staff_id").notNull(),
    // Subject this pair was derived from ('ela'|'math'|null for custom).
    subject: text("subject"),
    // JSON array of checklist item ids checked.
    discussedJson: text("discussed_json").notNull().default("[]"),
    // Family-visible goal / next step (shown on the HeartBEAT when the
    // campaign shares with families).
    goal: text("goal").notNull().default(""),
    // Staff-only note; never leaves the staff side.
    privateNote: text("private_note").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pairUnique: uniqueIndex("data_chat_logs_pair_unique").on(
      t.campaignId,
      t.teacherStaffId,
      t.studentId,
    ),
    studentIdx: index("data_chat_logs_school_student_idx").on(
      t.schoolId,
      t.studentId,
    ),
  }),
);

export type DataChatTemplateRow = typeof dataChatTemplatesTable.$inferSelect;
export type DataChatCampaignRow = typeof dataChatCampaignsTable.$inferSelect;
export type DataChatLogRow = typeof dataChatLogsTable.$inferSelect;
