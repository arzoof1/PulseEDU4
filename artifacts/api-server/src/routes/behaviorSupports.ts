// Behavior Supports — teacher-facing behavior snapshot records (MTSS).
//
// This module is a "teacher translation layer": the MTSS team writes a
// sanitized snapshot (behaviors observed, triggers, recommended responses,
// replacement behaviors, reinforcement) that teachers see on the Teacher
// Roster as a purple Behavior pill + hover card. It is NOT a BIP/FBA and
// deliberately has no fields for confidential material.
//
// Routes (all under /api):
//   GET  /behavior-supports                       (view gate; current records + student info)
//   GET  /behavior-supports/student/:studentId    (view gate; current + history)
//   PUT  /behavior-supports/student/:studentId    (edit gate; archive current + insert new)
//   POST /behavior-supports/student/:studentId/archive (edit gate; retire the pill)
//
// Edit gate  = Core Team (isCoreTeam: SuperUser/District Admin/Admin —
//              which covers AP + Principal — Behavior Specialist, MTSS
//              Coordinator, School Psychologist, assignable Core Team,
//              Confidential Secretary).
// View gate  = edit gate + Guidance Counselors (view-only per spec).
// Teachers never hit these routes — their read-only snapshot rides on
// GET /teacher-roster rows.
import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import {
  db,
  behaviorSupportsTable,
  staffTable,
  studentsTable,
} from "@workspace/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import { isCoreTeam } from "../lib/coreTeam.js";

const router: IRouter = Router();

// Total bullets across all five lists — enforced at ENTRY time so
// coordinators know exactly what teachers will see (no display-time
// truncation surprises).
const MAX_TOTAL_BULLETS = 15;
const MAX_BULLET_LEN = 200;

async function loadStaff(req: Request) {
  const id = req.staffId;
  if (!id) return null;
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  if (!s || !s.active) return null;
  // Tenant guard: non-SuperUser actors must belong to the active school.
  if (!s.isSuperUser && s.schoolId !== req.schoolId) return null;
  return s;
}

function canEdit(s: {
  isSuperUser?: boolean | null;
  isDistrictAdmin?: boolean | null;
  isAdmin?: boolean | null;
  isBehaviorSpecialist?: boolean | null;
  isMtssCoordinator?: boolean | null;
  isSchoolPsychologist?: boolean | null;
  isCoreTeam?: boolean | null;
  isConfidentialSecretary?: boolean | null;
}): boolean {
  return isCoreTeam(s);
}

function canView(s: Parameters<typeof canEdit>[0] & {
  isGuidanceCounselor?: boolean | null;
  isCounselor?: boolean | null;
}): boolean {
  return canEdit(s) || Boolean(s.isGuidanceCounselor || s.isCounselor);
}

// Sanitize one bullet list: strings only, trimmed, non-empty. Overlength
// bullets are a validation ERROR (not a silent truncation) so direct API
// callers can't sneak past the entry-time cap the UI enforces.
function sanitizeList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const v = raw.trim();
    if (v.length > MAX_BULLET_LEN) {
      throw new BulletTooLongError(v);
    }
    if (v) out.push(v);
  }
  return out;
}

class BulletTooLongError extends Error {
  constructor(bullet: string) {
    super(
      `Each bullet must be ${MAX_BULLET_LEN} characters or fewer (got ${bullet.length}).`,
    );
  }
}

// Date fields are optional YYYY-MM-DD strings (kept as text like other
// school-facing date fields; no timezone math needed).
function sanitizeDate(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const v = input.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

type SnapshotRow = typeof behaviorSupportsTable.$inferSelect;

function toJson(r: SnapshotRow) {
  return {
    id: r.id,
    studentId: r.studentId,
    isActive: r.isActive,
    effectiveDate: r.effectiveDate,
    reviewDate: r.reviewDate,
    behaviors: r.behaviors,
    triggers: r.triggers,
    responses: r.responses,
    replacementBehaviors: r.replacementBehaviors,
    reinforcement: r.reinforcement,
    updatedByName: r.updatedByName,
    archivedAt: r.archivedAt ? r.archivedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// GET /behavior-supports — all current records for the school + student info.
router.get(
  "/behavior-supports",
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (schoolId == null) return;
    const staff = await loadStaff(req);
    if (!staff || !canView(staff)) {
      res.status(403).json({ error: "Not authorized" });
      return;
    }
    const rows = await db
      .select()
      .from(behaviorSupportsTable)
      .where(
        and(
          eq(behaviorSupportsTable.schoolId, schoolId),
          isNull(behaviorSupportsTable.archivedAt),
        ),
      )
      .orderBy(desc(behaviorSupportsTable.updatedAt));
    const students = await db
      .select({
        studentId: studentsTable.studentId,
        firstName: studentsTable.firstName,
        lastName: studentsTable.lastName,
        grade: studentsTable.grade,
        localSisId: studentsTable.localSisId,
      })
      .from(studentsTable)
      .where(eq(studentsTable.schoolId, schoolId));
    const byId = new Map(students.map((s) => [s.studentId, s]));
    res.json({
      canEdit: canEdit(staff),
      records: rows.map((r) => {
        const stu = byId.get(r.studentId);
        return {
          ...toJson(r),
          firstName: stu?.firstName ?? "",
          lastName: stu?.lastName ?? "",
          grade: stu?.grade ?? null,
          localSisId: stu?.localSisId ?? null,
        };
      }),
    });
  },
);

// ---------------------------------------------------------------------------
// GET /behavior-supports/student/:studentId — current + history.
router.get(
  "/behavior-supports/student/:studentId",
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (schoolId == null) return;
    const staff = await loadStaff(req);
    if (!staff || !canView(staff)) {
      res.status(403).json({ error: "Not authorized" });
      return;
    }
    const studentId = String(req.params.studentId);
    const rows = await db
      .select()
      .from(behaviorSupportsTable)
      .where(
        and(
          eq(behaviorSupportsTable.schoolId, schoolId),
          eq(behaviorSupportsTable.studentId, studentId),
        ),
      )
      .orderBy(desc(behaviorSupportsTable.createdAt));
    const current = rows.find((r) => r.archivedAt === null) ?? null;
    const history = rows.filter((r) => r.archivedAt !== null);
    res.json({
      canEdit: canEdit(staff),
      current: current ? toJson(current) : null,
      history: history.map(toJson),
    });
  },
);

// ---------------------------------------------------------------------------
// PUT /behavior-supports/student/:studentId — save a new snapshot version.
// Archives the current row (if any) and inserts a fresh one, in a tx.
router.put(
  "/behavior-supports/student/:studentId",
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (schoolId == null) return;
    const staff = await loadStaff(req);
    if (!staff || !canEdit(staff)) {
      res.status(403).json({ error: "Not authorized" });
      return;
    }
    const studentId = String(req.params.studentId);

    // Student must exist in this school (tenancy + typo guard).
    const [stu] = await db
      .select({ studentId: studentsTable.studentId })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.schoolId, schoolId),
          eq(studentsTable.studentId, studentId),
        ),
      );
    if (!stu) {
      res.status(404).json({ error: "Student not found" });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    let behaviors: string[];
    let triggers: string[];
    let responses: string[];
    let replacementBehaviors: string[];
    let reinforcement: string[];
    try {
      behaviors = sanitizeList(body.behaviors);
      triggers = sanitizeList(body.triggers);
      responses = sanitizeList(body.responses);
      replacementBehaviors = sanitizeList(body.replacementBehaviors);
      reinforcement = sanitizeList(body.reinforcement);
    } catch (e) {
      if (e instanceof BulletTooLongError) {
        res.status(400).json({ error: e.message });
        return;
      }
      throw e;
    }
    const total =
      behaviors.length +
      triggers.length +
      responses.length +
      replacementBehaviors.length +
      reinforcement.length;
    if (total > MAX_TOTAL_BULLETS) {
      res.status(400).json({
        error: `Keep the snapshot teacher-scannable: ${MAX_TOTAL_BULLETS} bullets max across all lists (you have ${total}).`,
      });
      return;
    }
    const isActive = body.isActive !== false; // default true
    if (isActive && total === 0) {
      res.status(400).json({
        error:
          "An active snapshot needs at least one bullet — otherwise teachers see an empty card.",
      });
      return;
    }

    // Archive-then-insert in one tx. Under a concurrent save, the loser's
    // INSERT trips the partial unique index (one current row per student);
    // map that to a controlled 409 instead of a raw 500.
    let inserted: SnapshotRow;
    try {
      inserted = await db.transaction(async (tx) => {
      await tx
        .update(behaviorSupportsTable)
        .set({ archivedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(behaviorSupportsTable.schoolId, schoolId),
            eq(behaviorSupportsTable.studentId, studentId),
            isNull(behaviorSupportsTable.archivedAt),
          ),
        );
      const [row] = await tx
        .insert(behaviorSupportsTable)
        .values({
          schoolId,
          studentId,
          isActive,
          effectiveDate: sanitizeDate(body.effectiveDate),
          reviewDate: sanitizeDate(body.reviewDate),
          behaviors,
          triggers,
          responses,
          replacementBehaviors,
          reinforcement,
          updatedByStaffId: staff.id,
          updatedByName: staff.displayName,
        })
        .returning();
        return row;
      });
    } catch (e) {
      const code = (e as { cause?: { code?: string }; code?: string })?.code ??
        (e as { cause?: { code?: string } })?.cause?.code;
      if (code === "23505") {
        res.status(409).json({
          error:
            "Someone else saved this student's snapshot at the same time. Reopen it and try again.",
        });
        return;
      }
      throw e;
    }
    res.json(toJson(inserted));
  },
);

// ---------------------------------------------------------------------------
// POST /behavior-supports/student/:studentId/archive — retire the current
// snapshot entirely (pill disappears; history preserved). Idempotent.
router.post(
  "/behavior-supports/student/:studentId/archive",
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (schoolId == null) return;
    const staff = await loadStaff(req);
    if (!staff || !canEdit(staff)) {
      res.status(403).json({ error: "Not authorized" });
      return;
    }
    const studentId = String(req.params.studentId);
    await db
      .update(behaviorSupportsTable)
      .set({
        archivedAt: new Date(),
        updatedAt: new Date(),
        updatedByStaffId: staff.id,
        updatedByName: staff.displayName,
      })
      .where(
        and(
          eq(behaviorSupportsTable.schoolId, schoolId),
          eq(behaviorSupportsTable.studentId, studentId),
          isNull(behaviorSupportsTable.archivedAt),
        ),
      );
    res.json({ ok: true });
  },
);

export default router;
