// Escort-required safety plan enforcement for hall passes.
//
// A student is "on escort hold" when they have a safety plan that is:
//   1. status = 'active'
//   2. escortRequired = true (explicit counselor answer in the editor)
//   3. within its start/end dates (school-timezone "today"; a plan with
//      no dates is always in-window while active)
//
// Consumers:
//   - POST /hall-passes (teacher flow): 409 ESCORT_REQUIRED with an
//     acknowledge-to-proceed override (teacher may BE the escort).
//   - Kiosk pass creation: hard block, neutral student-facing message
//     (never mention "safety plan" on a shared screen).
import { and, eq } from "drizzle-orm";
import { db, safetyPlansTable } from "@workspace/db";
import { getSchoolTimezone } from "./schoolYear";

function tzToday(tz: string): string {
  // en-CA gives YYYY-MM-DD directly.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export interface EscortHold {
  planId: number;
  // Active checklist item labels — shown to STAFF only (never the kiosk).
  activeItemLabels: string[];
}

export async function findEscortHold(
  schoolId: number,
  studentId: string,
): Promise<EscortHold | null> {
  const [plan] = await db
    .select({
      id: safetyPlansTable.id,
      items: safetyPlansTable.items,
      startDate: safetyPlansTable.startDate,
      endDate: safetyPlansTable.endDate,
    })
    .from(safetyPlansTable)
    .where(
      and(
        eq(safetyPlansTable.schoolId, schoolId),
        eq(safetyPlansTable.studentId, studentId),
        eq(safetyPlansTable.status, "active"),
        eq(safetyPlansTable.escortRequired, true),
      ),
    );
  if (!plan) return null;
  // Date-window check in the school's timezone. Dates are stored as
  // YYYY-MM-DD text, so plain string comparison is correct.
  const tz = await getSchoolTimezone(schoolId);
  const today = tzToday(tz);
  if (plan.startDate && today < plan.startDate) return null;
  if (plan.endDate && today > plan.endDate) return null;
  return {
    planId: plan.id,
    activeItemLabels: (plan.items ?? [])
      .filter((i) => i && i.active)
      .map((i) => i.label),
  };
}

// Student-facing kiosk message: deliberately neutral — no "safety plan",
// no reason, nothing another student at the kiosk could read into.
export const ESCORT_KIOSK_MESSAGE =
  "You can't start a pass here — please see your teacher.";
