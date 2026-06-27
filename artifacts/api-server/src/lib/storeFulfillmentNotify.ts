// School Store fulfillment → family notification.
//
// When a redeemed School Store item is fulfilled (prepped for delivery), we
// optionally email the student's family: "Your child [Name]'s School Store
// item '[Item]' has been processed and will be ready in [Mrs. X]'s room
// soon." (Room phrase is omitted when the fulfill had no class context.)
//
// THREE-TIER gate (mirrors the feature-licensing effectiveFeatures pattern):
//   effective = superFeatureSchoolStoreNotify && featureSchoolStoreNotify
// Both default FALSE — emailing families must be deliberately turned on at the
// district level AND by the school admin. A SuperUser override OFF wins
// (the super flag is false → effective false).
//
// FLEID boundary: the redemption carries the canonical FLEID (`studentId`) as
// an internal join key only. We resolve it to the student's first name and a
// linked family email — we NEVER put the FLEID in the email body.
//
// Recipients: attribute-to-one primary parent — the parent with an active
// account (accepted invite → has a password + email) linked to the student.
// If several qualify we pick the oldest account (lowest id) deterministically.
//
// This is fire-and-forget: callers MUST NOT await it inside the fulfill
// transaction. It swallows and logs every error so a mail failure can never
// roll back or break a fulfill.

import {
  db,
  schoolSettingsTable,
  schoolsTable,
  studentsTable,
  parentsTable,
  parentStudentsTable,
} from "@workspace/db";
import { and, eq, isNotNull } from "drizzle-orm";
import { getUncachableResendClient } from "./resendClient.js";
import { logger } from "./logger.js";

type NotifyArgs = {
  schoolId: number;
  // FLEID — internal join key only, never rendered.
  studentId: string;
  itemName: string;
  // Captured by the Distribution-by-class fulfill flow; null for bulk-log
  // fulfills (no class context). Drives the "in [name]'s room" phrase.
  deliverTeacherName: string | null;
};

function formatFromHeader(fromName: string, fromEmail: string): string {
  if (!fromName) return fromEmail;
  if (fromEmail.includes("<")) return fromEmail;
  const safeName = fromName.replace(/"/g, "'");
  return `${safeName} <${fromEmail}>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Reads both halves of the gate straight from school_settings (no req
// context here). Returns true only when the district AND admin halves are on.
async function isNotifyEffective(schoolId: number): Promise<boolean> {
  const [row] = await db
    .select({
      admin: schoolSettingsTable.featureSchoolStoreNotify,
      district: schoolSettingsTable.superFeatureSchoolStoreNotify,
    })
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, schoolId));
  if (!row) return false;
  return row.admin === true && row.district === true;
}

export async function notifyFamilyOfFulfillment(
  args: NotifyArgs,
): Promise<void> {
  const { schoolId, studentId, itemName, deliverTeacherName } = args;
  try {
    if (!(await isNotifyEffective(schoolId))) return;

    // Resolve the FLEID to the student's first name + integer PK (the join
    // key the parent link table uses).
    const [student] = await db
      .select({
        intId: studentsTable.id,
        firstName: studentsTable.firstName,
      })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.schoolId, schoolId),
          eq(studentsTable.studentId, studentId),
        ),
      );
    if (!student) return;

    // Attribute-to-one: the oldest active family account linked to this
    // student that has both a password (accepted invite) and an email.
    const [parent] = await db
      .select({
        email: parentsTable.email,
        displayName: parentsTable.displayName,
      })
      .from(parentStudentsTable)
      .innerJoin(
        parentsTable,
        eq(parentsTable.id, parentStudentsTable.parentId),
      )
      .where(
        and(
          eq(parentStudentsTable.studentId, student.intId),
          eq(parentsTable.schoolId, schoolId),
          eq(parentsTable.active, true),
          isNotNull(parentsTable.passwordHash),
        ),
      )
      .orderBy(parentsTable.id)
      .limit(1);
    if (!parent?.email) return;

    // School branding for the From header + email body.
    const [settings] = await db
      .select({
        schoolName: schoolSettingsTable.schoolName,
        fromName: schoolSettingsTable.fromName,
      })
      .from(schoolSettingsTable)
      .where(eq(schoolSettingsTable.schoolId, schoolId));
    const [school] = await db
      .select({ name: schoolsTable.name })
      .from(schoolsTable)
      .where(eq(schoolsTable.id, schoolId));
    const schoolName =
      settings?.schoolName?.trim() || school?.name?.trim() || "Your school";
    const fromName = settings?.fromName?.trim() || schoolName;

    const room = deliverTeacherName?.trim();
    const roomPhrase = room
      ? ` and will be ready in ${room}'s room soon`
      : ` and will be ready soon`;
    const sentence = `Your child ${student.firstName}'s School Store item "${itemName}" has been processed${roomPhrase}.`;

    const { client, fromEmail } = await getUncachableResendClient();
    const subject = `${schoolName}: ${student.firstName}'s School Store item is ready`;

    const text = [
      `Hello,`,
      ``,
      sentence,
      ``,
      `— ${schoolName}`,
    ].join("\n");

    const html = [
      `<p>Hello,</p>`,
      `<p>${escapeHtml(sentence)}</p>`,
      `<p>— ${escapeHtml(schoolName)}</p>`,
    ].join("");

    const { error } = await client.emails.send({
      from: formatFromHeader(fromName, fromEmail),
      to: parent.email,
      subject,
      text,
      html,
    });
    if (error) {
      logger.warn(
        { schoolId, err: String(error) },
        "store fulfillment notify: resend returned error",
      );
      return;
    }
    logger.info(
      { schoolId, hasRoom: Boolean(room) },
      "store fulfillment notify: family email sent",
    );
  } catch (err) {
    // Never let a notification failure surface to the fulfill caller.
    logger.warn(
      { schoolId, err: err instanceof Error ? err.message : String(err) },
      "store fulfillment notify: send failed",
    );
  }
}
