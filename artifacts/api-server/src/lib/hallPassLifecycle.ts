import { db, hallPassesTable, schoolSettingsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

// Forgotten-pass safety net. Any pass still `active` past the school's
// configured auto-end threshold is closed as `auto_ended`, with its end time
// capped at createdAt + threshold so the recorded duration never balloons for
// a pass a student simply forgot to close (e.g. the bell rang while they were
// out). Idempotent: each UPDATE re-checks `status = 'active'`, so concurrent
// readers converge and never double-apply.
//
// Shared single source of truth: EVERY surface that reads/gates on "currently
// active" passes (staff pass log, kiosk queue, companion queue, kiosk create /
// return) must call this first so a forgotten pass can't linger on one surface
// while it's been closed on another.
export async function autoEndStalePasses(schoolId: number): Promise<void> {
  const [settings] = await db
    .select({ minutes: schoolSettingsTable.hallPassAutoEndMinutes })
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, schoolId));
  const minutes = settings?.minutes ?? 20;
  if (!minutes || minutes < 1) return;
  const cutoffMs = Date.now() - minutes * 60 * 1000;
  const active = await db
    .select({ id: hallPassesTable.id, createdAt: hallPassesTable.createdAt })
    .from(hallPassesTable)
    .where(
      and(
        eq(hallPassesTable.schoolId, schoolId),
        eq(hallPassesTable.status, "active"),
      ),
    );
  for (const p of active) {
    const startedMs = new Date(p.createdAt).getTime();
    if (Number.isNaN(startedMs) || startedMs > cutoffMs) continue;
    const endedAt = new Date(startedMs + minutes * 60 * 1000).toISOString();
    await db
      .update(hallPassesTable)
      .set({ status: "auto_ended", endedAt, endedBy: "(auto)" })
      .where(
        and(
          eq(hallPassesTable.id, p.id),
          eq(hallPassesTable.status, "active"),
        ),
      );
  }
}
