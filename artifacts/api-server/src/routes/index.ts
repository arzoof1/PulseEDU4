import { Router, type IRouter } from "express";
import healthRouter from "./health";
import studentsRouter from "./students";
import hallPassesRouter from "./hallPasses";
import tardiesRouter from "./tardies";
import pbisRouter from "./pbis";
import supportNotesRouter from "./supportNotes";
import emailRouter from "./email";
import scheduleRouter from "./schedule";
import accommodationLogsRouter from "./accommodationLogs";
import schoolSettingsRouter from "./schoolSettings";
import locationsRouter from "./locations";
import staffDefaultsRouter from "./staffDefaults";

const router: IRouter = Router();

router.use(healthRouter);
router.use(studentsRouter);
router.use(hallPassesRouter);
router.use(tardiesRouter);
router.use(pbisRouter);
router.use(supportNotesRouter);
router.use(emailRouter);
router.use(scheduleRouter);
router.use(accommodationLogsRouter);
router.use(schoolSettingsRouter);
router.use(locationsRouter);
router.use(staffDefaultsRouter);

export default router;
