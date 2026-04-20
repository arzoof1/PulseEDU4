import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { db, districtIntegrationsTable, staffTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  SUPPORTED_SIS_PROVIDERS,
  SUPPORTED_SSO_PROVIDERS,
  getRosterAdapter,
  type SisProviderId,
  type SsoProviderId,
} from "@workspace/sis-adapters";

const router: IRouter = Router();

type StaffRow = typeof staffTable.$inferSelect;

async function loadStaff(req: Request): Promise<StaffRow | null> {
  const id = req.session.staffId;
  if (!id) return null;
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  return s && s.active ? s : null;
}

function requireAdmin() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const staff = await loadStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    if (!staff.isAdmin) {
      res.status(403).json({ error: "Admin only" });
      return;
    }
    next();
  };
}

async function getOrCreateRow() {
  // Race-safe: the unique index on school_name lets us upsert idempotently.
  await db
    .insert(districtIntegrationsTable)
    .values({ schoolName: "default" })
    .onConflictDoNothing({ target: districtIntegrationsTable.schoolName });
  const [row] = await db
    .select()
    .from(districtIntegrationsTable)
    .where(eq(districtIntegrationsTable.schoolName, "default"));
  return row;
}

// Read the active integration config + the list of providers the app can
// switch between. Used by the admin Settings screen to render dropdowns.
router.get("/district-integrations", requireAdmin(), async (_req, res) => {
  const row = await getOrCreateRow();
  res.json({
    config: row,
    supportedSisProviders: SUPPORTED_SIS_PROVIDERS,
    supportedSsoProviders: SUPPORTED_SSO_PROVIDERS,
  });
});

router.put("/district-integrations", requireAdmin(), async (req, res) => {
  const sisProvider = req.body?.sisProvider as string | undefined;
  const ssoProvider = req.body?.ssoProvider as string | undefined;
  const sisConfig = req.body?.sisConfig as Record<string, unknown> | undefined;
  const ssoConfig = req.body?.ssoConfig as Record<string, unknown> | undefined;

  if (
    sisProvider !== undefined &&
    !SUPPORTED_SIS_PROVIDERS.includes(sisProvider as SisProviderId)
  ) {
    res.status(400).json({ error: `Unsupported SIS provider: ${sisProvider}` });
    return;
  }
  if (
    ssoProvider !== undefined &&
    !SUPPORTED_SSO_PROVIDERS.includes(ssoProvider as SsoProviderId)
  ) {
    res.status(400).json({ error: `Unsupported SSO provider: ${ssoProvider}` });
    return;
  }

  const row = await getOrCreateRow();
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (sisProvider !== undefined) patch.sisProvider = sisProvider;
  if (ssoProvider !== undefined) patch.ssoProvider = ssoProvider;
  if (sisConfig !== undefined) patch.sisConfig = sisConfig;
  if (ssoConfig !== undefined) patch.ssoConfig = ssoConfig;

  await db
    .update(districtIntegrationsTable)
    .set(patch)
    .where(eq(districtIntegrationsTable.id, row.id));

  const [updated] = await db
    .select()
    .from(districtIntegrationsTable)
    .where(eq(districtIntegrationsTable.id, row.id));
  res.json({ ok: true, config: updated });
});

// Smoke-test the configured SIS adapter — does it have credentials, can it
// initialize? Real list/sync calls will land in a follow-up endpoint.
router.post("/district-integrations/sis-ping", requireAdmin(), async (_req, res) => {
  const row = await getOrCreateRow();
  const adapter = getRosterAdapter(
    row.sisProvider as SisProviderId,
    row.sisConfig ?? null,
  );
  if (!adapter) {
    res.json({ ok: false, message: "No SIS provider selected." });
    return;
  }
  try {
    const result = await adapter.ping();
    res.json(result);
  } catch (err) {
    res.json({
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

export default router;
