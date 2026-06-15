// Overdue-in-route hall pass alerts.
//
// A one-way (non-restroom) pass that has been active for longer than the
// school's `in_route_overdue_minutes` without an arrival means a student left
// their origin and never checked in at the destination — they could be
// wandering. This job finds those passes and raises ONE alert per pass
// (email always via Resend; SMS via lib/sms.ts once SMS is configured) to the
// school's admin / dean / behavior-specialist / core team.
//
// Idempotency: each pass carries `overdue_alerted_at`. We only consider passes
// where it is null, and we stamp it the moment we alert, so a pass is alerted
// at most once even if two cron ticks overlap. NO FLEID is ever placed in an
// alert body — student identity uses local_sis_id (or name) only.

import { and, eq, isNull, inArray } from "drizzle-orm";
import {
  db,
  hallPassesTable,
  schoolSettingsTable,
  studentsTable,
  staffTable,
} from "@workspace/db";
import { logger } from "../lib/logger.js";
import { loadRestroomDestinationNames } from "../lib/oneWayPass.js";
import { getUncachableResendClient } from "../lib/resendClient.js";
import { sendSmsBatch, toE164 } from "../lib/sms.js";

const DEFAULT_OVERDUE_MINUTES = 10;

export type InRouteOverdueResult = {
  schoolId: number;
  alerted: number;
};

// Staff who should hear about a stranded in-route student: admins and the
// core team (behavior specialist / MTSS coordinator / school psych / district
// admin / super) plus deans.
async function loadAlertRecipients(schoolId: number) {
  const rows = await db
    .select({
      displayName: staffTable.displayName,
      email: staffTable.email,
      cellPhone: staffTable.cellPhone,
      isSuperUser: staffTable.isSuperUser,
      isDistrictAdmin: staffTable.isDistrictAdmin,
      isAdmin: staffTable.isAdmin,
      isBehaviorSpecialist: staffTable.isBehaviorSpecialist,
      isMtssCoordinator: staffTable.isMtssCoordinator,
      isSchoolPsychologist: staffTable.isSchoolPsychologist,
      isDean: staffTable.isDean,
      active: staffTable.active,
    })
    .from(staffTable)
    .where(eq(staffTable.schoolId, schoolId));
  return rows.filter(
    (s) =>
      s.active &&
      (s.isSuperUser ||
        s.isDistrictAdmin ||
        s.isAdmin ||
        s.isBehaviorSpecialist ||
        s.isMtssCoordinator ||
        s.isSchoolPsychologist ||
        s.isDean),
  );
}

export async function runInRouteOverdueSweep(
  now: Date = new Date(),
): Promise<InRouteOverdueResult[]> {
  // Candidate passes across all schools: active, never arrived, never alerted.
  const candidates = await db
    .select()
    .from(hallPassesTable)
    .where(
      and(
        eq(hallPassesTable.status, "active"),
        isNull(hallPassesTable.arrivedAt),
        isNull(hallPassesTable.overdueAlertedAt),
      ),
    );
  if (candidates.length === 0) return [];

  const bySchool = new Map<number, typeof candidates>();
  for (const p of candidates) {
    if (!bySchool.has(p.schoolId)) bySchool.set(p.schoolId, []);
    bySchool.get(p.schoolId)!.push(p);
  }

  const results: InRouteOverdueResult[] = [];

  for (const [schoolId, passes] of bySchool.entries()) {
    const [settings] = await db
      .select({ minutes: schoolSettingsTable.inRouteOverdueMinutes })
      .from(schoolSettingsTable)
      .where(eq(schoolSettingsTable.schoolId, schoolId));
    const thresholdMin =
      settings?.minutes && settings.minutes > 0
        ? settings.minutes
        : DEFAULT_OVERDUE_MINUTES;
    const thresholdMs = thresholdMin * 60_000;

    const restroomNames = await loadRestroomDestinationNames(schoolId);

    // Overdue = non-restroom (one-way) AND aged past threshold.
    const overdue = passes.filter((p) => {
      if (restroomNames.has(p.destination)) return false;
      const age = now.getTime() - new Date(p.createdAt).getTime();
      return age >= thresholdMs;
    });
    if (overdue.length === 0) {
      results.push({ schoolId, alerted: 0 });
      continue;
    }

    // Enrich with student name / local SIS id for the alert body (no FLEID).
    const sids = Array.from(new Set(overdue.map((p) => p.studentId)));
    const studentBySid = new Map<
      string,
      { firstName: string | null; lastName: string | null; localSisId: string | null }
    >();
    if (sids.length > 0) {
      const stu = await db
        .select({
          studentId: studentsTable.studentId,
          firstName: studentsTable.firstName,
          lastName: studentsTable.lastName,
          localSisId: studentsTable.localSisId,
        })
        .from(studentsTable)
        .where(
          and(
            eq(studentsTable.schoolId, schoolId),
            inArray(studentsTable.studentId, sids),
          ),
        );
      for (const s of stu)
        studentBySid.set(s.studentId, {
          firstName: s.firstName,
          lastName: s.lastName,
          localSisId: s.localSisId,
        });
    }

    const recipients = await loadAlertRecipients(schoolId);
    const emails = recipients
      .map((r) => r.email)
      .filter((e): e is string => Boolean(e));
    const phones = recipients
      .map((r) => r.cellPhone)
      .filter((p): p is string => Boolean(p && toE164(p)));

    let alerted = 0;
    for (const pass of overdue) {
      const stu = studentBySid.get(pass.studentId);
      const name =
        [stu?.firstName, stu?.lastName].filter(Boolean).join(" ") ||
        stu?.localSisId ||
        "A student";
      const idLabel = stu?.localSisId ? ` (ID ${stu.localSisId})` : "";
      const ageMin = Math.round(
        (now.getTime() - new Date(pass.createdAt).getTime()) / 60_000,
      );
      const subject = `Overdue hall pass: ${name} en route to ${pass.destination}`;
      const text =
        `${name}${idLabel} left ${pass.originRoom} ${ageMin} min ago ` +
        `on a pass to ${pass.destination} and has not checked in. ` +
        `Please verify the student arrived safely.`;

      // Atomically CLAIM this pass as the dedup key: only the run that wins
      // the `overdue_alerted_at IS NULL` race gets a returned row and sends.
      // A second overlapping cron tick (or retry) finds it already stamped
      // and skips — so we never double-alert even under concurrent runs.
      const claimed = await db
        .update(hallPassesTable)
        .set({ overdueAlertedAt: now.toISOString() })
        .where(
          and(
            eq(hallPassesTable.id, pass.id),
            isNull(hallPassesTable.overdueAlertedAt),
          ),
        )
        .returning({ id: hallPassesTable.id });
      if (claimed.length === 0) continue;

      if (emails.length > 0) {
        try {
          const { client, fromEmail } = await getUncachableResendClient();
          await client.emails.send({
            from: fromEmail,
            to: emails,
            subject,
            text,
          });
        } catch (err) {
          logger.warn(
            { err, schoolId, passId: pass.id },
            "in-route overdue: email send failed",
          );
        }
      }

      if (phones.length > 0) {
        await sendSmsBatch(phones, text);
      }

      alerted += 1;
    }

    logger.info(
      { schoolId, alerted, thresholdMin },
      "in-route overdue sweep complete",
    );
    results.push({ schoolId, alerted });
  }

  return results;
}
