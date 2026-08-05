// School-configurable kiosk pass length (minutes). Replaces the old
// hardcoded config.defaultHallPassDurationMinutes (4). Used for
// kiosk-created passes and as the fallback when a teacher-created pass
// doesn't specify a duration. Falls back to the config default when the
// school has no settings row yet.
import { eq } from "drizzle-orm";
import { db, schoolSettingsTable } from "@workspace/db";
import { config } from "../data/config";

export async function kioskPassMinutesFor(schoolId: number): Promise<number> {
  const [row] = await db
    .select({ minutes: schoolSettingsTable.kioskPassMinutes })
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, schoolId));
  const m = row?.minutes;
  return typeof m === "number" && Number.isInteger(m) && m >= 1 && m <= 60
    ? m
    : config.defaultHallPassDurationMinutes;
}
