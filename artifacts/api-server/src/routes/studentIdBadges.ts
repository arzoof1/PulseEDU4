import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import {
  db,
  studentsTable,
  staffTable,
  schoolsTable,
  housesTable,
} from "@workspace/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import {
  renderStudentBadgesPdf,
  type BadgeSize,
  type StudentBadgeInput,
} from "../lib/studentIdBadgesPdf";

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
        ...(all ? [] : [sql`${studentsTable.id} = ANY(${studentIds})`]),
      ),
    )
    .orderBy(asc(studentsTable.lastName), asc(studentsTable.firstName));

  if (students.length === 0) {
    res.status(404).json({ error: "No matching students" });
    return;
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
    { name: string; color: string; iconKey: string | null }
  >();
  if (houseIds.length) {
    const rows = await db
      .select({
        id: housesTable.id,
        name: housesTable.name,
        color: housesTable.color,
        iconKey: housesTable.iconKey,
      })
      .from(housesTable)
      .where(
        and(
          eq(housesTable.schoolId, schoolId),
          sql`${housesTable.id} = ANY(${houseIds})`,
        ),
      );
    for (const r of rows) {
      houseById.set(r.id, {
        name: r.name,
        color: r.color,
        iconKey: r.iconKey,
      });
    }
  }

  const baseUrl = kioskBaseUrl(req);
  const badges: StudentBadgeInput[] = students.map((s) => ({
    studentId: s.studentId,
    firstName: s.firstName,
    lastName: s.lastName,
    grade: s.grade,
    schoolName,
    baseUrl,
    house:
      s.houseId !== null && s.houseId !== undefined
        ? houseById.get(s.houseId) ?? null
        : null,
  }));

  const pdf = await renderStudentBadgesPdf(badges, size);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="student-id-badges-${new Date().toISOString().slice(0, 10)}.pdf"`,
  );
  res.send(pdf);
}

router.post("/students/id-badges.pdf", requireAdmin, handleBadges);
router.get("/students/id-badges.pdf", requireAdmin, handleBadges);

export default router;
