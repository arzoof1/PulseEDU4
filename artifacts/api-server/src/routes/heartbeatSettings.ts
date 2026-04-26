import { Router, type IRouter } from "express";
import {
  db,
  schoolHeartbeatSettingsTable,
  staffTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";

const router: IRouter = Router();

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
  "allowWeeklyEmail",
] as const;
type SectionKey = (typeof SECTION_KEYS)[number];

const SECTION_DEFAULTS: Record<SectionKey, boolean> = {
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
  allowWeeklyEmail: true,
};

async function getOrCreate(schoolId: number) {
  const [row] = await db
    .select()
    .from(schoolHeartbeatSettingsTable)
    .where(eq(schoolHeartbeatSettingsTable.schoolId, schoolId));
  if (row) return row;
  try {
    const [created] = await db
      .insert(schoolHeartbeatSettingsTable)
      .values({ schoolId })
      .returning();
    return created;
  } catch {
    const [row2] = await db
      .select()
      .from(schoolHeartbeatSettingsTable)
      .where(eq(schoolHeartbeatSettingsTable.schoolId, schoolId));
    return row2;
  }
}

async function isAdminOrSuperUser(staffId: number | undefined): Promise<boolean> {
  if (!staffId) return false;
  const [s] = await db
    .select({
      active: staffTable.active,
      isAdmin: staffTable.isAdmin,
      isSuperUser: staffTable.isSuperUser,
    })
    .from(staffTable)
    .where(eq(staffTable.id, staffId));
  if (!s || !s.active) return false;
  return Boolean(s.isAdmin) || Boolean(s.isSuperUser);
}

// Both GET and PUT are restricted to admin / SuperUser. These flags are a
// school-wide policy surface — non-editor staff have no need to read them
// (and the tile that surfaces them is hidden from non-admins client-side
// anyway).
router.get("/heartbeat-settings", async (req, res): Promise<void> => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const allowed = await isAdminOrSuperUser(req.staffId);
  if (!allowed) {
    res
      .status(403)
      .json({ error: "Only an admin or SuperUser may view parent portal sections" });
    return;
  }
  const row = await getOrCreate(schoolId);
  res.json(row);
});

router.put("/heartbeat-settings", async (req, res): Promise<void> => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  const allowed = await isAdminOrSuperUser(req.staffId);
  if (!allowed) {
    res
      .status(403)
      .json({ error: "Only an admin or SuperUser may change parent portal sections" });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const updates: Partial<typeof schoolHeartbeatSettingsTable.$inferInsert> = {};
  for (const k of SECTION_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(body, k)) continue;
    const v = body[k];
    if (typeof v !== "boolean") {
      res.status(400).json({ error: `${k} must be a boolean` });
      return;
    }
    (updates as Record<string, unknown>)[k] = v;
  }

  const current = await getOrCreate(schoolId);
  if (Object.keys(updates).length === 0) {
    res.json(current);
    return;
  }

  const [updated] = await db
    .update(schoolHeartbeatSettingsTable)
    .set(updates)
    .where(
      and(
        eq(schoolHeartbeatSettingsTable.id, current.id),
        eq(schoolHeartbeatSettingsTable.schoolId, schoolId),
      ),
    )
    .returning();
  res.json(updated);
});

export const HEARTBEAT_SECTION_DEFAULTS = SECTION_DEFAULTS;
export default router;
