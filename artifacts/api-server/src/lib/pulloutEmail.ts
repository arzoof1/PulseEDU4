import {
  db,
  pulloutsTable,
  studentsTable,
  schoolSettingsTable,
  staffTable,
} from "@workspace/db";
import { and, eq, or } from "drizzle-orm";
import { getUncachableResendClient } from "./resendClient";

// Tiny HTML escaper used when interpolating staff-supplied free text
// (e.g. parent_message authored in the Verify modal) into the HTML
// email body. Mirrors the helper in weeklyHeartbeatEmail.ts so we
// don't pull in a heavy sanitizer for one field.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type PulloutEmailResult = {
  status: "sent" | "skipped" | "error";
  emailTo: string | null;
  errorMsg: string | null;
};

/**
 * Send the parent arrival email for a pullout that just transitioned to
 * arrived. Idempotent: if parentEmailSentAt is already set, no-op.
 */
export async function sendPulloutArrivalEmail(
  pulloutId: number,
): Promise<PulloutEmailResult> {
  const [p] = await db
    .select()
    .from(pulloutsTable)
    .where(eq(pulloutsTable.id, pulloutId));
  if (!p) {
    return { status: "skipped", emailTo: null, errorMsg: "Pullout not found" };
  }
  if (p.parentEmailSentAt) {
    return {
      status:
        (p.parentEmailStatus as "sent" | "skipped" | "error" | null) ??
        "skipped",
      emailTo: p.parentEmailTo,
      errorMsg: p.parentEmailErrorMsg,
    };
  }

  const [student] = await db
    .select()
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.studentId, p.studentId),
        eq(studentsTable.schoolId, p.schoolId),
      ),
    );
  const [settings] = await db
    .select()
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, p.schoolId));
  const schoolName = settings?.schoolName ?? "PulseED";
  const fromName = settings?.fromName ?? schoolName;
  const signature = settings?.emailSignature ?? `Thank you,\n${schoolName}`;
  const nowIso = new Date().toISOString();

  if (!student) {
    await db
      .update(pulloutsTable)
      .set({
        parentEmailSentAt: nowIso,
        parentEmailStatus: "skipped",
        parentEmailTo: null,
        parentEmailErrorMsg: "Student not found in roster",
      })
      .where(eq(pulloutsTable.id, pulloutId));
    return {
      status: "skipped",
      emailTo: null,
      errorMsg: "Student not found in roster",
    };
  }

  const parentEmail = student.parentEmail?.trim() || null;
  if (!parentEmail) {
    await db
      .update(pulloutsTable)
      .set({
        parentEmailSentAt: nowIso,
        parentEmailStatus: "skipped",
        parentEmailTo: null,
        parentEmailErrorMsg: "No parent email on file",
      })
      .where(eq(pulloutsTable.id, pulloutId));
    return {
      status: "skipped",
      emailTo: null,
      errorMsg: "No parent email on file",
    };
  }

  const studentName = `${student.firstName} ${student.lastName}`;
  const greeting = student.parentName
    ? `Dear ${student.parentName},`
    : "Dear Parent or Guardian,";
  const reasonText = (p.editedReason ?? p.reason).trim();
  const periodText = p.period ? ` during period ${p.period}` : "";
  const teacherText = p.referringTeacherName
    ? ` from ${p.referringTeacherName}'s class`
    : "";
  const arrivedTime = new Date(p.arrivedAt ?? nowIso).toLocaleString();

  const subject = `${schoolName}: ${studentName} pulled from class today`;
  // If the verifier authored a parent message in the Verify modal, use
  // it verbatim (placeholders were already substituted client-side).
  // Otherwise fall back to the auto-generated wording so older pullouts
  // with no parent_message still produce a useful email.
  const customMessage = p.parentMessage?.trim() ?? "";
  const body = customMessage
    ? `${greeting}\n\n${customMessage}\n\n${signature}`
    : `${greeting}\n\n` +
      `We are writing to let you know that ${studentName} was pulled from class${teacherText}${periodText} today and arrived in our intervention room at ${arrivedTime}. ` +
      `The reason given was: "${reasonText}".\n\n` +
      `Our staff will work with ${studentName} and follow up with you if any further action is needed. Please reach out if you have questions.\n\n` +
      `${signature}`;
  // HTML body: the parent_message is staff-supplied free text, so we
  // HTML-escape it before injecting into the template (newlines still
  // become <br>). Without this, a verifier could inject script/img
  // tags that would render in the parent's email client.
  const html = customMessage
    ? `<p>${escapeHtml(greeting).replace(/\n/g, "<br>")}</p>` +
      `<p>${escapeHtml(customMessage).replace(/\n/g, "<br>")}</p>` +
      `<p>${escapeHtml(signature).replace(/\n/g, "<br>")}</p>`
    : `<p>${greeting.replace(/\n/g, "<br>")}</p>` +
      `<p>We are writing to let you know that <strong>${studentName}</strong> was pulled from class${teacherText}${periodText} today and arrived in our intervention room at <strong>${arrivedTime}</strong>. ` +
      `The reason given was: <em>"${reasonText}"</em>.</p>` +
      `<p>Our staff will work with ${studentName} and follow up with you if any further action is needed. Please reach out if you have questions.</p>` +
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
      .update(pulloutsTable)
      .set({
        parentEmailSentAt: nowIso,
        parentEmailStatus: "sent",
        parentEmailTo: parentEmail,
        parentEmailErrorMsg: null,
      })
      .where(eq(pulloutsTable.id, pulloutId));
    return { status: "sent", emailTo: parentEmail, errorMsg: null };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    await db
      .update(pulloutsTable)
      .set({
        parentEmailSentAt: nowIso,
        parentEmailStatus: "error",
        parentEmailTo: parentEmail,
        parentEmailErrorMsg: errMsg,
      })
      .where(eq(pulloutsTable.id, pulloutId));
    return { status: "error", emailTo: parentEmail, errorMsg: errMsg };
  }
}

/**
 * Send a parent return/release email when a student leaves ISS. Always sends
 * (not idempotent on the pullout record — we don't want to suppress the email
 * if the student is re-added later).
 */
export async function sendPulloutReturnEmail(
  pulloutId: number,
): Promise<PulloutEmailResult> {
  const [p] = await db
    .select()
    .from(pulloutsTable)
    .where(eq(pulloutsTable.id, pulloutId));
  if (!p) {
    return { status: "skipped", emailTo: null, errorMsg: "Pullout not found" };
  }
  const [student] = await db
    .select()
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.studentId, p.studentId),
        eq(studentsTable.schoolId, p.schoolId),
      ),
    );
  if (!student) {
    return {
      status: "skipped",
      emailTo: null,
      errorMsg: "Student not found in roster",
    };
  }
  const parentEmail = student.parentEmail?.trim() || null;
  if (!parentEmail) {
    return {
      status: "skipped",
      emailTo: null,
      errorMsg: "No parent email on file",
    };
  }
  const [settings] = await db
    .select()
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, p.schoolId));
  const schoolName = settings?.schoolName ?? "PulseED";
  const fromName = settings?.fromName ?? schoolName;
  const signature = settings?.emailSignature ?? `Thank you,\n${schoolName}`;
  const studentName = `${student.firstName} ${student.lastName}`;
  const greeting = student.parentName
    ? `Dear ${student.parentName},`
    : "Dear Parent or Guardian,";
  const subject = `${schoolName}: ${studentName} returned to class`;
  // Canonical Return-to-Class message — same string a future SMS
  // sender will read from pullouts.return_message.
  const returnLine = `Your student, ${studentName}, has returned to their regular class schedule.`;
  const body =
    `${greeting}\n\n` +
    `${returnLine}\n\n` +
    `Please reach out if you have any questions.\n\n` +
    `${signature}`;
  const html =
    `<p>${greeting.replace(/\n/g, "<br>")}</p>` +
    `<p>${returnLine}</p>` +
    `<p>Please reach out if you have any questions.</p>` +
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
    return { status: "sent", emailTo: parentEmail, errorMsg: null };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    return { status: "error", emailTo: parentEmail, errorMsg: errMsg };
  }
}

/**
 * Notify the dispatch team (admins, deans, MTSS coordinators, ISS staff)
 * that a new pullout request has been submitted. Mirrors the Resend
 * front-desk radio call. Idempotent via dispatchEmailSentAt.
 */
export async function sendPulloutDispatchEmail(
  pulloutId: number,
): Promise<PulloutEmailResult> {
  const [p] = await db
    .select()
    .from(pulloutsTable)
    .where(eq(pulloutsTable.id, pulloutId));
  if (!p) {
    return { status: "skipped", emailTo: null, errorMsg: "Pullout not found" };
  }
  if (p.dispatchEmailSentAt) {
    return {
      status:
        (p.dispatchEmailStatus as "sent" | "skipped" | "error" | null) ??
        "skipped",
      emailTo: p.dispatchEmailTo,
      errorMsg: p.dispatchEmailErrorMsg,
    };
  }

  const nowIso = new Date().toISOString();

  // Recipients: any active staff in THIS pullout's school with
  // admin / dean / MTSS / ISS role. School-scoped so pullout details
  // (student id, reason, teacher) don't leak to dispatchers in other
  // schools.
  const dispatchers = await db
    .select()
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
  const recipients = dispatchers
    .filter((s) => s.active && s.email && s.email.includes("@"))
    .map((s) => s.email);

  if (recipients.length === 0) {
    await db
      .update(pulloutsTable)
      .set({
        dispatchEmailSentAt: nowIso,
        dispatchEmailStatus: "skipped",
        dispatchEmailTo: null,
        dispatchEmailErrorMsg: "No dispatchers configured",
      })
      .where(eq(pulloutsTable.id, pulloutId));
    return {
      status: "skipped",
      emailTo: null,
      errorMsg: "No dispatchers configured",
    };
  }

  const [student] = await db
    .select()
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.studentId, p.studentId),
        eq(studentsTable.schoolId, p.schoolId),
      ),
    );
  const [settings] = await db
    .select()
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, p.schoolId));
  const schoolName = settings?.schoolName ?? "PulseED";
  const fromName = settings?.fromName ?? schoolName;

  const studentLabel = student
    ? `${student.firstName} ${student.lastName} (${p.studentId})`
    : p.studentId;
  const reasonText = (p.editedReason ?? p.reason).trim();
  const periodText = p.period ? `Period ${p.period}` : "Period n/a";
  const teacherText = p.referringTeacherName || "(unspecified)";

  const subject = `[${schoolName}] Pullout requested: ${studentLabel} (${periodText})`;
  const body =
    `A new pullout request has been submitted in PulseED.\n\n` +
    `Student: ${studentLabel}\n` +
    `Referring teacher: ${teacherText}\n` +
    `${periodText}\n` +
    `Submitted by: ${p.requestedByName}\n` +
    `Reason: "${reasonText}"\n\n` +
    `Open PulseED → Verify Pullouts to verify and dispatch to ISS.`;
  const html =
    `<p>A new pullout request has been submitted in PulseED.</p>` +
    `<ul>` +
    `<li><strong>Student:</strong> ${studentLabel}</li>` +
    `<li><strong>Referring teacher:</strong> ${teacherText}</li>` +
    `<li><strong>${periodText}</strong></li>` +
    `<li><strong>Submitted by:</strong> ${p.requestedByName}</li>` +
    `<li><strong>Reason:</strong> "${reasonText}"</li>` +
    `</ul>` +
    `<p>Open PulseED → <em>Verify Pullouts</em> to verify and dispatch to ISS.</p>`;

  const recipientStr = recipients.join(", ");
  try {
    const { client, fromEmail } = await getUncachableResendClient();
    const fromHeader = `${fromName} <${fromEmail}>`;
    const sendRes = await client.emails.send({
      from: fromHeader,
      to: recipients,
      subject,
      text: body,
      html,
    });
    if (sendRes.error) {
      throw new Error(sendRes.error.message ?? "Resend error");
    }
    await db
      .update(pulloutsTable)
      .set({
        dispatchEmailSentAt: nowIso,
        dispatchEmailStatus: "sent",
        dispatchEmailTo: recipientStr,
        dispatchEmailErrorMsg: null,
      })
      .where(eq(pulloutsTable.id, pulloutId));
    return { status: "sent", emailTo: recipientStr, errorMsg: null };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    await db
      .update(pulloutsTable)
      .set({
        dispatchEmailSentAt: nowIso,
        dispatchEmailStatus: "error",
        dispatchEmailTo: recipientStr,
        dispatchEmailErrorMsg: errMsg,
      })
      .where(eq(pulloutsTable.id, pulloutId));
    return { status: "error", emailTo: recipientStr, errorMsg: errMsg };
  }
}
