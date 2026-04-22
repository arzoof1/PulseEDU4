import { Router, type IRouter } from "express";
import { db, schoolSettingsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";

const router: IRouter = Router();

// Read or lazily create the settings row for a given school. The
// `school_settings_school_id_unique` index guarantees one row per school,
// so the second concurrent request just hits the existing row.
async function getOrCreate(schoolId: number) {
  const [row] = await db
    .select()
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, schoolId));
  if (row) return row;
  try {
    const [created] = await db
      .insert(schoolSettingsTable)
      .values({ schoolId })
      .returning();
    return created;
  } catch {
    // Another concurrent request inserted first — just re-read.
    const [row2] = await db
      .select()
      .from(schoolSettingsTable)
      .where(eq(schoolSettingsTable.schoolId, schoolId));
    return row2;
  }
}

router.get("/school-settings", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const row = await getOrCreate(schoolId);
  res.json(row);
});

router.put("/school-settings", async (req, res): Promise<void> => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const current = await getOrCreate(schoolId);
  const {
    schoolName,
    fromName,
    emailSignature,
    periodCount,
    hallPassMaxMinutes,
    hallPassDefaultMinutes,
    globalDailyHallPassLimit,
    pbisQuietTeacherDays,
    pbisInvisibleStudentDays,
    pbisReasonImbalancePct,
    pbisColdPeriodMultiple,
  } = req.body ?? {};

  const updates: Partial<typeof schoolSettingsTable.$inferInsert> = {};
  if (typeof schoolName === "string" && schoolName.trim()) {
    updates.schoolName = schoolName.trim();
  }
  if (typeof fromName === "string" && fromName.trim()) {
    updates.fromName = fromName.trim();
  }
  if (typeof emailSignature === "string") {
    updates.emailSignature = emailSignature;
  }
  if (periodCount !== undefined) {
    if (
      typeof periodCount !== "number" ||
      !Number.isInteger(periodCount) ||
      periodCount < 1 ||
      periodCount > 12
    ) {
      res
        .status(400)
        .json({ error: "periodCount must be an integer between 1 and 12" });
      return;
    }
    updates.periodCount = periodCount;
  }
  if (hallPassMaxMinutes !== undefined) {
    if (
      typeof hallPassMaxMinutes !== "number" ||
      !Number.isInteger(hallPassMaxMinutes) ||
      hallPassMaxMinutes < 1 ||
      hallPassMaxMinutes > 240
    ) {
      res.status(400).json({
        error: "hallPassMaxMinutes must be an integer between 1 and 240",
      });
      return;
    }
    updates.hallPassMaxMinutes = hallPassMaxMinutes;
  }
  if (hallPassDefaultMinutes !== undefined) {
    if (
      typeof hallPassDefaultMinutes !== "number" ||
      !Number.isInteger(hallPassDefaultMinutes) ||
      hallPassDefaultMinutes < 1 ||
      hallPassDefaultMinutes > 240
    ) {
      res.status(400).json({
        error:
          "hallPassDefaultMinutes must be an integer between 1 and 240",
      });
      return;
    }
    updates.hallPassDefaultMinutes = hallPassDefaultMinutes;
  }
  if (globalDailyHallPassLimit !== undefined) {
    if (globalDailyHallPassLimit === null) {
      updates.globalDailyHallPassLimit = null;
    } else if (
      typeof globalDailyHallPassLimit !== "number" ||
      !Number.isInteger(globalDailyHallPassLimit) ||
      globalDailyHallPassLimit < 1 ||
      globalDailyHallPassLimit > 100
    ) {
      res.status(400).json({
        error:
          "globalDailyHallPassLimit must be null or an integer between 1 and 100",
      });
      return;
    } else {
      updates.globalDailyHallPassLimit = globalDailyHallPassLimit;
    }
  }

  const intRange = (
    name: string,
    val: unknown,
    min: number,
    max: number,
    field: keyof typeof schoolSettingsTable.$inferInsert,
  ): string | null => {
    if (val === undefined) return null;
    if (
      typeof val !== "number" ||
      !Number.isInteger(val) ||
      val < min ||
      val > max
    ) {
      return `${name} must be an integer between ${min} and ${max}`;
    }
    (updates as Record<string, unknown>)[field as string] = val;
    return null;
  };

  for (const err of [
    intRange(
      "pbisQuietTeacherDays",
      pbisQuietTeacherDays,
      1,
      60,
      "pbisQuietTeacherDays",
    ),
    intRange(
      "pbisInvisibleStudentDays",
      pbisInvisibleStudentDays,
      1,
      180,
      "pbisInvisibleStudentDays",
    ),
    intRange(
      "pbisReasonImbalancePct",
      pbisReasonImbalancePct,
      10,
      100,
      "pbisReasonImbalancePct",
    ),
    intRange(
      "pbisColdPeriodMultiple",
      pbisColdPeriodMultiple,
      2,
      20,
      "pbisColdPeriodMultiple",
    ),
  ]) {
    if (err) {
      res.status(400).json({ error: err });
      return;
    }
  }

  if (Object.keys(updates).length === 0) {
    res.json(current);
    return;
  }

  // Always scope by both id AND schoolId — defensive, in case the
  // settings row id ever leaks across schools.
  const [updated] = await db
    .update(schoolSettingsTable)
    .set(updates)
    .where(
      and(
        eq(schoolSettingsTable.id, current.id),
        eq(schoolSettingsTable.schoolId, schoolId),
      ),
    )
    .returning();
  res.json(updated);
});

export default router;
