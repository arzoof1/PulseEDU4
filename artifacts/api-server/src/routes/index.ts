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
import reportsRouter from "./reports";
import listsAdminRouter from "./listsAdmin";
import interventionsRouter from "./interventions";
import tier2Router from "./tier2";
import tier3Router from "./tier3";
import tier3StrategiesRouter from "./tier3Strategies";
import interventionsBellRouter from "./interventionsBell";
import interventionHistoryRouter from "./interventionHistory";
import emailPreviewRouter from "./emailPreview";
import pbisGoalsRouter from "./pbisGoals";
import pbisMilestonesRouter from "./pbisMilestones";
import pulloutsRouter from "./pullouts";
import digestRouter from "./digest";
import adminStaffRouter from "./adminStaff";
import parentEmailRouter from "./parentEmail";
import pulloutReasonsRouter from "./pulloutReasons";
import pulloutNoteTemplatesRouter from "./pulloutNoteTemplates";
import polarityPairsRouter from "./polarityPairs";
import teacherAllowlistRouter from "./teacherAllowlist";
import studentHallPassLimitsRouter from "./studentHallPassLimits";
import customRolesRouter from "./customRoles";
import sectionLookupRouter from "./sectionLookup";
import bellSchedulesRouter from "./bellSchedules";
import issRosterRouter from "./issRoster";
import issAttendanceRouter from "./issAttendance";
import tenancyRouter from "./tenancy";
import storageRouter from "./storage";
import classroomStoreRouter from "./classroomStore";
import schoolStoreRouter from "./schoolStore";
import mtssPlansRouter from "./mtssPlans";
import mtssReportsRouter from "./mtssReports";
import teacherRosterRouter from "./teacherRoster";
import parentAuthRouter from "./parentAuth";
import parentInvitesRouter from "./parentInvites";
import parentPreviewRouter from "./parentPreview";
import staffPreviewRouter from "./staffPreview";
import parentSnapshotRouter from "./parentSnapshot";
import schoolBrandingRouter from "./schoolBranding";
import pulseRouter from "./pulse";
import housesRouter from "./houses";
import dataImportsRouter from "./dataImports";
import studentFlagsRouter from "./studentFlags";
import studentRetentionsRouter from "./studentRetentions";
import trustedAdultLinksRouter from "./trustedAdultLinks";
import insightsRouter from "./insights";
import myWatchlistRouter from "./myWatchlist";
import heartbeatSettingsRouter from "./heartbeatSettings";
import parentHeartbeatPrefsRouter from "./parentHeartbeatPrefs";
import parentSnapshotPdfRouter from "./parentSnapshotPdf";
import displaysRouter from "./displays";
import displayOverridesRouter from "./displayOverrides";
import uiPrefsRouter from "./uiPrefs";
import schoolPlansRouter from "./schoolPlans";
import tierPresetsRouter from "./tierPresets";
import safetyPlansRouter from "./safetyPlans";
import adminHubRouter from "./adminHub";
import disciplineReasonsRouter from "./disciplineReasons";
import separationsRouter from "./separations";
import schoolClosedDaysRouter from "./schoolClosedDays";
import studentReportPdfRouter from "./studentReportPdf";
import studentFinderRouter from "./studentFinder";
import staffDirectoryRouter from "./staffDirectory";
import hallPassQueueRouter from "./hallPassQueue";
import spotlightRouter from "./spotlight";
import watchlistRouter from "./watchlist";
import onboardingRouter from "./onboarding";
import pickupRouter from "./pickup";
import astRouter from "./ast";
import featureLicensingRouter from "./featureLicensing";
import {
  requireFeature,
  requireFeatureAllowingSignageSchool,
  requireFeatureForParent,
} from "../lib/featureLicensing";

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
router.use(reportsRouter);
router.use(listsAdminRouter);
router.use(interventionsRouter);
router.use(tier2Router);
router.use(tier3Router);
router.use(tier3StrategiesRouter);
router.use(interventionsBellRouter);
router.use(interventionHistoryRouter);
router.use(emailPreviewRouter);
router.use(pbisGoalsRouter);
router.use(pbisMilestonesRouter);
router.use(pulloutsRouter);
router.use(digestRouter);
router.use(adminStaffRouter);

// -----------------------------------------------------------------------------
// Feature licensing gates — MUST be registered BEFORE the gated routers.
// Express runs matching middleware in registration order; if the actual
// router is registered first it handles the request and the gate never
// fires. So we mount gates here, ahead of the parent + AST routers
// below.
//
// Mount paths are relative to the parent router's mount point (which
// is `/api` in app.ts) — do NOT include a leading `/api`.
//
// Staff-facing gates use `requireFeature` (reads `req.schoolId` populated
// by staff-auth middleware in app.ts). Parent-facing gates use
// `requireFeatureForParent` (resolves schoolId from `req.parentId` →
// parents.school_id) because parent sessions don't carry `req.schoolId`.
router.use("/ast", requireFeature("ast"));
router.use("/admin/parent-invites", requireFeature("parentPortal"));
router.use("/admin/parent-preview", requireFeature("parentPortal"));

// Additional staff-licensed surfaces. Sub-path mounts (rather than the
// router's whole prefix) so adjacent unauthenticated kiosk routes
// (e.g. `/displays/public/*`) keep working for signage TVs.
router.use("/mtss-plans", requireFeature("mtssPlans"));
router.use("/mtss-reports", requireFeature("mtssPlans"));
router.use("/iss-roster", requireFeature("issDashboard"));
router.use("/iss-attendance", requireFeature("issDashboard"));
router.use("/displays/playlists", requireFeature("displays"));
router.use("/displays/calendar", requireFeature("displays"));

// `/houses` doubles as a signage kiosk endpoint that authenticates via
// `?schoolId=N`. Use the signage-aware variant so unauthenticated TV
// kiosks at licensed schools keep working while unlicensed schools are
// gated whether the caller is staff or signage.
router.use("/houses", requireFeatureAllowingSignageSchool("houses"));

// Parent-side runtime gates. Mounted BEFORE the parent runtime routers
// (parentSnapshotRouter / parentHeartbeatPrefsRouter / parentSnapshotPdfRouter)
// so a school's parentPortal license being revoked blocks already-
// logged-in parents from hitting the snapshot, PDF, and prefs APIs.
// `requireFeatureForParent` resolves school context from `req.parentId`
// since parent sessions don't have `req.schoolId`. Returns 403
// `parent_portal_disabled` which the client maps to a friendly screen.
router.use("/parent/snapshot", requireFeatureForParent("parentPortal"));
router.use("/parent/snapshot.pdf", requireFeatureForParent("parentPortal"));
router.use(
  "/parent/heartbeat-prefs",
  requireFeatureForParent("parentPortal"),
);

router.use(parentEmailRouter);
router.use(pulloutReasonsRouter);
router.use(pulloutNoteTemplatesRouter);
router.use(polarityPairsRouter);
router.use(teacherAllowlistRouter);
router.use(studentHallPassLimitsRouter);
router.use(customRolesRouter);
router.use(sectionLookupRouter);
router.use(bellSchedulesRouter);
router.use(issRosterRouter);
router.use(issAttendanceRouter);
router.use(tenancyRouter);
router.use(storageRouter);
router.use(classroomStoreRouter);
router.use(schoolStoreRouter);
router.use(mtssPlansRouter);
router.use(mtssReportsRouter);
router.use(teacherRosterRouter);
router.use(parentAuthRouter);
router.use(parentInvitesRouter);
router.use(parentPreviewRouter);
router.use(staffPreviewRouter);
router.use(parentSnapshotRouter);
router.use(schoolBrandingRouter);
router.use(pulseRouter);
router.use(housesRouter);
router.use(dataImportsRouter);
router.use(studentFlagsRouter);
router.use(studentRetentionsRouter);
router.use(trustedAdultLinksRouter);
router.use(insightsRouter);
router.use(myWatchlistRouter);
router.use(uiPrefsRouter);
router.use(heartbeatSettingsRouter);
router.use(parentHeartbeatPrefsRouter);
router.use(parentSnapshotPdfRouter);
router.use(displaysRouter);
router.use(displayOverridesRouter);
router.use(schoolPlansRouter);
router.use(tierPresetsRouter);
router.use(safetyPlansRouter);
router.use(adminHubRouter);
router.use(disciplineReasonsRouter);
router.use(separationsRouter);
router.use(schoolClosedDaysRouter);
router.use(studentReportPdfRouter);
router.use(studentFinderRouter);
router.use(staffDirectoryRouter);
router.use(hallPassQueueRouter);
router.use(spotlightRouter);
router.use(watchlistRouter);
router.use(onboardingRouter);
router.use(pickupRouter);
router.use(astRouter);
router.use(featureLicensingRouter);

export default router;
