import { Router, type IRouter } from "express";
import { students } from "../data/students";

const router: IRouter = Router();

router.get("/students", (_req, res) => {
  res.json(students);
});

export default router;
