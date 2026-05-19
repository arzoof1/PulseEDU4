import { Router, type IRouter, type Request } from "express";
import bcrypt from "bcryptjs";
import { db, staffTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { verifyAuthToken } from "../lib/authToken.js";
import { runDspParrottReseed } from "../lib/dspParrottReseed.js";
import { rebuildDspSections } from "../lib/rebuildDspSections.js";

// Hardcoded so this bootstrap can ONLY ever reset chris.clifford's password.
// No body, no params — calling it for anyone else is structurally impossible.
const BOOTSTRAP_TARGET_EMAIL = "chris.clifford@hcsb.k12.fl.us";
const BOOTSTRAP_NEW_PASSWORD = "PulseDemo!";

const router: IRouter = Router();

async function loadStaff(req: Request) {
  let id = req.staffId ?? null;
  if (!id) {
    const auth = req.headers.authorization;
    if (typeof auth === "string" && auth.startsWith("Bearer ")) {
      id = verifyAuthToken(auth.slice(7).trim());
    }
  }
  if (!id) return null;
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  return s && s.active ? s : null;
}

router.post("/full-reseed", async (req, res) => {
  const staff = await loadStaff(req);
  if (!staff) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  if (!staff.isSuperUser) {
    res.status(403).json({ error: "superuser_required" });
    return;
  }
  req.log.warn(
    { staffId: staff.id },
    "DSP Parrott full-reseed initiated (destructive)",
  );
  try {
    const result = await runDspParrottReseed();
    req.log.warn(
      { staffId: staff.id, summary: result.summary },
      "DSP Parrott full-reseed completed",
    );
    res.json({ ok: true, ...result });
  } catch (err) {
    req.log.error({ err }, "DSP Parrott full-reseed failed");
    res
      .status(500)
      .json({ error: "reseed_failed", message: (err as Error).message });
  }
});

// One-shot, NO-AUTH bootstrap endpoint. Does TWO things atomically so the
// operator does not have to log in to trigger the reseed:
//   1. Resets ONLY the hardcoded SuperUser's password (so they can log in
//      after the data is wiped + re-seeded).
//   2. Runs the destructive DSP Parrott reseed.
// Both endpoints are removed in the next deploy.
router.post("/bootstrap-password", async (req, res) => {
  req.log.warn(
    { email: BOOTSTRAP_TARGET_EMAIL },
    "bootstrap-password + reseed initiated (destructive, no-auth)",
  );
  try {
    const passwordHash = await bcrypt.hash(BOOTSTRAP_NEW_PASSWORD, 10);
    const updated = await db
      .update(staffTable)
      .set({ passwordHash })
      .where(
        and(
          eq(staffTable.email, BOOTSTRAP_TARGET_EMAIL),
          eq(staffTable.isSuperUser, true),
        ),
      )
      .returning({ id: staffTable.id, email: staffTable.email });
    if (updated.length === 0) {
      res.status(404).json({ error: "target_not_found" });
      return;
    }
    const result = await runDspParrottReseed();
    req.log.warn(
      { summary: result.summary },
      "bootstrap-password + reseed completed",
    );
    res.json({
      ok: true,
      email: BOOTSTRAP_TARGET_EMAIL,
      tempPassword: BOOTSTRAP_NEW_PASSWORD,
      ...result,
    });
  } catch (err) {
    req.log.error({ err }, "bootstrap-password + reseed failed");
    res
      .status(500)
      .json({ error: "bootstrap_failed", message: (err as Error).message });
  }
});

// One-shot NO-AUTH endpoint: rebuilds teachers + 7-period schedule and fixes
// ESE/504 mutex. Non-destructive to students/FAST/accommodations. Removed in
// the next deploy.
router.post("/rebuild-sections", async (req, res) => {
  req.log.warn("rebuild-sections initiated (no-auth)");
  try {
    const result = await rebuildDspSections();
    req.log.warn({ result }, "rebuild-sections completed");
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "rebuild-sections failed");
    res
      .status(500)
      .json({ error: "rebuild_failed", message: (err as Error).message });
  }
});

export default router;
