import { Router, type IRouter, type Request } from "express";
import {
  db,
  parentStudentsTable,
  studentsTable,
  schoolHeartbeatSettingsTable,
  parentHeartbeatPrefsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { requireActiveParent } from "../lib/parentAuthMiddleware.js";

const router: IRouter = Router();

// Resolve req.parentId AND enforce parents.active=true on every request (F02).
router.use(requireActiveParent);

const SECTION_KEYS = [
  "showRecognition",
  "showAttendance",
  "showHallPasses",
  "showAccommodations",
  "showFastScores",
  "showCommHistory",
  "showPullouts",
  "showInterventions",
  "showStaffNotes",
  "showIss",
  "showMtss",
  "showOss",
  "showReteach",
] as const;
type SectionKey = (typeof SECTION_KEYS)[number];

const SCHOOL_DEFAULTS: Record<SectionKey, boolean> = {
  showRecognition: true,
  showAttendance: true,
  showHallPasses: true,
  showAccommodations: true,
  showFastScores: true,
  showCommHistory: true,
  showPullouts: true,
  showInterventions: false,
  showStaffNotes: false,
  showIss: false,
  showMtss: false,
  showOss: false,
  showReteach: false,
};

const VALID_DATE_RANGES = new Set(["semester", "month", "all"]);
const SECTION_KEY_SET: ReadonlySet<string> = new Set(SECTION_KEYS);

function parseStudentId(raw: unknown): number | null {
  // Accept either a number or a numeric string. Must be a positive
  // integer; anything else (NaN, Infinity, 0, negative, decimal) is
  // rejected so callers get a 400 instead of an opaque DB error.
  const n = typeof raw === "string" ? Number(raw) : (raw as number);
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

async function ensureLink(
  req: Request,
  studentId: number,
): Promise<{ parentId: number; schoolId: number } | null> {
  const pid = req.parentId;
  if (!pid) return null;
  const [link] = await db
    .select({ id: parentStudentsTable.id })
    .from(parentStudentsTable)
    .where(
      and(
        eq(parentStudentsTable.parentId, pid),
        eq(parentStudentsTable.studentId, studentId),
      ),
    );
  if (!link) return null;
  const [s] = await db
    .select({ schoolId: studentsTable.schoolId })
    .from(studentsTable)
    .where(eq(studentsTable.id, studentId));
  if (!s) return null;
  return { parentId: pid, schoolId: s.schoolId };
}

async function readSchoolSettings(schoolId: number) {
  const [row] = await db
    .select()
    .from(schoolHeartbeatSettingsTable)
    .where(eq(schoolHeartbeatSettingsTable.schoolId, schoolId));
  return row ?? null;
}

async function readParentPrefs(parentId: number, studentId: number) {
  const [row] = await db
    .select()
    .from(parentHeartbeatPrefsTable)
    .where(
      and(
        eq(parentHeartbeatPrefsTable.parentId, parentId),
        eq(parentHeartbeatPrefsTable.studentId, studentId),
      ),
    );
  return row ?? null;
}

// Compose the school + parent view for the prefs UI. Each section reports:
//   schoolEnabled — whether parents at this school may see it at all.
//   parentPref    — null means "inherit", true/false is an explicit choice.
// The parent UI uses these two together: if schoolEnabled is false, the
// row is shown as locked; otherwise the parent's switch reflects
// (parentPref ?? true) and writing `false` hides the section for this
// (parent, student) pair only.
router.get("/parent/heartbeat-prefs", async (req, res) => {
  const pid = req.parentId;
  if (!pid) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const studentId = parseStudentId(req.query.studentId);
  if (studentId === null) {
    res.status(400).json({ error: "studentId must be a positive integer" });
    return;
  }
  const linked = await ensureLink(req, studentId);
  if (!linked) {
    res.status(403).json({ error: "Not your student" });
    return;
  }
  const [settingsRow, prefsRow] = await Promise.all([
    readSchoolSettings(linked.schoolId),
    readParentPrefs(pid, studentId),
  ]);
  const sections = SECTION_KEYS.map((k) => {
    const schoolEnabled = settingsRow?.[k] ?? SCHOOL_DEFAULTS[k];
    const parentPref =
      prefsRow == null ? null : (prefsRow[k] as boolean | null | undefined);
    return {
      key: k,
      schoolEnabled,
      parentPref: parentPref === undefined ? null : parentPref,
    };
  });
  res.json({
    studentId,
    sections,
    weeklyEmailAllowed: settingsRow?.allowWeeklyEmail ?? true,
    weeklyEmailEnabled: prefsRow?.weeklyEmailEnabled ?? false,
    dateRangeDefault: prefsRow?.dateRangeDefault ?? "semester",
  });
});

// Upsert the parent's prefs row for a (parent, student) pair. The
// `prefs` object may carry any subset of section keys with values of
// `boolean` or `null` (null = inherit school default), plus optional
// `weeklyEmailEnabled` and `dateRangeDefault`. School ceiling is NOT
// re-enforced here — parentSnapshot.ts already does so at read time —
// because storing a parent's "I'd like to see this" intent across a
// later admin re-enable is friendlier than silently dropping it.
router.put("/parent/heartbeat-prefs", async (req, res): Promise<void> => {
  const pid = req.parentId;
  if (!pid) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const studentId = parseStudentId(body.studentId);
  if (studentId === null) {
    res.status(400).json({ error: "studentId must be a positive integer" });
    return;
  }
  const linked = await ensureLink(req, studentId);
  if (!linked) {
    res.status(403).json({ error: "Not your student" });
    return;
  }

  const incomingPrefs = (body.prefs ?? {}) as Record<string, unknown>;
  if (incomingPrefs && typeof incomingPrefs !== "object") {
    res.status(400).json({ error: "prefs must be an object" });
    return;
  }
  // Reject any unknown keys outright instead of silently dropping them
  // — this catches typos in client refactors and prevents a malicious
  // payload from probing column names.
  for (const k of Object.keys(incomingPrefs)) {
    if (!SECTION_KEY_SET.has(k)) {
      res.status(400).json({ error: `Unknown section key: ${k}` });
      return;
    }
  }
  const updates: Record<string, unknown> = {};
  for (const k of SECTION_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(incomingPrefs, k)) continue;
    const v = incomingPrefs[k];
    if (v !== null && typeof v !== "boolean") {
      res.status(400).json({ error: `${k} must be boolean or null` });
      return;
    }
    updates[k] = v;
  }
  if (Object.prototype.hasOwnProperty.call(body, "weeklyEmailEnabled")) {
    const v = body.weeklyEmailEnabled;
    if (typeof v !== "boolean") {
      res.status(400).json({ error: "weeklyEmailEnabled must be a boolean" });
      return;
    }
    updates.weeklyEmailEnabled = v;
  }
  if (Object.prototype.hasOwnProperty.call(body, "dateRangeDefault")) {
    const v = body.dateRangeDefault;
    if (typeof v !== "string" || !VALID_DATE_RANGES.has(v)) {
      res
        .status(400)
        .json({ error: "dateRangeDefault must be 'semester', 'month', or 'all'" });
      return;
    }
    updates.dateRangeDefault = v;
  }

  if (Object.keys(updates).length === 0) {
    const existing = await readParentPrefs(pid, studentId);
    res.json({ ok: true, row: existing });
    return;
  }

  updates.updatedAt = new Date();

  const existing = await readParentPrefs(pid, studentId);
  if (existing) {
    const [updated] = await db
      .update(parentHeartbeatPrefsTable)
      .set(updates)
      .where(
        and(
          eq(parentHeartbeatPrefsTable.id, existing.id),
          eq(parentHeartbeatPrefsTable.parentId, pid),
          eq(parentHeartbeatPrefsTable.studentId, studentId),
        ),
      )
      .returning();
    res.json({ ok: true, row: updated });
    return;
  }
  try {
    const [created] = await db
      .insert(parentHeartbeatPrefsTable)
      .values({
        parentId: pid,
        studentId,
        ...updates,
      })
      .returning();
    res.json({ ok: true, row: created });
  } catch (err) {
    // Postgres unique-violation = 23505 — that means another tab/inflight
    // request inserted the row first; re-read the winner. Any other DB
    // error is a real failure and must surface as a 500 rather than be
    // silently masked as success.
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as { code?: unknown }).code
        : undefined;
    if (code !== "23505") {
      console.error("parentHeartbeatPrefs upsert failed", err);
      res.status(500).json({ error: "Could not save preferences" });
      return;
    }
    const [row2] = await db
      .select()
      .from(parentHeartbeatPrefsTable)
      .where(
        and(
          eq(parentHeartbeatPrefsTable.parentId, pid),
          eq(parentHeartbeatPrefsTable.studentId, studentId),
        ),
      );
    if (!row2) {
      res.status(500).json({ error: "Could not save preferences" });
      return;
    }
    res.json({ ok: true, row: row2 });
  }
});

export default router;
