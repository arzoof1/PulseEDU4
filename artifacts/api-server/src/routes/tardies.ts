import { Router, type IRouter } from "express";
import { tardies, getNextTardyId, type Tardy } from "../data/tardies";

const router: IRouter = Router();

router.get("/tardies", (_req, res) => {
  res.json(tardies);
});

router.post("/tardies", (req, res) => {
  const { studentId, teacherName, period, reason } = req.body ?? {};

  if (
    typeof studentId !== "string" ||
    typeof teacherName !== "string" ||
    typeof period !== "string" ||
    typeof reason !== "string"
  ) {
    res.status(400).json({
      error: "studentId, teacherName, period, and reason are required",
    });
    return;
  }

  const tardy: Tardy = {
    id: getNextTardyId(),
    studentId,
    teacherName,
    period,
    reason,
    createdAt: new Date().toISOString(),
  };

  tardies.push(tardy);
  res.status(201).json(tardy);
});

export default router;
