// Communication Log + Call Initiative.
//
// The Communication Log records family contacts (calls / emails / Parent Square
// messages) about a student. Surfaces:
//   - communication_types: editable per-school list (Phone / Email / Parent
//     Square seeded lazily), rename-preserving (logs snapshot the name).
//   - family contact loader: the student's primary guardian + emergency
//     contacts, with bad-number flags and corrected-number overrides applied.
//   - POST a log; GET the per-student timeline.
//   - bad-number flags -> front-office "Contact Info Fixes" queue.
//   - call initiatives ("call all families" campaigns) + per-teacher worklist.
//
// FLEID-safe: student_id is the FK; every student-facing field renders
// localSisId. Every query is school-scoped. Reads are visibility-scoped with
// the SAME resolver the Student Profile / Student Lookup endpoints use.

import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  db,
  staffTable,
  studentsTable,
  studentEmergencyContactsTable,
  communicationTypesTable,
  communicationLogsTable,
  badNumberFlagsTable,
  schoolsTable,
} from "@workspace/db";
import { and, eq, inArray, desc, sql } from "drizzle-orm";
import PDFDocument from "pdfkit";
import { requireSchool } from "../lib/scope.js";
import { isCoreTeam } from "../lib/coreTeam.js";
import { getVisibleStudentIds } from "./insights.js";
import { getUncachableResendClient } from "../lib/resendClient.js";
import { logger } from "../lib/logger.js";

// Neutralize CSV formula injection: a cell starting with = + - @ (or a control
// char) can execute in Excel/Sheets. Prefix with an apostrophe and always quote.
function csvCell(value: unknown): string {
  let s = value == null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

// Escape user-supplied text before interpolating into email HTML.
function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const router: IRouter = Router();

type Staff = typeof staffTable.$inferSelect;

async function loadStaff(req: Request, res: Response): Promise<Staff | null> {
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

async function requireStaff(req: Request, res: Response, next: NextFunction) {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  (req as Request & { staff: Staff }).staff = staff;
  next();
}

function getStaff(req: Request): Staff {
  return (req as Request & { staff: Staff }).staff;
}

// ---------------------------------------------------------------------------
// Communication Types (editable list)
// ---------------------------------------------------------------------------

const DEFAULT_TYPES = ["Phone", "Email", "Parent Square"];

// Seed the three defaults the first time a school reads the list. Idempotent:
// uses ON CONFLICT DO NOTHING against the (school_id, name) unique index.
async function ensureDefaultTypes(schoolId: number) {
  const existing = await db
    .select({ id: communicationTypesTable.id })
    .from(communicationTypesTable)
    .where(eq(communicationTypesTable.schoolId, schoolId))
    .limit(1);
  if (existing.length > 0) return;
  await db
    .insert(communicationTypesTable)
    .values(
      DEFAULT_TYPES.map((name, i) => ({
        schoolId,
        name,
        active: true,
        sortOrder: i,
      })),
    )
    .onConflictDoNothing();
}

// Who may edit the controlled list: admin tier or Core Team (mirrors the
// other school-wide vocab editors).
function canEditTypes(staff: Staff): boolean {
  return Boolean(staff.isSuperUser || staff.isAdmin) || isCoreTeam(staff);
}

// GET /communication-types  — any signed-in staff. Seeds defaults lazily.
router.get("/communication-types", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId === null) return;
  await ensureDefaultTypes(schoolId);
  const rows = await db
    .select()
    .from(communicationTypesTable)
    .where(eq(communicationTypesTable.schoolId, schoolId))
    .orderBy(communicationTypesTable.sortOrder, communicationTypesTable.name);
  res.json({ types: rows, canEdit: canEditTypes(getStaff(req)) });
});

// POST /communication-types  { name }
router.post("/communication-types", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId === null) return;
  if (!canEditTypes(getStaff(req))) {
    res.status(403).json({ error: "Admin or Core Team only" });
    return;
  }
  const name = String((req.body as { name?: unknown }).name ?? "").trim();
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const dup = await db
    .select({ id: communicationTypesTable.id })
    .from(communicationTypesTable)
    .where(
      and(
        eq(communicationTypesTable.schoolId, schoolId),
        sql`lower(${communicationTypesTable.name}) = lower(${name})`,
      ),
    );
  if (dup.length > 0) {
    res.status(409).json({ error: "That type already exists" });
    return;
  }
  const [maxRow] = await db
    .select({ max: sql<number>`coalesce(max(${communicationTypesTable.sortOrder}), -1)` })
    .from(communicationTypesTable)
    .where(eq(communicationTypesTable.schoolId, schoolId));
  const [row] = await db
    .insert(communicationTypesTable)
    .values({
      schoolId,
      name,
      active: true,
      sortOrder: (maxRow?.max ?? -1) + 1,
    })
    .returning();
  res.status(201).json(row);
});

// PATCH /communication-types/:id  { name?, active? }
router.patch("/communication-types/:id", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId === null) return;
  if (!canEditTypes(getStaff(req))) {
    res.status(403).json({ error: "Admin or Core Team only" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const body = req.body as { name?: unknown; active?: unknown };
  const updates: Partial<typeof communicationTypesTable.$inferInsert> = {};
  if (typeof body.name === "string" && body.name.trim()) {
    updates.name = body.name.trim();
  }
  if (typeof body.active === "boolean") {
    updates.active = body.active;
  }
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "Nothing to update" });
    return;
  }
  const [row] = await db
    .update(communicationTypesTable)
    .set(updates)
    .where(
      and(
        eq(communicationTypesTable.id, id),
        eq(communicationTypesTable.schoolId, schoolId),
      ),
    )
    .returning();
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(row);
});

// ---------------------------------------------------------------------------
// Family contacts
// ---------------------------------------------------------------------------

// Visibility helper shared by every student-facing read here. Returns true if
// the caller may see this student. Mirrors Student Lookup / Student Profile.
async function canSeeStudent(
  staff: Staff,
  schoolId: number,
  studentId: string,
): Promise<boolean> {
  const visibility = await getVisibleStudentIds(staff, schoolId);
  return visibility.full || visibility.ids.has(studentId);
}

export type FamilyContact = {
  // contactSlot 0 = primary guardian (students.parentPhone); 1..4 =
  // student_emergency_contacts.slot.
  contactSlot: number;
  name: string;
  relationship: string | null;
  // The phone to display/dial: corrected override if present, else the raw
  // SIS phone.
  phone: string | null;
  phoneLabel: string | null;
  email: string | null;
  // Bad-number flag state for this slot (null if none open/resolved-with-fix).
  badFlag: {
    id: number;
    status: string;
    reason: string;
    correctedPhone: string | null;
  } | null;
};

// Load the student's family contacts (primary guardian + emergency contacts),
// applying bad-number flags and corrected-number overrides.
async function loadFamilyContacts(
  schoolId: number,
  studentId: string,
): Promise<{
  student: {
    studentId: string;
    localSisId: string | null;
    firstName: string;
    lastName: string;
  };
  contacts: FamilyContact[];
} | null> {
  const [student] = await db
    .select({
      studentId: studentsTable.studentId,
      localSisId: studentsTable.localSisId,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      parentName: studentsTable.parentName,
      parentEmail: studentsTable.parentEmail,
      parentPhone: studentsTable.parentPhone,
    })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.studentId, studentId),
        eq(studentsTable.schoolId, schoolId),
      ),
    );
  if (!student) return null;

  const emergency = await db
    .select()
    .from(studentEmergencyContactsTable)
    .where(
      and(
        eq(studentEmergencyContactsTable.schoolId, schoolId),
        eq(studentEmergencyContactsTable.studentId, studentId),
      ),
    )
    .orderBy(studentEmergencyContactsTable.slot);

  const flags = await db
    .select()
    .from(badNumberFlagsTable)
    .where(
      and(
        eq(badNumberFlagsTable.schoolId, schoolId),
        eq(badNumberFlagsTable.studentId, studentId),
      ),
    )
    .orderBy(desc(badNumberFlagsTable.flaggedAt));
  // Latest flag per slot wins (the override is the most recent correction).
  const flagBySlot = new Map<number, (typeof flags)[number]>();
  for (const f of flags) {
    if (!flagBySlot.has(f.contactSlot)) flagBySlot.set(f.contactSlot, f);
  }

  const toFlag = (slot: number): FamilyContact["badFlag"] => {
    const f = flagBySlot.get(slot);
    if (!f) return null;
    return {
      id: f.id,
      status: f.status,
      reason: f.reason,
      correctedPhone: f.correctedPhone,
    };
  };
  // Corrected override wins over the SIS phone until overwritten.
  const phoneFor = (slot: number, raw: string | null): string | null => {
    const f = flagBySlot.get(slot);
    if (f?.correctedPhone && f.correctedPhone.trim()) return f.correctedPhone;
    return raw;
  };

  const contacts: FamilyContact[] = [];
  // Slot 0 — primary guardian.
  if (
    (student.parentName && student.parentName.trim()) ||
    (student.parentPhone && student.parentPhone.trim()) ||
    (student.parentEmail && student.parentEmail.trim())
  ) {
    contacts.push({
      contactSlot: 0,
      name: student.parentName?.trim() || "Primary guardian",
      relationship: "Primary guardian",
      phone: phoneFor(0, student.parentPhone),
      phoneLabel: null,
      email: student.parentEmail ?? null,
      badFlag: toFlag(0),
    });
  }
  for (const c of emergency) {
    contacts.push({
      contactSlot: c.slot,
      name: c.contactName,
      relationship: c.relationship,
      phone: phoneFor(c.slot, c.phone),
      phoneLabel: c.phoneLabel,
      email: null,
      badFlag: toFlag(c.slot),
    });
  }

  return {
    student: {
      studentId: student.studentId,
      localSisId: student.localSisId,
      firstName: student.firstName,
      lastName: student.lastName,
    },
    contacts,
  };
}

// GET /communications/family/:studentId
router.get(
  "/communications/family/:studentId",
  requireStaff,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const studentId = String(req.params.studentId ?? "").trim();
    if (!studentId) {
      res.status(400).json({ error: "studentId is required" });
      return;
    }
    if (!(await canSeeStudent(getStaff(req), schoolId, studentId))) {
      res.status(403).json({ error: "Not permitted for this student" });
      return;
    }
    const data = await loadFamilyContacts(schoolId, studentId);
    if (!data) {
      res.status(404).json({ error: "Student not found" });
      return;
    }
    res.json(data);
  },
);

// ---------------------------------------------------------------------------
// Communication log
// ---------------------------------------------------------------------------

const OUTCOMES = [
  "Reached",
  "Left message",
  "No answer",
  "Wrong number",
  "Inbound",
];
const TONES = ["positive", "neutral", "concern"];

// POST /communications
// { studentId, type, whoContacted?, outcome, tone, note?, contactedAt? }
router.post("/communications", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId === null) return;
  const staff = getStaff(req);
  const body = req.body as {
    studentId?: unknown;
    type?: unknown;
    whoContacted?: unknown;
    outcome?: unknown;
    tone?: unknown;
    note?: unknown;
    contactedAt?: unknown;
  };
  const studentId = String(body.studentId ?? "").trim();
  const type = String(body.type ?? "").trim();
  const outcome = String(body.outcome ?? "").trim();
  const tone = String(body.tone ?? "neutral").trim();
  if (!studentId) {
    res.status(400).json({ error: "studentId is required" });
    return;
  }
  if (!type) {
    res.status(400).json({ error: "type is required" });
    return;
  }
  if (!OUTCOMES.includes(outcome)) {
    res.status(400).json({ error: "Invalid outcome" });
    return;
  }
  if (!TONES.includes(tone)) {
    res.status(400).json({ error: "Invalid tone" });
    return;
  }
  if (!(await canSeeStudent(staff, schoolId, studentId))) {
    res.status(403).json({ error: "Not permitted for this student" });
    return;
  }
  // Confirm the student is in this school (visibility.full callers skip the
  // per-id check above, so re-assert tenancy here).
  const [student] = await db
    .select({ id: studentsTable.studentId })
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

  // contactedAt: default now, allow backdating. Reject a future timestamp or
  // an unparseable value.
  let contactedAt = new Date();
  if (body.contactedAt != null && String(body.contactedAt).trim()) {
    const parsed = new Date(String(body.contactedAt));
    if (Number.isNaN(parsed.getTime())) {
      res.status(400).json({ error: "Invalid contactedAt" });
      return;
    }
    // Allow a small forward skew for clock drift, but not real future dates.
    if (parsed.getTime() > Date.now() + 5 * 60 * 1000) {
      res.status(400).json({ error: "contactedAt cannot be in the future" });
      return;
    }
    contactedAt = parsed;
  }

  const whoContacted =
    typeof body.whoContacted === "string" && body.whoContacted.trim()
      ? body.whoContacted.trim()
      : null;
  const note =
    typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;

  const [row] = await db
    .insert(communicationLogsTable)
    .values({
      schoolId,
      studentId,
      type,
      whoContacted,
      outcome,
      tone,
      note,
      staffId: staff.id,
      staffName: staff.displayName ?? "Staff",
      contactedAt,
    })
    .returning();
  res.status(201).json(row);
});

// GET /communications/student/:studentId  — per-student timeline.
router.get(
  "/communications/student/:studentId",
  requireStaff,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const studentId = String(req.params.studentId ?? "").trim();
    if (!studentId) {
      res.status(400).json({ error: "studentId is required" });
      return;
    }
    if (!(await canSeeStudent(getStaff(req), schoolId, studentId))) {
      res.status(403).json({ error: "Not permitted for this student" });
      return;
    }
    const rows = await db
      .select()
      .from(communicationLogsTable)
      .where(
        and(
          eq(communicationLogsTable.schoolId, schoolId),
          eq(communicationLogsTable.studentId, studentId),
        ),
      )
      .orderBy(desc(communicationLogsTable.contactedAt))
      .limit(500);
    res.json({ logs: rows });
  },
);

// -----------------------------------------------------------------------------
// Per-student Communication Report (Core Team) — JSON + CSV + PDF.
// Mirrors the Classroom Intervention Report: a shared loader feeds all three
// formats, a ?teacher= filter narrows by staffName, and the PDF renders
// localSisId only (never the FLEID). The client triggers the PDF/CSV as blob
// DOWNLOADS because the session cookie is blocked inside the preview iframe.
// -----------------------------------------------------------------------------

type CommReportRow = {
  type: string;
  whoContacted: string | null;
  outcome: string;
  tone: string;
  note: string | null;
  staffName: string;
  contactedAt: Date;
};

async function loadCommReport(schoolId: number, studentId: string) {
  const [student] = await db
    .select({
      studentId: studentsTable.studentId,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      localSisId: studentsTable.localSisId,
    })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.studentId, studentId),
        eq(studentsTable.schoolId, schoolId),
      ),
    );
  if (!student) return null;

  const logs = await db
    .select({
      type: communicationLogsTable.type,
      whoContacted: communicationLogsTable.whoContacted,
      outcome: communicationLogsTable.outcome,
      tone: communicationLogsTable.tone,
      note: communicationLogsTable.note,
      staffName: communicationLogsTable.staffName,
      contactedAt: communicationLogsTable.contactedAt,
    })
    .from(communicationLogsTable)
    .where(
      and(
        eq(communicationLogsTable.schoolId, schoolId),
        eq(communicationLogsTable.studentId, studentId),
      ),
    )
    .orderBy(desc(communicationLogsTable.contactedAt))
    .limit(500);

  return { student, logs: logs as CommReportRow[] };
}

function summarizeComm(logs: CommReportRow[]) {
  let positive = 0;
  let neutral = 0;
  let concern = 0;
  let reached = 0;
  for (const l of logs) {
    if (l.tone === "positive") positive += 1;
    else if (l.tone === "concern") concern += 1;
    else neutral += 1;
    if (l.outcome === "Reached") reached += 1;
  }
  return { total: logs.length, positive, neutral, concern, reached };
}

function filterCommByTeacher(
  logs: CommReportRow[],
  teacher: string,
): CommReportRow[] {
  const t = teacher.trim();
  if (!t) return logs;
  return logs.filter((l) => l.staffName === t);
}

const fmtDateTime = (d: Date) => {
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dt.getTime())
    ? String(d)
    : dt.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
};

// JSON report
router.get(
  "/communications/student-report/:studentId",
  requireStaff,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    if (!isCoreTeam(getStaff(req))) {
      res.status(403).json({ error: "Core Team access required" });
      return;
    }
    const studentId = String(req.params.studentId ?? "").trim();
    if (!studentId) {
      res.status(400).json({ error: "studentId is required" });
      return;
    }
    const data = await loadCommReport(schoolId, studentId);
    if (!data) {
      res.status(404).json({ error: "Student not found" });
      return;
    }
    const teacherParam = String(req.query.teacher ?? "").trim();
    const logs = filterCommByTeacher(data.logs, teacherParam);
    res.json({
      student: data.student,
      logs,
      summary: summarizeComm(logs),
    });
  },
);

// CSV report
router.get(
  "/communications/student-report/:studentId.csv",
  requireStaff,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    if (!isCoreTeam(getStaff(req))) {
      res.status(403).json({ error: "Core Team access required" });
      return;
    }
    const studentId = String(req.params.studentId ?? "").trim();
    if (!studentId) {
      res.status(400).json({ error: "studentId is required" });
      return;
    }
    const data = await loadCommReport(schoolId, studentId);
    if (!data) {
      res.status(404).json({ error: "Student not found" });
      return;
    }
    const teacherParam = String(req.query.teacher ?? "").trim();
    const logs = filterCommByTeacher(data.logs, teacherParam);

    const header = [
      "Date/Time",
      "Type",
      "Who contacted",
      "Outcome",
      "Tone",
      "Staff",
      "Notes",
    ];
    const lines = [header.map(csvCell).join(",")];
    for (const l of logs) {
      lines.push(
        [
          fmtDateTime(l.contactedAt),
          l.type,
          l.whoContacted ?? "",
          l.outcome,
          l.tone,
          l.staffName,
          l.note ?? "",
        ]
          .map(csvCell)
          .join(","),
      );
    }
    const safeName = `${data.student.lastName}_${data.student.firstName}`.replace(
      /[^A-Za-z0-9_-]/g,
      "",
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="communication-report-${safeName || "student"}.csv"`,
    );
    res.send("\uFEFF" + lines.join("\r\n"));
  },
);

// PDF report (attachable)
router.get(
  "/communications/student-report/:studentId/pdf",
  requireStaff,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    if (!isCoreTeam(getStaff(req))) {
      res.status(403).json({ error: "Core Team access required" });
      return;
    }
    const studentId = String(req.params.studentId ?? "").trim();
    if (!studentId) {
      res.status(400).json({ error: "studentId is required" });
      return;
    }
    const data = await loadCommReport(schoolId, studentId);
    if (!data) {
      res.status(404).json({ error: "Student not found" });
      return;
    }
    const teacherParam = String(req.query.teacher ?? "").trim();
    const includeNotes = String(req.query.notes ?? "").trim() === "1";
    const logs = filterCommByTeacher(data.logs, teacherParam);
    const summary = summarizeComm(logs);

    const safeName = `${data.student.lastName}_${data.student.firstName}`.replace(
      /[^A-Za-z0-9_-]/g,
      "",
    );
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="communication-report-${safeName || "student"}.pdf"`,
    );

    const doc = new PDFDocument({ size: "LETTER", margin: 50 });
    doc.pipe(res);

    doc
      .font("Helvetica-Bold")
      .fontSize(18)
      .fillColor("#0f172a")
      .text("Family Communication Report");
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(11).fillColor("#334155");
    doc.text(
      `${data.student.lastName}, ${data.student.firstName}    ID: ${
        data.student.localSisId ?? "—"
      }`,
    );
    const genDate = new Date().toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    doc.text(`Generated ${genDate}`);
    if (teacherParam) doc.text(`Filtered to staff: ${teacherParam}`);
    doc.moveDown(0.5);

    doc
      .font("Helvetica-Bold")
      .fontSize(13)
      .fillColor("#0f172a")
      .text("Summary");
    doc.moveDown(0.15);
    doc.font("Helvetica").fontSize(10).fillColor("#334155");
    doc.text(
      `Total contacts: ${summary.total}   •   Reached: ${summary.reached}`,
    );
    doc.text(
      `Tone — Positive: ${summary.positive}   Neutral: ${summary.neutral}   Concern: ${summary.concern}`,
    );
    doc.moveDown(0.5);

    doc
      .font("Helvetica-Bold")
      .fontSize(13)
      .fillColor("#0f172a")
      .text("Communications");
    doc.moveDown(0.15);
    doc.font("Helvetica").fontSize(10).fillColor("#334155");
    if (logs.length === 0) {
      doc.text("No communications logged yet.");
    } else {
      const toneLabel = (t: string) =>
        t === "positive" ? "Positive" : t === "concern" ? "Concern" : "Neutral";
      for (const l of logs) {
        doc
          .font("Helvetica-Bold")
          .fontSize(10)
          .fillColor("#0f172a")
          .text(
            `${fmtDateTime(l.contactedAt)}  —  ${l.type} (${l.outcome}, ${toneLabel(
              l.tone,
            )})`,
          );
        doc.font("Helvetica").fontSize(10).fillColor("#334155");
        const who = l.whoContacted ? `To: ${l.whoContacted}   ` : "";
        doc.text(`   ${who}By: ${l.staffName}`);
        if (includeNotes && l.note) {
          doc.fillColor("#64748b").text(`   ${l.note}`);
          doc.fillColor("#334155");
        }
        doc.moveDown(0.3);
      }
    }

    doc.end();
  },
);

// -----------------------------------------------------------------------------
// Bad-number flags + Contact Info Fixes queue (front office).
// Any staffer who can see a student may flag a bad line. Front-office staff
// (capManageContactInfo) work the queue and enter a corrected number — an
// audited override that WINS app-wide until overwritten (pickup pattern).
// -----------------------------------------------------------------------------

const BAD_NUMBER_REASONS = [
  "Disconnected",
  "Not in service",
  "Wrong person",
  "Voicemail full",
  "Other",
];

function canManageContactInfo(staff: Staff): boolean {
  return Boolean(
    staff.isSuperUser || staff.isAdmin || staff.capManageContactInfo,
  );
}

// POST /communications/bad-number-flag
// { studentId, contactSlot, reason, badPhone?, contactLabel? }
router.post("/communications/bad-number-flag", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId === null) return;
  const staff = getStaff(req);
  const body = req.body as {
    studentId?: unknown;
    contactSlot?: unknown;
    reason?: unknown;
    badPhone?: unknown;
    contactLabel?: unknown;
  };
  const studentId = String(body.studentId ?? "").trim();
  const contactSlot = Number(body.contactSlot);
  const reason = String(body.reason ?? "").trim();
  if (!studentId) {
    res.status(400).json({ error: "studentId is required" });
    return;
  }
  if (!Number.isInteger(contactSlot) || contactSlot < 0 || contactSlot > 4) {
    res.status(400).json({ error: "Invalid contactSlot" });
    return;
  }
  if (!BAD_NUMBER_REASONS.includes(reason)) {
    res.status(400).json({ error: "Invalid reason" });
    return;
  }
  if (!(await canSeeStudent(staff, schoolId, studentId))) {
    res.status(403).json({ error: "Not permitted for this student" });
    return;
  }
  const [student] = await db
    .select({ id: studentsTable.studentId })
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
  // One open flag per (student, slot): if one is already open, leave it.
  const [existing] = await db
    .select({ id: badNumberFlagsTable.id })
    .from(badNumberFlagsTable)
    .where(
      and(
        eq(badNumberFlagsTable.schoolId, schoolId),
        eq(badNumberFlagsTable.studentId, studentId),
        eq(badNumberFlagsTable.contactSlot, contactSlot),
        eq(badNumberFlagsTable.status, "open"),
      ),
    );
  if (existing) {
    res.status(200).json({ id: existing.id, alreadyOpen: true });
    return;
  }
  const badPhone =
    typeof body.badPhone === "string" && body.badPhone.trim()
      ? body.badPhone.trim()
      : null;
  const contactLabel =
    typeof body.contactLabel === "string" && body.contactLabel.trim()
      ? body.contactLabel.trim()
      : null;
  const [row] = await db
    .insert(badNumberFlagsTable)
    .values({
      schoolId,
      studentId,
      contactSlot,
      contactLabel,
      badPhone,
      reason,
      status: "open",
      flaggedByStaffId: staff.id,
      flaggedByName: staff.displayName ?? "Staff",
    })
    .returning();
  res.status(201).json(row);
});

// Resolve a (studentId, slot) to its current SIS phone. slot 0 = primary
// guardian (students.parentPhone), 1..4 = emergency contact slot.
async function loadSisPhones(
  schoolId: number,
  keys: Array<{ studentId: string; slot: number }>,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const studentIds = [...new Set(keys.map((k) => k.studentId))];
  if (studentIds.length === 0) return out;
  const students = await db
    .select({
      studentId: studentsTable.studentId,
      parentPhone: studentsTable.parentPhone,
    })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.schoolId, schoolId),
        inArray(studentsTable.studentId, studentIds),
      ),
    );
  const primaryByStudent = new Map<string, string | null>();
  for (const s of students) primaryByStudent.set(s.studentId, s.parentPhone);
  const emergency = await db
    .select({
      studentId: studentEmergencyContactsTable.studentId,
      slot: studentEmergencyContactsTable.slot,
      phone: studentEmergencyContactsTable.phone,
    })
    .from(studentEmergencyContactsTable)
    .where(
      and(
        eq(studentEmergencyContactsTable.schoolId, schoolId),
        inArray(studentEmergencyContactsTable.studentId, studentIds),
      ),
    );
  const emByKey = new Map<string, string | null>();
  for (const e of emergency)
    emByKey.set(`${e.studentId}:${e.slot}`, e.phone);
  for (const k of keys) {
    const key = `${k.studentId}:${k.slot}`;
    out.set(
      key,
      k.slot === 0
        ? primaryByStudent.get(k.studentId) ?? null
        : emByKey.get(key) ?? null,
    );
  }
  return out;
}

// GET /communications/contact-fixes?status=open|all  (front office)
router.get("/communications/contact-fixes", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId === null) return;
  if (!canManageContactInfo(getStaff(req))) {
    res.status(403).json({ error: "Contact-info access required" });
    return;
  }
  const status = String(req.query.status ?? "open").trim();
  const where =
    status === "all"
      ? eq(badNumberFlagsTable.schoolId, schoolId)
      : and(
          eq(badNumberFlagsTable.schoolId, schoolId),
          eq(badNumberFlagsTable.status, "open"),
        );
  const flags = await db
    .select()
    .from(badNumberFlagsTable)
    .where(where)
    .orderBy(desc(badNumberFlagsTable.flaggedAt))
    .limit(500);

  const studentIds = [...new Set(flags.map((f) => f.studentId))];
  const students =
    studentIds.length > 0
      ? await db
          .select({
            studentId: studentsTable.studentId,
            firstName: studentsTable.firstName,
            lastName: studentsTable.lastName,
            localSisId: studentsTable.localSisId,
          })
          .from(studentsTable)
          .where(
            and(
              eq(studentsTable.schoolId, schoolId),
              inArray(studentsTable.studentId, studentIds),
            ),
          )
      : [];
  const studentById = new Map(students.map((s) => [s.studentId, s]));
  const sisPhones = await loadSisPhones(
    schoolId,
    flags.map((f) => ({ studentId: f.studentId, slot: f.contactSlot })),
  );

  const rows = flags.map((f) => {
    const s = studentById.get(f.studentId);
    const sisPhone = sisPhones.get(`${f.studentId}:${f.contactSlot}`) ?? null;
    // SIS disagrees: an active override exists but the SIS now carries a
    // different number — RosterOne re-import may have new info to reconcile.
    const sisDisagrees =
      f.status === "resolved" &&
      !!f.correctedPhone &&
      !!sisPhone &&
      sisPhone.trim() !== f.correctedPhone.trim();
    return {
      id: f.id,
      studentId: f.studentId,
      studentName: s ? `${s.lastName}, ${s.firstName}` : "(unknown)",
      localSisId: s?.localSisId ?? null,
      contactSlot: f.contactSlot,
      contactLabel: f.contactLabel,
      badPhone: f.badPhone,
      sisPhone,
      reason: f.reason,
      status: f.status,
      flaggedByName: f.flaggedByName,
      flaggedAt: f.flaggedAt,
      correctedPhone: f.correctedPhone,
      resolvedByName: f.resolvedByName,
      resolvedAt: f.resolvedAt,
      note: f.note,
      sisDisagrees,
    };
  });
  res.json({ fixes: rows });
});

// GET /communications/contact-fixes/count  (front office) — open count badge.
router.get(
  "/communications/contact-fixes/count",
  requireStaff,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    if (!canManageContactInfo(getStaff(req))) {
      res.json({ count: 0 });
      return;
    }
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(badNumberFlagsTable)
      .where(
        and(
          eq(badNumberFlagsTable.schoolId, schoolId),
          eq(badNumberFlagsTable.status, "open"),
        ),
      );
    res.json({ count: row?.count ?? 0 });
  },
);

// POST /communications/contact-fixes/:id/resolve  (front office)
// { correctedPhone?, note? } — sets the audited override and closes the flag.
router.post(
  "/communications/contact-fixes/:id/resolve",
  requireStaff,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const staff = getStaff(req);
    if (!canManageContactInfo(staff)) {
      res.status(403).json({ error: "Contact-info access required" });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const body = req.body as { correctedPhone?: unknown; note?: unknown };
    const correctedPhone =
      typeof body.correctedPhone === "string" && body.correctedPhone.trim()
        ? body.correctedPhone.trim()
        : null;
    const note =
      typeof body.note === "string" && body.note.trim()
        ? body.note.trim()
        : null;
    const [existing] = await db
      .select({ id: badNumberFlagsTable.id })
      .from(badNumberFlagsTable)
      .where(
        and(
          eq(badNumberFlagsTable.id, id),
          eq(badNumberFlagsTable.schoolId, schoolId),
        ),
      );
    if (!existing) {
      res.status(404).json({ error: "Flag not found" });
      return;
    }
    const [row] = await db
      .update(badNumberFlagsTable)
      .set({
        status: "resolved",
        correctedPhone,
        note,
        resolvedByStaffId: staff.id,
        resolvedByName: staff.displayName ?? "Staff",
        resolvedAt: new Date(),
      })
      .where(
        and(
          eq(badNumberFlagsTable.id, id),
          eq(badNumberFlagsTable.schoolId, schoolId),
        ),
      )
      .returning();
    res.json(row);
  },
);

// -----------------------------------------------------------------------------
// Call Initiatives ("call all families" campaigns).
// Core Team creates one active campaign at a time. Each student is "owned" by
// the teacher of their responsible-period class (default 1st period). A
// per-teacher worklist tracks completion under the campaign's rule. Students
// with no reachable phone line are auto-excluded from the denominator.
// -----------------------------------------------------------------------------

import {
  callInitiativesTable,
  classSectionsTable,
  sectionRosterTable,
} from "@workspace/db";

type Initiative = typeof callInitiativesTable.$inferSelect;

// Window bounds [start, end) as Dates from the campaign's school-local
// YYYY-MM-DD start + windowDays.
function initiativeWindow(init: Initiative): { start: Date; end: Date } {
  const start = new Date(`${init.startDate}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + init.windowDays);
  return { start, end };
}

// A student is reachable if at least one family contact has a usable phone:
// a phone with no open bad-number flag, OR a flag that has a corrected number.
async function loadReachability(
  schoolId: number,
  studentIds: string[],
): Promise<Map<string, boolean>> {
  const reach = new Map<string, boolean>();
  if (studentIds.length === 0) return reach;
  const students = await db
    .select({
      studentId: studentsTable.studentId,
      parentPhone: studentsTable.parentPhone,
    })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.schoolId, schoolId),
        inArray(studentsTable.studentId, studentIds),
      ),
    );
  const emergency = await db
    .select({
      studentId: studentEmergencyContactsTable.studentId,
      slot: studentEmergencyContactsTable.slot,
      phone: studentEmergencyContactsTable.phone,
    })
    .from(studentEmergencyContactsTable)
    .where(
      and(
        eq(studentEmergencyContactsTable.schoolId, schoolId),
        inArray(studentEmergencyContactsTable.studentId, studentIds),
      ),
    );
  const flags = await db
    .select({
      studentId: badNumberFlagsTable.studentId,
      contactSlot: badNumberFlagsTable.contactSlot,
      status: badNumberFlagsTable.status,
      correctedPhone: badNumberFlagsTable.correctedPhone,
    })
    .from(badNumberFlagsTable)
    .where(
      and(
        eq(badNumberFlagsTable.schoolId, schoolId),
        inArray(badNumberFlagsTable.studentId, studentIds),
      ),
    );
  // Open flag with no corrected number => that slot's line is dead.
  const deadSlot = new Set<string>();
  const correctedSlot = new Set<string>();
  for (const f of flags) {
    const key = `${f.studentId}:${f.contactSlot}`;
    if (f.status === "open" && !f.correctedPhone) deadSlot.add(key);
    if (f.correctedPhone) correctedSlot.add(key);
  }
  const phonesByStudent = new Map<string, Array<{ slot: number; phone: string | null }>>();
  for (const s of students) {
    const arr = phonesByStudent.get(s.studentId) ?? [];
    arr.push({ slot: 0, phone: s.parentPhone });
    phonesByStudent.set(s.studentId, arr);
  }
  for (const e of emergency) {
    const arr = phonesByStudent.get(e.studentId) ?? [];
    arr.push({ slot: e.slot, phone: e.phone });
    phonesByStudent.set(e.studentId, arr);
  }
  for (const sid of studentIds) {
    const lines = phonesByStudent.get(sid) ?? [];
    const usable = lines.some((l) => {
      const key = `${sid}:${l.slot}`;
      if (correctedSlot.has(key)) return true;
      return !!l.phone && !deadSlot.has(key);
    });
    reach.set(sid, usable);
  }
  return reach;
}

type WorklistStudent = {
  studentId: string;
  name: string;
  localSisId: string | null;
  attempts: number;
  reached: boolean;
  done: boolean;
  reachable: boolean;
  lastOutcome: string | null;
  lastContactedAt: string | null;
};

// Compute one teacher's worklist for a campaign: the students in their
// responsible-period sections + per-student completion status.
async function computeTeacherWorklist(
  schoolId: number,
  teacherStaffId: number,
  init: Initiative,
): Promise<WorklistStudent[]> {
  const sections = await db
    .select({ id: classSectionsTable.id })
    .from(classSectionsTable)
    .where(
      and(
        eq(classSectionsTable.schoolId, schoolId),
        eq(classSectionsTable.teacherStaffId, teacherStaffId),
        eq(classSectionsTable.period, init.responsiblePeriod),
        eq(classSectionsTable.isPlanning, false),
      ),
    );
  const sectionIds = sections.map((s) => s.id);
  if (sectionIds.length === 0) return [];
  const roster = await db
    .select({ studentId: sectionRosterTable.studentId })
    .from(sectionRosterTable)
    .where(
      and(
        eq(sectionRosterTable.schoolId, schoolId),
        inArray(sectionRosterTable.sectionId, sectionIds),
      ),
    );
  const studentIds = [...new Set(roster.map((r) => r.studentId))];
  if (studentIds.length === 0) return [];

  const students = await db
    .select({
      studentId: studentsTable.studentId,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      localSisId: studentsTable.localSisId,
    })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.schoolId, schoolId),
        inArray(studentsTable.studentId, studentIds),
      ),
    );
  const studentById = new Map(students.map((s) => [s.studentId, s]));

  const { start, end } = initiativeWindow(init);
  const logs = await db
    .select({
      studentId: communicationLogsTable.studentId,
      outcome: communicationLogsTable.outcome,
      contactedAt: communicationLogsTable.contactedAt,
    })
    .from(communicationLogsTable)
    .where(
      and(
        eq(communicationLogsTable.schoolId, schoolId),
        inArray(communicationLogsTable.studentId, studentIds),
        sql`${communicationLogsTable.contactedAt} >= ${start}`,
        sql`${communicationLogsTable.contactedAt} < ${end}`,
      ),
    )
    .orderBy(desc(communicationLogsTable.contactedAt));

  const byStudent = new Map<
    string,
    { attempts: number; reached: boolean; lastOutcome: string | null; lastAt: Date | null }
  >();
  for (const l of logs) {
    const cur =
      byStudent.get(l.studentId) ?? {
        attempts: 0,
        reached: false,
        lastOutcome: null as string | null,
        lastAt: null as Date | null,
      };
    cur.attempts += 1;
    if (l.outcome === "Reached") cur.reached = true;
    if (!cur.lastAt) {
      cur.lastOutcome = l.outcome;
      cur.lastAt = l.contactedAt;
    }
    byStudent.set(l.studentId, cur);
  }

  const reach = await loadReachability(schoolId, studentIds);

  return studentIds
    .map((sid) => {
      const s = studentById.get(sid);
      const agg = byStudent.get(sid);
      const attempts = agg?.attempts ?? 0;
      const reached = agg?.reached ?? false;
      const reachable = reach.get(sid) ?? false;
      let done = false;
      if (init.completionRule === "strict") done = reached;
      else if (init.completionRule === "any") done = attempts >= 1;
      else done = reached || attempts >= init.attemptsRequired; // balanced
      return {
        studentId: sid,
        name: s ? `${s.lastName}, ${s.firstName}` : "(unknown)",
        localSisId: s?.localSisId ?? null,
        attempts,
        reached,
        done,
        reachable,
        lastOutcome: agg?.lastOutcome ?? null,
        lastContactedAt: agg?.lastAt ? agg.lastAt.toISOString() : null,
      };
    })
    .sort((a, b) => {
      // Not-done + reachable first (the actual work), then done, then excluded.
      const rank = (s: WorklistStudent) =>
        !s.reachable ? 2 : s.done ? 1 : 0;
      const d = rank(a) - rank(b);
      return d !== 0 ? d : a.name.localeCompare(b.name);
    });
}

async function loadActiveInitiative(
  schoolId: number,
): Promise<Initiative | null> {
  const [row] = await db
    .select()
    .from(callInitiativesTable)
    .where(
      and(
        eq(callInitiativesTable.schoolId, schoolId),
        eq(callInitiativesTable.active, true),
      ),
    )
    .orderBy(desc(callInitiativesTable.createdAt))
    .limit(1);
  return row ?? null;
}

// POST /communications/call-initiatives  (Core Team) — create + archive prior.
router.post("/communications/call-initiatives", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId === null) return;
  const staff = getStaff(req);
  if (!isCoreTeam(staff)) {
    res.status(403).json({ error: "Core Team only" });
    return;
  }
  const body = req.body as {
    name?: unknown;
    startDate?: unknown;
    windowDays?: unknown;
    responsiblePeriod?: unknown;
    completionRule?: unknown;
    attemptsRequired?: unknown;
  };
  const name = String(body.name ?? "").trim();
  const startDate = String(body.startDate ?? "").trim();
  if (!name) {
    res.status(400).json({ error: "Name is required" });
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    res.status(400).json({ error: "startDate must be YYYY-MM-DD" });
    return;
  }
  const windowDays = Number.isInteger(Number(body.windowDays))
    ? Math.max(1, Math.min(120, Number(body.windowDays)))
    : 14;
  const responsiblePeriod = Number.isInteger(Number(body.responsiblePeriod))
    ? Math.max(1, Math.min(12, Number(body.responsiblePeriod)))
    : 1;
  const completionRule = ["strict", "balanced", "any"].includes(
    String(body.completionRule),
  )
    ? String(body.completionRule)
    : "balanced";
  const attemptsRequired = Number.isInteger(Number(body.attemptsRequired))
    ? Math.max(1, Math.min(10, Number(body.attemptsRequired)))
    : 2;

  // Archive any currently-active campaign (one active at a time).
  await db
    .update(callInitiativesTable)
    .set({ active: false })
    .where(
      and(
        eq(callInitiativesTable.schoolId, schoolId),
        eq(callInitiativesTable.active, true),
      ),
    );
  const [row] = await db
    .insert(callInitiativesTable)
    .values({
      schoolId,
      name,
      startDate,
      windowDays,
      responsiblePeriod,
      completionRule,
      attemptsRequired,
      active: true,
      createdByStaffId: staff.id,
      createdByName: staff.displayName ?? "Staff",
    })
    .returning();
  res.status(201).json(row);
});

// POST /communications/call-initiatives/:id/end  (Core Team) — archive.
router.post(
  "/communications/call-initiatives/:id/end",
  requireStaff,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    if (!isCoreTeam(getStaff(req))) {
      res.status(403).json({ error: "Core Team only" });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    await db
      .update(callInitiativesTable)
      .set({ active: false })
      .where(
        and(
          eq(callInitiativesTable.id, id),
          eq(callInitiativesTable.schoolId, schoolId),
        ),
      );
    res.json({ ok: true });
  },
);

// GET /communications/call-initiatives/active — active campaign + the signed-in
// staffer's own progress (drives the app-wide banner). Returns {initiative:null}
// when nothing is running.
router.get(
  "/communications/call-initiatives/active",
  requireStaff,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const init = await loadActiveInitiative(schoolId);
    if (!init) {
      res.json({ initiative: null });
      return;
    }
    const { end } = initiativeWindow(init);
    const daysRemaining = Math.max(
      0,
      Math.ceil((end.getTime() - Date.now()) / 86400000),
    );
    const worklist = await computeTeacherWorklist(
      schoolId,
      getStaff(req).id,
      init,
    );
    const reachable = worklist.filter((w) => w.reachable);
    const done = reachable.filter((w) => w.done).length;
    res.json({
      initiative: {
        id: init.id,
        name: init.name,
        startDate: init.startDate,
        windowDays: init.windowDays,
        responsiblePeriod: init.responsiblePeriod,
        completionRule: init.completionRule,
        attemptsRequired: init.attemptsRequired,
        daysRemaining,
      },
      myProgress: {
        total: reachable.length,
        done,
        remaining: reachable.length - done,
        excluded: worklist.length - reachable.length,
      },
    });
  },
);

// GET /communications/call-initiatives/worklist — the signed-in staffer's
// per-student worklist for the active campaign.
router.get(
  "/communications/call-initiatives/worklist",
  requireStaff,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const init = await loadActiveInitiative(schoolId);
    if (!init) {
      res.json({ initiative: null, students: [] });
      return;
    }
    const students = await computeTeacherWorklist(
      schoolId,
      getStaff(req).id,
      init,
    );
    res.json({
      initiative: {
        id: init.id,
        name: init.name,
        responsiblePeriod: init.responsiblePeriod,
        completionRule: init.completionRule,
        attemptsRequired: init.attemptsRequired,
      },
      students,
    });
  },
);

// -----------------------------------------------------------------------------
// Insights — Contact Rate.
// Across the school: % of reachable students contacted in the last N days,
// % YTD (since Aug 1), and the positive-vs-concern tone split. Plus a
// not-contacted worklist with the responsible-period teacher so admins can
// escalate. Auto-excludes fully-unreachable students from the denominator
// (no usable phone), mirroring the Call Initiative.
// -----------------------------------------------------------------------------

// School-year start anchor: Aug 1 of the current school year (matches the
// tardy/lost-instruction YTD window invariant). Before Aug 1, roll back a year.
function schoolYearStart(now = new Date()): Date {
  const y = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  return new Date(y, 7, 1, 0, 0, 0); // Aug = month 7
}

type ContactRateRow = {
  studentId: string;
  name: string;
  localSisId: string | null;
  grade: number | null;
  teacherStaffId: number | null;
  teacherName: string | null;
  reachable: boolean;
  contactedWindow: boolean;
  contactedYtd: boolean;
  positive: number;
  concern: number;
  lastContactedAt: string | null;
};

type ContactRateReport = {
  windowDays: number;
  responsiblePeriod: number;
  generatedAt: string;
  rows: ContactRateRow[];
  summary: {
    reachableTotal: number;
    contactedWindow: number;
    contactedYtd: number;
    windowRate: number; // 0..1 over reachable
    ytdRate: number;
    positive: number;
    concern: number;
    excluded: number; // unreachable
  };
};

async function loadContactRateReport(
  schoolId: number,
  windowDays: number,
  responsiblePeriod: number,
): Promise<ContactRateReport> {
  const now = new Date();
  const windowStart = new Date(now);
  windowStart.setDate(windowStart.getDate() - windowDays);
  const ytdStart = schoolYearStart(now);

  const students = await db
    .select({
      studentId: studentsTable.studentId,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      localSisId: studentsTable.localSisId,
      grade: studentsTable.grade,
    })
    .from(studentsTable)
    .where(eq(studentsTable.schoolId, schoolId));
  const studentIds = students.map((s) => s.studentId);

  // Responsible-period teacher per student (the period that owns the call).
  const teacherByStudent = new Map<
    string,
    { id: number; name: string }
  >();
  if (studentIds.length > 0) {
    const rows = await db
      .select({
        studentId: sectionRosterTable.studentId,
        teacherStaffId: staffTable.id,
        teacherName: staffTable.displayName,
      })
      .from(sectionRosterTable)
      .innerJoin(
        classSectionsTable,
        eq(sectionRosterTable.sectionId, classSectionsTable.id),
      )
      .innerJoin(
        staffTable,
        eq(classSectionsTable.teacherStaffId, staffTable.id),
      )
      .where(
        and(
          eq(sectionRosterTable.schoolId, schoolId),
          eq(classSectionsTable.schoolId, schoolId),
          eq(staffTable.schoolId, schoolId),
          eq(classSectionsTable.period, responsiblePeriod),
          eq(classSectionsTable.isPlanning, false),
        ),
      );
    for (const r of rows) {
      if (!teacherByStudent.has(r.studentId)) {
        teacherByStudent.set(r.studentId, {
          id: r.teacherStaffId,
          name: r.teacherName,
        });
      }
    }
  }

  // All comm logs since the YTD anchor; tag tone + which windows they fall in.
  const logs =
    studentIds.length === 0
      ? []
      : await db
          .select({
            studentId: communicationLogsTable.studentId,
            tone: communicationLogsTable.tone,
            contactedAt: communicationLogsTable.contactedAt,
          })
          .from(communicationLogsTable)
          .where(
            and(
              eq(communicationLogsTable.schoolId, schoolId),
              sql`${communicationLogsTable.contactedAt} >= ${ytdStart}`,
            ),
          );

  type Agg = {
    window: boolean;
    ytd: boolean;
    positive: number;
    concern: number;
    lastAt: Date | null;
  };
  const byStudent = new Map<string, Agg>();
  for (const l of logs) {
    const cur =
      byStudent.get(l.studentId) ??
      ({ window: false, ytd: true, positive: 0, concern: 0, lastAt: null } as Agg);
    cur.ytd = true;
    if (l.contactedAt >= windowStart) cur.window = true;
    if (l.tone === "positive") cur.positive += 1;
    if (l.tone === "concern") cur.concern += 1;
    if (!cur.lastAt || l.contactedAt > cur.lastAt) cur.lastAt = l.contactedAt;
    byStudent.set(l.studentId, cur);
  }

  const reach = await loadReachability(schoolId, studentIds);

  const rows: ContactRateRow[] = students.map((s) => {
    const agg = byStudent.get(s.studentId);
    const teacher = teacherByStudent.get(s.studentId);
    return {
      studentId: s.studentId,
      name: `${s.lastName}, ${s.firstName}`,
      localSisId: s.localSisId,
      grade: s.grade ?? null,
      teacherStaffId: teacher?.id ?? null,
      teacherName: teacher?.name ?? null,
      reachable: reach.get(s.studentId) ?? false,
      contactedWindow: agg?.window ?? false,
      contactedYtd: agg?.ytd ?? false,
      positive: agg?.positive ?? 0,
      concern: agg?.concern ?? 0,
      lastContactedAt: agg?.lastAt ? agg.lastAt.toISOString() : null,
    };
  });

  const reachableRows = rows.filter((r) => r.reachable);
  const contactedWindow = reachableRows.filter((r) => r.contactedWindow).length;
  const contactedYtd = reachableRows.filter((r) => r.contactedYtd).length;
  const positive = rows.reduce((a, r) => a + r.positive, 0);
  const concern = rows.reduce((a, r) => a + r.concern, 0);
  const reachableTotal = reachableRows.length;

  rows.sort((a, b) => {
    // Not-contacted reachable first (the work), then contacted, then excluded.
    const rank = (r: ContactRateRow) =>
      !r.reachable ? 2 : r.contactedWindow ? 1 : 0;
    const d = rank(a) - rank(b);
    return d !== 0 ? d : a.name.localeCompare(b.name);
  });

  return {
    windowDays,
    responsiblePeriod,
    generatedAt: now.toISOString(),
    rows,
    summary: {
      reachableTotal,
      contactedWindow,
      contactedYtd,
      windowRate: reachableTotal > 0 ? contactedWindow / reachableTotal : 0,
      ytdRate: reachableTotal > 0 ? contactedYtd / reachableTotal : 0,
      positive,
      concern,
      excluded: rows.length - reachableTotal,
    },
  };
}

function parseContactRateParams(req: Request): {
  windowDays: number;
  responsiblePeriod: number;
} {
  const windowDays = Math.min(
    365,
    Math.max(1, Number(req.query.days) || 30),
  );
  const responsiblePeriod = Math.min(
    12,
    Math.max(1, Number(req.query.period) || 1),
  );
  return { windowDays, responsiblePeriod };
}

// JSON
router.get("/communications/contact-rate", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId === null) return;
  if (!isCoreTeam(getStaff(req))) {
    res.status(403).json({ error: "Core Team access required" });
    return;
  }
  const { windowDays, responsiblePeriod } = parseContactRateParams(req);
  const report = await loadContactRateReport(
    schoolId,
    windowDays,
    responsiblePeriod,
  );
  res.json(report);
});

// CSV
router.get(
  "/communications/contact-rate.csv",
  requireStaff,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    if (!isCoreTeam(getStaff(req))) {
      res.status(403).json({ error: "Core Team access required" });
      return;
    }
    const { windowDays, responsiblePeriod } = parseContactRateParams(req);
    const report = await loadContactRateReport(
      schoolId,
      windowDays,
      responsiblePeriod,
    );
    const header = [
      "Student",
      "ID",
      "Grade",
      `Responsible teacher (P${responsiblePeriod})`,
      "Reachable",
      `Contacted (last ${windowDays}d)`,
      "Contacted YTD",
      "Positive",
      "Concern",
      "Last contact",
    ];
    const lines = [header.map(csvCell).join(",")];
    for (const r of report.rows) {
      lines.push(
        [
          r.name,
          r.localSisId ?? "—",
          r.grade ?? "",
          r.teacherName ?? "",
          r.reachable ? "Yes" : "No (excluded)",
          r.contactedWindow ? "Yes" : "No",
          r.contactedYtd ? "Yes" : "No",
          r.positive,
          r.concern,
          r.lastContactedAt ? fmtDateTime(new Date(r.lastContactedAt)) : "",
        ]
          .map(csvCell)
          .join(","),
      );
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="contact-rate-${windowDays}d.csv"`,
    );
    res.send("\uFEFF" + lines.join("\r\n"));
  },
);

// PDF (param header)
router.get(
  "/communications/contact-rate/pdf",
  requireStaff,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    if (!isCoreTeam(getStaff(req))) {
      res.status(403).json({ error: "Core Team access required" });
      return;
    }
    const { windowDays, responsiblePeriod } = parseContactRateParams(req);
    const report = await loadContactRateReport(
      schoolId,
      windowDays,
      responsiblePeriod,
    );
    const [school] = await db
      .select({ name: schoolsTable.name })
      .from(schoolsTable)
      .where(eq(schoolsTable.id, schoolId));

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="contact-rate-${windowDays}d.pdf"`,
    );
    const doc = new PDFDocument({ size: "LETTER", margin: 50 });
    doc.pipe(res);

    doc
      .font("Helvetica-Bold")
      .fontSize(18)
      .fillColor("#0f172a")
      .text("Family Contact Rate");
    doc.moveDown(0.2);
    doc.font("Helvetica").fontSize(11).fillColor("#334155");
    if (school?.name) doc.text(school.name);
    doc.text(
      `Window: last ${windowDays} days   •   Responsible period: ${responsiblePeriod}`,
    );
    doc.text(
      `Generated ${new Date().toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })}`,
    );
    doc.moveDown(0.5);

    const s = report.summary;
    const pct = (n: number) => `${Math.round(n * 100)}%`;
    doc
      .font("Helvetica-Bold")
      .fontSize(13)
      .fillColor("#0f172a")
      .text("Summary");
    doc.moveDown(0.15);
    doc.font("Helvetica").fontSize(10).fillColor("#334155");
    doc.text(
      `Reachable students: ${s.reachableTotal}   (excluded as unreachable: ${s.excluded})`,
    );
    doc.text(
      `Contacted in last ${windowDays}d: ${s.contactedWindow} (${pct(
        s.windowRate,
      )})   •   Contacted YTD: ${s.contactedYtd} (${pct(s.ytdRate)})`,
    );
    doc.text(`Tone — Positive: ${s.positive}   Concern: ${s.concern}`);
    doc.moveDown(0.5);

    const notContacted = report.rows.filter(
      (r) => r.reachable && !r.contactedWindow,
    );
    doc
      .font("Helvetica-Bold")
      .fontSize(13)
      .fillColor("#0f172a")
      .text(`Not contacted in last ${windowDays} days (${notContacted.length})`);
    doc.moveDown(0.15);
    doc.font("Helvetica").fontSize(10).fillColor("#334155");
    if (notContacted.length === 0) {
      doc.text("Everyone reachable has been contacted in the window.");
    } else {
      for (const r of notContacted) {
        doc.text(
          `${r.name}   (${r.localSisId ?? "—"})   —   ${
            r.teacherName ?? "No responsible teacher"
          }`,
        );
      }
    }
    doc.end();
  },
);

// Escalation email — notify each responsible teacher who still has
// not-contacted reachable students. One email per teacher, listing their
// outstanding students. Resend via the school's connector.
router.post(
  "/communications/contact-rate/escalate",
  requireStaff,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    if (!isCoreTeam(getStaff(req))) {
      res.status(403).json({ error: "Core Team access required" });
      return;
    }
    const { windowDays, responsiblePeriod } = parseContactRateParams(req);
    const report = await loadContactRateReport(
      schoolId,
      windowDays,
      responsiblePeriod,
    );
    const outstanding = report.rows.filter(
      (r) => r.reachable && !r.contactedWindow && r.teacherStaffId !== null,
    );
    // Group outstanding students by responsible teacher staff id (stable key
    // — display names are not unique within a school, so grouping by name can
    // merge two teachers' rosters and misroute student data).
    const byTeacher = new Map<number, ContactRateRow[]>();
    for (const r of outstanding) {
      const arr = byTeacher.get(r.teacherStaffId!) ?? [];
      arr.push(r);
      byTeacher.set(r.teacherStaffId!, arr);
    }
    if (byTeacher.size === 0) {
      res.json({ sent: 0, failed: 0, message: "No outstanding teachers." });
      return;
    }

    // Resolve teacher emails by staff id (school-scoped, active).
    const staffRows = await db
      .select({
        id: staffTable.id,
        email: staffTable.email,
      })
      .from(staffTable)
      .where(
        and(eq(staffTable.schoolId, schoolId), eq(staffTable.active, true)),
      );
    const emailById = new Map(staffRows.map((s) => [s.id, s.email]));
    const [school] = await db
      .select({ name: schoolsTable.name })
      .from(schoolsTable)
      .where(eq(schoolsTable.id, schoolId));

    let client: Awaited<ReturnType<typeof getUncachableResendClient>>;
    try {
      client = await getUncachableResendClient();
    } catch (err) {
      logger.error({ err }, "Contact-rate escalation: Resend unavailable");
      res.status(503).json({ error: "Email service unavailable" });
      return;
    }

    let sent = 0;
    let failed = 0;
    let skipped = 0;
    for (const [teacherStaffId, rows] of byTeacher) {
      const to = emailById.get(teacherStaffId);
      if (!to) {
        skipped += 1;
        continue;
      }
      const list = rows
        .map(
          (r) =>
            `<li>${escapeHtml(r.name)} (${escapeHtml(
              r.localSisId ?? "—",
            )})</li>`,
        )
        .join("");
      const html = `
        <div style="font-family:Arial,sans-serif;color:#0f172a">
          <h2 style="margin:0 0 8px">Family calls still needed</h2>
          <p>${escapeHtml(
            school?.name ?? "Your school",
          )} is running a family-contact push. The following families in your
          period ${responsiblePeriod} roster have <strong>not been contacted in
          the last ${windowDays} days</strong>:</p>
          <ul>${list}</ul>
          <p>Please log each call in PulseEDU (Classroom Interventions →
          Communication Log) once complete. Thank you!</p>
        </div>`;
      try {
        await client.client.emails.send({
          from: `PulseEDU <${client.fromEmail}>`,
          to,
          subject: `${rows.length} family ${
            rows.length === 1 ? "call" : "calls"
          } still needed`,
          html,
        });
        sent += 1;
      } catch (err) {
        logger.error({ err, to }, "Contact-rate escalation email failed");
        failed += 1;
      }
    }

    res.json({ sent, failed, skipped, teachers: byTeacher.size });
  },
);

export default router;
