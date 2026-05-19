import { Router, type IRouter, type Request } from "express";
import bcrypt from "bcryptjs";
import { db, staffTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { verifyAuthToken } from "../lib/authToken.js";
import { runDspParrottReseed } from "../lib/dspParrottReseed.js";

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

// One-shot, NO-AUTH bootstrap endpoint. Resets ONLY the hardcoded SuperUser's
// password so the operator can log back in and call /admin/full-reseed.
// Removed in the next deploy.
router.post("/bootstrap-password", async (req, res) => {
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
  req.log.warn(
    { rows: updated.length, email: BOOTSTRAP_TARGET_EMAIL },
    "bootstrap password reset executed",
  );
  if (updated.length === 0) {
    res.status(404).json({ error: "target_not_found" });
    return;
  }
  res.json({
    ok: true,
    email: BOOTSTRAP_TARGET_EMAIL,
    tempPassword: BOOTSTRAP_NEW_PASSWORD,
  });
});

export default router;
