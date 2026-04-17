import { Router, type IRouter } from "express";
import healthRouter from "./health";
import studentsRouter from "./students";

const router: IRouter = Router();

router.use(healthRouter);
router.use(studentsRouter);

export default router;
