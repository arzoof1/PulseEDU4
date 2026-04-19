import {
  db,
  pbisEntriesTable,
  pbisMilestonesTable,
  pbisMilestoneEmailsTable,
  studentsTable,
  schoolSettingsTable,
} from "@workspace/db";
import { eq, and, isNull } from "drizzle-orm";
import { getUncachableResendClient } from "./resendClient";

export type MilestoneResult = {
  milestonePoints: number;
  status: "sent" | "skipped" | "error";
  emailTo: string | null;
  errorMsg: string | null;
};

export async function processMilestonesForStudent(
  studentId: string,
): Promise<MilestoneResult[]> {
  const milestones = await db
    .select()
    .from(pbisMilestonesTable)
    .where(eq(pbisMilestonesTable.active, true));
  if (milestones.length === 0) return [];

  const entries = await db
    .select()
    .from(pbisEntriesTable)
    .where(eq(pbisEntriesTable.studentId, studentId));
  const total = entries
    .filter((e) => !e.voidedAt)
    .reduce((s, e) => s + e.points, 0);

  const reached = milestones.filter((m) => total >= m.points);
  if (reached.length === 0) return [];

  const sent = await db
    .select()
    .from(pbisMilestoneEmailsTable)
    .where(eq(pbisMilestoneEmailsTable.studentId, studentId));
  const sentSet = new Set(sent.map((s) => s.milestonePoints));

  const candidates = reached
    .filter((m) => !sentSet.has(m.points))
    .sort((a, b) => a.points - b.points);
  if (candidates.length === 0) return [];

  // CLAIM-BEFORE-SEND: insert a "pending" row per candidate; the unique
  // index on (student_id, milestone_points) ensures only one concurrent
  // worker actually sends.
  const todo: typeof candidates = [];
  const claimedAt = new Date().toISOString();
  for (const m of candidates) {
    try {
      await db.insert(pbisMilestoneEmailsTable).values({
        studentId,
        milestonePoints: m.points,
        sentAt: claimedAt,
        emailTo: null,
        status: "pending",
        errorMsg: null,
      });
      todo.push(m);
    } catch {
      // unique-violation: another worker is sending this milestone; skip.
    }
  }
  if (todo.length === 0) return [];

  const [student] = await db
    .select()
    .from(studentsTable)
    .where(eq(studentsTable.studentId, studentId));
  const [settings] = await db.select().from(schoolSettingsTable);
  const schoolName = settings?.schoolName ?? "PulseED";
  const fromName = settings?.fromName ?? schoolName;
  const signature = settings?.emailSignature ?? `Thank you,\n${schoolName}`;

  const results: MilestoneResult[] = [];
  for (const m of todo) {
    const nowIso = new Date().toISOString();
    if (!student) {
      await db
        .update(pbisMilestoneEmailsTable)
        .set({
          sentAt: nowIso,
          emailTo: null,
          status: "skipped",
          errorMsg: "Student not found in roster",
        })
        .where(
          and(
            eq(pbisMilestoneEmailsTable.studentId, studentId),
            eq(pbisMilestoneEmailsTable.milestonePoints, m.points),
          ),
        );
      results.push({
        milestonePoints: m.points,
        status: "skipped",
        emailTo: null,
        errorMsg: "Student not found in roster",
      });
      continue;
    }
    const parentEmail = student.parentEmail?.trim() || null;
    if (!parentEmail) {
      await db
        .update(pbisMilestoneEmailsTable)
        .set({
          sentAt: nowIso,
          emailTo: null,
          status: "skipped",
          errorMsg: "No parent email on file",
        })
        .where(
          and(
            eq(pbisMilestoneEmailsTable.studentId, studentId),
            eq(pbisMilestoneEmailsTable.milestonePoints, m.points),
          ),
        );
      results.push({
        milestonePoints: m.points,
        status: "skipped",
        emailTo: null,
        errorMsg: "No parent email on file",
      });
      continue;
    }

    const studentName = `${student.firstName} ${student.lastName}`;
    const greeting = student.parentName
      ? `Dear ${student.parentName},`
      : "Dear Parent or Guardian,";
    const subject = `${schoolName}: ${studentName} reached ${m.points} PBIS points!`;
    const body =
      `${greeting}\n\n` +
      `Great news from ${schoolName}! ${studentName} has earned ${m.points} positive behavior points. ` +
      `We wanted to let you know about this achievement and thank ${studentName} for the positive choices being made at school.\n\n` +
      `${signature}`;
    const html =
      `<p>${greeting.replace(/\n/g, "<br>")}</p>` +
      `<p>Great news from <strong>${schoolName}</strong>! <strong>${studentName}</strong> has earned <strong>${m.points} positive behavior points</strong>. ` +
      `We wanted to let you know about this achievement and thank ${studentName} for the positive choices being made at school.</p>` +
      `<p>${signature.replace(/\n/g, "<br>")}</p>`;

    try {
      const { client, fromEmail } = await getUncachableResendClient();
      const fromHeader = `${fromName} <${fromEmail}>`;
      const sendRes = await client.emails.send({
        from: fromHeader,
        to: parentEmail,
        subject,
        text: body,
        html,
      });
      if (sendRes.error) {
        throw new Error(sendRes.error.message ?? "Resend error");
      }
      await db
        .update(pbisMilestoneEmailsTable)
        .set({
          sentAt: nowIso,
          emailTo: parentEmail,
          status: "sent",
          errorMsg: null,
        })
        .where(
          and(
            eq(pbisMilestoneEmailsTable.studentId, studentId),
            eq(pbisMilestoneEmailsTable.milestonePoints, m.points),
          ),
        );
      results.push({
        milestonePoints: m.points,
        status: "sent",
        emailTo: parentEmail,
        errorMsg: null,
      });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      await db
        .update(pbisMilestoneEmailsTable)
        .set({
          sentAt: nowIso,
          emailTo: parentEmail,
          status: "error",
          errorMsg: errMsg,
        })
        .where(
          and(
            eq(pbisMilestoneEmailsTable.studentId, studentId),
            eq(pbisMilestoneEmailsTable.milestonePoints, m.points),
          ),
        );
      results.push({
        milestonePoints: m.points,
        status: "error",
        emailTo: parentEmail,
        errorMsg: errMsg,
      });
    }
  }
  return results;
}

// Used for bulk: sequential to avoid rate-limit + duplicate inserts.
export async function processMilestonesForStudents(
  studentIds: string[],
): Promise<Record<string, MilestoneResult[]>> {
  const out: Record<string, MilestoneResult[]> = {};
  const seen = new Set<string>();
  for (const id of studentIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    out[id] = await processMilestonesForStudent(id);
  }
  return out;
}

void isNull;
