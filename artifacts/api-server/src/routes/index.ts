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
import accommodationsAdminRouter from "./accommodationsAdmin";
import schoolSettingsRouter from "./schoolSettings";
import locationsRouter from "./locations";
import staffDefaultsRouter from "./staffDefaults";
import locationAllowedDestinationsRouter from "./locationAllowedDestinations";
import kioskRouter from "./kiosk";
import authRouter from "./auth";

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
router.use(accommodationsAdminRouter);
router.use(schoolSettingsRouter);
router.use(locationsRouter);
router.use(staffDefaultsRouter);
router.use(locationAllowedDestinationsRouter);
router.use(kioskRouter);
router.use(authRouter);

export default router;
