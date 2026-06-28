import {
  db,
  studentsTable,
  schoolSettingsTable,
  ticketEventsTable,
  ticketGrantsTable,
  ticketsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import QRCode from "qrcode";
import { getUncachableResendClient } from "./resendClient.js";
import { isParentNotifyEnabled } from "./parentNotify.js";
import { renderTicketsPdf } from "./ticketPdf.js";
import {
  TICKET_RESPONSIBILITY_HEADLINE,
  TICKET_RESPONSIBILITY_LINES,
  ticketShortCode,
} from "./ticketCopy.js";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type TicketEmailResult = {
  status: "sent" | "skipped" | "error";
  emailTo: string | null;
  errorMsg: string | null;
};

function eventWhen(ev: {
  eventDate: string | null;
  startTime: string | null;
  location: string | null;
}): string {
  const parts: string[] = [];
  if (ev.eventDate) parts.push(ev.eventDate);
  if (ev.startTime) parts.push(ev.startTime);
  if (ev.location) parts.push(ev.location);
  return parts.join(" \u2022 ");
}

// Send (or resend) one student's tickets to their guardian. Updates the grant's
// delivery-status snapshot. Idempotent only in the sense that re-calling will
// re-send and overwrite the status — callers control whether to skip already-
// sent grants. A grant with no email on file is marked `no_email` and skipped.
export async function sendTicketEmailForGrant(
  grantId: number,
): Promise<TicketEmailResult> {
  const [grant] = await db
    .select()
    .from(ticketGrantsTable)
    .where(eq(ticketGrantsTable.id, grantId));
  if (!grant) {
    return { status: "skipped", emailTo: null, errorMsg: "Grant not found" };
  }

  // Parent Notifications panel — master switch for event-ticket emails.
  if (!(await isParentNotifyEnabled(grant.schoolId, "notifyParentEventTickets"))) {
    return {
      status: "skipped",
      emailTo: null,
      errorMsg: "Parent ticket notifications disabled for this school",
    };
  }

  const [ev] = await db
    .select()
    .from(ticketEventsTable)
    .where(
      and(
        eq(ticketEventsTable.id, grant.eventId),
        eq(ticketEventsTable.schoolId, grant.schoolId),
      ),
    );
  if (!ev) {
    return { status: "skipped", emailTo: null, errorMsg: "Event not found" };
  }

  const [student] = await db
    .select()
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.id, grant.studentId),
        eq(studentsTable.schoolId, grant.schoolId),
      ),
    );
  if (!student) {
    return { status: "skipped", emailTo: null, errorMsg: "Student not found" };
  }

  const toEmail =
    grant.guardianEmail?.trim() || student.parentEmail?.trim() || null;
  const nowIso = new Date();
  if (!toEmail) {
    await db
      .update(ticketGrantsTable)
      .set({
        emailStatus: "no_email",
        emailTo: null,
        emailError: "No guardian email on file",
        updatedAt: nowIso,
      })
      .where(eq(ticketGrantsTable.id, grantId));
    return {
      status: "skipped",
      emailTo: null,
      errorMsg: "No guardian email on file",
    };
  }

  // Non-void tickets, ordered by seq.
  const tickets = await db
    .select({ token: ticketsTable.token, seq: ticketsTable.seq })
    .from(ticketsTable)
    .where(
      and(
        eq(ticketsTable.schoolId, grant.schoolId),
        eq(ticketsTable.grantId, grantId),
      ),
    )
    .orderBy(ticketsTable.seq);
  const liveTickets = tickets;

  const [settings] = await db
    .select()
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, grant.schoolId));
  const schoolName = settings?.schoolName ?? "PulseEDU";
  const fromName = settings?.fromName ?? schoolName;

  const studentName = `${student.firstName} ${student.lastName}`;
  const guardianName =
    grant.guardianName?.trim() || student.parentName?.trim() || null;
  const greeting = guardianName
    ? `Dear ${guardianName},`
    : "Dear Parent or Guardian,";
  const whenLine = eventWhen(ev);

  // Inline QR images via data URI. Resend's SDK attachment type has no
  // Content-ID field, so we embed inline images as data URIs (which render in
  // most clients) AND attach a PDF — the reliable printable fallback.
  const qrDataUris: string[] = [];
  for (const t of liveTickets) {
    const dataUri = await QRCode.toDataURL(t.token, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 220,
    });
    qrDataUris.push(dataUri);
  }

  // Wrap cards two-per-row.
  const rows: string[] = [];
  for (let i = 0; i < liveTickets.length; i += 2) {
    const cells = liveTickets
      .slice(i, i + 2)
      .map(
        (t, j) =>
          `<td style="padding:8px;text-align:center;vertical-align:top;">` +
          `<img src="${qrDataUris[i + j]}" width="150" height="150" alt="Ticket ${t.seq}" style="display:block;margin:0 auto;border:1px solid #e2e8f0;border-radius:8px;" />` +
          `<div style="font:bold 13px Helvetica,Arial,sans-serif;color:#0f172a;margin-top:6px;">Ticket ${t.seq} of ${liveTickets.length}</div>` +
          `<div style="font:11px Helvetica,Arial,sans-serif;color:#64748b;">Admit one &bull; Code ${ticketShortCode(t.token)}</div>` +
          `</td>`,
      )
      .join("");
    rows.push(`<tr>${cells}</tr>`);
  }

  const respHtml =
    `<div style="background:#fef3c7;border-radius:8px;padding:12px 14px;margin-top:18px;">` +
    `<div style="font:bold 13px Helvetica,Arial,sans-serif;color:#92400e;margin-bottom:6px;">${escapeHtml(TICKET_RESPONSIBILITY_HEADLINE)}</div>` +
    TICKET_RESPONSIBILITY_LINES.map(
      (l) =>
        `<div style="font:12px Helvetica,Arial,sans-serif;color:#92400e;margin:3px 0;">&bull; ${escapeHtml(l)}</div>`,
    ).join("") +
    `</div>`;

  const subject = `${schoolName}: Your tickets for ${ev.name}`;
  const html =
    `<div style="max-width:560px;margin:0 auto;font-family:Helvetica,Arial,sans-serif;color:#0f172a;">` +
    `<p style="font-size:12px;color:#64748b;margin:0;">${escapeHtml(schoolName)}</p>` +
    `<h1 style="font-size:20px;margin:4px 0 2px;">${escapeHtml(ev.name)}</h1>` +
    (whenLine
      ? `<p style="font-size:13px;color:#1e3a8a;margin:0 0 12px;">${escapeHtml(whenLine)}</p>`
      : "") +
    `<p style="font-size:14px;">${escapeHtml(greeting)}</p>` +
    `<p style="font-size:14px;">Below ${liveTickets.length === 1 ? "is the ticket" : `are the ${liveTickets.length} tickets`} for <strong>${escapeHtml(studentName)}</strong>. Each code is also in the attached PDF and in your Parent Portal. Bring any one of them to the door \u2014 a code only works for the FIRST person who scans it.</p>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px auto;">${rows.join("")}</table>` +
    respHtml +
    `<p style="font-size:12px;color:#64748b;margin-top:16px;">If a QR image doesn't show above, open the attached PDF or your Parent Portal.</p>` +
    `</div>`;

  const textLines = [
    schoolName,
    ev.name,
    whenLine,
    "",
    greeting,
    "",
    `Tickets for ${studentName}:`,
    ...liveTickets.map(
      (t) => `  - Ticket ${t.seq} of ${liveTickets.length}: code ${ticketShortCode(t.token)}`,
    ),
    "",
    TICKET_RESPONSIBILITY_HEADLINE,
    ...TICKET_RESPONSIBILITY_LINES.map((l) => `  - ${l}`),
    "",
    "Your QR codes are in the attached PDF and in your Parent Portal.",
  ];
  const text = textLines.filter((l) => l !== undefined).join("\n");

  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await renderTicketsPdf({
      schoolName,
      eventName: ev.name,
      eventDate: ev.eventDate,
      startTime: ev.startTime,
      location: ev.location,
      sheets: [
        {
          studentName,
          grade: student.grade ?? null,
          guardianName,
          tickets: liveTickets,
        },
      ],
    });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    await db
      .update(ticketGrantsTable)
      .set({
        emailStatus: "failed",
        emailTo: toEmail,
        emailError: `PDF render failed: ${errMsg}`,
        updatedAt: nowIso,
      })
      .where(eq(ticketGrantsTable.id, grantId));
    return { status: "error", emailTo: toEmail, errorMsg: errMsg };
  }

  const pdfName = `tickets-${studentName.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.pdf`;

  try {
    const { client, fromEmail } = await getUncachableResendClient();
    const sendRes = await client.emails.send({
      from: `${fromName} <${fromEmail}>`,
      to: toEmail,
      subject,
      text,
      html,
      attachments: [{ filename: pdfName, content: pdfBuffer }],
    });
    if (sendRes.error) {
      throw new Error(sendRes.error.message ?? "Resend error");
    }
    await db
      .update(ticketGrantsTable)
      .set({
        emailStatus: "sent",
        emailSentAt: nowIso,
        emailTo: toEmail,
        emailError: null,
        updatedAt: nowIso,
      })
      .where(eq(ticketGrantsTable.id, grantId));
    return { status: "sent", emailTo: toEmail, errorMsg: null };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    await db
      .update(ticketGrantsTable)
      .set({
        emailStatus: "failed",
        emailSentAt: nowIso,
        emailTo: toEmail,
        emailError: errMsg,
        updatedAt: nowIso,
      })
      .where(eq(ticketGrantsTable.id, grantId));
    return { status: "error", emailTo: toEmail, errorMsg: errMsg };
  }
}
