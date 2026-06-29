import { and, eq, inArray, isNull, or } from "drizzle-orm";
import {
  db,
  tourRequestsTable,
  tourRequestEventsTable,
  schoolSettingsTable,
  schoolsTable,
  staffTable,
  adminNotificationsTable,
} from "@workspace/db";
import { canManageTours } from "./coreTeam.js";
import {
  sendLeadOverdueEscalationEmail,
  sendFamilyTourReminderEmail,
  sendFamilyPostTourThankYouEmail,
  sendFamilyDecidingNudgeEmail,
  sendFamilyEnrollmentWelcomeEmail,
  type TourOverdueReason,
} from "./tourEmails.js";
import { DEFAULT_SCHOOL_TZ } from "./schoolYear.js";
import { logger } from "./logger.js";

// -----------------------------------------------------------------------------
// School Tours — Phase 2 "never lose a lead" background escalation job.
//
// Hourly sweep that finds leads that have crossed their stage SLA and emails the
// owner (or the notify group when unassigned), CC'ing the principal/admins. It
// is idempotent: a lead is nudged at most once per reason per re-nudge window
// (RENUDGE_MS), and immediately again when the reason changes (e.g. the lead
// moved new → scheduled and is now overdue for a different reason). Any staff
// stage change or logged contact clears lastEscalatedReason, re-arming the job.
//
// Sending is gated globally on EMAIL_REMINDERS_ENABLED *and* per-school on
// schoolSettings.tourEscalationEnabled. Best-effort: failures are logged, never
// thrown, so one bad lead never sinks the sweep.
// -----------------------------------------------------------------------------

const RENUDGE_MS = 24 * 60 * 60 * 1000;
const ACTIVE_STATUSES = ["new", "scheduled", "deciding"] as const;

// Resolve the public app origin from env only — no request is available inside
// a cron (prod domain in prod, dev host in dev). Mirrors publicAppOrigin() in
// routes/tours.ts so cron-built links match request-built ones.
function originFromEnv(): string {
  const explicit = process.env.PUBLIC_APP_URL;
  if (explicit && explicit.length > 0) return explicit.replace(/\/+$/, "");
  const replitDomains = (process.env.REPLIT_DOMAINS ?? "").trim();
  if (replitDomains) {
    const first = replitDomains.split(",")[0]?.trim();
    if (first) return `https://${first}`;
  }
  const replit = process.env.REPLIT_DEV_DOMAIN;
  if (replit && replit.length > 0) return `https://${replit}`;
  return "http://localhost:5000";
}

// Staff-app origin for the "Open the lead" button.
function pipelineUrl(): string {
  return `${originFromEnv()}/?settingsTile=school-tours`;
}

// Public survey link printed/emailed to families — mirrors surveyUrlFor() in
// routes/tours.ts.
function surveyUrlForToken(token: string): string {
  return `${originFromEnv()}/tour/survey/${encodeURIComponent(token)}`;
}

function waitingSummary(since: Date, now: Date): string {
  const ms = Math.max(0, now.getTime() - since.getTime());
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days >= 1) return `${days} day${days === 1 ? "" : "s"} overdue`;
  const hours = Math.floor(ms / (60 * 60 * 1000));
  return `${hours} hour${hours === 1 ? "" : "s"} overdue`;
}

// Decide whether a lead is overdue and why. Returns the reason + the timestamp
// the lead has been waiting since, or null when not overdue.
//
// This is the SINGLE source of truth for overdue semantics. The hourly
// escalation sweep, the pipeline list endpoint, and the lead-detail endpoint
// all call it so they can never disagree on who is overdue or why. It only
// needs the lifecycle-relevant fields, so it accepts a structural subset rather
// than the full row.
export function overdueFor(
  lead: Pick<
    typeof tourRequestsTable.$inferSelect,
    "status" | "createdAt" | "tourScheduledAt" | "followUpDueAt"
  >,
  firstContactHours: number,
  now: Date,
): { reason: TourOverdueReason; since: Date } | null {
  if (lead.status === "new") {
    const since = lead.createdAt;
    if (now.getTime() - since.getTime() > firstContactHours * 60 * 60 * 1000) {
      return { reason: "first_contact", since };
    }
  } else if (lead.status === "scheduled") {
    if (lead.tourScheduledAt && lead.tourScheduledAt.getTime() < now.getTime()) {
      return { reason: "tour_not_logged", since: lead.tourScheduledAt };
    }
  } else if (lead.status === "deciding") {
    if (lead.followUpDueAt && lead.followUpDueAt.getTime() < now.getTime()) {
      return { reason: "follow_up", since: lead.followUpDueAt };
    }
  }
  return null;
}

export interface TourEscalationResult {
  skipped: boolean;
  scanned: number;
  sent: number;
}

export async function runTourEscalations(
  now: Date = new Date(),
): Promise<TourEscalationResult> {
  if (process.env.EMAIL_REMINDERS_ENABLED !== "true") {
    return { skipped: true, scanned: 0, sent: 0 };
  }

  // All active candidate leads across every school (kept small by status).
  const leads = await db
    .select()
    .from(tourRequestsTable)
    .where(inArray(tourRequestsTable.status, ACTIVE_STATUSES as never));
  if (leads.length === 0) return { skipped: false, scanned: 0, sent: 0 };

  const schoolIds = Array.from(new Set(leads.map((l) => l.schoolId)));

  // Per-school SLA settings (default when no row exists).
  const settingsRows = await db
    .select({
      schoolId: schoolSettingsTable.schoolId,
      firstContactHours: schoolSettingsTable.tourFirstContactHours,
      escalationEnabled: schoolSettingsTable.tourEscalationEnabled,
    })
    .from(schoolSettingsTable)
    .where(inArray(schoolSettingsTable.schoolId, schoolIds));
  const settingsMap = new Map(settingsRows.map((s) => [s.schoolId, s]));

  // School names for subject lines.
  const schoolRows = await db
    .select({ id: schoolsTable.id, name: schoolsTable.name })
    .from(schoolsTable)
    .where(inArray(schoolsTable.id, schoolIds));
  const schoolNameMap = new Map(schoolRows.map((s) => [s.id, s.name]));

  // Active staff for the schools in play (recipients + CC).
  const staff = await db
    .select()
    .from(staffTable)
    .where(
      and(
        inArray(staffTable.schoolId, schoolIds),
        eq(staffTable.active, true),
      ),
    );
  const staffById = new Map(staff.map((s) => [s.id, s]));
  const notifyBySchool = new Map<number, string[]>();
  const adminsBySchool = new Map<number, { id: number; email: string }[]>();
  for (const id of schoolIds) {
    const forSchool = staff.filter((s) => s.schoolId === id);
    notifyBySchool.set(
      id,
      forSchool
        .filter((s) => canManageTours(s) && Boolean(s.email))
        .map((s) => s.email as string),
    );
    adminsBySchool.set(
      id,
      forSchool
        .filter((s) => s.isAdmin && Boolean(s.email))
        .map((s) => ({ id: s.id, email: s.email as string })),
    );
  }

  const url = pipelineUrl();
  let sent = 0;

  for (const lead of leads) {
    const settings = settingsMap.get(lead.schoolId);
    // Per-school master switch (defaults to enabled when no row exists).
    if (settings && settings.escalationEnabled === false) continue;
    const firstContactHours = settings?.firstContactHours ?? 24;

    const overdue = overdueFor(lead, firstContactHours, now);
    if (!overdue) continue;

    // Idempotency: at most one nudge per reason per re-nudge window.
    if (
      lead.lastEscalatedReason === overdue.reason &&
      lead.lastEscalatedAt &&
      now.getTime() - lead.lastEscalatedAt.getTime() < RENUDGE_MS
    ) {
      continue;
    }

    // Recipients: the owner if assigned (else the notify group); CC the
    // principal/admins (excluding the to-address to avoid a dup).
    const owner = lead.assignedStaffId
      ? staffById.get(lead.assignedStaffId)
      : undefined;
    const ownerEmail = owner?.email ?? null;
    const to = ownerEmail
      ? [ownerEmail]
      : (notifyBySchool.get(lead.schoolId) ?? []);
    if (to.length === 0) {
      // No one to email yet — leave the lead un-stamped so it retries once a
      // recipient exists.
      continue;
    }
    const cc = (adminsBySchool.get(lead.schoolId) ?? [])
      .filter((a) => a.id !== lead.assignedStaffId)
      .map((a) => a.email)
      .filter((e) => !to.includes(e));

    const childrenSummary =
      lead.children
        .map((c) => `${c.name}${c.grade ? ` (Grade ${c.grade})` : ""}`)
        .join(", ") || "—";

    const ok = await sendLeadOverdueEscalationEmail({
      to,
      cc,
      schoolName: schoolNameMap.get(lead.schoolId) ?? "your school",
      familyName: lead.familyName,
      phone: lead.phone,
      childrenSummary,
      assigneeName: owner?.displayName ?? null,
      reason: overdue.reason,
      waitingSummary: waitingSummary(overdue.since, now),
      pipelineUrl: url,
    });
    if (!ok) continue;

    // Stamp + record only after a successful send so a transient email failure
    // is retried on the next sweep.
    await db
      .update(tourRequestsTable)
      .set({
        lastEscalatedAt: now,
        lastEscalatedReason: overdue.reason,
        updatedAt: now,
      })
      .where(
        and(
          eq(tourRequestsTable.id, lead.id),
          eq(tourRequestsTable.schoolId, lead.schoolId),
        ),
      );
    await db.insert(tourRequestEventsTable).values({
      schoolId: lead.schoolId,
      tourRequestId: lead.id,
      staffId: null,
      eventType: "escalation",
      body: `Auto-escalation emailed (${overdue.reason}): ${waitingSummary(
        overdue.since,
        now,
      )}.`,
    });
    await db.insert(adminNotificationsTable).values({
      schoolId: lead.schoolId,
      type: "tour_lead_overdue",
      payload: {
        tourRequestId: lead.id,
        familyName: lead.familyName,
        reason: overdue.reason,
        assignedStaffId: lead.assignedStaffId ?? null,
      },
    });
    sent += 1;
  }

  return { skipped: false, scanned: leads.length, sent };
}

// -----------------------------------------------------------------------------
// School Tours — Phase 3 "close the loop with families" background nurture job.
//
// Hourly sweep (shares the escalation cron) that emails the FAMILY at the right
// lifecycle moment:
//   1. Pre-tour reminder      — status 'scheduled', within reminderLeadHours of
//                               tourScheduledAt (and not past).
//   2. Post-tour thank-you    — status 'toured' (with the survey link).
//   3. "Still deciding" nudge — status 'deciding', follow-up clock lapsed.
//   4. Enrollment welcome     — status 'closed' with outcome 'enrolled'.
//
// Idempotent: each step has its own *SentAt stamp set ONLY after a successful
// send, so a transient email failure is retried next hour and a step never
// double-sends. The deciding-nudge stamp is cleared whenever the follow-up
// clock is re-armed (see routes/tours.ts), so a fresh deciding cycle nudges
// again. Gated globally on EMAIL_REMINDERS_ENABLED and per-school on
// schoolSettings.tourFamilyNurtureEnabled (defaults OFF). Best-effort: one bad
// lead never sinks the sweep. Families without an email on file are skipped.
// -----------------------------------------------------------------------------

const FAMILY_STATUSES = ["scheduled", "toured", "deciding"] as const;

export interface TourFamilyNurtureResult {
  skipped: boolean;
  scanned: number;
  sent: number;
}

export async function runTourFamilyNurture(
  now: Date = new Date(),
): Promise<TourFamilyNurtureResult> {
  if (process.env.EMAIL_REMINDERS_ENABLED !== "true") {
    return { skipped: true, scanned: 0, sent: 0 };
  }

  // Candidates: the active-ish family-touch statuses, PLUS closed+enrolled leads
  // that have not yet had a welcome (the isNull guard keeps the historical
  // closed pile from being re-scanned forever).
  const leads = await db
    .select()
    .from(tourRequestsTable)
    .where(
      or(
        inArray(tourRequestsTable.status, FAMILY_STATUSES as never),
        and(
          eq(tourRequestsTable.status, "closed"),
          eq(tourRequestsTable.outcome, "enrolled"),
          isNull(tourRequestsTable.familyWelcomeSentAt),
        ),
      ),
    );
  if (leads.length === 0) return { skipped: false, scanned: 0, sent: 0 };

  const schoolIds = Array.from(new Set(leads.map((l) => l.schoolId)));

  const settingsRows = await db
    .select({
      schoolId: schoolSettingsTable.schoolId,
      nurtureEnabled: schoolSettingsTable.tourFamilyNurtureEnabled,
      reminderLeadHours: schoolSettingsTable.tourReminderLeadHours,
    })
    .from(schoolSettingsTable)
    .where(inArray(schoolSettingsTable.schoolId, schoolIds));
  const settingsMap = new Map(settingsRows.map((s) => [s.schoolId, s]));

  const schoolRows = await db
    .select({ id: schoolsTable.id, name: schoolsTable.name })
    .from(schoolsTable)
    .where(inArray(schoolsTable.id, schoolIds));
  const schoolNameMap = new Map(schoolRows.map((s) => [s.id, s.name]));

  let sent = 0;

  for (const lead of leads) {
    const settings = settingsMap.get(lead.schoolId);
    // Per-school opt-in (defaults OFF when no row exists).
    if (!settings || settings.nurtureEnabled !== true) continue;
    // Family email is required for every nurture message.
    const to = lead.email;
    if (!to) continue;

    const schoolName = schoolNameMap.get(lead.schoolId) ?? "our school";
    const base = {
      to,
      schoolName,
      familyName: lead.familyName,
      fromName: schoolName,
      signature: `Warmly,\nThe ${schoolName} Team`,
    };

    // Decide which (single) message applies to this lead this hour, send it,
    // and record the matching stamp column. At most one send per lead per pass.
    let ok = false;
    let stamp: Partial<typeof tourRequestsTable.$inferInsert> | null = null;
    let eventBody = "";

    if (lead.status === "scheduled") {
      const leadHours = settings.reminderLeadHours ?? 24;
      const at = lead.tourScheduledAt;
      const windowOpens = at
        ? at.getTime() - leadHours * 60 * 60 * 1000
        : null;
      if (
        at &&
        !lead.familyReminderSentAt &&
        windowOpens !== null &&
        now.getTime() >= windowOpens &&
        now.getTime() < at.getTime()
      ) {
        ok = await sendFamilyTourReminderEmail({
          ...base,
          tourWhen: at.toLocaleString("en-US", {
            timeZone: DEFAULT_SCHOOL_TZ,
            dateStyle: "full",
            timeStyle: "short",
          }),
        });
        stamp = { familyReminderSentAt: now };
        eventBody = "Pre-tour reminder emailed to the family.";
      }
    } else if (lead.status === "toured") {
      if (!lead.familyThankYouSentAt) {
        ok = await sendFamilyPostTourThankYouEmail({
          ...base,
          surveyUrl: surveyUrlForToken(lead.surveyToken),
        });
        stamp = { familyThankYouSentAt: now };
        eventBody = "Post-tour thank-you + survey emailed to the family.";
      }
    } else if (lead.status === "deciding") {
      if (
        !lead.familyDecidingNudgeSentAt &&
        lead.followUpDueAt &&
        lead.followUpDueAt.getTime() < now.getTime()
      ) {
        ok = await sendFamilyDecidingNudgeEmail(base);
        stamp = { familyDecidingNudgeSentAt: now };
        eventBody = "Gentle \u201cstill deciding\u201d nudge emailed to the family.";
      }
    } else if (lead.status === "closed" && lead.outcome === "enrolled") {
      if (!lead.familyWelcomeSentAt) {
        ok = await sendFamilyEnrollmentWelcomeEmail(base);
        stamp = { familyWelcomeSentAt: now };
        eventBody = "Enrollment welcome emailed to the family.";
      }
    }

    if (!ok || !stamp) continue;

    // Stamp + log only after a successful send.
    await db
      .update(tourRequestsTable)
      .set({ ...stamp, updatedAt: now })
      .where(
        and(
          eq(tourRequestsTable.id, lead.id),
          eq(tourRequestsTable.schoolId, lead.schoolId),
        ),
      );
    await db.insert(tourRequestEventsTable).values({
      schoolId: lead.schoolId,
      tourRequestId: lead.id,
      staffId: null,
      eventType: "escalation",
      body: eventBody,
    });
    sent += 1;
  }

  return { skipped: false, scanned: leads.length, sent };
}
