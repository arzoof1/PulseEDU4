import { Router, type IRouter } from "express";
import { db, supportNotesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";

const router: IRouter = Router();

router.get("/support-notes", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const { studentId } = req.query;
  if (typeof studentId === "string" && studentId) {
    const rows = await db
      .select()
      .from(supportNotesTable)
      .where(
        and(
          eq(supportNotesTable.studentId, studentId),
          eq(supportNotesTable.schoolId, schoolId),
        ),
      );
    res.json(rows);
    return;
  }
  const rows = await db
    .select()
    .from(supportNotesTable)
    .where(eq(supportNotesTable.schoolId, schoolId));
  res.json(rows);
});

router.post("/support-notes", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const { studentId, noteType, noteText, staffName } = req.body ?? {};

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

  const [note] = await db
    .insert(supportNotesTable)
    .values({
      schoolId,
      studentId,
      noteType,
      noteText,
      staffName: typeof staffName === "string" ? staffName : "",
      createdAt: new Date().toISOString(),
    })
    .returning();

  res.status(201).json(note);
});

export default router;
