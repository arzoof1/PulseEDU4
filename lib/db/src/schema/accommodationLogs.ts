import { pgTable, serial, text, integer, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const accommodationLogsTable = pgTable(
  "accommodation_logs",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull().default(1),
    studentId: text("student_id").notNull(),
    accommodationId: integer("accommodation_id"),
    accommodation: text("accommodation").notNull(),
    period: integer("period"),
    staffId: integer("staff_id"),
    staffName: text("staff_name").notNull(),
    status: text("status").notNull().default("provided"),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    // Race-safe duplicate guard for the bulk Daily Class Log endpoint.
    // Day key is derived from the ISO string (UTC) — must match the
    // server-side duplicate pre-check which also uses UTC midnight.
    providedUniquePerDay: uniqueIndex(
      "accommodation_logs_provided_unique_per_day",
    )
      .on(
        t.studentId,
        t.accommodationId,
        t.period,
        sql`substring(${t.createdAt}, 1, 10)`,
      )
      .where(sql`${t.status} = 'provided' AND ${t.accommodationId} IS NOT NULL`),
  }),
);

export type AccommodationLogRow = typeof accommodationLogsTable.$inferSelect;
