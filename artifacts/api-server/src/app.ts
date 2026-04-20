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
      // SameSite=None + Secure lets the session cookie work both inside the
      // Replit workspace preview iframe (cross-site context) and in a normal
      // standalone tab. Both dev and prod are served over HTTPS so Secure is
      // safe to require.
      sameSite: "none",
      secure: true,
      maxAge: 1000 * 60 * 60 * 24 * 14,
    },
    name: "pulseed.sid",
  }),
);

app.use("/api", router);

export default app;
