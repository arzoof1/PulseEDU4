import { db, schoolSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// Master per-school switches for automated/recurring PARENT notifications,
// managed from the Parent Notifications panel (Family Communication). Each is
// an additive AND-gate layered on top of the send site's existing gates
// (feature flags, parent opt-ins, etc.). All default TRUE so a school with no
// settings row — or one that never touched the panel — keeps current behavior.
export type ParentNotifyKey =
  | "notifyParentEligibility"
  | "notifyParentPbisMilestone"
  | "notifyParentTardy"
  | "notifyParentEventTickets"
  | "notifyParentEsign";

export async function isParentNotifyEnabled(
  schoolId: number,
  key: ParentNotifyKey,
): Promise<boolean> {
  const [row] = await db
    .select({ v: schoolSettingsTable[key] })
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, schoolId));
  // No settings row yet → preserve behavior (enabled).
  return row?.v ?? true;
}
