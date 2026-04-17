import { Router, type IRouter } from "express";
import { pbisEntries, getNextPbisId, type PbisEntry } from "../data/pbis";

const router: IRouter = Router();

router.get("/pbis", (_req, res) => {
  res.json(pbisEntries);
});

router.post("/pbis", (req, res) => {
  const { studentId, reason, points } = req.body ?? {};

  if (typeof studentId !== "string" || !studentId) {
    res.status(400).json({ error: "studentId is required" });
    return;
  }
  if (typeof reason !== "string" || !reason) {
    res.status(400).json({ error: "reason is required" });
    return;
  }
  const pts = Number(points);
  if (!Number.isFinite(pts)) {
    res.status(400).json({ error: "points must be a number" });
    return;
  }

  const entry: PbisEntry = {
    id: getNextPbisId(),
    studentId,
    reason,
    points: pts,
    createdAt: new Date().toISOString(),
  };

  pbisEntries.push(entry);
  res.status(201).json(entry);
});

export default router;
