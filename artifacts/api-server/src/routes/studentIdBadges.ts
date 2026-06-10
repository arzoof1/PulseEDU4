import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import {
  db,
  studentsTable,
  staffTable,
  schoolsTable,
  housesTable,
  badgePrintEventsTable,
} from "@workspace/db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import {
  renderStudentBadgesPdf,
  type BadgeSize,
  type StudentBadgeInput,
} from "../lib/studentIdBadgesPdf";
import {
  ObjectStorageService,
  ObjectNotFoundError,
} from "../lib/objectStorage.js";

const objectStorage = new ObjectStorageService();

// Fetch the raw bytes of a stored object so we can embed it in the
// generated PDF. Returns null on any failure (missing object, ACL
// mismatch handled at upstream bind time, network glitch) — the
// renderer falls back to the initials bubble silently. We bypass
// `downloadObject` (which writes to an Express response) and pipe
// the GCS readStream directly into a buffer.
async function fetchObjectBytes(objectPath: string): Promise<Buffer | null> {
  try {
    const file = await objectStorage.getObjectEntityFile(objectPath);
    return await new Promise<Buffer | null>((resolve) => {
      const chunks: Buffer[] = [];
      const stream = file.createReadStream();
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => resolve(Buffer.concat(chunks)));
      stream.on("error", () => resolve(null));
    });
  } catch (err) {
    if (err instanceof ObjectNotFoundError) return null;
    return null;
  }
}

const router: IRouter = Router();

// Reuse the same shape used by kiosk cards — wrap requireStaff with an
// inline admin gate so we don't reach across routes for it.
async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const staffId = req.staffId;
  if (!staffId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const [staff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, staffId));
  if (!staff || !staff.active) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  if (!staff.isAdmin && !staff.isSuperUser) {
    res.status(403).json({ error: "Admin only" });
    return;
  }
  (req as Request & { staff: typeof staffTable.$inferSelect }).staff = staff;
  next();
}

// Build the base URL the QR codes point at. Matches the kiosk-cards
// pattern so a school's printed materials all encode the same origin.
function kioskBaseUrl(req: Request): string {
  const host = req.get("host");
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol;
  return `${proto}://${host}/kiosk`;
}

// GET → POST mirror of /kiosk/cards.pdf: accepts ?all=1 or
// ?studentIds=1,2,3, returns a PDF stream. POST is preferred so the
// client includes credentials + CSRF.
async function handleBadges(req: Request, res: Response): Promise<void> {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  const body = (req.body ?? {}) as {
    all?: boolean;
    studentIds?: number[];
    size?: string;
    reason?: string;
  };
  // Badge physical size — "lanyard" (default, portrait 3.375"×4.25")
  // or "cr80" (landscape 3.375"×2.125", standard credit-card ID).
  const sizeRaw = body.size ?? req.query.size;
  const size: BadgeSize = sizeRaw === "cr80" ? "cr80" : "lanyard";
  const all =
    body.all === true || req.query.all === "1" || req.query.all === "true";
  const bodyIds = Array.isArray(body.studentIds)
    ? body.studentIds.filter((n): n is number => Number.isInteger(n) && n > 0)
    : [];
  const queryIdsRaw =
    typeof req.query.studentIds === "string" ? req.query.studentIds : "";
  const queryIds = queryIdsRaw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  const studentIds = bodyIds.length ? bodyIds : queryIds;

  if (!all && studentIds.length === 0) {
    res
      .status(400)
      .json({ error: "Provide studentIds=1,2,3 or all=1" });
    return;
  }

  const students = await db
    .select()
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.schoolId, schoolId),
        ...(all ? [] : [inArray(studentsTable.id, studentIds)]),
      ),
    )
    .orderBy(asc(studentsTable.lastName), asc(studentsTable.firstName));

  if (students.length === 0) {
    res.status(404).json({ error: "No matching students" });
    return;
  }

  // When the caller passed an explicit ID list, refuse silent partial
  // success: any ID that wasn't in this school (or doesn't exist) means
  // the request was wrong (typo, stale tab, cross-school injection
  // attempt). Surface that as a 404 with the offending IDs so the UI
  // can tell the admin instead of printing a half-correct batch.
  if (!all) {
    const foundIds = new Set(students.map((s) => s.id));
    const missing = studentIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      res.status(404).json({
        error: "Some student IDs are not in your school",
        missingStudentIds: missing,
      });
      return;
    }
  }

  const [school] = await db
    .select({ name: schoolsTable.name })
    .from(schoolsTable)
    .where(eq(schoolsTable.id, schoolId));
  const schoolName = school?.name ?? "PulseEDU";

  // Batch-load houses for the colored ribbon, scoped to this school
  // (defense-in-depth — students.houseId is already school-scoped at
  // assignment time but we double-check here).
  const houseIds = Array.from(
    new Set(
      students
        .map((s) => s.houseId)
        .filter((id): id is number => typeof id === "number"),
    ),
  );
  const houseById = new Map<
    number,
    {
      name: string;
      color: string;
      iconKey: string | null;
      iconObjectKey: string | null;
      logoBytes: Buffer | null;
    }
  >();
  if (houseIds.length) {
    const rows = await db
      .select({
        id: housesTable.id,
        name: housesTable.name,
        color: housesTable.color,
        iconKey: housesTable.iconKey,
        iconObjectKey: housesTable.iconObjectKey,
      })
      .from(housesTable)
      .where(
        and(
          eq(housesTable.schoolId, schoolId),
          inArray(housesTable.id, houseIds),
        ),
      );
    // Pre-fetch any uploaded house logos in parallel — at most one
    // round-trip per house in the batch (typical = 4). SVG bytes are
    // not supported by pdfkit's .image(), so we only embed
    // PNG/JPEG/WebP. Bytes that don't pass that bar fall back to
    // the colored letter circle on the renderer side.
    const MAX_LOGO_BYTES = 2 * 1024 * 1024;
    const logoBytesById = new Map<number, Buffer>();
    await Promise.all(
      rows
        .filter((r) => r.iconObjectKey)
        .map(async (r) => {
          const bytes = await fetchObjectBytes(r.iconObjectKey as string);
          if (bytes && bytes.length <= MAX_LOGO_BYTES) {
            // Skip SVG — pdfkit can't rasterize it without svg-to-pdfkit,
            // which we haven't pulled into the bundle. Header sniff: the
            // first non-whitespace bytes of an SVG file are "<".
            const head = bytes.slice(0, 16).toString("utf8").trimStart();
            if (!head.startsWith("<")) {
              logoBytesById.set(r.id, bytes);
            }
          }
        }),
    );
    for (const r of rows) {
      houseById.set(r.id, {
        name: r.name,
        color: r.color,
        iconKey: r.iconKey,
        iconObjectKey: r.iconObjectKey,
        logoBytes: logoBytesById.get(r.id) ?? null,
      });
    }
  }

  const baseUrl = kioskBaseUrl(req);
  // Fetch all referenced photos in parallel. Consent toggle hides
  // the photo even when bytes are on disk (matches the rest of the
  // app's render gating).
  const photoByStudent = new Map<number, Buffer>();
  // Bounded-concurrency photo fetch. A "print all" for a 2000-student
  // school would otherwise open 2000 simultaneous GCS streams and
  // hold every photo in memory at once — easy OOM. We cap to 6 in
  // flight and skip any image > 4MB (a sane upper bound for a badge
  // thumbnail — anything bigger is almost certainly an unscaled
  // upload that would bloat the PDF and slow rendering to a crawl).
  const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
  const CONCURRENCY = 6;
  const candidates = students.filter(
    (s) => s.photoConsent && s.photoObjectKey,
  );
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const slice = candidates.slice(i, i + CONCURRENCY);
    await Promise.all(
      slice.map(async (s) => {
        const bytes = await fetchObjectBytes(s.photoObjectKey as string);
        if (bytes && bytes.length <= MAX_PHOTO_BYTES) {
          photoByStudent.set(s.id, bytes);
        }
      }),
    );
  }

  const badges: StudentBadgeInput[] = students.map((s) => ({
    studentId: s.studentId,
    // District-level Local SIS id (the human-facing id students scan/type).
    // The visible "ID" line, the QR, and the Code128 barcode all encode this
    // — the internal FLEID-style student_id never reaches a student.
    localSisId: s.localSisId ?? null,
    firstName: s.firstName,
    lastName: s.lastName,
    grade: s.grade,
    dismissalMode: s.dismissalMode ?? null,
    schoolName,
    baseUrl,
    house: (() => {
      if (s.houseId === null || s.houseId === undefined) return null;
      const h = houseById.get(s.houseId);
      if (!h) return null;
      return {
        name: h.name,
        color: h.color,
        iconKey: h.iconKey,
        logoBytes: h.logoBytes,
      };
    })(),
    photoBytes: photoByStudent.get(s.id) ?? null,
  }));

  // Audit ledger — one row per student per batch. Optional reason
  // is pulled from the request body so the admin can label a
  // single-student reprint ("lost", "damaged", etc.). Don't let
  // logging failures block the actual PDF delivery.
  const reason =
    typeof body.reason === "string" && body.reason.trim()
      ? body.reason.trim().slice(0, 120)
      : null;
  try {
    const printedBy = req.staffId ?? null;
    await db.insert(badgePrintEventsTable).values(
      students.map((s) => ({
        schoolId,
        studentId: s.id,
        printedByStaffId: printedBy,
        size,
        reason,
        batchSize: students.length,
      })),
    );
  } catch {
    // Audit is best-effort; never block a print.
  }

  const pdf = await renderStudentBadgesPdf(badges, size);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="student-id-badges-${new Date().toISOString().slice(0, 10)}.pdf"`,
  );
  res.send(pdf);
}

// GET /api/students/badge-print-events?limit=50
// Recent badge prints for the school, newest first. Joined to
// students so the UI can render names without a second roundtrip.
router.get(
  "/students/badge-print-events",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const limitRaw = Number(req.query.limit ?? 50);
    const limit = Math.max(1, Math.min(200, Number.isFinite(limitRaw) ? limitRaw : 50));
    const rows = await db
      .select({
        id: badgePrintEventsTable.id,
        studentId: badgePrintEventsTable.studentId,
        studentRecordId: studentsTable.studentId,
        firstName: studentsTable.firstName,
        lastName: studentsTable.lastName,
        grade: studentsTable.grade,
        printedByStaffId: badgePrintEventsTable.printedByStaffId,
        printedByName: sql<string>`COALESCE(${staffTable.displayName}, '')`.as("printedByName"),
        size: badgePrintEventsTable.size,
        reason: badgePrintEventsTable.reason,
        batchSize: badgePrintEventsTable.batchSize,
        printedAt: badgePrintEventsTable.printedAt,
      })
      .from(badgePrintEventsTable)
      .leftJoin(
        studentsTable,
        and(
          eq(badgePrintEventsTable.studentId, studentsTable.id),
          eq(studentsTable.schoolId, schoolId),
        ),
      )
      .leftJoin(staffTable, eq(badgePrintEventsTable.printedByStaffId, staffTable.id))
      .where(eq(badgePrintEventsTable.schoolId, schoolId))
      .orderBy(desc(badgePrintEventsTable.printedAt))
      .limit(limit);
    res.json({ events: rows });
  },
);

router.post("/students/id-badges.pdf", requireAdmin, handleBadges);
router.get("/students/id-badges.pdf", requireAdmin, handleBadges);

export default router;
