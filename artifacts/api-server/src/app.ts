import express, { type Express, type RequestHandler } from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import router from "./routes";
import { corsMiddleware } from "./lib/corsConfig.js";
import { resolvePublicAppOrigin } from "./lib/publicAppUrl.js";
import { csrfProtectionMiddleware } from "./lib/csrf.js";
import { logger } from "./lib/logger";
import {
  isStaffBearerAuthEnabled,
  staffIdFromBearerToken,
} from "./lib/staffBearerAuth";
import { db, staffTable, schoolsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

declare global {
  namespace Express {
    interface Request {
      staffId?: number | null;
      // Parent identity for HeartBEAT parent-portal routes. Resolved by a
      // router-level middleware inside parentAuth.ts (NOT by the global
      // staff middleware below) so the two identity systems stay isolated.
      parentId?: number | null;
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
        if (staff.isSuperUser && override && override !== staff.schoolId) {
          // D6 defense-in-depth: even if a stale pre-D6 override points
          // at a school in another district, refuse to honor it. Only
          // requires an extra DB hop on the rare requests where an
          // override is actually present, and prevents a Hernando
          // SuperUser whose row already has activeSchoolOverride = some
          // Pasco school from quietly reading Pasco data on the next
          // request. switch-school now refuses to *set* such an
          // override, but old data may still exist.
          const [overrideSchool] = await db
            .select({ districtId: schoolsTable.districtId })
            .from(schoolsTable)
            .where(eq(schoolsTable.id, override));
          const [homeSchool] = await db
            .select({ districtId: schoolsTable.districtId })
            .from(schoolsTable)
            .where(eq(schoolsTable.id, staff.schoolId));
          if (
            overrideSchool &&
            homeSchool &&
            overrideSchool.districtId === homeSchool.districtId
          ) {
            req.schoolId = override;
            req.isSchoolSwitched = true;
          } else {
            // Stale or cross-district override — fall back to home school.
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

app.use("/api", csrfProtectionMiddleware);
app.use("/api", router);

export default app;
