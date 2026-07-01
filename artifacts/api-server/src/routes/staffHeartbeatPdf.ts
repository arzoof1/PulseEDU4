import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { db, staffTable, studentsTable, schoolsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import { getVisibleStudentIds } from "./insights.js";
import { buildStaffSnapshot } from "../lib/parentSnapshot.js";
import { renderSnapshotPdf } from "../lib/parentSnapshotPdf.js";

const router: IRouter = Router();

// Inline requireStaff — matches the self-contained pattern the other route
// files use (studentLookup.ts / students.ts). Loads the full staff row onto
// req.staff for the visibility resolver.
async function requireStaff(req: Request, res: Response, next: NextFunction) {
  const staffId = req.staffId;
  if (!staffId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const [staff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, staffId));
  if (!staff || !staff.active) {
    res.status(401).json({ error: "Staff not found or inactive" });
    return;
  }
  (req as Request & { staff: typeof staffTable.$inferSelect }).staff = staff;
  next();
}

function parsePositiveInt(raw: unknown): number | null {
  const n = typeof raw === "string" ? Number(raw) : (raw as number);
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

// ---------------------------------------------------------------------------
// GET /api/staff/heartbeat.pdf?studentId=<numeric db id>
//
// Staff-facing print of the family HeartBEAT PDF — the same document a parent
// would download, for use during a data chat. Visibility-scoped via the SAME
// getVisibleStudentIds resolver the Student Lookup / Profile endpoints use
// (teachers -> own roster + trusted-adult; core team / admin / counselor ->
// school-wide) and school-scoped, so it never leaks an out-of-scope student.
// Section visibility falls back to the school's HeartBEAT defaults (no parent
// account, no per-parent prefs). localSisId only — never FLEID.
// ---------------------------------------------------------------------------
router.get("/staff/heartbeat.pdf", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;

  const studentDbId = parsePositiveInt(req.query.studentId);
  if (studentDbId === null) {
    res.status(400).json({ error: "studentId must be a positive integer" });
    return;
  }

  // Resolve the student's canonical (string) studentId for the visibility
  // check — the resolver keys on that, not the numeric db id.
  const [student] = await db
    .select({
      id: studentsTable.id,
      studentId: studentsTable.studentId,
      schoolId: studentsTable.schoolId,
    })
    .from(studentsTable)
    .where(eq(studentsTable.id, studentDbId));
  if (!student || student.schoolId !== schoolId) {
    res.status(404).json({ error: "Student not found" });
    return;
  }

  // Visibility gate. Return an indistinguishable 404 (same as a non-existent
  // id) so an authenticated staff member can't probe which students exist in
  // the school but sit outside their roster / trusted-adult scope.
  const visibility = await getVisibleStudentIds(staff, schoolId);
  if (!visibility.full && !visibility.ids.has(student.studentId)) {
    res.status(404).json({ error: "Student not found" });
    return;
  }

  const result = await buildStaffSnapshot(studentDbId, schoolId);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }

  // School name for the header strip — best-effort, ok if missing.
  let schoolName: string | undefined;
  try {
    const [row] = await db
      .select({ name: schoolsTable.name })
      .from(schoolsTable)
      .where(eq(schoolsTable.id, schoolId));
    schoolName = row?.name ?? undefined;
  } catch {
    schoolName = undefined;
  }

  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await renderSnapshotPdf(result.data, { schoolName });
  } catch (err) {
    req.log.error({ err }, "renderSnapshotPdf (staff) failed");
    res.status(500).json({ error: "Could not generate PDF" });
    return;
  }

  const safeName =
    `${result.data.student.firstName}-${result.data.student.lastName}`
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .slice(0, 80) || "snapshot";
  const filename = `HeartBEAT-${safeName}.pdf`;

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Length", pdfBuffer.length.toString());
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}"`,
  );
  res.end(pdfBuffer);
});

export default router;
