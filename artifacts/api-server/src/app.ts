import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import router from "./routes";
import { logger } from "./lib/logger";
import { verifyAuthToken } from "./lib/authToken";
import { db, staffTable, schoolsTable, districtsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

declare global {
  namespace Express {
    interface Request {
      staffId?: number | null;
      // Parent identity for HeartBEAT parent-portal routes. Resolved by a
      // router-level middleware inside parentAuth.ts (NOT by the global
      // staff middleware below) so the two identity systems stay isolated.
      parentId?: number | null;
      // Student identity for the student HeartBEAT portal (ClassLink SSO).
      // The NUMERIC students.id row id (never the FLEID). Resolved by a
      // router-level middleware inside studentAuth.ts / studentPortal.ts,
      // kept isolated from the staff + parent identity systems.
      studentId?: number | null;
      // The active school for this request. For most staff this is their
      // home school (staff.school_id). SuperUsers can override per-session
      // via POST /api/tenancy/switch-school. null when unauthenticated.
      schoolId?: number | null;
      // The signed-in staff's HOME school (never overridden). Used by the
      // top bar to show "Acting as: <school>" vs "Home: <school>" for
      // SuperUsers.
      homeSchoolId?: number | null;
      // True when the active schoolId was set by a SuperUser switch.
      isSchoolSwitched?: boolean;
      // When the signed-in staff is currently using the "Preview as
      // another staff" QA tool, req.staffId is swapped to the target's
      // id and these two fields surface the original (impersonator)
      // staff so /auth/me can render a banner. Set in the global
      // request middleware below from staff.preview_target_staff_id.
      impersonatorStaffId?: number | null;
      impersonatorDisplayName?: string | null;
    }
  }
}

declare module "express-session" {
  interface SessionData {
    activeSchoolId?: number;
    // Set when a student signs into their personal HeartBEAT portal via
    // ClassLink SSO (or the guarded demo login). NUMERIC students.id.
    studentId?: number;
    // CSRF state for the in-flight student ClassLink SSO authorize→callback
    // round-trip. Set on /student-auth/sso/start, verified + cleared on
    // /student-auth/sso/callback.
    studentSsoState?: string;
    // The school the student began the SSO flow for. Carried across the
    // authorize→callback round-trip so the callback can scope the roster
    // lookup to a SINGLE tenant (identifiers are not globally unique).
    studentSsoSchoolId?: number;
  }
}

const app: Express = express();

// Required so express-session honors X-Forwarded-Proto from the Replit proxy
// (TLS terminates upstream, so without this `secure: true` cookies are dropped).
app.set("trust proxy", 1);

const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  throw new Error("SESSION_SECRET environment variable is required");
}
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL environment variable is required");
}

const PgSession = connectPgSimple(session);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
// JSON body limit: bumped from the 100KB default so the Data Imports
// route can accept CSV text in the request body. The frontend caps file
// uploads at 10MB; 15MB gives headroom for JSON-quoting overhead.
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));

app.use(
  session({
    store: new PgSession({
      conObject: { connectionString: databaseUrl },
      tableName: "user_sessions",
    }),
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      // Use SameSite=Lax so the cookie works for same-site requests (the
      // common case in both dev and prod). SameSite=None requires the browser
      // to allow third-party cookies, which is increasingly blocked by
      // default and was breaking the session inside the Replit preview iframe.
      sameSite: "lax",
      secure: true,
      maxAge: 1000 * 60 * 60 * 24 * 14,
    },
    name: "pulseed.sid",
  }),
);

// Resolve the authenticated staff id per request from EITHER the session
// cookie OR a server-issued Bearer token (HMAC-signed with SESSION_SECRET).
// The bearer fallback is needed inside the Replit preview iframe where the
// session cookie is often blocked. We DO NOT write to req.session here, so:
//   - logout (which destroys the session) stays authoritative for cookie auth
//   - the session store sees no extra writes/churn
//   - bearer-derived identity never gets persisted with a different sid
// Routes should read req.staffId instead of req.session.staffId.
app.use(async (req, _res, next) => {
  let sid: number | null = req.session.staffId ?? null;
  if (!sid) {
    const auth = req.headers.authorization;
    if (typeof auth === "string" && auth.startsWith("Bearer ")) {
      sid = verifyAuthToken(auth.slice(7).trim());
    }
  }
  // "Preview as another staff" swap. Backed by staff.preview_target_staff_id
  // (a DB column) rather than the session, because session cookies are
  // blocked inside the Replit preview iframe — bearer-only requests would
  // otherwise lose the impersonation immediately. Strategy: resolve the
  // ORIGINAL staff first; if it's an Admin/DA/SU and they have a valid
  // preview pointer to a non-privileged active staff, swap sid to the
  // target and remember the impersonator for /auth/me's banner.
  req.impersonatorStaffId = null;
  req.impersonatorDisplayName = null;
  if (sid) {
    try {
      const [orig] = await db
        .select({
          id: staffTable.id,
          displayName: staffTable.displayName,
          active: staffTable.active,
          isAdmin: staffTable.isAdmin,
          isDistrictAdmin: staffTable.isDistrictAdmin,
          isSuperUser: staffTable.isSuperUser,
          previewTargetStaffId: staffTable.previewTargetStaffId,
        })
        .from(staffTable)
        .where(eq(staffTable.id, sid));
      if (orig && orig.previewTargetStaffId) {
        const stillEligible =
          orig.active &&
          (orig.isAdmin || orig.isDistrictAdmin || orig.isSuperUser);
        if (stillEligible) {
          const [target] = await db
            .select({
              id: staffTable.id,
              active: staffTable.active,
              isSuperUser: staffTable.isSuperUser,
              isDistrictAdmin: staffTable.isDistrictAdmin,
            })
            .from(staffTable)
            .where(eq(staffTable.id, orig.previewTargetStaffId));
          if (
            target &&
            target.active &&
            !target.isSuperUser &&
            !target.isDistrictAdmin
          ) {
            req.impersonatorStaffId = orig.id;
            req.impersonatorDisplayName = orig.displayName;
            sid = target.id;
          } else {
            // Stale pointer: target deleted, deactivated, or promoted
            // to a privileged role. Clear it so future requests stop
            // attempting the swap.
            await db
              .update(staffTable)
              .set({ previewTargetStaffId: null })
              .where(eq(staffTable.id, orig.id));
          }
        } else {
          // Original actor lost privilege (deactivated or role
          // changed) while a pointer was still set. Clear it so the
          // pointer can't strand them in an unreachable preview.
          await db
            .update(staffTable)
            .set({ previewTargetStaffId: null })
            .where(eq(staffTable.id, orig.id));
        }
      }
    } catch (err) {
      logger.warn({ err }, "preview-as middleware lookup failed");
    }
  }
  req.staffId = sid;

  // Resolve the active school for this request. For non-SuperUsers it is
  // strictly the staff's home school (session override is ignored). For
  // SuperUsers, session.activeSchoolId wins; otherwise fall back to the
  // home school. This single source of truth lets every route just read
  // req.schoolId without re-running the resolution.
  req.schoolId = null;
  req.homeSchoolId = null;
  req.isSchoolSwitched = false;
  if (sid) {
    try {
      const [staff] = await db
        .select({
          schoolId: staffTable.schoolId,
          activeSchoolOverride: staffTable.activeSchoolOverride,
          isSuperUser: staffTable.isSuperUser,
          active: staffTable.active,
        })
        .from(staffTable)
        .where(eq(staffTable.id, sid));
      if (staff && staff.active) {
        req.homeSchoolId = staff.schoolId;
        // Persisted on the staff row (not the session) so bearer-token
        // requests inside the Replit preview iframe — where session cookies
        // are blocked — keep the SuperUser's switch active across reloads.
        const override = staff.activeSchoolOverride ?? null;
        // Confirm the staff's home school AND its district are still
        // active before honoring any school context. Soft-deactivated
        // (active=false) schools or districts must not be able to act
        // as the request's tenant; otherwise existing sessions keep
        // reading/writing under a "retired" tenant. We let the request
        // through with req.schoolId=null; downstream route guards
        // already 4xx on missing school.
        const [homeSchoolActive] = await db
          .select({
            schoolActive: schoolsTable.active,
            districtActive: districtsTable.active,
          })
          .from(schoolsTable)
          .leftJoin(
            districtsTable,
            eq(districtsTable.id, schoolsTable.districtId),
          )
          .where(eq(schoolsTable.id, staff.schoolId));
        if (
          !homeSchoolActive ||
          !homeSchoolActive.schoolActive ||
          !homeSchoolActive.districtActive
        ) {
          req.schoolId = null;
          next();
          return;
        }
        if (staff.isSuperUser && override && override !== staff.schoolId) {
          // D6 defense-in-depth: validate the override still points at an
          // active school. Phase 5 District Switcher: when
          // ALLOW_CROSS_DISTRICT_SUPERUSER=1 a cross-district override is
          // permitted (the operator has opted into the cross-district
          // control tier). Without the flag we still hard-refuse cross-
          // district overrides — even a stale row in activeSchoolOverride
          // from before the gate landed must not silently leak data.
          const crossDistrict =
            process.env.ALLOW_CROSS_DISTRICT_SUPERUSER === "1";
          // Architect-flagged (Phase 5): previously this only validated
          // the override school was active, not its district. Mirror the
          // home-school check above and require districts.active=true on
          // the override target before honoring it.
          const [overrideSchool] = await db
            .select({
              districtId: schoolsTable.districtId,
              schoolActive: schoolsTable.active,
              districtActive: districtsTable.active,
            })
            .from(schoolsTable)
            .leftJoin(
              districtsTable,
              eq(districtsTable.id, schoolsTable.districtId),
            )
            .where(eq(schoolsTable.id, override));
          const [homeSchool] = await db
            .select({ districtId: schoolsTable.districtId })
            .from(schoolsTable)
            .where(eq(schoolsTable.id, staff.schoolId));
          const sameDistrict =
            overrideSchool &&
            homeSchool &&
            overrideSchool.districtId === homeSchool.districtId;
          if (
            overrideSchool &&
            overrideSchool.schoolActive &&
            overrideSchool.districtActive &&
            (sameDistrict || crossDistrict)
          ) {
            req.schoolId = override;
            req.isSchoolSwitched = true;
          } else {
            // Stale, cross-district (when gate off), or inactive override
            // — fall back to home school. (Home school is already known
            // active here.)
            req.schoolId = staff.schoolId;
          }
        } else {
          req.schoolId = staff.schoolId;
        }
      }
    } catch (err) {
      logger.warn({ err }, "schoolId middleware lookup failed");
    }
  }
  next();
});

app.use("/api", router);

// -----------------------------------------------------------------------------
// 5xx error surface. Before this middleware, an uncaught throw inside a route
// would be swallowed by Express's default handler — a 500 with no body and
// nothing in the structured logger. This catches anything that bubbles out,
// logs it with request context (req.log already has reqId + schoolId from
// pino-http), and returns a clean JSON 500 to the client. Stack traces are
// only included in non-production responses so they don't leak to the parent
// portal or a public preview.
// -----------------------------------------------------------------------------
app.use(
  (
    err: unknown,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const e = err as { message?: string; stack?: string; status?: number };
    const status = typeof e?.status === "number" ? e.status : 500;
    const reqAny = req as unknown as { log?: typeof logger };
    (reqAny.log ?? logger).error(
      {
        err,
        path: req.path,
        method: req.method,
        schoolId: (req as { schoolId?: number | null }).schoolId ?? null,
        staffId: (req as { staffId?: number | null }).staffId ?? null,
        status,
      },
      "unhandled route error",
    );
    const body: Record<string, unknown> = {
      error: e?.message ?? "Internal server error",
    };
    if (process.env.NODE_ENV !== "production" && e?.stack) {
      body["stack"] = e.stack;
    }
    res.status(status).json(body);
  },
);

export default app;
