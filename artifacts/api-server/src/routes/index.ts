import { Router, type IRouter } from "express";
import healthRouter from "./health";
import studentsRouter from "./students";
import hallPassesRouter from "./hallPasses";
import tardiesRouter from "./tardies";
import pbisRouter from "./pbis";
import supportNotesRouter from "./supportNotes";
import emailRouter from "./email";
import scheduleRouter from "./schedule";

const router: IRouter = Router();

router.use(healthRouter);
router.use(studentsRouter);
router.use(hallPassesRouter);
router.use(tardiesRouter);
router.use(pbisRouter);
router.use(supportNotesRouter);
router.use(emailRouter);
router.use(scheduleRouter);

export default router;
