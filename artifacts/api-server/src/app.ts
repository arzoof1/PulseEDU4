import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import router from "./routes";
import { logger } from "./lib/logger";

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
      // Production: SameSite=None + Secure so the cookie works both in the
      // Replit workspace preview iframe (cross-site) and a normal HTTPS tab.
      // Development: the editor preview iframe loads the app over HTTP, which
      // strips Secure cookies and breaks login. Fall back to Lax/non-secure
      // there so local testing works. Production is unchanged.
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 14,
    },
    name: "pulseed.sid",
  }),
);

app.use("/api", router);

export default app;
