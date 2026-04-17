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
    notes,
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

  const type: "tardy" | "checkin" | "checkout" =
    entryType === "checkin"
      ? "checkin"
      : entryType === "checkout"
        ? "checkout"
        : "tardy";

  if (
    (type === "checkin" || type === "checkout") &&
    (typeof checkInWith !== "string" || !checkInWith)
  ) {
    res
      .status(400)
      .json({
        error: "checkInWith is required for check-in and check-out entries",
      });
    return;
  }

  const tardy: Tardy = {
    id: getNextTardyId(),
    studentId,
    teacherName,
    period,
    reason: typeof reason === "string" ? reason : "",
    entryType: type,
    checkInWith:
      type === "checkin" || type === "checkout"
        ? (checkInWith as string)
        : null,
    notes: typeof notes === "string" ? notes : "",
    createdAt: new Date().toISOString(),
  };

  tardies.push(tardy);
  res.status(201).json(tardy);
});

export default router;
