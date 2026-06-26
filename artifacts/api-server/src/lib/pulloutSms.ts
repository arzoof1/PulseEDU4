import { db, pulloutsTable, studentsTable, staffTable } from "@workspace/db";
import { and, eq, or } from "drizzle-orm";
import { sendSmsBatch, toE164 } from "./sms.js";

export type PulloutDispatchSmsResult = {
  recipients: number;
  sent: number;
  stubbed: number;
  failed: number;
};

// SMS sibling of sendPulloutDispatchEmail: text the dispatch team (active
// admin / dean / MTSS coordinator / ISS teacher in this pullout's school who
// have a cell phone on file) that a new pullout request was submitted. This is
// the "Text alerts for Request Pullout" use case called out in the launch
// clarification doc — staff-facing only.
//
// Best-effort: never throws, so a notification failure can't block the pullout
// insert. Inert until SMS is configured — sendSms() no-ops while SMS_ENABLED is
// off — so it is safe to call in the create flow today.
//
// FLEID-safe: the body uses the student's name / local SIS id only, never the
// canonical students.student_id.
export async function sendPulloutDispatchSms(
  pulloutId: number,
): Promise<PulloutDispatchSmsResult> {
  const empty: PulloutDispatchSmsResult = {
    recipients: 0,
    sent: 0,
    stubbed: 0,
    failed: 0,
  };
  try {
    const [p] = await db
      .select()
      .from(pulloutsTable)
      .where(eq(pulloutsTable.id, pulloutId));
    if (!p) return empty;

    // Same audience as the dispatch email, but keyed on cell phone.
    const dispatchers = await db
      .select({ active: staffTable.active, cellPhone: staffTable.cellPhone })
      .from(staffTable)
      .where(
        and(
          eq(staffTable.schoolId, p.schoolId),
          or(
            eq(staffTable.isAdmin, true),
            eq(staffTable.isDean, true),
            eq(staffTable.isMtssCoordinator, true),
            eq(staffTable.isIssTeacher, true),
          ),
        ),
      );
    const phones = dispatchers
      .filter((s) => s.active && s.cellPhone && toE164(s.cellPhone))
      .map((s) => s.cellPhone as string);
    if (phones.length === 0) return empty;

    const [student] = await db
      .select({
        firstName: studentsTable.firstName,
        lastName: studentsTable.lastName,
        localSisId: studentsTable.localSisId,
      })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.studentId, p.studentId),
          eq(studentsTable.schoolId, p.schoolId),
        ),
      );
    const name =
      [student?.firstName, student?.lastName].filter(Boolean).join(" ") ||
      student?.localSisId ||
      "A student";
    const idLabel = student?.localSisId ? ` (ID ${student.localSisId})` : "";
    const periodText = p.period ? `Period ${p.period}` : "Period n/a";
    const body =
      `PulseEDU: Pullout requested — ${name}${idLabel}, ${periodText}, ` +
      `by ${p.requestedByName}. Verify in PulseEDU → Verify Pullouts.`;

    const r = await sendSmsBatch(phones, body);
    return { recipients: phones.length, ...r };
  } catch {
    return empty;
  }
}
