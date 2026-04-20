import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  db,
  studentsTable,
  studentAccommodationsTable,
  schoolAccommodationsTable,
  staffTable,
} from "@workspace/db";
import { eq, isNull } from "drizzle-orm";

const router: IRouter = Router();

async function requireSignedIn(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const staffId = req.session.staffId;
  if (!staffId) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const [staff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, staffId));
  if (!staff || !staff.active) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  next();
}

// Student roster is read by nearly every screen (hall passes, kiosk picker,
// rosters, accommodation pages). Any signed-in staff member may read it;
// per-feature gates live on the action endpoints (e.g. capStudentActivity
// gates the "Student Activity" screen on the client).
router.get("/students", requireSignedIn, async (_req, res) => {
  const rows = await db.select().from(studentsTable).orderBy(studentsTable.id);
  const assignments = await db
    .select({
      studentId: studentAccommodationsTable.studentId,
      name: schoolAccommodationsTable.name,
    })
    .from(studentAccommodationsTable)
    .innerJoin(
      schoolAccommodationsTable,
      eq(studentAccommodationsTable.accommodationId, schoolAccommodationsTable.id),
    )
    .where(isNull(studentAccommodationsTable.removedAt));

  const byStudent = new Map<string, string[]>();
  for (const a of assignments) {
    const list = byStudent.get(a.studentId) ?? [];
    list.push(a.name);
    byStudent.set(a.studentId, list);
  }

  res.json(
    rows.map((r) => ({
      ...r,
      accommodations: byStudent.get(r.studentId) ?? [],
    })),
  );
});

export default router;
