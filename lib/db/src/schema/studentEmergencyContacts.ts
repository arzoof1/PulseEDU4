import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Up to 4 emergency contacts per student, populated from the SIS feed
// where available (Skyward / Focus expose a contact list with
// relationship + phone-type metadata). For now this is read-only on the
// staff side: when an admin opens the Add ISS / OSS Log modal, the
// student card surfaces these contacts so a staff member can call them
// without leaving the screen.
//
// `slot` (1-4) controls display order so a student always shows
// "Mom / Dad / Grandma / Aunt" in the same positions across the app.
// `phoneLabel` carries the SIS phone-type ("Cell", "Home", "Work").
// `relationship` is the SIS contact-type ("Mom", "Step-Dad", etc).
export const studentEmergencyContactsTable = pgTable(
  "student_emergency_contacts",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    studentId: text("student_id").notNull(),
    slot: integer("slot").notNull(),
    contactName: text("contact_name").notNull(),
    relationship: text("relationship"),
    phone: text("phone"),
    phoneLabel: text("phone_label"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqStudentSlot: uniqueIndex("student_emergency_contact_slot_uq").on(
      t.schoolId,
      t.studentId,
      t.slot,
    ),
  }),
);

export type StudentEmergencyContactRow =
  typeof studentEmergencyContactsTable.$inferSelect;
