// Demo heartbeat admin router — exposes a manual "fire one now" endpoint
// backing the small button on the houses signage page. Gated on
// isDemoHeartbeatEnabled() (defaults ON in dev, OFF in prod) so it's a
// no-op for real tenants.

import { Router, type IRouter, type Request, type Response } from "express";
import { runDemoHeartbeatTick, isDemoHeartbeatEnabled } from "../cron/demoHeartbeat.js";

const router: IRouter = Router();

router.post("/demo-heartbeat/fire", async (req: Request, res: Response) => {
  if (!isDemoHeartbeatEnabled()) {
    res.status(404).json({ error: "demo mode disabled" });
    return;
  }
  try {
    const result = await runDemoHeartbeatTick({ force: true });
    req.log.info({ result }, "demo heartbeat force-fired");
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "demo heartbeat force fire failed");
    res.status(500).json({ error: "fire failed" });
  }
});

export default router;
