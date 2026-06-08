// "My Watch List" — teacher-personal hand-curated bookmark list.
//
// Six endpoints, all scoped to the authenticated staff member:
//
//   GET    /api/insights/my-watchlist
//          List the caller's entries with hydrated student details.
//   GET    /api/insights/my-watchlist/staff-directory
//          (Core team only.) List active staff at the school so the
//          UI can offer an "add to whose list?" picker when an admin
//          / MTSS coord / behavior specialist seeds an entry on a
//          teacher's behalf.
//   POST   /api/insights/my-watchlist
//          Add a student. Body: { studentId, groupKey, note?,
//            followupText?, followupDue?, targetStaffId? }
//          targetStaffId is core-team-only — when set, the entry
//          lands on that teacher's list instead of the caller's, and
//          the row records the caller as `addedByStaffId` so the
//          target teacher sees an "Added by X" badge.
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
// Writes validate visibility against the OWNING teacher (not the
// caller). For self-adds that's identical; for core-team-on-behalf-of
// adds it ensures the target teacher actually has visibility to the
// student — otherwise the entry would just show as "no access" in
// their UI.

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
  teacherWatchlistGroupsTable,
} from "@workspace/db";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { sendMyWatchlistSeedEmail } from "../lib/myWatchlistSeedEmail.js";

const router: IRouter = Router();

// Built-in groups that ship with every account. The client also
// hardcodes these (keeps the styling/microcopy consistent across all
// users). Custom groups stored in teacher_watchlist_groups extend
// this set per-teacher.
const BUILTIN_GROUP_KEYS = new Set([
  "reading",
  "behavior",
  "family",
  "shine",
]);

// Normalize raw group key input. Accepts any non-empty trimmed
// lowercase string up to 40 chars. Validation that the key is
// actually one of the caller's allowed groups happens separately
// (see isAllowedGroupKey).
function normalizeGroupKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase().slice(0, 40);
  if (!trimmed) return null;
  return trimmed;
}

// Slugify a label into a key safe to store / index. Lowercase,
// alphanumeric + dash, collapsed dashes, trimmed of leading/trailing
// dashes. Used when a teacher creates a custom group from a label.
function slugifyGroupLabel(label: string): string {
  return label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

// Check whether a given groupKey is allowed for a particular owner
// (built-in OR a custom group they own at the given school). Used by
// POST + PATCH on entries to reject typos / stale custom-group keys.
// School-scoped so a staff member who switched active schools doesn't
// silently inherit groups from their other school.
async function isAllowedGroupKey(
  ownerStaffId: number,
  schoolId: number,
  key: string,
): Promise<boolean> {
  if (BUILTIN_GROUP_KEYS.has(key)) return true;
  const [match] = await db
    .select({ id: teacherWatchlistGroupsTable.id })
    .from(teacherWatchlistGroupsTable)
    .where(
      and(
        eq(teacherWatchlistGroupsTable.staffId, ownerStaffId),
        eq(teacherWatchlistGroupsTable.schoolId, schoolId),
        eq(teacherWatchlistGroupsTable.key, key),
      ),
    );
  return Boolean(match);
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

// The staff table stores a single denormalized `display_name` column
// (no first/last split), so this is mostly trivial. Email + id are
// kept as last-resort fallbacks in case a row was inserted without a
// display name during a partial import.
function staffDisplayName(s: {
  id: number;
  displayName?: string | null;
  email?: string | null;
}): string {
  const dn = (s.displayName ?? "").trim();
  if (dn) return dn;
  return s.email || `Staff #${s.id}`;
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

    // Hydrate "added by" display name for entries seeded by a core
    // team member on this teacher's behalf. Self-added entries (the
    // overwhelming common case) skip this lookup.
    const addedByIds = Array.from(
      new Set(
        entries
          .map((e) => e.addedByStaffId)
          .filter((v): v is number => v != null && v !== staff.id),
      ),
    );
    const addedByMap = new Map<number, string>();
    if (addedByIds.length > 0) {
      const addedByRows = await db
        .select({
          id: staffTable.id,
          displayName: staffTable.displayName,
          email: staffTable.email,
        })
        .from(staffTable)
        .where(inArray(staffTable.id, addedByIds));
      for (const r of addedByRows) {
        addedByMap.set(r.id, staffDisplayName(r));
      }
    }

    const hydrated = entries
      .map((e) => {
        const s = byId.get(e.studentId);
        if (!s || s.schoolId !== schoolId) return null;
        if (!vis.full && !vis.ids.has(e.studentId)) return null;
        const addedBy =
          e.addedByStaffId != null && e.addedByStaffId !== staff.id
            ? {
                id: e.addedByStaffId,
                displayName:
                  addedByMap.get(e.addedByStaffId) ??
                  `Staff #${e.addedByStaffId}`,
              }
            : null;
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
          addedBy,
          // Only meaningful when addedBy is set. Null on every
          // self-added entry (acknowledgement is for "someone else
          // touched my list" only).
          acknowledgedAt:
            e.addedByStaffId != null && e.addedByStaffId !== staff.id
              ? e.acknowledgedAt
              : null,
          lastTouchBy: e.lastTouchBy,
          lastTouchWhat: e.lastTouchWhat,
          lastTouchAt: e.lastTouchAt,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    // Order: unacknowledged seeded entries first (so they pin to the
    // top of their group bucket on the client), then by addedAt
    // descending. Same group bucket on both sides — the client
    // re-buckets by groupKey after this sort, so within-group order
    // is what survives.
    hydrated.sort((a, b) => {
      const aPinned =
        a.addedBy != null && a.acknowledgedAt == null ? 0 : 1;
      const bPinned =
        b.addedBy != null && b.acknowledgedAt == null ? 0 : 1;
      if (aPinned !== bPinned) return aPinned - bPinned;
      const aTime = a.addedAt ? new Date(a.addedAt).getTime() : 0;
      const bTime = b.addedAt ? new Date(b.addedAt).getTime() : 0;
      return bTime - aTime;
    });

    res.json({ entries: hydrated });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[my-watchlist] list failed", e);
    res.status(500).json({ error: "Failed to load watch list" });
  }
});

// ---- GET: staff directory (core team only) ---------------------------
//
// Powers the "Add to whose watch list?" picker in the Add modal so an
// admin / MTSS coord / behavior specialist / PBIS coord / SuperUser
// can seed an entry on a teacher's behalf. Returns active staff at
// the caller's active school. Defined before any `:id` route to
// avoid being shadowed by future GET-by-id endpoints.
router.get("/insights/my-watchlist/staff-directory", async (req, res) => {
  try {
    const staff = await loadStaff(req, res);
    if (!staff) return;
    if (!isCoreTeam(staff)) {
      res.status(403).json({ error: "Core team only" });
      return;
    }
    const schoolId = activeSchoolId(staff);
    const rows = await db
      .select({
        id: staffTable.id,
        displayName: staffTable.displayName,
        email: staffTable.email,
      })
      .from(staffTable)
      .where(and(eq(staffTable.schoolId, schoolId), eq(staffTable.active, true)))
      .orderBy(staffTable.displayName);
    res.json({
      staff: rows.map((r) => ({
        id: r.id,
        displayName: staffDisplayName(r),
      })),
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[my-watchlist] staff-directory failed", e);
    res.status(500).json({ error: "Failed to load staff directory" });
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

    // Resolve target staff (the person whose list this lands on).
    // (Defined below; we need the targetStaff before we can check
    // whether the group key is valid for THEM, since custom groups
    // are per-owner.)
    // Defaults to the caller (self-add). Core team can specify a
    // different teacher to seed an entry on their behalf.
    const rawTarget = req.body?.targetStaffId;
    let targetStaff: typeof staffTable.$inferSelect = staff;
    if (rawTarget != null && rawTarget !== staff.id) {
      const parsed =
        typeof rawTarget === "number"
          ? rawTarget
          : typeof rawTarget === "string"
          ? parseInt(rawTarget, 10)
          : NaN;
      if (!Number.isFinite(parsed)) {
        res.status(400).json({ error: "Invalid targetStaffId" });
        return;
      }
      if (!isCoreTeam(staff)) {
        res
          .status(403)
          .json({ error: "Only admins / coordinators can add to another teacher's list" });
        return;
      }
      const [target] = await db
        .select()
        .from(staffTable)
        .where(eq(staffTable.id, parsed));
      if (!target || !target.active || target.schoolId !== schoolId) {
        res.status(404).json({ error: "Target staff not found at this school" });
        return;
      }
      targetStaff = target;
    }
    const isOnBehalfOf = targetStaff.id !== staff.id;

    // Group key must be either built-in or one of the TARGET teacher's
    // own custom groups (since custom groups are per-owner). This
    // catches typos in clients and stops core team from accidentally
    // assigning a group key that won't render on the target's list.
    const allowed = await isAllowedGroupKey(targetStaff.id, schoolId, groupKey);
    if (!allowed) {
      res.status(400).json({
        error: "Unknown group",
        detail:
          "Pick one of the built-in groups or one of the target teacher's custom groups.",
      });
      return;
    }

    // Visibility check — against the OWNING teacher (target), not the
    // caller. An admin acts as their own check on which teacher to
    // pick; what matters is whether the target teacher will actually
    // be able to open the student's profile from the entry.
    const vis = await visibleStudentIds(targetStaff, schoolId);
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
          staffId: targetStaff.id,
          schoolId,
          studentId,
          groupKey,
          note,
          followupText,
          followupDue,
          // Only set addedBy when seeded by someone other than the
          // owner — keeps self-add rows visually clean (no badge).
          addedByStaffId: isOnBehalfOf ? staff.id : null,
        })
        .returning();

      // Best-effort email notification on on-behalf-of adds. The
      // in-app banner is the primary signal; this is the secondary
      // channel for teachers who don't open PulseEDU often. The whole
      // block — group/student lookups + Resend send — runs inside a
      // self-contained async IIFE with a top-level catch so a DB blip
      // or Resend timeout can never surface as a 500 on a row that
      // was already inserted.
      if (isOnBehalfOf && targetStaff.email) {
        const targetEmail = targetStaff.email;
        const targetDisplay = staffDisplayName(targetStaff);
        const seederDisplay = staffDisplayName(staff);
        const targetStaffId = targetStaff.id;
        void (async () => {
          try {
            const groupLabelMap: Record<string, string> = {
              reading: "Reading concerns",
              behavior: "Behavior watch",
              family: "Family things to know",
              shine: "Quiet kids to lift up",
            };
            let groupLabel = groupLabelMap[groupKey];
            if (!groupLabel) {
              // Custom group — look up the owner's label so the
              // email says "Math intervention" instead of
              // "math-intervention".
              const [g] = await db
                .select({ label: teacherWatchlistGroupsTable.label })
                .from(teacherWatchlistGroupsTable)
                .where(
                  and(
                    eq(teacherWatchlistGroupsTable.staffId, targetStaffId),
                    eq(teacherWatchlistGroupsTable.schoolId, schoolId),
                    eq(teacherWatchlistGroupsTable.key, groupKey),
                  ),
                );
              groupLabel = g?.label ?? groupKey;
            }
            const [studentRow] = await db
              .select({
                firstName: studentsTable.firstName,
                lastName: studentsTable.lastName,
              })
              .from(studentsTable)
              .where(eq(studentsTable.studentId, studentId));
            const studentName = studentRow
              ? `${studentRow.firstName} ${studentRow.lastName}`
              : studentId;
            const appBaseUrl =
              process.env.PUBLIC_APP_URL ||
              (process.env.REPLIT_DEV_DOMAIN
                ? `https://${process.env.REPLIT_DEV_DOMAIN}`
                : "https://app.pulseedu.com");
            await sendMyWatchlistSeedEmail({
              toEmail: targetEmail,
              toDisplayName: targetDisplay,
              fromDisplayName: seederDisplay,
              studentDisplayName: studentName,
              groupLabel,
              note,
              appBaseUrl,
            });
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn("[my-watchlist] seed email failed", err);
          }
        })();
      }

      res.status(201).json({ entry: inserted });
    } catch (err) {
      // Drizzle wraps the underlying pg error in DrizzleQueryError, so
      // the constraint name lives at .cause.constraint and the SQLSTATE
      // at .cause.code. Fall back to substring matching for the rare
      // case where the wrapper is bypassed (e.g. raw client paths).
      const msg = err instanceof Error ? err.message : String(err);
      const cause = (err as { cause?: { code?: string; constraint?: string } })
        .cause;
      const isUniqueViolation =
        cause?.code === "23505" ||
        cause?.constraint === "teacher_watchlist_staff_student_uniq" ||
        msg.includes("teacher_watchlist_staff_student_uniq") ||
        msg.includes("duplicate key");
      if (isUniqueViolation) {
        const [existing] = await db
          .select()
          .from(teacherWatchlistEntriesTable)
          .where(
            and(
              eq(teacherWatchlistEntriesTable.staffId, targetStaff.id),
              eq(teacherWatchlistEntriesTable.studentId, studentId),
            ),
          );
        res.status(409).json({
          error: isOnBehalfOf
            ? "Already on this teacher's list"
            : "Already on your list",
          entry: existing,
        });
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
      // Same allow-list as POST: must be a built-in or one of the
      // owner's custom keys for this school. Otherwise a stale or
      // hand-typed key could land in the row and never render in any
      // group tab.
      const allowed = await isAllowedGroupKey(staff.id, existing.schoolId, g);
      if (!allowed) {
        res.status(400).json({
          error: "Unknown group",
          detail:
            "Pick one of the built-in groups or one of your custom groups.",
        });
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

// ---- POST: acknowledge a seeded entry --------------------------------
//
// When a core team member adds a student to a teacher's list the entry
// gets a bright amber "Added by X" pill so the teacher can't miss it.
// Once they've seen it, clicking Acknowledge stamps acknowledged_at
// and the pill quiets to a muted "Acknowledged" state, AND the entry
// stops being pinned to the top of its group bucket.
//
// Only the OWNING teacher can acknowledge. Self-added entries (no
// addedByStaffId) can't be acknowledged — the action is meaningless.

router.post("/insights/my-watchlist/:id/acknowledge", async (req, res) => {
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
      // 404 not 403 — never leak existence of someone else's entry.
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (existing.addedByStaffId == null) {
      res.status(400).json({
        error: "Nothing to acknowledge — this entry was self-added.",
      });
      return;
    }
    if (existing.acknowledgedAt != null) {
      // Idempotent — already acknowledged. Return the row unchanged.
      res.json({ entry: existing });
      return;
    }
    const [updated] = await db
      .update(teacherWatchlistEntriesTable)
      .set({ acknowledgedAt: new Date() })
      .where(eq(teacherWatchlistEntriesTable.id, id))
      .returning();
    res.json({ entry: updated });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[my-watchlist] acknowledge failed", e);
    res.status(500).json({ error: "Failed to acknowledge entry" });
  }
});

// ---- Custom group management -----------------------------------------
//
// GET    /api/insights/my-watchlist/groups
// POST   /api/insights/my-watchlist/groups
// DELETE /api/insights/my-watchlist/groups/:id
//
// Each teacher owns their own custom groups. Built-ins (reading,
// behavior, family, shine) are baked into the client and aren't
// returned here — the client knows about them already and merges
// the two lists when rendering the group tabs / picker.

router.get("/insights/my-watchlist/groups", async (req, res) => {
  try {
    const staff = await loadStaff(req, res);
    if (!staff) return;
    const schoolId = activeSchoolId(staff);
    const rows = await db
      .select({
        id: teacherWatchlistGroupsTable.id,
        key: teacherWatchlistGroupsTable.key,
        label: teacherWatchlistGroupsTable.label,
        emoji: teacherWatchlistGroupsTable.emoji,
      })
      .from(teacherWatchlistGroupsTable)
      .where(
        and(
          eq(teacherWatchlistGroupsTable.staffId, staff.id),
          // School-scoped — a staff member with multiple schools (or
          // an active-school override) only sees the groups they
          // created for the school they're currently viewing.
          eq(teacherWatchlistGroupsTable.schoolId, schoolId),
        ),
      )
      .orderBy(teacherWatchlistGroupsTable.label);
    res.json({ groups: rows });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[my-watchlist] groups list failed", e);
    res.status(500).json({ error: "Failed to load custom groups" });
  }
});

router.post("/insights/my-watchlist/groups", async (req, res) => {
  try {
    const staff = await loadStaff(req, res);
    if (!staff) return;
    const schoolId = activeSchoolId(staff);

    const labelRaw =
      typeof req.body?.label === "string" ? req.body.label.trim() : "";
    if (!labelRaw) {
      res.status(400).json({ error: "Label is required" });
      return;
    }
    if (labelRaw.length > 60) {
      res.status(400).json({ error: "Label must be 60 characters or less" });
      return;
    }
    const emoji =
      typeof req.body?.emoji === "string"
        ? req.body.emoji.trim().slice(0, 8) || null
        : null;

    const key = slugifyGroupLabel(labelRaw);
    if (!key) {
      res.status(400).json({
        error: "Label must contain at least one letter or number",
      });
      return;
    }
    if (BUILTIN_GROUP_KEYS.has(key)) {
      res.status(409).json({
        error: "That label conflicts with a built-in group. Pick a different name.",
      });
      return;
    }

    try {
      const [inserted] = await db
        .insert(teacherWatchlistGroupsTable)
        .values({
          staffId: staff.id,
          schoolId,
          key,
          label: labelRaw,
          emoji,
        })
        .returning();
      res.status(201).json({ group: inserted });
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause;
      if (cause?.code === "23505") {
        res.status(409).json({ error: "You already have a group with that name." });
        return;
      }
      throw err;
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[my-watchlist] groups create failed", e);
    res.status(500).json({ error: "Failed to create group" });
  }
});

router.delete("/insights/my-watchlist/groups/:id", async (req, res) => {
  try {
    const staff = await loadStaff(req, res);
    if (!staff) return;
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    // Run lookup → in-use count → delete in one transaction so a
    // racing POST /my-watchlist that uses this group key can't slip
    // through after the count and leave us with orphaned entries.
    // We lock the group row FOR UPDATE; the entries-count is still
    // not strictly race-proof against an entry insert (no FK), but
    // the window shrinks to "between count and delete inside the
    // same tx" instead of "between two top-level requests".
    const result = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(teacherWatchlistGroupsTable)
        .where(eq(teacherWatchlistGroupsTable.id, id))
        .for("update");
      if (!existing || existing.staffId !== staff.id) {
        return { status: 404 as const, body: { error: "Not found" } };
      }
      const [{ count: inUse } = { count: 0 }] = await tx
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(teacherWatchlistEntriesTable)
        .where(
          and(
            eq(teacherWatchlistEntriesTable.staffId, staff.id),
            eq(teacherWatchlistEntriesTable.groupKey, existing.key),
          ),
        );
      if (inUse > 0) {
        return {
          status: 409 as const,
          body: {
            error: `Can't delete — ${inUse} student${inUse === 1 ? " is" : "s are"} still in this group. Move or remove them first.`,
          },
        };
      }
      await tx
        .delete(teacherWatchlistGroupsTable)
        .where(eq(teacherWatchlistGroupsTable.id, id));
      return { status: 200 as const, body: { ok: true } };
    });

    res.status(result.status).json(result.body);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[my-watchlist] groups delete failed", e);
    res.status(500).json({ error: "Failed to delete group" });
  }
});

export default router;
