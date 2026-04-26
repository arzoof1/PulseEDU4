// Student demographic + designation flags — PATCH endpoint used by the
// MTSS Coordinator / Behavior Specialist / Admin to set the
// non-importer-managed flags (Critical Thinking ELA / Math) and to
// correct the importer-managed ones (gender, ELL, ESE, 504) inline
// from the Insights screens.
//
// Read access lives elsewhere: the existing students/teacherRoster/
// insights routes already join these columns into their payloads.

import { Router, type IRouter, type Request, type Response } from "express";
import { db, studentsTable, staffTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";

const router: IRouter = Router();

async function loadStaff(req: Request, res: Response) {
  const staffId = req.staffId;
  if (!staffId) {
    res.status(401).json({ error: "Sign-in required" });
    return null;
  }
  const [staff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, staffId));
  if (!staff || !staff.active) {
    res.status(401).json({ error: "Sign-in required" });
    return null;
  }
  return staff;
}

// Same gate the rest of the core-team surfaces use (mtssPlans, school
// store edit, accommodations admin). Keep this list in sync with
// requireCoreTeam in mtssPlans.ts.
function requireCoreTeam(
  staff: typeof staffTable.$inferSelect,
  res: Response,
): boolean {
  const allowed =
    staff.isSuperUser ||
    staff.isAdmin ||
    staff.isBehaviorSpecialist ||
    staff.isMtssCoordinator ||
    staff.isPbisCoordinator;
  if (!allowed) {
    res.status(403).json({
      error:
        "Only admins, Behavior Specialists, MTSS Coordinators, and PBIS Coordinators can edit student flags",
    });
    return false;
  }
  return true;
}

// PATCH /api/students/:studentId/flags
//   Body: { gender?, ell?, ese?, is504?, ctEla?, ctMath? }
//   - studentId in the path is the SIS-side text id (matches the rest
//     of this codebase's student references).
//   - Only fields explicitly present in the body are updated; missing
//     keys are left alone. Send `null` to clear `gender`; booleans must
//     be true/false.
//   - 200 returns the updated row. 404 if no such student in this school.
router.patch("/students/:studentId/flags", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!requireCoreTeam(staff, res)) return;

  const studentId = String(req.params.studentId ?? "").trim();
  if (!studentId) {
    res.status(400).json({ error: "Missing studentId" });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const updates: Partial<typeof studentsTable.$inferInsert> = {};

  // Boolean validator: only accepts strict true/false. Reject anything
  // else (numbers, strings, undefined-via-null) so a typo on the client
  // can't silently flip a flag.
  const setBool = (key: keyof typeof updates, src: unknown) => {
    if (src === undefined) return null; // not present → no change
    if (typeof src !== "boolean") return "BAD";
    (updates as Record<string, unknown>)[key as string] = src;
    return "OK";
  };
  for (const [bodyKey, colKey] of [
    ["ell", "ell"],
    ["ese", "ese"],
    ["is504", "is504"],
    ["ctEla", "ctEla"],
    ["ctMath", "ctMath"],
  ] as const) {
    const r = setBool(colKey, body[bodyKey]);
    if (r === "BAD") {
      res.status(400).json({ error: `${bodyKey} must be a boolean` });
      return;
    }
  }
  // Gender: text or null. We accept the empty string as "clear".
  if (Object.prototype.hasOwnProperty.call(body, "gender")) {
    const g = body.gender;
    if (g === null || g === "") {
      updates.gender = null;
    } else if (typeof g === "string") {
      updates.gender = g.trim().slice(0, 64) || null;
    } else {
      res.status(400).json({ error: "gender must be a string or null" });
      return;
    }
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  const [updated] = await db
    .update(studentsTable)
    .set(updates)
    .where(
      and(
        eq(studentsTable.studentId, studentId),
        eq(studentsTable.schoolId, schoolId),
      ),
    )
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Student not found in this school" });
    return;
  }
  res.json({
    studentId: updated.studentId,
    gender: updated.gender,
    ell: updated.ell,
    ese: updated.ese,
    is504: updated.is504,
    ctEla: updated.ctEla,
    ctMath: updated.ctMath,
  });
});

export default router;
