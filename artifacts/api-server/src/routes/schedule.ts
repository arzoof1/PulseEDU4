import { Router, type IRouter } from "express";
import { periodRoster } from "../data/schedule";

const router: IRouter = Router();

router.get("/schedule", (_req, res) => {
  res.json({ periodRoster });
});

export default router;
