import { Router, type IRouter } from "express";
import {
  db,
  parentStudentsTable,
  studentsTable,
  schoolSettingsTable,
  ticketEventsTable,
  ticketGrantsTable,
  ticketsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { verifyParentAuthToken } from "../lib/authToken.js";
import { renderTicketsPdf } from "../lib/ticketPdf.js";
import {
  TICKET_RESPONSIBILITY_HEADLINE,
  TICKET_RESPONSIBILITY_LINES,
  ticketShortCode,
} from "../lib/ticketCopy.js";

// Parent-portal view of a student's event tickets. Mirrors the parent-id
// resolution used by parentSnapshot (session cookie OR Bearer token). Only
// PUBLISHED events are exposed; drafts and closed-but-unpublished events stay
// hidden from families. Ownership is enforced via parent_students on every
// route so a parent can never read another family's tickets.
const router: IRouter = Router();

router.use(async (req, _res, next) => {
  let pid: number | null = req.session.parentId ?? null;
  if (!pid) {
    const auth = req.headers.authorization;
    if (typeof auth === "string" && auth.startsWith("Bearer ")) {
      pid = verifyParentAuthToken(auth.slice(7).trim());
    }
  }
  req.parentId = pid;
  next();
});

// Returns the set of student table-ids this parent is linked to. Empty set if
// none (caller should 403/empty).
async function studentIdsForParent(parentId: number): Promise<Set<number>> {
  const rows = await db
    .select({ studentId: parentStudentsTable.studentId })
    .from(parentStudentsTable)
    .where(eq(parentStudentsTable.parentId, parentId));
  return new Set(rows.map((r) => r.studentId));
}

// Shared responsibility copy so the portal renders the SAME wording as the
// email + PDF.
const RESPONSIBILITY = {
  headline: TICKET_RESPONSIBILITY_HEADLINE,
  lines: TICKET_RESPONSIBILITY_LINES,
};

// GET /parent/tickets?studentId= — list a student's ticket grants (published
// events only) with each ticket's token, seq, and status.
router.get("/parent/tickets", async (req, res) => {
  const pid = req.parentId;
  if (!pid) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const studentId = Number(req.query.studentId);
  if (!Number.isInteger(studentId)) {
    res.status(400).json({ error: "studentId is required" });
    return;
  }
  const owned = await studentIdsForParent(pid);
  if (!owned.has(studentId)) {
    res.status(403).json({ error: "Not authorized for this student" });
    return;
  }

  const grants = await db
    .select({
      grantId: ticketGrantsTable.id,
      eventId: ticketGrantsTable.eventId,
      schoolId: ticketGrantsTable.schoolId,
      eventName: ticketEventsTable.name,
      eventDate: ticketEventsTable.eventDate,
      startTime: ticketEventsTable.startTime,
      location: ticketEventsTable.location,
      eventStatus: ticketEventsTable.status,
    })
    .from(ticketGrantsTable)
    .innerJoin(
      ticketEventsTable,
      and(
        eq(ticketEventsTable.id, ticketGrantsTable.eventId),
        // Defense-in-depth: never cross a tenant boundary even if a grant
        // somehow references an event in another school.
        eq(ticketEventsTable.schoolId, ticketGrantsTable.schoolId),
      ),
    )
    .where(
      and(
        eq(ticketGrantsTable.studentId, studentId),
        eq(ticketEventsTable.status, "published"),
      ),
    );

  const grantIds = grants.map((g) => g.grantId);
  const schoolIds = Array.from(new Set(grants.map((g) => g.schoolId)));
  const ticketsByGrant = new Map<
    number,
    { token: string; seq: number; status: string }[]
  >();
  if (grantIds.length > 0) {
    const rows = await db
      .select({
        grantId: ticketsTable.grantId,
        token: ticketsTable.token,
        seq: ticketsTable.seq,
        status: ticketsTable.status,
      })
      .from(ticketsTable)
      .where(
        and(
          inArray(ticketsTable.grantId, grantIds),
          inArray(ticketsTable.schoolId, schoolIds),
        ),
      )
      .orderBy(ticketsTable.seq);
    for (const r of rows) {
      if (r.status === "void") continue;
      const arr = ticketsByGrant.get(r.grantId) ?? [];
      arr.push({ token: r.token, seq: r.seq, status: r.status });
      ticketsByGrant.set(r.grantId, arr);
    }
  }

  res.setHeader("Cache-Control", "private, no-store");
  res.json({
    responsibility: RESPONSIBILITY,
    events: grants
      .map((g) => {
        const tks = ticketsByGrant.get(g.grantId) ?? [];
        return {
          grantId: g.grantId,
          eventId: g.eventId,
          eventName: g.eventName,
          eventDate: g.eventDate,
          startTime: g.startTime,
          location: g.location,
          tickets: tks.map((t) => ({
            token: t.token,
            seq: t.seq,
            total: tks.length,
            status: t.status,
            shortCode: ticketShortCode(t.token),
          })),
        };
      })
      .filter((e) => e.tickets.length > 0),
  });
});

// GET /parent/tickets/:grantId.pdf — download one student's printable tickets.
router.get("/parent/tickets/:grantId.pdf", async (req, res) => {
  const pid = req.parentId;
  if (!pid) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const grantId = Number(req.params.grantId);
  if (!Number.isInteger(grantId)) {
    res.status(400).json({ error: "Invalid grant id" });
    return;
  }
  const [grant] = await db
    .select({
      id: ticketGrantsTable.id,
      studentId: ticketGrantsTable.studentId,
      eventId: ticketGrantsTable.eventId,
      schoolId: ticketGrantsTable.schoolId,
      guardianName: ticketGrantsTable.guardianName,
    })
    .from(ticketGrantsTable)
    .where(eq(ticketGrantsTable.id, grantId));
  if (!grant) {
    res.status(404).json({ error: "Tickets not found" });
    return;
  }
  const owned = await studentIdsForParent(pid);
  if (!owned.has(grant.studentId)) {
    res.status(403).json({ error: "Not authorized for these tickets" });
    return;
  }

  const [ev] = await db
    .select()
    .from(ticketEventsTable)
    .where(
      and(
        eq(ticketEventsTable.id, grant.eventId),
        eq(ticketEventsTable.schoolId, grant.schoolId),
        eq(ticketEventsTable.status, "published"),
      ),
    );
  if (!ev) {
    res.status(404).json({ error: "Event not available" });
    return;
  }
  const [student] = await db
    .select({
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      grade: studentsTable.grade,
      parentName: studentsTable.parentName,
    })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.id, grant.studentId),
        eq(studentsTable.schoolId, grant.schoolId),
      ),
    );
  // List all non-void tickets so the family always sees the full set (used
  // ones included — the UI greys them; the PDF lists them).
  const allTickets = await db
    .select({ token: ticketsTable.token, seq: ticketsTable.seq })
    .from(ticketsTable)
    .where(
      and(
        eq(ticketsTable.grantId, grantId),
        eq(ticketsTable.schoolId, grant.schoolId),
        inArray(ticketsTable.status, ["valid", "used"]),
      ),
    )
    .orderBy(ticketsTable.seq);

  const [settings] = await db
    .select({ schoolName: schoolSettingsTable.schoolName })
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, grant.schoolId));
  const studentName = student
    ? `${student.firstName} ${student.lastName}`
    : `Student ${grant.studentId}`;

  let pdf: Buffer;
  try {
    pdf = await renderTicketsPdf({
      schoolName: settings?.schoolName ?? "PulseEDU",
      eventName: ev.name,
      eventDate: ev.eventDate,
      startTime: ev.startTime,
      location: ev.location,
      sheets: [
        {
          studentName,
          grade: student?.grade ?? null,
          guardianName: grant.guardianName ?? student?.parentName ?? null,
          tickets: allTickets,
        },
      ],
    });
  } catch {
    res.status(500).json({ error: "Could not generate PDF" });
    return;
  }

  const safeName =
    studentName.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "tickets";
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Length", pdf.length.toString());
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="tickets-${safeName}.pdf"`,
  );
  res.setHeader("Cache-Control", "private, no-store");
  res.status(200).end(pdf);
});

export default router;
