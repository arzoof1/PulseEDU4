// Printable Student Overall Report PDF.
// Gated to admin tier (Admin/SuperUser/DistrictAdmin), Core Team
// (BehaviorSpec/MTSS/ESE), School Psychologist, and Guidance Counselor.
// Other staff (and parents) get 403.
//
// The report is a one-pager designed for case-conference printouts:
//   - Identity & demographics (name, ID, grade, ESE/504/ELL, accommodations)
//   - PBIS rollup (points YTD, recent recognitions count)
//   - Hall passes & tardies counts (YTD)
//   - ISS / OSS day counts (YTD)
//   - Active MTSS plans summary
//   - Active safety plan summary
//   - Emergency contacts
import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  staffTable,
  studentsTable,
  pbisEntriesTable,
  hallPassesTable,
  tardiesTable,
  issAttendanceDayTable,
  ossLogDaysTable,
  studentMtssPlansTable,
  safetyPlansTable,
  studentAccommodationsTable,
  schoolAccommodationsTable,
  studentEmergencyContactsTable,
} from "@workspace/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import PDFDocument from "pdfkit";
import { requireSchool } from "../lib/scope.js";

const router: IRouter = Router();
type StaffRow = typeof staffTable.$inferSelect;

function canPrintReport(s: StaffRow): boolean {
  return Boolean(
    s.isSuperUser ||
      s.isDistrictAdmin ||
      s.isAdmin ||
      s.isBehaviorSpecialist ||
      s.isMtssCoordinator ||
      s.isEseCoordinator ||
      s.isSchoolPsychologist ||
      s.isGuidanceCounselor,
  );
}

router.get(
  "/students/:studentId/overall-report-pdf",
  async (req: Request, res: Response): Promise<void> => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;

    const staffId = req.staffId;
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
    if (!canPrintReport(staff)) {
      res.status(403).json({
        error:
          "Admin / Core Team / School Psych / Guidance Counselor only",
      });
      return;
    }

    const studentId = String(req.params.studentId ?? "");
    if (!studentId) {
      res.status(400).json({ error: "studentId required" });
      return;
    }
    const [student] = await db
      .select()
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.studentId, studentId),
          eq(studentsTable.schoolId, schoolId),
        ),
      );
    if (!student) {
      res.status(404).json({ error: "Student not found" });
      return;
    }

    // Roll-ups (counts only — PDF stays one page).
    const yearStart = (() => {
      const today = new Date();
      const y = today.getMonth() + 1 >= 7 ? today.getFullYear() : today.getFullYear() - 1;
      return `${y}-07-01`;
    })();

    const [pbisRow] = (await db.execute(
      sql`SELECT COALESCE(SUM(points), 0)::int AS total,
                 COUNT(*)::int AS entries
            FROM pbis_entries
           WHERE school_id = ${schoolId}
             AND student_id = ${studentId}
             AND voided_at IS NULL
             AND created_at >= ${yearStart}`,
    )).rows as { total: number; entries: number }[];

    const [hpRow] = (await db.execute(
      sql`SELECT COUNT(*)::int AS c FROM hall_passes
           WHERE school_id = ${schoolId} AND student_id = ${studentId}
             AND created_at >= ${yearStart}`,
    )).rows as { c: number }[];

    const [tardyRow] = (await db.execute(
      sql`SELECT COUNT(*)::int AS c FROM tardies
           WHERE school_id = ${schoolId} AND student_id = ${studentId}
             AND created_at >= ${yearStart}`,
    )).rows as { c: number }[];

    const [issRow] = (await db.execute(
      sql`SELECT COUNT(*)::int AS c FROM iss_attendance_day
           WHERE school_id = ${schoolId} AND student_id = ${studentId}
             AND day >= ${yearStart}`,
    )).rows as { c: number }[];

    const [ossRow] = (await db.execute(
      sql`SELECT COUNT(*)::int AS c FROM oss_log_days
           WHERE school_id = ${schoolId} AND student_id = ${studentId}
             AND NOT cancelled AND day >= ${yearStart}`,
    )).rows as { c: number }[];

    const mtssPlans = await db
      .select()
      .from(studentMtssPlansTable)
      .where(
        and(
          eq(studentMtssPlansTable.schoolId, schoolId),
          eq(studentMtssPlansTable.studentId, studentId),
          isNull(studentMtssPlansTable.closedAt),
        ),
      );

    const [safety] = await db
      .select()
      .from(safetyPlansTable)
      .where(
        and(
          eq(safetyPlansTable.schoolId, schoolId),
          eq(safetyPlansTable.studentId, studentId),
          eq(safetyPlansTable.status, "active"),
        ),
      );

    const accommodations = await db
      .select({ name: schoolAccommodationsTable.name })
      .from(studentAccommodationsTable)
      .innerJoin(
        schoolAccommodationsTable,
        eq(
          studentAccommodationsTable.accommodationId,
          schoolAccommodationsTable.id,
        ),
      )
      .where(
        and(
          eq(studentAccommodationsTable.schoolId, schoolId),
          eq(studentAccommodationsTable.studentId, studentId),
          isNull(studentAccommodationsTable.removedAt),
        ),
      );

    const contacts = await db
      .select()
      .from(studentEmergencyContactsTable)
      .where(
        and(
          eq(studentEmergencyContactsTable.schoolId, schoolId),
          eq(studentEmergencyContactsTable.studentId, studentId),
        ),
      );

    // Render
    const doc = new PDFDocument({
      size: "LETTER",
      margins: { top: 50, bottom: 50, left: 50, right: 50 },
      info: {
        Title: `Overall Report — ${student.firstName} ${student.lastName}`,
        Author: "PulseEDU",
      },
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="overall-report-${studentId}.pdf"`,
    );
    doc.pipe(res);

    const heading = (txt: string) => {
      doc
        .moveDown(0.6)
        .font("Helvetica-Bold")
        .fontSize(11)
        .fillColor("#3b3b3b")
        .text(txt.toUpperCase(), { characterSpacing: 1 })
        .moveTo(50, doc.y)
        .lineTo(562, doc.y)
        .strokeColor("#d4d4d4")
        .stroke()
        .moveDown(0.3)
        .fillColor("black")
        .font("Helvetica")
        .fontSize(10);
    };

    doc
      .font("Helvetica-Bold")
      .fontSize(18)
      .text(`${student.firstName} ${student.lastName}`, { continued: false });
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor("#666")
      .text(
        `Student ID ${student.studentId}  ·  Grade ${student.grade ?? "—"}  ·  Generated ${new Date().toLocaleString()}`,
      )
      .fillColor("black");

    heading("Programs");
    const programs: string[] = [];
    if (student.ese) programs.push("ESE");
    if (student.is504) programs.push("504");
    if (student.ell) programs.push("ELL");
    doc.text(programs.length ? programs.join("  ·  ") : "None on file");
    if (accommodations.length > 0) {
      doc.moveDown(0.3).text(
        `Accommodations: ${accommodations.map((a) => a.name).join(", ")}`,
      );
    }

    heading("This year at a glance");
    doc.text(
      `PBIS points: ${pbisRow?.total ?? 0}  ·  Recognitions: ${pbisRow?.entries ?? 0}`,
    );
    doc.text(`Hall passes: ${hpRow?.c ?? 0}  ·  Tardies: ${tardyRow?.c ?? 0}`);
    doc.text(`ISS days: ${issRow?.c ?? 0}  ·  OSS days: ${ossRow?.c ?? 0}`);

    heading("Active MTSS plans");
    if (mtssPlans.length === 0) {
      doc.fillColor("#666").text("None active.").fillColor("black");
    } else {
      for (const p of mtssPlans) {
        doc.text(`Tier ${p.tier} — ${p.goals ?? "(no goal stated)"}`);
      }
    }

    heading("Safety plan");
    if (!safety) {
      doc.fillColor("#666").text("No active safety plan.").fillColor("black");
    } else {
      const items = (safety.items ?? []) as Array<{
        active?: boolean;
        label?: string;
      }>;
      const active = items.filter((i) => i && i.active);
      doc.text(`${active.length} active item${active.length === 1 ? "" : "s"}.`);
      for (const it of active.slice(0, 8)) {
        doc.text(`  • ${it.label ?? "(unlabeled)"}`);
      }
    }

    heading("Emergency contacts");
    if (contacts.length === 0) {
      doc.fillColor("#666").text("No contacts on file.").fillColor("black");
    } else {
      const sorted = [...contacts].sort((a, b) => a.slot - b.slot);
      for (const c of sorted) {
        const parts = [c.contactName];
        if (c.relationship) parts.push(`(${c.relationship})`);
        if (c.phone)
          parts.push(c.phoneLabel ? `${c.phone} [${c.phoneLabel}]` : c.phone);
        doc.text(parts.join("  "));
      }
    }

    doc
      .moveDown(1)
      .fontSize(8)
      .fillColor("#888")
      .text(
        "Confidential — for staff use only. Not for distribution outside the case-conference team.",
        { align: "center" },
      );

    doc.end();
  },
);

export default router;
