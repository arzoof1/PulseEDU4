import { Router, type IRouter, type Request, type Response } from "express";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import {
  db,
  studentsTable,
  schoolsTable,
  districtIntegrationsTable,
} from "@workspace/db";
import { getSsoAdapter } from "@workspace/sis-adapters";
import { AdapterNotImplementedError } from "@workspace/sis-adapters";
import {
  issueStudentAuthToken,
  verifyStudentAuthToken,
} from "../lib/authToken.js";
import { genUrlSafeToken } from "../lib/urlSafeToken.js";
import { logger } from "../lib/logger.js";

// -----------------------------------------------------------------------------
// Student HeartBEAT portal authentication (ClassLink district SSO).
//
// Students are NOT a separate accounts table — a student IS their roster row
// (`students`). "Linking an account" therefore means stamping the SSO
// identity (`sso_external_id`) onto the existing roster row on first login.
//
// Real ClassLink SSO is an EXTERNAL prerequisite: the district must register
// PulseEDU as an OIDC client and populate `district_integrations.ssoConfig`.
// Until then the adapter's buildAuthorizeUrl/verifyCallback throw
// AdapterNotImplementedError, and the /sso/* routes return a clear
// "not configured" 501. A guarded demo login (non-production OR
// STUDENT_DEMO_LOGIN=1) lets the portal be exercised end-to-end meanwhile.
//
// Identity isolation: this router resolves `req.studentId` (NUMERIC
// students.id) from the session OR a student-kind bearer token, never from
// the staff/parent identity systems. The FLEID never leaves the server.
// -----------------------------------------------------------------------------

const router: IRouter = Router();

function demoLoginAllowed(): boolean {
  return (
    process.env.NODE_ENV !== "production" ||
    process.env.STUDENT_DEMO_LOGIN === "1"
  );
}

// Public, FLEID-safe student identity. localSisId is the ONLY id that leaves
// the server; the canonical FLEID (`studentId` column) is never serialized.
function publicStudent(row: typeof studentsTable.$inferSelect) {
  return {
    id: row.id,
    schoolId: row.schoolId,
    localSisId: row.localSisId ?? null,
    firstName: row.firstName,
    lastName: row.lastName,
    grade: row.grade,
  };
}

// Regenerate the session, stamp the student id + last-login, and invoke `done`
// once the session is durably saved. Shared by the JSON sign-in (demo login)
// and the SSO callback (which redirects instead of returning JSON), so the
// session/token issuance path is identical and fully exercised by the demo
// login. Never carries over a staff/parent session in the same browser.
function establishStudentSession(
  req: Request,
  row: typeof studentsTable.$inferSelect,
  done: (err?: unknown) => void,
): void {
  req.session.regenerate((err) => {
    if (err) {
      done(err);
      return;
    }
    req.session.studentId = row.id;
    delete req.session.staffId;
    delete req.session.parentId;
    delete req.session.activeSchoolId;
    req.session.save(async (saveErr) => {
      if (saveErr) {
        done(saveErr);
        return;
      }
      try {
        await db
          .update(studentsTable)
          .set({ lastPortalLoginAt: new Date().toISOString() })
          .where(eq(studentsTable.id, row.id));
      } catch {
        /* last-login stamp is best-effort */
      }
      done();
    });
  });
}

// JSON sign-in: returns the public student plus a fresh bearer token. Used by
// the guarded demo login.
function signInStudent(
  req: Request,
  res: Response,
  row: typeof studentsTable.$inferSelect,
): void {
  establishStudentSession(req, row, (err) => {
    if (err) {
      res.status(500).json({ error: "Could not start session" });
      return;
    }
    res.json({
      ...publicStudent(row),
      authToken: issueStudentAuthToken(row.id),
    });
  });
}

// -----------------------------------------------------------------------------
// Resolve student identity per request (session cookie OR student bearer).
// -----------------------------------------------------------------------------
router.use(async (req, _res, next) => {
  let sid: number | null = req.session.studentId ?? null;
  if (!sid) {
    const auth = req.headers.authorization;
    if (typeof auth === "string" && auth.startsWith("Bearer ")) {
      sid = verifyStudentAuthToken(auth.slice(7).trim());
    }
  }
  req.studentId = sid;
  next();
});

// Resolve the district SSO adapter for a SPECIFIC school. `district_integrations`
// is keyed by `school_name`; we map schoolId → schools.name and prefer that
// school's row, falling back to the "default" row (single-tenant installs).
// Returns null when no SSO provider is configured for the school. Resolving by
// school (not a global `limit 1`) is required so multi-school/district installs
// route each student to the correct IdP config.
async function resolveSsoForSchool(schoolId: number) {
  const [school] = await db
    .select({ name: schoolsTable.name })
    .from(schoolsTable)
    .where(eq(schoolsTable.id, schoolId))
    .limit(1);
  if (!school) return null;

  const rows = await db
    .select({
      schoolName: districtIntegrationsTable.schoolName,
      provider: districtIntegrationsTable.ssoProvider,
      config: districtIntegrationsTable.ssoConfig,
    })
    .from(districtIntegrationsTable);
  const row =
    rows.find((r) => r.schoolName === school.name) ??
    rows.find((r) => r.schoolName === "default");
  if (!row || row.provider === "none") return null;
  return getSsoAdapter(
    row.provider as Parameters<typeof getSsoAdapter>[0],
    row.config ?? {},
  );
}

// GET /api/student-auth/sso/start — begin the district SSO flow. Returns the
// authorize URL (the client redirects to it) or 501 when SSO isn't configured
// yet (the documented external prerequisite).
router.get("/student-auth/sso/start", async (req, res) => {
  try {
    // schoolId is REQUIRED: it both selects the school's IdP config and scopes
    // the callback's roster lookup to a single tenant. Without it we cannot
    // safely resolve which student record to bind, so we refuse to start.
    const schoolId = Number(req.query.schoolId);
    if (!Number.isFinite(schoolId)) {
      res.status(400).json({ error: "A school is required to sign in." });
      return;
    }
    const adapter = await resolveSsoForSchool(schoolId);
    if (!adapter) {
      res.status(501).json({
        error: "not_configured",
        message:
          "District single sign-on isn't set up yet. Ask your school to enable ClassLink for the student portal.",
      });
      return;
    }
    // CSRF state — stored in the session so the callback can verify it.
    const state = genUrlSafeToken(24);
    req.session.studentSsoState = state;
    // Remember which school this sign-in is for so the callback can scope the
    // roster lookup to a SINGLE tenant (identifiers are not globally unique).
    req.session.studentSsoSchoolId = schoolId;
    const url = adapter.buildAuthorizeUrl(state);
    req.session.save(() => {
      res.json({ url });
    });
  } catch (err) {
    if (err instanceof AdapterNotImplementedError) {
      res.status(501).json({
        error: "not_configured",
        message:
          "District single sign-on isn't fully configured yet. Ask your school to finish ClassLink setup.",
      });
      return;
    }
    logger.error({ err }, "student SSO start failed");
    res.status(500).json({ error: "Could not start sign-in" });
  }
});

// GET /api/student-auth/sso/callback — district SSO redirect target. Verifies
// the callback, links the SSO identity to an existing roster student, and
// signs them in. Blocked end-to-end until ssoConfig is present (see header).
router.get("/student-auth/sso/callback", async (req, res) => {
  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.query)) {
    if (typeof v === "string") query[k] = v;
  }
  // CSRF state check.
  const expectedState = req.session.studentSsoState;
  if (!expectedState || query.state !== expectedState) {
    res.status(400).json({ error: "Invalid sign-in state. Please try again." });
    return;
  }
  delete req.session.studentSsoState;
  // The tenant this sign-in is scoped to (captured at /sso/start). REQUIRED:
  // roster identifiers are NOT globally unique, so without a school we cannot
  // safely bind a student record. There is NO unscoped fallback.
  const ssoSchoolId = req.session.studentSsoSchoolId ?? null;
  delete req.session.studentSsoSchoolId;
  if (ssoSchoolId === null) {
    res.status(400).json({ error: "Invalid sign-in session. Please try again." });
    return;
  }

  try {
    const adapter = await resolveSsoForSchool(ssoSchoolId);
    if (!adapter) {
      res
        .status(501)
        .json({ error: "District single sign-on isn't set up yet." });
      return;
    }
    const identity = await adapter.verifyCallback(query);
    // Resolve the roster student, ALWAYS scoped to the SSO tenant — roster
    // identifiers (sso_external_id, local_sis_id) are NOT globally unique, so a
    // bare match could bind the wrong school's student (cross-tenant leak). We
    // select up to 2 rows and reject ambiguous matches instead of signing into
    // an arbitrary one. Never auto-create a student — they come from the SIS.
    const scoped = (
      col: typeof studentsTable.ssoExternalId | typeof studentsTable.localSisId,
      value: string,
    ) => and(eq(col, value), eq(studentsTable.schoolId, ssoSchoolId));

    let student: typeof studentsTable.$inferSelect | undefined;
    const byExternal = await db
      .select()
      .from(studentsTable)
      .where(scoped(studentsTable.ssoExternalId, identity.externalId))
      .limit(2);
    if (byExternal.length > 1) {
      logger.warn(
        { externalId: identity.externalId, ssoSchoolId },
        "ambiguous SSO external id match",
      );
      res.status(409).json({
        error:
          "Your sign-in matched more than one student record. Ask your school office for help.",
      });
      return;
    }
    student = byExternal[0];

    // Fall back to the local SIS id (districts commonly key OneRoster
    // sourcedId == local id) and stamp the SSO id onto that row for next time.
    if (!student && identity.externalId) {
      const byLocal = await db
        .select()
        .from(studentsTable)
        .where(scoped(studentsTable.localSisId, identity.externalId))
        .limit(2);
      if (byLocal.length > 1) {
        logger.warn(
          { externalId: identity.externalId, ssoSchoolId },
          "ambiguous SSO local_sis_id match",
        );
        res.status(409).json({
          error:
            "Your sign-in matched more than one student record. Ask your school office for help.",
        });
        return;
      }
      if (byLocal[0]) {
        await db
          .update(studentsTable)
          .set({ ssoExternalId: identity.externalId })
          .where(eq(studentsTable.id, byLocal[0].id));
        student = { ...byLocal[0], ssoExternalId: identity.externalId };
      }
    }
    if (!student) {
      res.status(403).json({
        error:
          "We couldn't find your student record. Ask your school office to confirm your account.",
      });
      return;
    }
    // SSO callback is a top-level BROWSER redirect target, not an XHR — so on
    // success we establish the session and redirect into the SPA portal. The
    // student lands on /student; StudentApp's /me call re-establishes the
    // bearer token from the fresh session cookie.
    establishStudentSession(req, student, (err) => {
      if (err) {
        logger.error({ err }, "student SSO session establish failed");
        res.redirect("/student?ssoError=" + encodeURIComponent("Could not complete sign-in. Please try again."));
        return;
      }
      res.redirect("/student");
    });
  } catch (err) {
    if (err instanceof AdapterNotImplementedError) {
      res.status(501).json({ error: "District single sign-on isn't set up yet." });
      return;
    }
    logger.error({ err }, "student SSO callback failed");
    res.status(500).json({ error: "Could not complete sign-in" });
  }
});

// GET /api/student-auth/sso/available — lets the login page know whether the
// real SSO button should be shown and whether the demo login is offered.
router.get("/student-auth/sso/available", async (req, res) => {
  // Per-school: the login page asks "is ClassLink set up for THIS school?".
  // Defaults to school 1 (single-tenant default, matches the demo flow).
  const schoolId = Number(req.query.schoolId) || 1;
  const adapter = await resolveSsoForSchool(schoolId).catch(() => null);
  res.json({
    ssoConfigured: Boolean(adapter),
    demoLoginAllowed: demoLoginAllowed(),
  });
});

// GET /api/student-auth/demo-students?schoolId=N — guarded helper that lists a
// few students with recent activity so the demo login screen has something to
// pick. Only available when the demo login is allowed. FLEID-safe.
router.get("/student-auth/demo-students", async (req, res) => {
  if (!demoLoginAllowed()) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const schoolId = Number(req.query.schoolId) || 1;
  const rows = await db
    .select()
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.schoolId, schoolId),
        isNotNull(studentsTable.localSisId),
      ),
    )
    .orderBy(sql`${studentsTable.lastName}, ${studentsTable.firstName}`)
    .limit(50);
  res.json({ students: rows.map(publicStudent) });
});

// POST /api/student-auth/demo-login { studentRowId } — GUARDED. Signs in as an
// existing roster student so the portal is testable without live SSO.
router.post("/student-auth/demo-login", async (req, res) => {
  if (!demoLoginAllowed()) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const studentRowId = Number((req.body ?? {}).studentRowId);
  if (!Number.isFinite(studentRowId)) {
    res.status(400).json({ error: "studentRowId is required" });
    return;
  }
  const [student] = await db
    .select()
    .from(studentsTable)
    .where(eq(studentsTable.id, studentRowId))
    .limit(1);
  if (!student) {
    res.status(404).json({ error: "Student not found" });
    return;
  }
  signInStudent(req, res, student);
});

// GET /api/student-auth/me — current signed-in student (FLEID-safe) + a fresh
// token (so the client can refresh it the way the parent portal does).
router.get("/student-auth/me", async (req, res) => {
  const sid = req.studentId;
  if (!sid) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const [student] = await db
    .select()
    .from(studentsTable)
    .where(eq(studentsTable.id, sid))
    .limit(1);
  if (!student) {
    req.session.destroy(() => {
      res.status(401).json({ error: "Not authenticated" });
    });
    return;
  }
  res.json({
    ...publicStudent(student),
    authToken: issueStudentAuthToken(student.id),
  });
});

// POST /api/student-auth/logout
router.post("/student-auth/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      res.status(500).json({ error: "Could not log out" });
      return;
    }
    res.clearCookie("pulseed.sid");
    res.status(204).end();
  });
});

export default router;
