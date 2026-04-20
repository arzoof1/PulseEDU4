// Polarity Pairs: two students who must NOT both be out on a hall pass at
// the same time. Managed from the Interventions page. CRUD is gated to the
// same roles as the rest of the intervention/behavior lists. The exported
// `findPolarityConflict` helper is also called by the hall-pass and kiosk
// pass-creation endpoints to enforce the rule at the moment of issuance.

import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  db,
  polarityPairsTable,
  studentsTable,
  staffTable,
  hallPassesTable,
} from "@workspace/db";
import { and, eq, or, ne } from "drizzle-orm";

const router: IRouter = Router();

async function loadStaff(req: Request, res: Response) {
  const staffId = req.session.staffId;
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

function requireRole(
  check: (s: typeof staffTable.$inferSelect) => boolean,
  label: string,
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const staff = await loadStaff(req, res);
    if (!staff) return;
    if (!check(staff)) {
      res.status(403).json({ error: `${label} only` });
      return;
    }
    (req as Request & { staff: typeof staff }).staff = staff;
    next();
  };
}

const requirePolarityAdmin = requireRole(
  (s) =>
    s.isAdmin || s.isBehaviorSpecialist || s.isMtssCoordinator || s.isDean,
  "Admin, behavior specialist, MTSS coordinator, or dean",
);

// Normalize so [a,b] always has a <= b. Eliminates ambiguity around order.
function normalizePair(a: string, b: string): [string, string] {
  return a <= b ? [a, b] : [b, a];
}

/**
 * Returns information about an active polarity conflict for `studentId`, or
 * null if none. A conflict exists when the student has at least one polarity
 * partner who currently has an active hall pass.
 */
export async function findPolarityConflict(studentId: string): Promise<{
  partnerStudentId: string;
  partnerFirstName: string | null;
  partnerLastName: string | null;
  partnerActiveDestination: string;
} | null> {
  const trimmed = studentId.trim();
  if (!trimmed) return null;

  // Find every partner of this student.
  const pairs = await db
    .select()
    .from(polarityPairsTable)
    .where(
      or(
        eq(polarityPairsTable.studentIdA, trimmed),
        eq(polarityPairsTable.studentIdB, trimmed),
      ),
    );
  if (pairs.length === 0) return null;

  const partnerIds = pairs.map((p) =>
    p.studentIdA === trimmed ? p.studentIdB : p.studentIdA,
  );

  // Check if any partner has an active pass right now.
  for (const pid of partnerIds) {
    const [openPass] = await db
      .select({ destination: hallPassesTable.destination })
      .from(hallPassesTable)
      .where(
        and(
          eq(hallPassesTable.studentId, pid),
          eq(hallPassesTable.status, "active"),
        ),
      );
    if (!openPass) continue;
    const [partner] = await db
      .select({
        firstName: studentsTable.firstName,
        lastName: studentsTable.lastName,
      })
      .from(studentsTable)
      .where(eq(studentsTable.studentId, pid));
    return {
      partnerStudentId: pid,
      partnerFirstName: partner?.firstName ?? null,
      partnerLastName: partner?.lastName ?? null,
      partnerActiveDestination: openPass.destination,
    };
  }

  return null;
}

/**
 * Builds a friendly error message for a conflict. Used by both the regular
 * hall-pass route and the kiosk route so the wording is consistent.
 */
export function polarityConflictMessage(c: {
  partnerStudentId: string;
  partnerFirstName: string | null;
  partnerLastName: string | null;
  partnerActiveDestination: string;
}): string {
  const name =
    c.partnerFirstName && c.partnerLastName
      ? `${c.partnerFirstName} ${c.partnerLastName}`
      : c.partnerStudentId;
  return `Cannot issue pass: ${name} is currently out on a pass to ${c.partnerActiveDestination} and is on this student's keep-apart list.`;
}

// ---- list (any signed-in staff) ----
router.get("/polarity-pairs", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const rows = await db
    .select()
    .from(polarityPairsTable)
    .orderBy(polarityPairsTable.createdAt);
  if (rows.length === 0) {
    res.json([]);
    return;
  }
  // Hydrate names for both sides in a single students fetch.
  const ids = Array.from(
    new Set(rows.flatMap((r) => [r.studentIdA, r.studentIdB])),
  );
  const students = await db
    .select({
      studentId: studentsTable.studentId,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
    })
    .from(studentsTable);
  const byId = new Map(
    students
      .filter((s) => ids.includes(s.studentId))
      .map((s) => [s.studentId, s]),
  );
  res.json(
    rows.map((r) => {
      const a = byId.get(r.studentIdA);
      const b = byId.get(r.studentIdB);
      return {
        id: r.id,
        studentIdA: r.studentIdA,
        studentAFirstName: a?.firstName ?? null,
        studentALastName: a?.lastName ?? null,
        studentIdB: r.studentIdB,
        studentBFirstName: b?.firstName ?? null,
        studentBLastName: b?.lastName ?? null,
        note: r.note,
        createdAt: r.createdAt,
      };
    }),
  );
});

// ---- create ----
router.post("/polarity-pairs", requirePolarityAdmin, async (req, res) => {
  const { studentIdA, studentIdB, note } = req.body ?? {};
  const sa = typeof studentIdA === "string" ? studentIdA.trim() : "";
  const sb = typeof studentIdB === "string" ? studentIdB.trim() : "";
  if (!sa || !sb) {
    res.status(400).json({ error: "Both studentIdA and studentIdB are required" });
    return;
  }
  if (sa === sb) {
    res
      .status(400)
      .json({ error: "Cannot pair a student with themselves" });
    return;
  }

  // Validate both students exist.
  const found = await db
    .select({ studentId: studentsTable.studentId })
    .from(studentsTable)
    .where(or(eq(studentsTable.studentId, sa), eq(studentsTable.studentId, sb)));
  const foundIds = new Set(found.map((f) => f.studentId));
  const missing = [sa, sb].filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    res
      .status(400)
      .json({ error: `Unknown student id(s): ${missing.join(", ")}` });
    return;
  }

  const [a, b] = normalizePair(sa, sb);

  const existing = await db
    .select()
    .from(polarityPairsTable)
    .where(
      and(
        eq(polarityPairsTable.studentIdA, a),
        eq(polarityPairsTable.studentIdB, b),
      ),
    );
  if (existing.length > 0) {
    res.status(409).json({ error: "These students are already paired" });
    return;
  }

  const cleanNote =
    typeof note === "string" && note.trim() ? note.trim().slice(0, 500) : null;
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;

  const [row] = await db
    .insert(polarityPairsTable)
    .values({
      studentIdA: a,
      studentIdB: b,
      note: cleanNote,
      createdByStaffId: staff.id,
    })
    .returning();
  res.status(201).json(row);
});

// ---- delete ----
router.delete("/polarity-pairs/:id", requirePolarityAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [row] = await db
    .delete(polarityPairsTable)
    .where(eq(polarityPairsTable.id, id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({ ok: true, id: row.id });
});

// Silence unused-import warning for `ne` (kept for future extensions).
void ne;

export default router;
