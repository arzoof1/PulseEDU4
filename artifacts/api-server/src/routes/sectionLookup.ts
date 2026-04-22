import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import {
  db,
  classSectionsTable,
  sectionRosterTable,
  staffTable,
} from "@workspace/db";

const router: IRouter = Router();

router.get("/section-lookup", async (req, res) => {
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

  const studentId = String(req.query.studentId ?? "");
  const periodNum = Number(req.query.period);

  if (!studentId || !Number.isFinite(periodNum)) {
    res.status(400).json({ error: "studentId and period are required" });
    return;
  }

  const rows = await db
    .select({
      teacherName: staffTable.displayName,
      defaultRoom: staffTable.defaultRoom,
      isPlanning: classSectionsTable.isPlanning,
      courseName: classSectionsTable.courseName,
    })
    .from(sectionRosterTable)
    .innerJoin(
      classSectionsTable,
      eq(sectionRosterTable.sectionId, classSectionsTable.id),
    )
    .innerJoin(staffTable, eq(staffTable.id, classSectionsTable.teacherStaffId))
    .where(
      and(
        eq(sectionRosterTable.studentId, studentId),
        eq(classSectionsTable.period, periodNum),
      ),
    )
    .limit(1);

  if (rows.length === 0) {
    res.status(404).json({
      error: `No section found for student ${studentId} in period ${periodNum}`,
    });
    return;
  }

  res.json({
    teacherName: rows[0].teacherName,
    room: rows[0].defaultRoom ?? "",
    courseName: rows[0].courseName,
  });
});

export default router;
