import { Router, type IRouter } from "express";
import { tardies, getNextTardyId, type Tardy } from "../data/tardies";

const router: IRouter = Router();

router.get("/tardies", (_req, res) => {
  res.json(tardies);
});

router.post("/tardies", (req, res) => {
  const {
    studentId,
    teacherName,
    period,
    reason,
    entryType,
    checkInWith,
  } = req.body ?? {};

  if (
    typeof studentId !== "string" ||
    typeof teacherName !== "string" ||
    typeof period !== "string"
  ) {
    res.status(400).json({
      error: "studentId, teacherName, and period are required",
    });
    return;
  }

  const type: "tardy" | "checkin" = entryType === "checkin" ? "checkin" : "tardy";

  if (type === "checkin" && (typeof checkInWith !== "string" || !checkInWith)) {
    res
      .status(400)
      .json({ error: "checkInWith is required for check-in entries" });
    return;
  }

  const tardy: Tardy = {
    id: getNextTardyId(),
    studentId,
    teacherName,
    period,
    reason: typeof reason === "string" ? reason : "",
    entryType: type,
    checkInWith: type === "checkin" ? (checkInWith as string) : null,
    createdAt: new Date().toISOString(),
  };

  tardies.push(tardy);
  res.status(201).json(tardy);
});

export default router;
