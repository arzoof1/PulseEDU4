import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// =============================================================================
// Family Messages — admin/Core-Team → parent broadcast announcements.
//
// A Core Team member composes one message (subject + body + optional .png/.pdf
// attachment), targets an audience (whole school or specific grades), and the
// server fans it out into per-family rows. Each family sees the message in
// their Parent Portal inbox with a "Got it" button; an optional Resend email
// nudge links back to the portal.
//
// Counters are REAL, not estimates: every targeted family gets one
// parent_message_recipients row, so "Reached" and "Got it" are COUNT()s over
// that table — never a guess.
//
// Tenancy: school_id stamped on both tables; every read/write is school-scoped.
// =============================================================================

export const parentMessagesTable = pgTable(
  "parent_messages",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    // Staff member (Core Team) who sent it.
    createdByStaffId: integer("created_by_staff_id").notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    // Optional single attachment, stored in object storage and bound to the
    // school (reuses the /api/storage/* + bindObjectToSchool pattern). Only
    // image/png or application/pdf are accepted at the route layer.
    attachmentObjectKey: text("attachment_object_key"),
    attachmentName: text("attachment_name"),
    attachmentType: text("attachment_type"),
    // Optional PulseDNA video attachment (pulse_dna_videos.id). When set, the
    // message renders an inline video the family can play/download. Attaching a
    // video to a sent message flips that video to school-year retention.
    videoId: integer("video_id"),
    // Audience selector. One of:
    //   "school"   — every family in the school.
    //   "grade"    — families with a student in `audienceGrades`.
    //   "house"    — families with a student in `audienceHouseIds`.
    //   "students" — families of the explicit `audienceStudentIds` set
    //                (resolved from a CSV upload of local SIS IDs).
    audienceType: text("audience_type").notNull().default("school"),
    audienceGrades: text("audience_grades").array(),
    audienceHouseIds: integer("audience_house_ids").array(),
    // students.id values resolved from the uploaded CSV (matched by
    // local_sis_id within this school). Kept for "who was targeted" display
    // and potential re-sends; the per-family fan-out lives in recipients.
    audienceStudentIds: integer("audience_student_ids").array(),
    // Whether an email nudge was requested at send time.
    emailNudge: boolean("email_nudge").notNull().default(true),
    // Snapshots taken at send time so the list view is cheap and stable:
    //  - totalRecipients: distinct families targeted.
    //  - reachedRecipients: families we actually delivered to via any channel.
    // "Got it" is computed live from recipients.acknowledgedAt (it changes as
    // parents tap), so it is NOT snapshotted here.
    totalRecipients: integer("total_recipients").notNull().default(0),
    reachedRecipients: integer("reached_recipients").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    bySchool: index("parent_messages_by_school").on(t.schoolId, t.createdAt),
  }),
);

export const insertParentMessageSchema = createInsertSchema(
  parentMessagesTable,
).omit({ id: true, createdAt: true });
export type InsertParentMessage = z.infer<typeof insertParentMessageSchema>;
export type ParentMessageRow = typeof parentMessagesTable.$inferSelect;

// -----------------------------------------------------------------------------
// parent_message_recipients — one row per (message × family). The "family" is a
// guardian, identified by `recipientKey`:
//   - "p:<parentId>" when the guardian has a Parent Portal account.
//   - "e:<email>"    when we only have an on-file email (no account yet).
// Storing the qualifying students as an array (not one row per student) keeps a
// two-child family from getting duplicate inbox entries for a school-wide note.
// -----------------------------------------------------------------------------
export const parentMessageRecipientsTable = pgTable(
  "parent_message_recipients",
  {
    id: serial("id").primaryKey(),
    messageId: integer("message_id").notNull(),
    schoolId: integer("school_id").notNull(),
    // Stable dedup key per family within a message (see header).
    recipientKey: text("recipient_key").notNull(),
    // Present when the guardian has a portal account (enables "Got it").
    parentId: integer("parent_id"),
    // Snapshot of the address we nudged (may be null if portal-only / no email).
    email: text("email"),
    // students.id values this family qualified through (for portal context).
    studentIds: integer("student_ids").array().notNull(),
    deliveredPortal: boolean("delivered_portal").notNull().default(false),
    deliveredEmail: boolean("delivered_email").notNull().default(false),
    // Set when the parent taps "Got it" in the portal. Only possible for rows
    // that have a parentId (an account). NULL = not yet acknowledged.
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // One row per family per message.
    uniquePerMessage: uniqueIndex("parent_message_recipients_unique").on(
      t.messageId,
      t.recipientKey,
    ),
    byMessage: index("parent_message_recipients_by_message").on(t.messageId),
    // Parent Portal inbox lookup: "messages for me".
    byParent: index("parent_message_recipients_by_parent").on(
      t.schoolId,
      t.parentId,
    ),
  }),
);

export type ParentMessageRecipientRow =
  typeof parentMessageRecipientsTable.$inferSelect;
