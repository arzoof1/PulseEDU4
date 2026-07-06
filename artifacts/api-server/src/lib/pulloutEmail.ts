import {
  db,
  pulloutsTable,
  studentsTable,
  schoolSettingsTable,
  staffTable,
} from "@workspace/db";
import { and, eq, or, inArray } from "drizzle-orm";
import { getUncachableResendClient } from "./resendClient";
import { sendSmsBatch } from "./sms";

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

  const subject = `${schoolName}: ${studentName} arrived at ISS`;
  // Canonical arrival message — distinct from the verify-time
  // send-to-ISS email which used p.parentMessage. The arrival email
  // is shorter and confirms the student is now physically in ISS.
  // Discard `reasonText` / `teacherText` / `periodText` / `arrivedTime`
  // here — they are surfaced in the earlier send-to-ISS email; the
  // arrival note is intentionally minimal and reassuring.
  void reasonText;
  void teacherText;
  void periodText;
  void arrivedTime;
  const arrivalLine =
    `Your student, ${studentName}, has arrived at ISS and will remain ` +
    `for the rest of the period. They will return to their regular ` +
    `schedule at the end of this period.`;
  const body =
    `${greeting}\n\n` +
    `${arrivalLine}\n\n` +
    `Please reach out if you have any questions.\n\n` +
    `${signature}`;
  const html =
    `<p>${greeting.replace(/\n/g, "<br>")}</p>` +
    `<p>${arrivalLine}</p>` +
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
 * Send the parent send-to-ISS email at verify time. Uses the
 * verifier-authored `parent_message` body (which already has
 * placeholders substituted client-side). Idempotent on
 * sentToIssEmailSentAt so re-verifying or refreshing the dashboard
 * won't double-send.
 *
 * If the verifier did not author a message, falls back to the
 * canonical default wording so a parent always gets some context.
 */
export async function sendPulloutSendToIssEmail(
  pulloutId: number,
): Promise<PulloutEmailResult> {
  const [p] = await db
    .select()
    .from(pulloutsTable)
    .where(eq(pulloutsTable.id, pulloutId));
  if (!p) {
    return { status: "skipped", emailTo: null, errorMsg: "Pullout not found" };
  }
  if (p.sentToIssEmailSentAt) {
    return {
      status:
        (p.sentToIssEmailStatus as "sent" | "skipped" | "error" | null) ??
        "skipped",
      emailTo: p.sentToIssEmailTo,
      errorMsg: p.sentToIssEmailErrorMsg,
    };
  }
  const nowIso = new Date().toISOString();

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
    await db
      .update(pulloutsTable)
      .set({
        sentToIssEmailSentAt: nowIso,
        sentToIssEmailStatus: "skipped",
        sentToIssEmailTo: null,
        sentToIssEmailErrorMsg: "Student not found in roster",
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
        sentToIssEmailSentAt: nowIso,
        sentToIssEmailStatus: "skipped",
        sentToIssEmailTo: null,
        sentToIssEmailErrorMsg: "No parent email on file",
      })
      .where(eq(pulloutsTable.id, pulloutId));
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

  // Verifier-authored message body (placeholders already substituted
  // client-side). Falls back to a minimal canonical line so the
  // parent always receives meaningful context even if the verifier
  // somehow cleared the textarea.
  const customMessage =
    p.parentMessage?.trim() ||
    `Your student, ${studentName}, has been pulled from class and ` +
      `is being placed in ISS. They will return to their regular ` +
      `schedule at the end of this period.`;

  const subject = `${schoolName}: ${studentName} pulled from class — sent to ISS`;
  const body = `${greeting}\n\n${customMessage}\n\n${signature}`;
  // HTML-escape staff-supplied free text before injecting into the
  // template (newlines become <br>). Same treatment as the original
  // arrival email had for parent_message.
  const html =
    `<p>${escapeHtml(greeting).replace(/\n/g, "<br>")}</p>` +
    `<p>${escapeHtml(customMessage).replace(/\n/g, "<br>")}</p>` +
    `<p>${escapeHtml(signature).replace(/\n/g, "<br>")}</p>`;

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
        sentToIssEmailSentAt: nowIso,
        sentToIssEmailStatus: "sent",
        sentToIssEmailTo: parentEmail,
        sentToIssEmailErrorMsg: null,
      })
      .where(eq(pulloutsTable.id, pulloutId));
    return { status: "sent", emailTo: parentEmail, errorMsg: null };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    await db
      .update(pulloutsTable)
      .set({
        sentToIssEmailSentAt: nowIso,
        sentToIssEmailStatus: "error",
        sentToIssEmailTo: parentEmail,
        sentToIssEmailErrorMsg: errMsg,
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

  // Load settings up front — needed here for the SMS toggle + extra
  // recipients, and below for school / from name.
  const [settings] = await db
    .select()
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, p.schoolId));

  const extraIds: number[] =
    settings && Array.isArray(settings.pulloutExtraRecipientStaffIds)
      ? settings.pulloutExtraRecipientStaffIds.filter(
          (n): n is number => typeof n === "number" && Number.isInteger(n),
        )
      : [];

  // Recipients: active staff in THIS pullout's school who EITHER hold a
  // dispatch role (admin / dean / MTSS / ISS / Behavior Specialist) OR were
  // hand-picked as extra pullout recipients (e.g. a reading coach who helps
  // with pullouts but isn't one of those roles). School-scoped so pullout
  // details (student id, reason, teacher) don't leak to dispatchers in other
  // schools.
  const roleClauses = [
    eq(staffTable.isAdmin, true),
    eq(staffTable.isDean, true),
    eq(staffTable.isMtssCoordinator, true),
    eq(staffTable.isIssTeacher, true),
    eq(staffTable.isBehaviorSpecialist, true),
  ];
  const recipientClause = extraIds.length
    ? or(...roleClauses, inArray(staffTable.id, extraIds))
    : or(...roleClauses);
  const dispatchers = await db
    .select()
    .from(staffTable)
    .where(and(eq(staffTable.schoolId, p.schoolId), recipientClause));

  const activeDispatchers = dispatchers.filter((s) => s.active);
  const recipients = Array.from(
    new Set(
      activeDispatchers
        .filter((s) => s.email && s.email.includes("@"))
        .map((s) => s.email as string),
    ),
  );

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
  const schoolName = settings?.schoolName ?? "PulseED";
  const fromName = settings?.fromName ?? schoolName;

  // NEVER surface the canonical FLEID (`p.studentId`) in forward-facing
  // dispatch comms — only the local SIS id is displayable. Extra recipients
  // broaden who sees this, so the label must stay FLEID-free.
  const studentSisLabel = student?.localSisId ?? null;
  const studentLabel = student
    ? `${student.firstName} ${student.lastName}${
        studentSisLabel ? ` (${studentSisLabel})` : ""
      }`
    : (studentSisLabel ?? "Student");
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

    // Optional TEXT alert (off by default; admin-controlled). Best-effort —
    // never fails the dispatch over a text, and carries NO student
    // identifying info (no name / FLEID): recipients open PulseED to see
    // details, keeping PII out of SMS.
    if (settings?.pulloutSmsEnabled) {
      const smsTo = Array.from(
        new Set(
          activeDispatchers
            .map((s) => s.cellPhone)
            .filter(
              (c): c is string => typeof c === "string" && c.trim().length > 0,
            ),
        ),
      );
      if (smsTo.length > 0) {
        await sendSmsBatch(
          smsTo,
          `New ${schoolName} pullout request (${periodText}). Open PulseED \u2192 Verify Pullouts to review.`,
        );
      }
    }
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
