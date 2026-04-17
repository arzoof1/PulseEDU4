import { Router, type IRouter } from "express";
import {
  accommodationLogs,
  getNextAccommodationLogId,
  type AccommodationLog,
} from "../data/accommodationLogs";

const router: IRouter = Router();

router.get("/accommodation-logs", (req, res) => {
  const { studentId } = req.query;
  if (typeof studentId === "string" && studentId) {
    res.json(accommodationLogs.filter((l) => l.studentId === studentId));
    return;
  }
  res.json(accommodationLogs);
});

router.post("/accommodation-logs", (req, res) => {
  const { studentId, accommodation, period, staffName } = req.body ?? {};

  if (typeof studentId !== "string" || !studentId) {
    res.status(400).json({ error: "studentId is required" });
    return;
  }
  if (typeof accommodation !== "string" || !accommodation) {
    res.status(400).json({ error: "accommodation is required" });
    return;
  }

  const log: AccommodationLog = {
    id: getNextAccommodationLogId(),
    studentId,
    accommodation,
    period:
      typeof period === "number"
        ? period
        : typeof period === "string" && period
          ? Number(period)
          : null,
    staffName: typeof staffName === "string" ? staffName : "",
    createdAt: new Date().toISOString(),
  };

  accommodationLogs.push(log);
  res.status(201).json(log);
});

export default router;
