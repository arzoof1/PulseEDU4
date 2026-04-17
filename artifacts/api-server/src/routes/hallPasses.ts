import { Router, type IRouter } from "express";
import {
  hallPasses,
  getNextHallPassId,
  type HallPass,
} from "../data/hallPasses";
import { config } from "../data/config";

const router: IRouter = Router();

router.get("/hall-passes", (_req, res) => {
  res.json(hallPasses);
});

router.post("/hall-passes", (req, res) => {
  const { studentId, destination, originRoom } = req.body ?? {};

  if (
    typeof studentId !== "string" ||
    typeof destination !== "string" ||
    typeof originRoom !== "string"
  ) {
    res
      .status(400)
      .json({ error: "studentId, destination, and originRoom are required" });
    return;
  }

  const pass: HallPass = {
    id: getNextHallPassId(),
    studentId,
    destination,
    originRoom,
    status: "active",
    createdAt: new Date().toISOString(),
    maxDurationMinutes: config.defaultHallPassDurationMinutes,
  };

  hallPasses.push(pass);
  res.status(201).json(pass);
});

router.patch("/hall-passes/:id/end", (req, res) => {
  const id = Number(req.params.id);
  const pass = hallPasses.find((p) => p.id === id);

  if (!pass) {
    res.status(404).json({ error: "Hall pass not found" });
    return;
  }

  pass.status = "ended";
  res.json(pass);
});

export default router;
