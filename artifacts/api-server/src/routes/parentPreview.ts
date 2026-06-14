import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  parentsTable,
  parentStudentsTable,
  studentsTable,
  staffTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { issueParentAuthToken } from "../lib/authToken.js";

const router: IRouter = Router();

// =============================================================================
// Parent Portal — staff "Preview as parent" tool.
//
// Lets an Admin / SuperUser instantly view the parent-facing HeartBEAT for any
// student in their school WITHOUT going through the real invite + email +
// accept-password flow. Useful for QA + support.
//
// Two entry points share the same setup:
//   - POST /admin/parent-preview        swaps THIS session to the preview
//                                        parent (opens in a new tab).
//   - POST /admin/parent-preview/link   returns a shareable link WITHOUT
//                                        touching the caller's session, so it
//                                        can be sent to someone on another
//                                        device (e.g. an admin during a demo).
//
// Safety / production-isolation:
//   - Gated to staff who are isAdmin or isSuperUser on the active school.
//   - Uses a single sentinel parent row per school, keyed off a reserved
//     `__preview@pulseedu.local` email. Never receives real invites or emails;
//     never carries a password (passwordHash stays NULL so /parent-auth/login
//     refuses it).
//   - Re-uses parent_students (the existing M:N table) but REPLACES links each
//     time so the previewer only ever sees the chosen student. Because the
//     sentinel is shared per school, only ONE student preview is live at a
//     time — a new preview/link supersedes the previous one.
// =============================================================================

const PREVIEW_EMAIL = "__preview@pulseedu.local";
const PREVIEW_DISPLAY_NAME = "Preview Parent";

// Resolve the public-facing origin for links opened OUTSIDE the workspace.
// Mirrors `publicAppOrigin` in routes/tours.ts: never trust REPLIT_DEV_DOMAIN
// first (it is the dev host and is often unset in prod). See replit.md gotchas.
function publicAppOrigin(req?: Request): string {
  const explicit = process.env.PUBLIC_APP_URL;
  if (explicit && explicit.length > 0) return explicit.replace(/\/+$/, "");
  const replitDomains = (process.env.REPLIT_DOMAINS ?? "").trim();
  if (replitDomains) {
    const first = replitDomains.split(",")[0]?.trim();
    if (first) return `https://${first}`;
  }
  if (req) {
    const rawProto = (req.headers["x-forwarded-proto"] as string | undefined)
      ?.split(",")[0]
      ?.trim()
      .toLowerCase();
    const proto =
      rawProto === "http" || rawProto === "https" ? rawProto : "https";
    const rawHost = (req.headers["x-forwarded-host"] ?? req.headers.host) as
      | string
      | undefined;
    const host = rawHost?.split(",")[0]?.trim();
    if (host) return `${proto}://${host}`;
  }
  const replit = process.env.REPLIT_DEV_DOMAIN;
  if (replit && replit.length > 0) return `https://${replit}`;
  return "http://localhost:5000";
}

// Shared setup: gate to admin/superuser, confirm the student is in the active
// school, then point the per-school sentinel preview parent at that student.
// Returns the sentinel parent id, or null after already sending an error.
async function setupPreviewParent(
  req: Request,
  res: Response,
): Promise<number | null> {
  const sid = req.staffId ?? null;
  if (!sid) {
    res.status(401).json({ error: "Sign-in required" });
    return null;
  }
  const [staff] = await db
    .select({
      isAdmin: staffTable.isAdmin,
      isSuperUser: staffTable.isSuperUser,
    })
    .from(staffTable)
    .where(eq(staffTable.id, sid));
  if (!staff || (!staff.isAdmin && !staff.isSuperUser)) {
    res.status(403).json({ error: "Admin or SuperUser only" });
    return null;
  }
  const schoolId = req.schoolId;
  if (!schoolId) {
    res.status(400).json({ error: "No active school" });
    return null;
  }
  const studentRowId = Number(req.body?.studentRowId);
  if (!Number.isInteger(studentRowId) || studentRowId < 1) {
    res.status(400).json({ error: "studentRowId is required" });
    return null;
  }

  // Confirm the student belongs to this school. Prevents a SuperUser hopping
  // schools without an active context, and prevents a school admin from
  // previewing another school's student.
  const [student] = await db
    .select({ id: studentsTable.id, schoolId: studentsTable.schoolId })
    .from(studentsTable)
    .where(eq(studentsTable.id, studentRowId));
  if (!student || student.schoolId !== schoolId) {
    res.status(404).json({ error: "Student not found in active school" });
    return null;
  }

  // Find-or-create the sentinel preview parent for this school.
  let [preview] = await db
    .select()
    .from(parentsTable)
    .where(
      and(
        eq(parentsTable.schoolId, schoolId),
        eq(parentsTable.email, PREVIEW_EMAIL),
      ),
    );
  if (!preview) {
    const inserted = await db
      .insert(parentsTable)
      .values({
        schoolId,
        email: PREVIEW_EMAIL,
        // Null password — login endpoint rejects rows with no password.
        passwordHash: null,
        displayName: PREVIEW_DISPLAY_NAME,
        active: true,
      })
      .returning();
    preview = inserted[0];
  }

  // Replace links so the preview parent only sees the chosen student. Avoids
  // confusion from sibling switcher carrying over a previous preview pick.
  await db
    .delete(parentStudentsTable)
    .where(eq(parentStudentsTable.parentId, preview.id));
  await db.insert(parentStudentsTable).values({
    parentId: preview.id,
    studentId: student.id,
  });

  return preview.id;
}

router.post(
  "/admin/parent-preview",
  async (req: Request, res: Response): Promise<void> => {
    const previewId = await setupPreviewParent(req, res);
    if (previewId == null) return;

    // Swap session: drop staff identity, install parent identity.
    req.session.regenerate((err) => {
      if (err) {
        res.status(500).json({ error: "Could not start preview session" });
        return;
      }
      req.session.parentId = previewId;
      delete req.session.staffId;
      delete req.session.activeSchoolId;
      req.session.save((saveErr) => {
        if (saveErr) {
          res.status(500).json({ error: "Could not save preview session" });
          return;
        }
        // Also mint a parent Bearer token. Inside the Replit preview iframe the
        // session COOKIE is blocked, so the parent app authenticates off a
        // Bearer token in sessionStorage (`pulseed.parentToken`). Hand it back
        // so the staff client can pass it to the freshly opened preview tab.
        res.json({
          ok: true,
          redirectTo: "/parent",
          authToken: issueParentAuthToken(previewId),
        });
      });
    });
  },
);

// Sister endpoint: build a SHAREABLE parent-preview link WITHOUT touching the
// caller's own session. Handy in a live demo — generate the link, send it to an
// admin on another device, and they land straight in the parent HeartBEAT for
// the chosen student. The parent Bearer token rides in the URL hash (the parent
// app consumes `#pt=` on boot); the link is good for ~12h (token TTL).
router.post(
  "/admin/parent-preview/link",
  async (req: Request, res: Response): Promise<void> => {
    const previewId = await setupPreviewParent(req, res);
    if (previewId == null) return;
    const token = issueParentAuthToken(previewId);
    const url = `${publicAppOrigin(req)}/parent#pt=${encodeURIComponent(token)}`;
    res.json({ ok: true, url });
  },
);

export default router;
