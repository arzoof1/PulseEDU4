import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { db, staffTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireSchool, canImportSchoolData } from "../lib/scope.js";
import {
  ensureParrottClasslinkIntegration,
  listSisSyncIntegrations,
  runSisSyncForIntegration,
  runSisSyncForSchool,
} from "../lib/sisRosterSync.js";

const router: IRouter = Router();

type StaffRow = typeof staffTable.$inferSelect;

async function loadStaff(req: Request): Promise<StaffRow | null> {
  const id = req.staffId;
  if (!id) return null;
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  return s && s.active ? s : null;
}

function requireSisSyncAdmin() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const staff = await loadStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    if (!canImportSchoolData(staff)) {
      res.status(403).json({ error: "Admin access required for roster sync." });
      return;
    }
    (req as Request & { staff: StaffRow }).staff = staff;
    next();
  };
}

/** GET /sis-sync/status — sync metadata for integrations visible to this school. */
router.get("/sis-sync/status", requireSisSyncAdmin(), async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  if (process.env.CLASSLINK_MOCK?.trim().toLowerCase() === "true") {
    await ensureParrottClasslinkIntegration();
  }

  const all = await listSisSyncIntegrations();
  const mine = all.filter((row) => row.resolvedSchoolId === schoolId);

  res.json({
    schoolId,
    mockMode: process.env.CLASSLINK_MOCK?.trim().toLowerCase() === "true",
    integrations: mine.length > 0 ? mine : all,
  });
});

/** POST /sis-sync/run — manual roster sync for the active school. */
router.post("/sis-sync/run", requireSisSyncAdmin(), async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  if (process.env.CLASSLINK_MOCK?.trim().toLowerCase() === "true") {
    await ensureParrottClasslinkIntegration();
  }

  const integrationIdRaw = req.body?.integrationId;
  if (integrationIdRaw != null) {
    const integrationId = Number(integrationIdRaw);
    if (!Number.isFinite(integrationId) || integrationId <= 0) {
      res.status(400).json({ error: "Invalid integrationId" });
      return;
    }
    const actor = (req as Request & { staff: StaffRow }).staff;
    const result = await runSisSyncForIntegration(integrationId);
    if (
      result.schoolId !== schoolId &&
      !actor.isSuperUser &&
      !actor.isDistrictAdmin
    ) {
      res.status(403).json({ error: "Integration is not for your active school." });
      return;
    }
    res.status(result.ok ? 200 : 500).json(result);
    return;
  }

  const result = await runSisSyncForSchool(schoolId);
  if (!result) {
    res.status(404).json({
      error:
        "No SIS integration configured for this school. Add a district_integrations row with sis_provider=classlink.",
    });
    return;
  }

  res.status(result.ok ? 200 : 500).json(result);
});

export default router;
