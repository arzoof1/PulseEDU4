import express, { type Express, type RequestHandler } from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import router from "./routes";
import { corsMiddleware } from "./lib/corsConfig.js";
import { resolvePublicAppOrigin } from "./lib/publicAppUrl.js";
import { csrfProtectionMiddleware } from "./lib/csrf.js";
import { isStaffMfaEnabled } from "./lib/staffMfaSwitch.js";
import { isMfaRequiredForStaffCached } from "./lib/mfaPolicyCache.js";
import { mfaEnrollmentGate } from "./lib/mfaEnrollmentGate.js";
import { apiUsageAlertMiddleware } from "./lib/apiUsageMonitor.js";
import { resolveActiveSchoolId } from "./lib/tenantScope.js";
import { logger } from "./lib/logger";
import {
  isStaffBearerAuthEnabled,
  staffIdFromBearerToken,
} from "./lib/staffBearerAuth";
import { db, staffTable, schoolsTable, districtsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

declare global {
  namespace Express {
    interface Request {
      staffId?: number | null;
      // Set by the global auth middleware when this staff's role is required
      // by MFA policy but they have not enrolled. The mfaEnrollmentGate reads
      // it to block all non-enrollment routes. Fail-open: any resolution error
      // leaves it false (a transient DB blip must not wall the whole app).
      mfaEnrollmentRequired?: boolean;
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
    csrfToken?: string;
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
    // Epoch-ms of the staff's last successful privileged step-up reauth
    // (Section 1.15). Sensitive actions (bulk export, Safety Plan viewing)
    // require this to be within PRIVILEGED_REAUTH_WINDOW_MS. Set by
    // POST /api/auth/reauth; checked via hasFreshPrivilegedReauth().
    privilegedReauthAt?: number;
  }
}

const app: Express = express();
const isProduction = process.env.NODE_ENV === "production";

function csvEnv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function frameAncestors(): string[] {
  const configured = csvEnv("SECURITY_FRAME_ANCESTORS");
  if (configured.length > 0) return configured;

  const ancestors = ["'self'"];
  ancestors.push(resolvePublicAppOrigin());

  // Replit previews are iframe-based in development; keep that opt-in and
  // production-configurable instead of using X-Frame-Options DENY/SAMEORIGIN.
  if (!isProduction) {
    ancestors.push("http://localhost:5173", "http://localhost:5174");
    const replit = process.env.REPLIT_DEV_DOMAIN?.trim();
    if (replit) ancestors.push(`https://${replit}`);
  }

  return ancestors;
}

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
  helmet({
    // Development Vite/React tooling can require eval/inline assets. Keep CSP
    // strict in production and disabled locally to avoid breaking dev UX.
    contentSecurityPolicy: isProduction
      ? {
        useDefaults: true,
        directives: {
          "default-src": ["'self'"],
          "base-uri": ["'self'"],
          "object-src": ["'none'"],
          "frame-ancestors": frameAncestors(),
          "form-action": ["'self'"],
          "img-src": ["'self'", "data:", "blob:", "https:"],
          "media-src": ["'self'", "data:", "blob:", "https:"],
          "connect-src": ["'self'", ...csvEnv("CSP_CONNECT_SRC")],
          "script-src": ["'self'"],
          "style-src": ["'self'", "'unsafe-inline'"],
        },
      }
      : false,
    crossOriginEmbedderPolicy: false,
    // frame-ancestors is more precise than X-Frame-Options for this app's
    // preview/deployment needs; avoid emitting a conflicting legacy header.
    frameguard: false,
    hsts: isProduction
      ? {
        maxAge: 15552000,
        includeSubDomains: true,
      }
      : false,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  }),
);

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
app.use(corsMiddleware);

const defaultJsonParser = express.json({ limit: "256kb" });
const defaultUrlencodedParser = express.urlencoded({
  extended: true,
  limit: "64kb",
});
const importJsonParser = express.json({ limit: "15mb" });
const importUrlencodedParser = express.urlencoded({
  extended: true,
  limit: "15mb",
});

function skipDataImportRequests(parser: RequestHandler): RequestHandler {
  return (req, res, next) => {
    const path = req.originalUrl.split("?")[0] ?? "";
    if (path.startsWith("/api/data-imports")) {
      next();
      return;
    }
    parser(req, res, next);
  };
}

// Data import endpoints accept CSV text in JSON bodies. Keep the larger limit
// scoped to those routes; normal APIs use tighter defaults to reduce abuse.
app.use("/api/data-imports", importJsonParser, importUrlencodedParser);
app.use(skipDataImportRequests(defaultJsonParser));
app.use(skipDataImportRequests(defaultUrlencodedParser));

app.use(
  session({
    store: new PgSession({
      conObject: { connectionString: databaseUrl },
      tableName: "user_sessions",
      // Not in Drizzle schema (connect-pg-simple owns this table). Create on first use
      // so local / fresh DBs work without a separate migration step.
      createTableIfMissing: true,
      // Make the default cleanup behavior explicit: prune expired sessions
      // every 15 minutes so user_sessions does not grow without bound.
      pruneSessionInterval: 15 * 60,
      errorLog: (err: unknown) =>
        logger.warn({ err }, "session store background error"),
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
      // HttpOnly cookies work on http://localhost in dev; Secure only over HTTPS.
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 14,
    },
    name: "pulseed.sid",
  }),
);

// Resolve staff identity from the HttpOnly session cookie. Bearer tokens are
// optional (STAFF_BEARER_AUTH_ENABLED) for legacy iframe/dev only; they are
// versioned and revoked on logout. Routes should read req.staffId.
app.use(async (req, _res, next) => {
  let sid: number | null = req.session.staffId ?? null;
  if (!sid && isStaffBearerAuthEnabled()) {
    const auth = req.headers.authorization;
    if (typeof auth === "string" && auth.startsWith("Bearer ")) {
      sid = await staffIdFromBearerToken(auth.slice(7).trim());
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
  req.mfaEnrollmentRequired = false;

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
          isDistrictAdmin: staffTable.isDistrictAdmin,
          isAdmin: staffTable.isAdmin,
          mfaEnrolledAt: staffTable.mfaEnrolledAt,
          active: staffTable.active,
        })
        .from(staffTable)
        .where(eq(staffTable.id, sid));
      if (staff && staff.active) {
        req.homeSchoolId = staff.schoolId;

        // MFA enrollment gate (Gate A / Section 1). Flag the request when this
        // staff's role is required by policy but they have not enrolled, so
        // mfaEnrollmentGate can block everything except the enrollment/sign-out
        // routes. Computed here (before the school-active early-returns below)
        // so it is set on every code path. Cheap short-circuits keep this off
        // the hot path for the common cases: the master switch being off or an
        // already-enrolled account both skip the policy lookup entirely; only
        // un-enrolled users pay it, and the result is cached per school+tier.
        if (isStaffMfaEnabled() && !staff.mfaEnrolledAt) {
          req.mfaEnrollmentRequired = await isMfaRequiredForStaffCached({
            isSuperUser: staff.isSuperUser,
            isDistrictAdmin: staff.isDistrictAdmin,
            isAdmin: staff.isAdmin,
            schoolId: staff.schoolId,
          });
        }
        // Persisted on the staff row (not the session) so bearer-token
        // requests inside the Replit preview iframe — where session cookies
        // are blocked — keep the SuperUser's switch active across reloads.
        const override = staff.activeSchoolOverride ?? null;
        // Confirm the staff's home school AND its district are still
        // active before honoring any school context. Soft-deactivated
        // (active=false) schools or districts must not be able to act
        // as the request's tenant; otherwise existing sessions keep
        // reading/writing under a "retired" tenant. When inactive we let the
        // request through with req.schoolId=null; downstream route guards
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
        const homeSchoolActiveOk = Boolean(
          homeSchoolActive && homeSchoolActive.schoolActive,
        );
        const homeDistrictActiveOk = Boolean(
          homeSchoolActive && homeSchoolActive.districtActive,
        );

        // Only look up the override target when a SuperUser actually holds a
        // differing, persisted override and the home school is active — this
        // preserves the previous "no extra DB work in the common case" pattern.
        // D6 defense-in-depth / Phase 5 District Switcher: a cross-district
        // override is honored only when ALLOW_CROSS_DISTRICT_SUPERUSER=1; a
        // stale row must never silently leak another tenant's data. Both the
        // override school AND its district must be active.
        let overrideExists = false;
        let overrideSchoolActive = false;
        let overrideDistrictActive = false;
        let overrideSameDistrict = false;
        if (
          homeSchoolActiveOk &&
          homeDistrictActiveOk &&
          staff.isSuperUser &&
          override &&
          override !== staff.schoolId
        ) {
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
          overrideExists = Boolean(overrideSchool);
          overrideSchoolActive = Boolean(
            overrideSchool && overrideSchool.schoolActive,
          );
          overrideDistrictActive = Boolean(
            overrideSchool && overrideSchool.districtActive,
          );
          overrideSameDistrict = Boolean(
            overrideSchool &&
            homeSchool &&
            overrideSchool.districtId === homeSchool.districtId,
          );
        }

        // Pure, unit-tested tenant decision (Section 5.2, tenantScope.ts). Keeps
        // the single most security-critical branch — which tenant a request acts
        // under — in one testable place.
        const resolution = resolveActiveSchoolId({
          isSuperUser: Boolean(staff.isSuperUser),
          homeSchoolId: staff.schoolId,
          homeSchoolActive: homeSchoolActiveOk,
          homeDistrictActive: homeDistrictActiveOk,
          override,
          overrideExists,
          overrideSchoolActive,
          overrideDistrictActive,
          overrideSameDistrict,
          allowCrossDistrict:
            process.env.ALLOW_CROSS_DISTRICT_SUPERUSER === "1",
        });
        req.schoolId = resolution.schoolId;
        req.isSchoolSwitched = resolution.isSchoolSwitched;
      }
    } catch (err) {
      logger.warn({ err }, "schoolId middleware lookup failed");
    }
  }
  next();
});

app.use("/api", csrfProtectionMiddleware);
// Excessive-API-usage monitor (3.3): counts requests per account/IP and alerts
// on abnormal volume. Placed before the enrollment gate so even a flood of
// gate-blocked requests still counts toward the volume threshold.
app.use("/api", apiUsageAlertMiddleware);
// Runs after CSRF (so enrollment POSTs still validate a token) and before the
// route table: a not-yet-enrolled required user is 403'd on everything except
// the enrollment + sign-out routes.
app.use("/api", mfaEnrollmentGate);
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
