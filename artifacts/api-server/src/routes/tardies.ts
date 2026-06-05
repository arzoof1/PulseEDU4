import { Router, type IRouter } from "express";
import { db, tardiesTable, staffTable, studentsTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import { resolveStudentIdInput } from "../lib/studentIdResolver.js";

const router: IRouter = Router();

router.get("/tardies", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const rows = await db
    .select()
    .from(tardiesTable)
    .where(eq(tardiesTable.schoolId, schoolId));
  // Enrich each tardy with the student's local_sis_id so the UI can
  // render it as the student-facing credential. FLEID stays in
  // studentId for internal joins.
  const sids = Array.from(new Set(rows.map((r) => r.studentId)));
  const localBySid = new Map<string, string | null>();
  if (sids.length > 0) {
    const stu = await db
      .select({
        studentId: studentsTable.studentId,
        localSisId: studentsTable.localSisId,
      })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.schoolId, schoolId),
          inArray(studentsTable.studentId, sids),
        ),
      );
    for (const s of stu) localBySid.set(s.studentId, s.localSisId);
  }
  res.json(
    rows.map((r) => ({ ...r, localSisId: localBySid.get(r.studentId) ?? null })),
  );
});

router.post("/tardies", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const {
    studentId,
    teacherName,
    period,
    reason,
    entryType,
    checkInWith,
    notes,
  } = req.body ?? {};

  const sessionStaffId = req.staffId;
  if (!sessionStaffId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const [sessionStaff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, sessionStaffId));
  if (!sessionStaff || !sessionStaff.active) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const serverCreatedBy = sessionStaff.displayName || String(sessionStaff.id);

  if (
    typeof studentId !== "string" ||
    typeof teacherName !== "string" ||
    typeof period !== "string"
  ) {
    res.status(400).json({
      error: "studentId, teacherName, and period are required",
    });
    return;
  }

  // Accept either FLEID or local SIS ID — translate the latter to
  // the canonical FLEID before insert so the rest of the system
  // (FAST joins, parent portal, audit logs) keeps working.
  const resolved = await resolveStudentIdInput(schoolId, studentId);
  if (!resolved) {
    res.status(404).json({ error: `No student with ID "${studentId}"` });
    return;
  }
  const canonicalStudentId = resolved;

  // "intervention" is a first-class entry type written by the
  // CheckInOutModal when a teacher logs a classroom intervention. Without
  // it here the row would silently land as "tardy" and disappear from the
  // Recent Interventions list (which filters on checkin/checkout/intervention).
  const type: "tardy" | "checkin" | "checkout" | "intervention" =
    entryType === "checkin"
      ? "checkin"
      : entryType === "checkout"
        ? "checkout"
        : entryType === "intervention"
          ? "intervention"
          : "tardy";

  if (
    (type === "checkin" || type === "checkout" || type === "intervention") &&
    (typeof checkInWith !== "string" || !checkInWith)
  ) {
    res
      .status(400)
      .json({
        error:
          "checkInWith is required for check-in, check-out, and intervention entries",
      });
    return;
  }

  const [tardy] = await db
    .insert(tardiesTable)
    .values({
      schoolId,
      studentId: canonicalStudentId,
      teacherName,
      period,
      reason: typeof reason === "string" ? reason : "",
      entryType: type,
      // Persist the intervention/check-in/check-out label so the Recent
      // Interventions table can render the intervention name.
      checkInWith:
        type === "checkin" || type === "checkout" || type === "intervention"
          ? (checkInWith as string)
          : null,
      notes: typeof notes === "string" ? notes : "",
      createdBy: serverCreatedBy,
      createdAt: new Date().toISOString(),
    })
    .returning();

  res.status(201).json(tardy);
});

export default router;
