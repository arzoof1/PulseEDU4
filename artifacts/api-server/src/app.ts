import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import router from "./routes";
import { logger } from "./lib/logger";
import { verifyAuthToken } from "./lib/authToken";
import { db, staffTable } from "@workspace/db";
import { eq } from "drizzle-orm";

declare global {
  namespace Express {
    interface Request {
      staffId?: number | null;
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
    }
  }
}

declare module "express-session" {
  interface SessionData {
    activeSchoolId?: number;
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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
          isSuperUser: staffTable.isSuperUser,
          active: staffTable.active,
        })
        .from(staffTable)
        .where(eq(staffTable.id, sid));
      if (staff && staff.active) {
        req.homeSchoolId = staff.schoolId;
        const override = req.session.activeSchoolId ?? null;
        if (staff.isSuperUser && override && override !== staff.schoolId) {
          req.schoolId = override;
          req.isSchoolSwitched = true;
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

export default app;
