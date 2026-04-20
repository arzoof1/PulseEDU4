import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { db, supportNotesTable, staffTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

type StaffRow = typeof staffTable.$inferSelect;

async function requireStaff(
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
  (req as Request & { staff: StaffRow }).staff = staff;
  next();
}

// Support notes are part of a student's full activity history (Student
// Activity screen, student detail panels). Any signed-in staff may read.
router.get("/support-notes", requireStaff, async (req, res) => {
  const { studentId } = req.query;
  if (typeof studentId === "string" && studentId) {
    const rows = await db
      .select()
      .from(supportNotesTable)
      .where(eq(supportNotesTable.studentId, studentId));
    res.json(rows);
    return;
  }
  const rows = await db.select().from(supportNotesTable);
  res.json(rows);
});

router.post("/support-notes", requireStaff, async (req, res) => {
  const staff = (req as Request & { staff: StaffRow }).staff;
  if (!staff.capSupportNotes) {
    res.status(403).json({ error: "Support notes is not granted" });
    return;
  }
  const { studentId, noteType, noteText } = req.body ?? {};

  if (typeof studentId !== "string" || !studentId) {
    res.status(400).json({ error: "studentId is required" });
    return;
  }
  if (typeof noteType !== "string" || !noteType) {
    res.status(400).json({ error: "noteType is required" });
    return;
  }
  if (typeof noteText !== "string" || !noteText) {
    res.status(400).json({ error: "noteText is required" });
    return;
  }

  // staffName is always derived from session — never trust client input.
  const [note] = await db
    .insert(supportNotesTable)
    .values({
      studentId,
      noteType,
      noteText,
      staffName: staff.displayName,
      createdAt: new Date().toISOString(),
    })
    .returning();

  res.status(201).json(note);
});

export default router;
