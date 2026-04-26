// "My Watch List" — teacher-personal hand-curated bookmark list.
//
// Five endpoints, all scoped to the authenticated staff member:
//
//   GET    /api/insights/my-watchlist
//          List the caller's entries with hydrated student details.
//   POST   /api/insights/my-watchlist
//          Add a student. Body: { studentId, groupKey, note?,
//            followupText?, followupDue? }
//   PATCH  /api/insights/my-watchlist/:id
//          Edit groupKey / note / followup{Text,Due} on an existing
//          entry. Touches a non-owned entry → 404 (don't leak existence).
//   POST   /api/insights/my-watchlist/:id/touch
//          Stamp a touch event. Body: { what }. Server fills in
//          lastTouchBy (caller's display name) and lastTouchAt (now).
//   DELETE /api/insights/my-watchlist/:id
//          Hard delete (it's a personal bookmark — soft delete adds no
//          value here).
//
// All writes also validate the studentId is in the caller's visibility
// scope, mirroring the system watchlist's rule: the teacher can only
// add students they can already see (their roster ∪ trusted-adult
// links; core team can add any student at the active school). This
// prevents a teacher from bookmarking a student they couldn't open
// anyway, which would just show "no access" cards in the UI.

import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import {
  db,
  staffTable,
  studentsTable,
  classSectionsTable,
  sectionRosterTable,
  studentTrustedAdultsTable,
  teacherWatchlistEntriesTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

const router: IRouter = Router();

// Allowed group keys. Mirrors the four built-in groups in
// MyWatchList.tsx. Free-form strings are still accepted (custom groups
// is a planned follow-up) but unknown values must be at most 40 chars
// and not blank — keeps DB hygiene tight.
const BUILTIN_GROUP_KEYS = new Set([
  "reading",
  "behavior",
  "family",
  "shine",
]);

function normalizeGroupKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase().slice(0, 40);
  if (!trimmed) return null;
  return trimmed;
}

// Quick-action button labels. Free-form text is also accepted (so the
// UI can grow new presets without a schema change), but capped to 80
// chars to avoid storing essays in this column.
function normalizeTouchWhat(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().slice(0, 80);
  if (!trimmed) return null;
  return trimmed;
}

async function loadStaff(req: Request, res: Response) {
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

function isCoreTeam(s: typeof staffTable.$inferSelect): boolean {
  return Boolean(
    s.isSuperUser ||
      s.isAdmin ||
      s.isBehaviorSpecialist ||
      s.isMtssCoordinator ||
      s.isPbisCoordinator,
  );
}

function activeSchoolId(s: typeof staffTable.$inferSelect): number {
  return s.activeSchoolOverride ?? s.schoolId;
}

function staffDisplayName(s: typeof staffTable.$inferSelect): string {
  const first = (s.firstName ?? "").trim();
  const last = (s.lastName ?? "").trim();
  const combined = `${first} ${last}`.trim();
  return combined || s.email || `Staff #${s.id}`;
}

// Returns the set of student business IDs (text) the caller can add to
// their list. Mirrors the watchlist visibility rules.
async function visibleStudentIds(
  staff: typeof staffTable.$inferSelect,
  schoolId: number,
): Promise<{ ids: Set<string>; full: boolean }> {
  if (isCoreTeam(staff)) return { ids: new Set(), full: true };

  const rosterRows = await db
    .select({ studentId: sectionRosterTable.studentId })
    .from(sectionRosterTable)
    .innerJoin(
      classSectionsTable,
      eq(classSectionsTable.id, sectionRosterTable.sectionId),
    )
    .where(
      and(
        eq(sectionRosterTable.schoolId, schoolId),
        eq(classSectionsTable.teacherStaffId, staff.id),
        eq(classSectionsTable.isPlanning, false),
      ),
    );

  const trustedRows = await db
    .select({ studentId: studentTrustedAdultsTable.studentId })
    .from(studentTrustedAdultsTable)
    .where(
      and(
        eq(studentTrustedAdultsTable.staffId, staff.id),
        eq(studentTrustedAdultsTable.schoolId, schoolId),
      ),
    );

  const ids = new Set<string>();
  for (const r of rosterRows) ids.add(r.studentId);
  for (const r of trustedRows) ids.add(r.studentId);
  return { ids, full: false };
}

// ---- GET: list the caller's entries ----------------------------------

router.get("/insights/my-watchlist", async (req, res) => {
  try {
    const staff = await loadStaff(req, res);
    if (!staff) return;
    const schoolId = activeSchoolId(staff);

    const entries = await db
      .select()
      .from(teacherWatchlistEntriesTable)
      .where(eq(teacherWatchlistEntriesTable.staffId, staff.id));

    if (entries.length === 0) {
      res.json({ entries: [] });
      return;
    }

    // Hydrate student name / grade. Cap to current school's roster to
    // avoid surfacing stale entries if the teacher moved schools — those
    // still exist in the DB but the UI hides them. (We could 404 them
    // out, but a future "view archive" affordance benefits from them
    // staying around.)
    const studentIds = Array.from(new Set(entries.map((e) => e.studentId)));
    const students = await db
      .select({
        studentId: studentsTable.studentId,
        firstName: studentsTable.firstName,
        lastName: studentsTable.lastName,
        grade: studentsTable.grade,
        schoolId: studentsTable.schoolId,
      })
      .from(studentsTable)
      .where(inArray(studentsTable.studentId, studentIds));

    const byId = new Map(students.map((s) => [s.studentId, s]));

    // Re-apply visibility scope at hydration time. An entry that was
    // valid at create-time can become invalid later (teacher loses the
    // section, trusted-adult link removed, etc.); we MUST not surface
    // student name/grade for kids the caller no longer has access to.
    // Core team bypasses this filter (vis.full === true).
    const vis = await visibleStudentIds(staff, schoolId);

    const hydrated = entries
      .map((e) => {
        const s = byId.get(e.studentId);
        if (!s || s.schoolId !== schoolId) return null;
        if (!vis.full && !vis.ids.has(e.studentId)) return null;
        return {
          id: e.id,
          studentId: e.studentId,
          firstName: s.firstName,
          lastName: s.lastName,
          grade: s.grade,
          groupKey: e.groupKey,
          note: e.note,
          followupText: e.followupText,
          followupDue: e.followupDue,
          addedAt: e.addedAt,
          lastTouchBy: e.lastTouchBy,
          lastTouchWhat: e.lastTouchWhat,
          lastTouchAt: e.lastTouchAt,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    res.json({ entries: hydrated });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[my-watchlist] list failed", e);
    res.status(500).json({ error: "Failed to load watch list" });
  }
});

// ---- POST: add an entry ----------------------------------------------

router.post("/insights/my-watchlist", async (req, res) => {
  try {
    const staff = await loadStaff(req, res);
    if (!staff) return;
    const schoolId = activeSchoolId(staff);

    const studentId =
      typeof req.body?.studentId === "string"
        ? req.body.studentId.trim()
        : "";
    const groupKey = normalizeGroupKey(req.body?.groupKey);
    const note =
      typeof req.body?.note === "string" ? req.body.note.slice(0, 2000) : "";
    const followupText =
      typeof req.body?.followupText === "string"
        ? req.body.followupText.trim().slice(0, 240) || null
        : null;
    // Date input value is "YYYY-MM-DD"; pass through as-is.
    const followupDue =
      typeof req.body?.followupDue === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(req.body.followupDue)
        ? req.body.followupDue
        : null;

    if (!studentId) {
      res.status(400).json({ error: "studentId is required" });
      return;
    }
    if (!groupKey) {
      res.status(400).json({ error: "groupKey is required" });
      return;
    }

    // Visibility check.
    const vis = await visibleStudentIds(staff, schoolId);
    if (!vis.full && !vis.ids.has(studentId)) {
      // Confirm the student even exists at this school before deciding
      // between 403 and 404. If the student doesn't exist here, return
      // 404 to avoid leaking enrollment info.
      const [exists] = await db
        .select({ studentId: studentsTable.studentId })
        .from(studentsTable)
        .where(
          and(
            eq(studentsTable.studentId, studentId),
            eq(studentsTable.schoolId, schoolId),
          ),
        );
      res
        .status(exists ? 403 : 404)
        .json({ error: "Student not in your visibility scope" });
      return;
    }

    // Confirm the student is at the active school (catches the core-team
    // branch where vis.full short-circuited the roster check).
    const [studentRow] = await db
      .select({ studentId: studentsTable.studentId })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.studentId, studentId),
          eq(studentsTable.schoolId, schoolId),
        ),
      );
    if (!studentRow) {
      res.status(404).json({ error: "Student not found at this school" });
      return;
    }

    // UNIQUE (staffId, studentId) means this insert can race with a
    // duplicate. Catch the unique violation and return 409 with the
    // existing entry's id so the client can switch to "edit" mode.
    try {
      const [inserted] = await db
        .insert(teacherWatchlistEntriesTable)
        .values({
          staffId: staff.id,
          schoolId,
          studentId,
          groupKey,
          note,
          followupText,
          followupDue,
        })
        .returning();
      res.status(201).json({ entry: inserted });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("teacher_watchlist_staff_student_uniq") ||
        msg.includes("duplicate key")
      ) {
        const [existing] = await db
          .select()
          .from(teacherWatchlistEntriesTable)
          .where(
            and(
              eq(teacherWatchlistEntriesTable.staffId, staff.id),
              eq(teacherWatchlistEntriesTable.studentId, studentId),
            ),
          );
        res
          .status(409)
          .json({ error: "Already on your list", entry: existing });
        return;
      }
      throw err;
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[my-watchlist] create failed", e);
    res.status(500).json({ error: "Failed to add entry" });
  }
});

// ---- PATCH: edit groupKey / note / followup --------------------------

router.patch("/insights/my-watchlist/:id", async (req, res) => {
  try {
    const staff = await loadStaff(req, res);
    if (!staff) return;
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const [existing] = await db
      .select()
      .from(teacherWatchlistEntriesTable)
      .where(eq(teacherWatchlistEntriesTable.id, id));
    if (!existing || existing.staffId !== staff.id) {
      // 404 not 403 — don't leak the existence of someone else's entry.
      res.status(404).json({ error: "Not found" });
      return;
    }

    const update: Record<string, unknown> = {};
    if (req.body?.groupKey !== undefined) {
      const g = normalizeGroupKey(req.body.groupKey);
      if (!g) {
        res.status(400).json({ error: "Invalid groupKey" });
        return;
      }
      update.groupKey = g;
    }
    if (req.body?.note !== undefined) {
      update.note =
        typeof req.body.note === "string" ? req.body.note.slice(0, 2000) : "";
    }
    if (req.body?.followupText !== undefined) {
      update.followupText =
        typeof req.body.followupText === "string" &&
        req.body.followupText.trim()
          ? req.body.followupText.trim().slice(0, 240)
          : null;
    }
    if (req.body?.followupDue !== undefined) {
      update.followupDue =
        typeof req.body.followupDue === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(req.body.followupDue)
          ? req.body.followupDue
          : null;
    }

    if (Object.keys(update).length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }

    const [updated] = await db
      .update(teacherWatchlistEntriesTable)
      .set(update)
      .where(eq(teacherWatchlistEntriesTable.id, id))
      .returning();
    res.json({ entry: updated });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[my-watchlist] patch failed", e);
    res.status(500).json({ error: "Failed to update entry" });
  }
});

// ---- POST: log a touch -----------------------------------------------

router.post("/insights/my-watchlist/:id/touch", async (req, res) => {
  try {
    const staff = await loadStaff(req, res);
    if (!staff) return;
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const what = normalizeTouchWhat(req.body?.what);
    if (!what) {
      res.status(400).json({ error: "what is required" });
      return;
    }

    const [existing] = await db
      .select()
      .from(teacherWatchlistEntriesTable)
      .where(eq(teacherWatchlistEntriesTable.id, id));
    if (!existing || existing.staffId !== staff.id) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const [updated] = await db
      .update(teacherWatchlistEntriesTable)
      .set({
        lastTouchAt: new Date(),
        lastTouchBy: staffDisplayName(staff),
        lastTouchWhat: what,
      })
      .where(eq(teacherWatchlistEntriesTable.id, id))
      .returning();
    res.json({ entry: updated });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[my-watchlist] touch failed", e);
    res.status(500).json({ error: "Failed to log touch" });
  }
});

// ---- DELETE -----------------------------------------------------------

router.delete("/insights/my-watchlist/:id", async (req, res) => {
  try {
    const staff = await loadStaff(req, res);
    if (!staff) return;
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [existing] = await db
      .select()
      .from(teacherWatchlistEntriesTable)
      .where(eq(teacherWatchlistEntriesTable.id, id));
    if (!existing || existing.staffId !== staff.id) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    await db
      .delete(teacherWatchlistEntriesTable)
      .where(eq(teacherWatchlistEntriesTable.id, id));
    res.json({ ok: true });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[my-watchlist] delete failed", e);
    res.status(500).json({ error: "Failed to delete entry" });
  }
});

export default router;
