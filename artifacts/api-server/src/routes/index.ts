import { Router, type IRouter } from "express";
import healthRouter from "./health";
import studentsRouter from "./students";
import hallPassesRouter from "./hallPasses";
import tardiesRouter from "./tardies";

const router: IRouter = Router();

router.use(healthRouter);
router.use(studentsRouter);
router.use(hallPassesRouter);
router.use(tardiesRouter);

export default router;
