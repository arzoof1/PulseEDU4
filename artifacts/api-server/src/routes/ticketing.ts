import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  db,
  studentsTable,
  staffTable,
  schoolSettingsTable,
  ticketEventsTable,
  ticketGrantsTable,
  ticketsTable,
  ticketScanEventsTable,
  ticketScannerLinksTable,
  type TicketEventRow,
} from "@workspace/db";
import { and, eq, inArray, sql, desc } from "drizzle-orm";
import { randomBytes, createHash } from "crypto";
import { requireSchool } from "../lib/scope.js";
import { canManageTickets } from "../lib/coreTeam.js";
import { sendTicketEmailForGrant } from "../lib/ticketEmail.js";
import { renderTicketsPdf, type TicketPdfSheet } from "../lib/ticketPdf.js";

const router: IRouter = Router();

// =============================================================================
// Event Ticketing (Phase 1) — server routes.
//
// Free-ticket school events (8th-grade promotion, graduation). An office user
// creates an event, allocates a per-student quota by grade (with overrides),
// then emails each student's guardian their QR tickets (T003). Families share
// codes freely; staff or no-login volunteers scan at the gate where the first
// scan admits and rescans show "already used" (T004).
//
// Auth model:
//   - Management surface (events, allocation, send, print, scanner links,
//     void/reissue): canManageTickets() — admin + Core Team + counselor +
//     front office. Enforced by requireTicketManager below.
//   - Gate scanning (T004): any signed-in staff, plus no-login scanner links.
//
// Every query is tenant-scoped via req.schoolId (requireSchool).
// =============================================================================

const EVENT_STATUSES = new Set(["draft", "published", "closed"]);

type StaffRow = typeof staffTable.$inferSelect;

// Generate an unguessable QR payload token. base64url of 24 random bytes
// (~32 chars, 192 bits) — not derived from any student id, so a leaked code
// reveals nothing and cannot be forged or guessed.
function genTicketToken(): string {
  return randomBytes(24).toString("base64url");
}

async function requireStaff(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const staffId = req.staffId;
  if (!staffId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const [staff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, staffId));
  if (!staff || !staff.active) {
    res.status(401).json({ error: "Staff not found or inactive" });
    return;
  }
  (req as Request & { staff: StaffRow }).staff = staff;
  next();
}

function staffOf(req: Request): StaffRow {
  return (req as Request & { staff: StaffRow }).staff;
}

// Management gate — runs after requireStaff.
function requireTicketManager(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const staff = staffOf(req);
  if (!canManageTickets(staff)) {
    res.status(403).json({ error: "Not authorized to manage ticketing" });
    return;
  }
  next();
}

// ---- shared summary helper -------------------------------------------------

type EventSummary = {
  grants: number;
  allocated: number; // sum of quota across grants
  tickets: number;
  used: number; // admitted count
  emailed: number; // grants with email_status='sent'
  noEmail: number; // grants with email_status='no_email'
  failed: number; // grants with email_status in (failed,bounced)
  printed: number; // grants with printed_at set
};

async function summarizeEvents(
  schoolId: number,
  eventIds: number[],
): Promise<Map<number, EventSummary>> {
  const out = new Map<number, EventSummary>();
  if (eventIds.length === 0) return out;
  for (const id of eventIds) {
    out.set(id, {
      grants: 0,
      allocated: 0,
      tickets: 0,
      used: 0,
      emailed: 0,
      noEmail: 0,
      failed: 0,
      printed: 0,
    });
  }

  const grantRows = await db
    .select({
      eventId: ticketGrantsTable.eventId,
      quota: ticketGrantsTable.quota,
      emailStatus: ticketGrantsTable.emailStatus,
      printedAt: ticketGrantsTable.printedAt,
    })
    .from(ticketGrantsTable)
    .where(
      and(
        eq(ticketGrantsTable.schoolId, schoolId),
        inArray(ticketGrantsTable.eventId, eventIds),
      ),
    );
  for (const g of grantRows) {
    const s = out.get(g.eventId);
    if (!s) continue;
    s.grants += 1;
    s.allocated += g.quota ?? 0;
    if (g.emailStatus === "sent") s.emailed += 1;
    else if (g.emailStatus === "no_email") s.noEmail += 1;
    else if (g.emailStatus === "failed" || g.emailStatus === "bounced")
      s.failed += 1;
    if (g.printedAt) s.printed += 1;
  }

  const ticketRows = await db
    .select({
      eventId: ticketsTable.eventId,
      status: ticketsTable.status,
    })
    .from(ticketsTable)
    .where(
      and(
        eq(ticketsTable.schoolId, schoolId),
        inArray(ticketsTable.eventId, eventIds),
      ),
    );
  for (const t of ticketRows) {
    const s = out.get(t.eventId);
    if (!s) continue;
    if (t.status === "void") continue;
    s.tickets += 1;
    if (t.status === "used") s.used += 1;
  }

  return out;
}

function serializeEvent(ev: TicketEventRow, summary?: EventSummary) {
  return {
    id: ev.id,
    name: ev.name,
    description: ev.description,
    eventDate: ev.eventDate,
    startTime: ev.startTime,
    location: ev.location,
    capacity: ev.capacity,
    status: ev.status,
    eventDayOnly: ev.eventDayOnly,
    createdAt: ev.createdAt,
    updatedAt: ev.updatedAt,
    summary: summary ?? null,
  };
}

// ---- events CRUD -----------------------------------------------------------

// GET /ticketing/events — list all events for the school with summary counts.
router.get(
  "/ticketing/events",
  requireStaff,
  requireTicketManager,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const events = await db
      .select()
      .from(ticketEventsTable)
      .where(eq(ticketEventsTable.schoolId, schoolId))
      .orderBy(desc(ticketEventsTable.createdAt));
    const summaries = await summarizeEvents(
      schoolId,
      events.map((e) => e.id),
    );
    res.json({
      events: events.map((e) => serializeEvent(e, summaries.get(e.id))),
    });
  },
);

// POST /ticketing/events — create a new event.
router.post(
  "/ticketing/events",
  requireStaff,
  requireTicketManager,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const staff = staffOf(req);
    const body = (req.body ?? {}) as Record<string, unknown>;

    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      res.status(400).json({ error: "Event name is required" });
      return;
    }
    const capacity =
      body.capacity === null || body.capacity === undefined
        ? null
        : Number(body.capacity);
    if (capacity !== null && (!Number.isInteger(capacity) || capacity < 0)) {
      res.status(400).json({ error: "Capacity must be a non-negative integer" });
      return;
    }
    const status =
      typeof body.status === "string" && EVENT_STATUSES.has(body.status)
        ? body.status
        : "draft";

    const [created] = await db
      .insert(ticketEventsTable)
      .values({
        schoolId,
        name,
        description:
          typeof body.description === "string" ? body.description.trim() : null,
        eventDate:
          typeof body.eventDate === "string" && body.eventDate
            ? body.eventDate
            : null,
        startTime:
          typeof body.startTime === "string" && body.startTime
            ? body.startTime
            : null,
        location:
          typeof body.location === "string" && body.location
            ? body.location.trim()
            : null,
        capacity,
        status,
        eventDayOnly: Boolean(body.eventDayOnly),
        createdByStaffId: staff.id,
      })
      .returning();
    res.status(201).json({ event: serializeEvent(created) });
  },
);

// Load an event by id, school-scoped. Writes a 404 and returns null if absent.
async function loadEvent(
  schoolId: number,
  eventId: number,
  res: Response,
): Promise<TicketEventRow | null> {
  if (!Number.isInteger(eventId)) {
    res.status(400).json({ error: "Invalid event id" });
    return null;
  }
  const [ev] = await db
    .select()
    .from(ticketEventsTable)
    .where(
      and(
        eq(ticketEventsTable.id, eventId),
        eq(ticketEventsTable.schoolId, schoolId),
      ),
    );
  if (!ev) {
    res.status(404).json({ error: "Event not found" });
    return null;
  }
  return ev;
}

// GET /ticketing/events/:id — detail with summary + per-student grants.
router.get(
  "/ticketing/events/:id",
  requireStaff,
  requireTicketManager,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const eventId = Number(req.params.id);
    const ev = await loadEvent(schoolId, eventId, res);
    if (!ev) return;

    const summaries = await summarizeEvents(schoolId, [ev.id]);

    // Per-student grant rows joined to the student for display.
    const grantRows = await db
      .select({
        grantId: ticketGrantsTable.id,
        studentId: ticketGrantsTable.studentId,
        quota: ticketGrantsTable.quota,
        guardianEmail: ticketGrantsTable.guardianEmail,
        guardianName: ticketGrantsTable.guardianName,
        emailStatus: ticketGrantsTable.emailStatus,
        emailSentAt: ticketGrantsTable.emailSentAt,
        emailError: ticketGrantsTable.emailError,
        printedAt: ticketGrantsTable.printedAt,
        firstName: studentsTable.firstName,
        lastName: studentsTable.lastName,
        grade: studentsTable.grade,
        studentExtId: studentsTable.studentId,
        parentEmail: studentsTable.parentEmail,
        parentName: studentsTable.parentName,
      })
      .from(ticketGrantsTable)
      .innerJoin(
        studentsTable,
        eq(studentsTable.id, ticketGrantsTable.studentId),
      )
      .where(
        and(
          eq(ticketGrantsTable.schoolId, schoolId),
          eq(ticketGrantsTable.eventId, ev.id),
        ),
      )
      .orderBy(studentsTable.grade, studentsTable.lastName);

    // Per-grant ticket usage counts.
    const usageRows = await db
      .select({
        grantId: ticketsTable.grantId,
        total: sql<number>`COUNT(*) FILTER (WHERE ${ticketsTable.status} <> 'void')::int`,
        used: sql<number>`COUNT(*) FILTER (WHERE ${ticketsTable.status} = 'used')::int`,
      })
      .from(ticketsTable)
      .where(
        and(
          eq(ticketsTable.schoolId, schoolId),
          eq(ticketsTable.eventId, ev.id),
        ),
      )
      .groupBy(ticketsTable.grantId);
    const usageByGrant = new Map(
      usageRows.map((u) => [u.grantId, { total: u.total, used: u.used }]),
    );

    res.json({
      event: serializeEvent(ev, summaries.get(ev.id)),
      grants: grantRows.map((g) => ({
        grantId: g.grantId,
        studentId: g.studentId,
        studentExtId: g.studentExtId,
        name: `${g.firstName} ${g.lastName}`,
        grade: g.grade,
        quota: g.quota,
        guardianEmail: g.guardianEmail ?? g.parentEmail ?? null,
        guardianName: g.guardianName ?? g.parentName ?? null,
        hasEmail: Boolean(g.guardianEmail ?? g.parentEmail),
        emailStatus: g.emailStatus,
        emailSentAt: g.emailSentAt,
        emailError: g.emailError,
        printedAt: g.printedAt,
        ticketsTotal: usageByGrant.get(g.grantId)?.total ?? 0,
        ticketsUsed: usageByGrant.get(g.grantId)?.used ?? 0,
      })),
    });
  },
);

// GET /ticketing/events/:id/scan-history — append-only audit of every scan at
// the gate (admits, rescans, rejects). Read-only; school + event scoped. Pass
// ?format=csv to download, ?result= / ?gate= to filter.
router.get(
  "/ticketing/events/:id/scan-history",
  requireStaff,
  requireTicketManager,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const eventId = Number(req.params.id);
    const ev = await loadEvent(schoolId, eventId, res);
    if (!ev) return;

    const resultFilter =
      typeof req.query.result === "string" && req.query.result.trim()
        ? req.query.result.trim()
        : null;
    const gateFilter =
      typeof req.query.gate === "string" && req.query.gate.trim()
        ? req.query.gate.trim()
        : null;
    const isCsv = req.query.format === "csv";

    const conds = [
      eq(ticketScanEventsTable.schoolId, schoolId),
      eq(ticketScanEventsTable.eventId, ev.id),
    ];
    if (resultFilter)
      conds.push(eq(ticketScanEventsTable.result, resultFilter));
    if (gateFilter) conds.push(eq(ticketScanEventsTable.gateLabel, gateFilter));

    const rows = await db
      .select({
        id: ticketScanEventsTable.id,
        createdAt: ticketScanEventsTable.createdAt,
        result: ticketScanEventsTable.result,
        gateLabel: ticketScanEventsTable.gateLabel,
        scannedByStaffId: ticketScanEventsTable.scannedByStaffId,
        scannerLinkId: ticketScanEventsTable.scannerLinkId,
        seq: ticketsTable.seq,
        firstName: studentsTable.firstName,
        lastName: studentsTable.lastName,
        grade: studentsTable.grade,
      })
      .from(ticketScanEventsTable)
      .leftJoin(
        ticketsTable,
        and(
          eq(ticketsTable.id, ticketScanEventsTable.ticketId),
          eq(ticketsTable.schoolId, schoolId),
        ),
      )
      .leftJoin(
        studentsTable,
        and(
          eq(studentsTable.id, ticketsTable.studentId),
          eq(studentsTable.schoolId, schoolId),
        ),
      )
      .where(and(...conds))
      .orderBy(desc(ticketScanEventsTable.createdAt))
      .limit(isCsv ? 5000 : 500);

    // Resolve scanned-by display names (staff or volunteer link) in one pass.
    const staffIds = new Set<number>();
    const linkIds = new Set<number>();
    for (const r of rows) {
      if (r.scannedByStaffId != null) staffIds.add(r.scannedByStaffId);
      if (r.scannerLinkId != null) linkIds.add(r.scannerLinkId);
    }
    const staffNames = new Map<number, string>();
    if (staffIds.size) {
      const sr = await db
        .select({ id: staffTable.id, name: staffTable.displayName })
        .from(staffTable)
        .where(
          and(
            eq(staffTable.schoolId, schoolId),
            inArray(staffTable.id, [...staffIds]),
          ),
        );
      for (const s of sr) staffNames.set(s.id, s.name);
    }
    const linkLabels = new Map<number, string>();
    if (linkIds.size) {
      const lr = await db
        .select({
          id: ticketScannerLinksTable.id,
          label: ticketScannerLinksTable.label,
        })
        .from(ticketScannerLinksTable)
        .where(
          and(
            eq(ticketScannerLinksTable.schoolId, schoolId),
            inArray(ticketScannerLinksTable.id, [...linkIds]),
          ),
        );
      for (const l of lr) linkLabels.set(l.id, l.label);
    }

    const scannedByOf = (r: (typeof rows)[number]): string => {
      if (r.scannedByStaffId != null)
        return staffNames.get(r.scannedByStaffId) ?? "Staff";
      if (r.scannerLinkId != null) {
        const lbl = linkLabels.get(r.scannerLinkId);
        return lbl ? `Volunteer link · ${lbl}` : "Volunteer link";
      }
      return "—";
    };

    const items = rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      result: r.result,
      gateLabel: r.gateLabel,
      studentName: r.firstName ? `${r.firstName} ${r.lastName}` : null,
      grade: r.grade ?? null,
      seq: r.seq ?? null,
      scannedBy: scannedByOf(r),
    }));

    if (isCsv) {
      const esc = (v: unknown) => {
        let s = v == null ? "" : String(v);
        // Neutralize spreadsheet formula injection: a cell that begins with
        // =, +, -, @, or a tab/CR can execute when opened in Excel/Sheets.
        if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const header = [
        "When",
        "Result",
        "Student",
        "Grade",
        "Ticket #",
        "Gate",
        "Scanned by",
      ];
      const lines = [header.join(",")];
      for (const it of items) {
        lines.push(
          [
            esc(new Date(it.createdAt).toISOString()),
            esc(it.result),
            esc(it.studentName ?? ""),
            esc(it.grade ?? ""),
            esc(it.seq ?? ""),
            esc(it.gateLabel ?? ""),
            esc(it.scannedBy),
          ].join(","),
        );
      }
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="scan-history-event-${ev.id}.csv"`,
      );
      res.send(lines.join("\n"));
      return;
    }

    // Distinct gate labels (unfiltered) for the filter dropdown.
    const gateRows = await db
      .selectDistinct({ gateLabel: ticketScanEventsTable.gateLabel })
      .from(ticketScanEventsTable)
      .where(
        and(
          eq(ticketScanEventsTable.schoolId, schoolId),
          eq(ticketScanEventsTable.eventId, ev.id),
        ),
      );
    const gates = gateRows
      .map((g) => g.gateLabel)
      .filter((g): g is string => Boolean(g))
      .sort();

    res.json({ items, gates });
  },
);

// PATCH /ticketing/events/:id — update mutable fields.
router.patch(
  "/ticketing/events/:id",
  requireStaff,
  requireTicketManager,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const eventId = Number(req.params.id);
    const ev = await loadEvent(schoolId, eventId, res);
    if (!ev) return;
    const body = (req.body ?? {}) as Record<string, unknown>;

    const patch: Partial<typeof ticketEventsTable.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (typeof body.name === "string") {
      const name = body.name.trim();
      if (!name) {
        res.status(400).json({ error: "Event name cannot be empty" });
        return;
      }
      patch.name = name;
    }
    if ("description" in body)
      patch.description =
        typeof body.description === "string" ? body.description.trim() : null;
    if ("eventDate" in body)
      patch.eventDate =
        typeof body.eventDate === "string" && body.eventDate
          ? body.eventDate
          : null;
    if ("startTime" in body)
      patch.startTime =
        typeof body.startTime === "string" && body.startTime
          ? body.startTime
          : null;
    if ("location" in body)
      patch.location =
        typeof body.location === "string" && body.location
          ? body.location.trim()
          : null;
    if ("capacity" in body) {
      const capacity =
        body.capacity === null || body.capacity === undefined
          ? null
          : Number(body.capacity);
      if (capacity !== null && (!Number.isInteger(capacity) || capacity < 0)) {
        res
          .status(400)
          .json({ error: "Capacity must be a non-negative integer" });
        return;
      }
      patch.capacity = capacity;
    }
    if (typeof body.status === "string") {
      if (!EVENT_STATUSES.has(body.status)) {
        res.status(400).json({ error: "Invalid status" });
        return;
      }
      patch.status = body.status;
    }
    if ("eventDayOnly" in body) patch.eventDayOnly = Boolean(body.eventDayOnly);

    const [updated] = await db
      .update(ticketEventsTable)
      .set(patch)
      .where(
        and(
          eq(ticketEventsTable.id, ev.id),
          eq(ticketEventsTable.schoolId, schoolId),
        ),
      )
      .returning();
    res.json({ event: serializeEvent(updated) });
  },
);

// DELETE /ticketing/events/:id — delete an event and its child rows. Blocked
// once any ticket has been admitted (status='used') so we never destroy an
// attendance audit trail; close the event instead.
router.delete(
  "/ticketing/events/:id",
  requireStaff,
  requireTicketManager,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const eventId = Number(req.params.id);
    const ev = await loadEvent(schoolId, eventId, res);
    if (!ev) return;

    const [{ used }] = (await db.execute(
      sql`SELECT COUNT(*)::int AS used FROM tickets WHERE school_id = ${schoolId} AND event_id = ${ev.id} AND status = 'used'`,
    )).rows as { used: number }[];
    if (used > 0) {
      res.status(409).json({
        error:
          "This event already has admitted attendees. Close the event instead of deleting it to preserve the attendance record.",
      });
      return;
    }

    await db
      .delete(ticketsTable)
      .where(
        and(
          eq(ticketsTable.schoolId, schoolId),
          eq(ticketsTable.eventId, ev.id),
        ),
      );
    await db
      .delete(ticketGrantsTable)
      .where(
        and(
          eq(ticketGrantsTable.schoolId, schoolId),
          eq(ticketGrantsTable.eventId, ev.id),
        ),
      );
    await db
      .delete(ticketEventsTable)
      .where(
        and(
          eq(ticketEventsTable.id, ev.id),
          eq(ticketEventsTable.schoolId, schoolId),
        ),
      );
    res.json({ ok: true });
  },
);

// ---- allocation ------------------------------------------------------------

type AllocationInput = {
  grades: number[];
  quota: number;
  overrides: Map<number, number>; // studentId -> quota
  excludeStudentIds: Set<number>;
};

function parseAllocationBody(
  body: Record<string, unknown>,
  res: Response,
): AllocationInput | null {
  const grades = Array.isArray(body.grades)
    ? body.grades.map((g) => Number(g)).filter((g) => Number.isInteger(g))
    : [];
  if (grades.length === 0) {
    res.status(400).json({ error: "Select at least one grade" });
    return null;
  }
  const quota = Number(body.quota);
  if (!Number.isInteger(quota) || quota < 0 || quota > 50) {
    res.status(400).json({ error: "Quota must be an integer between 0 and 50" });
    return null;
  }
  const overrides = new Map<number, number>();
  if (Array.isArray(body.overrides)) {
    for (const o of body.overrides as Record<string, unknown>[]) {
      const sid = Number(o?.studentId);
      const q = Number(o?.quota);
      if (Number.isInteger(sid) && Number.isInteger(q) && q >= 0 && q <= 50) {
        overrides.set(sid, q);
      }
    }
  }
  const excludeStudentIds = new Set<number>(
    Array.isArray(body.excludeStudentIds)
      ? (body.excludeStudentIds as unknown[])
          .map((s) => Number(s))
          .filter((s) => Number.isInteger(s))
      : [],
  );
  return { grades, quota, overrides, excludeStudentIds };
}

// Resolve the concrete per-student allocation rows for an allocation input.
async function resolveAllocationRows(
  schoolId: number,
  input: AllocationInput,
): Promise<
  {
    studentId: number;
    studentExtId: string;
    name: string;
    grade: number;
    guardianEmail: string | null;
    guardianName: string | null;
    hasEmail: boolean;
    quota: number;
  }[]
> {
  const students = await db
    .select({
      id: studentsTable.id,
      studentExtId: studentsTable.studentId,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      grade: studentsTable.grade,
      parentEmail: studentsTable.parentEmail,
      parentName: studentsTable.parentName,
    })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.schoolId, schoolId),
        inArray(studentsTable.grade, input.grades),
      ),
    )
    .orderBy(studentsTable.grade, studentsTable.lastName);

  return students
    .filter((s) => !input.excludeStudentIds.has(s.id))
    .map((s) => {
      const quota = input.overrides.has(s.id)
        ? (input.overrides.get(s.id) as number)
        : input.quota;
      return {
        studentId: s.id,
        studentExtId: s.studentExtId,
        name: `${s.firstName} ${s.lastName}`,
        grade: s.grade,
        guardianEmail: s.parentEmail ?? null,
        guardianName: s.parentName ?? null,
        hasEmail: Boolean(s.parentEmail),
        quota,
      };
    });
}

// POST /ticketing/events/:id/allocate/preview — compute the proposed rows.
router.post(
  "/ticketing/events/:id/allocate/preview",
  requireStaff,
  requireTicketManager,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const eventId = Number(req.params.id);
    const ev = await loadEvent(schoolId, eventId, res);
    if (!ev) return;
    const input = parseAllocationBody(
      (req.body ?? {}) as Record<string, unknown>,
      res,
    );
    if (!input) return;

    const rows = await resolveAllocationRows(schoolId, input);
    const totalTickets = rows.reduce((acc, r) => acc + r.quota, 0);
    const withEmail = rows.filter((r) => r.hasEmail).length;
    res.json({
      rows,
      totals: {
        students: rows.length,
        tickets: totalTickets,
        withEmail,
        withoutEmail: rows.length - withEmail,
      },
    });
  },
);

// Reconcile the ticket rows for one grant so the count of non-void tickets
// matches `quota`. Adds new tokens when increasing; when decreasing, removes
// only UNUSED ('valid') tickets from the highest seq down — never deletes a
// used/void ticket (those are part of the audit/attendance record). Returns
// the resulting non-void ticket count.
async function reconcileTicketsForGrant(
  schoolId: number,
  eventId: number,
  grantId: number,
  studentId: number,
  quota: number,
): Promise<number> {
  const existing = await db
    .select({
      id: ticketsTable.id,
      seq: ticketsTable.seq,
      status: ticketsTable.status,
    })
    .from(ticketsTable)
    .where(
      and(
        eq(ticketsTable.schoolId, schoolId),
        eq(ticketsTable.grantId, grantId),
      ),
    )
    .orderBy(ticketsTable.seq);

  const nonVoid = existing.filter((t) => t.status !== "void");
  const current = nonVoid.length;

  if (current < quota) {
    const maxSeq = existing.reduce((m, t) => Math.max(m, t.seq), 0);
    const toAdd: (typeof ticketsTable.$inferInsert)[] = [];
    for (let i = 1; i <= quota - current; i++) {
      toAdd.push({
        schoolId,
        eventId,
        grantId,
        studentId,
        token: genTicketToken(),
        seq: maxSeq + i,
        status: "valid",
      });
    }
    if (toAdd.length > 0) await db.insert(ticketsTable).values(toAdd);
  } else if (current > quota) {
    // Remove unused tickets (highest seq first) down to quota.
    const removable = nonVoid
      .filter((t) => t.status === "valid")
      .sort((a, b) => b.seq - a.seq);
    const removeCount = current - quota;
    const idsToRemove = removable.slice(0, removeCount).map((t) => t.id);
    if (idsToRemove.length > 0) {
      await db
        .delete(ticketsTable)
        .where(
          and(
            eq(ticketsTable.schoolId, schoolId),
            inArray(ticketsTable.id, idsToRemove),
          ),
        );
    }
  }

  const [{ c }] = (await db.execute(
    sql`SELECT COUNT(*)::int AS c FROM tickets WHERE school_id = ${schoolId} AND grant_id = ${grantId} AND status <> 'void'`,
  )).rows as { c: number }[];
  return c;
}

// POST /ticketing/events/:id/allocate/commit — upsert grants + reconcile
// tickets to match the computed allocation. Idempotent: re-running keeps
// already-issued tokens stable (so a re-allocation never invalidates tickets
// a family already received), only adding/removing to hit the new quota.
router.post(
  "/ticketing/events/:id/allocate/commit",
  requireStaff,
  requireTicketManager,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const eventId = Number(req.params.id);
    const ev = await loadEvent(schoolId, eventId, res);
    if (!ev) return;
    const input = parseAllocationBody(
      (req.body ?? {}) as Record<string, unknown>,
      res,
    );
    if (!input) return;

    const rows = await resolveAllocationRows(schoolId, input);

    let grantsTouched = 0;
    let ticketsTotal = 0;
    for (const row of rows) {
      // Upsert the grant for this (event, student).
      const [existingGrant] = await db
        .select()
        .from(ticketGrantsTable)
        .where(
          and(
            eq(ticketGrantsTable.schoolId, schoolId),
            eq(ticketGrantsTable.eventId, ev.id),
            eq(ticketGrantsTable.studentId, row.studentId),
          ),
        );

      let grantId: number;
      if (existingGrant) {
        grantId = existingGrant.id;
        await db
          .update(ticketGrantsTable)
          .set({
            quota: row.quota,
            // Refresh the contact snapshot from the current student row.
            guardianEmail: row.guardianEmail,
            guardianName: row.guardianName,
            // If there's no email now, mark no_email unless it was already
            // sent/printed (don't clobber a real delivery record).
            emailStatus:
              !row.hasEmail &&
              existingGrant.emailStatus !== "sent" &&
              existingGrant.emailStatus !== "printed"
                ? "no_email"
                : existingGrant.emailStatus,
            updatedAt: new Date(),
          })
          .where(eq(ticketGrantsTable.id, grantId));
      } else {
        const [created] = await db
          .insert(ticketGrantsTable)
          .values({
            schoolId,
            eventId: ev.id,
            studentId: row.studentId,
            quota: row.quota,
            guardianEmail: row.guardianEmail,
            guardianName: row.guardianName,
            emailStatus: row.hasEmail ? "pending" : "no_email",
          })
          .returning();
        grantId = created.id;
      }

      grantsTouched += 1;
      ticketsTotal += await reconcileTicketsForGrant(
        schoolId,
        ev.id,
        grantId,
        row.studentId,
        row.quota,
      );
    }

    const summaries = await summarizeEvents(schoolId, [ev.id]);
    res.json({
      ok: true,
      grantsTouched,
      ticketsTotal,
      summary: summaries.get(ev.id) ?? null,
    });
  },
);

// ---- delivery: email send -------------------------------------------------

// POST /ticketing/events/:id/send — bulk send tickets to guardians.
// Body (all optional):
//   resendSent   : boolean — also re-send grants already marked 'sent'.
//   grantIds     : number[] — restrict to these grants (otherwise all).
// Grants with no email on file are skipped (marked no_email). Sends one
// SEPARATE email per student (siblings get two emails).
router.post(
  "/ticketing/events/:id/send",
  requireStaff,
  requireTicketManager,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const eventId = Number(req.params.id);
    const ev = await loadEvent(schoolId, eventId, res);
    if (!ev) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const resendSent = Boolean(body.resendSent);
    const restrictIds = Array.isArray(body.grantIds)
      ? new Set(
          (body.grantIds as unknown[])
            .map((g) => Number(g))
            .filter((g) => Number.isInteger(g)),
        )
      : null;

    const grants = await db
      .select({
        id: ticketGrantsTable.id,
        emailStatus: ticketGrantsTable.emailStatus,
        guardianEmail: ticketGrantsTable.guardianEmail,
      })
      .from(ticketGrantsTable)
      .where(
        and(
          eq(ticketGrantsTable.schoolId, schoolId),
          eq(ticketGrantsTable.eventId, ev.id),
        ),
      );

    let sent = 0;
    let skipped = 0;
    let failed = 0;
    let noEmail = 0;
    for (const g of grants) {
      if (restrictIds && !restrictIds.has(g.id)) continue;
      if (!g.guardianEmail) {
        noEmail += 1;
        // Ensure status reflects no_email (commit already does this, but a
        // grant edited later could be stale).
        await db
          .update(ticketGrantsTable)
          .set({ emailStatus: "no_email", updatedAt: new Date() })
          .where(eq(ticketGrantsTable.id, g.id));
        continue;
      }
      if (!resendSent && g.emailStatus === "sent") {
        skipped += 1;
        continue;
      }
      const result = await sendTicketEmailForGrant(g.id);
      if (result.status === "sent") sent += 1;
      else if (result.status === "error") failed += 1;
      else skipped += 1;
    }

    const summaries = await summarizeEvents(schoolId, [ev.id]);
    res.json({
      ok: true,
      sent,
      skipped,
      failed,
      noEmail,
      summary: summaries.get(ev.id) ?? null,
    });
  },
);

// POST /ticketing/grants/:grantId/send — (re)send a single student's tickets.
router.post(
  "/ticketing/grants/:grantId/send",
  requireStaff,
  requireTicketManager,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const grantId = Number(req.params.grantId);
    if (!Number.isInteger(grantId)) {
      res.status(400).json({ error: "Invalid grant id" });
      return;
    }
    // Verify the grant belongs to this school before sending.
    const [grant] = await db
      .select({ id: ticketGrantsTable.id })
      .from(ticketGrantsTable)
      .where(
        and(
          eq(ticketGrantsTable.id, grantId),
          eq(ticketGrantsTable.schoolId, schoolId),
        ),
      );
    if (!grant) {
      res.status(404).json({ error: "Grant not found" });
      return;
    }
    const result = await sendTicketEmailForGrant(grantId);
    const httpStatus = result.status === "error" ? 502 : 200;
    res.status(httpStatus).json(result);
  },
);

// ---- delivery: PDFs --------------------------------------------------------

// Build the sheet (student header + ticket list) for one grant. Returns null
// (after writing a 404) if the grant isn't found in this school.
async function buildSheetForGrant(
  schoolId: number,
  grantId: number,
): Promise<{ sheet: TicketPdfSheet; studentName: string } | null> {
  const [grant] = await db
    .select({
      id: ticketGrantsTable.id,
      studentId: ticketGrantsTable.studentId,
      guardianName: ticketGrantsTable.guardianName,
    })
    .from(ticketGrantsTable)
    .where(
      and(
        eq(ticketGrantsTable.id, grantId),
        eq(ticketGrantsTable.schoolId, schoolId),
      ),
    );
  if (!grant) return null;
  const [student] = await db
    .select({
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      grade: studentsTable.grade,
      parentName: studentsTable.parentName,
    })
    .from(studentsTable)
    .where(eq(studentsTable.id, grant.studentId));
  const tickets = await db
    .select({ token: ticketsTable.token, seq: ticketsTable.seq })
    .from(ticketsTable)
    .where(
      and(
        eq(ticketsTable.schoolId, schoolId),
        eq(ticketsTable.grantId, grantId),
        sql`${ticketsTable.status} <> 'void'`,
      ),
    )
    .orderBy(ticketsTable.seq);
  const studentName = student
    ? `${student.firstName} ${student.lastName}`
    : `Student ${grant.studentId}`;
  return {
    studentName,
    sheet: {
      studentName,
      grade: student?.grade ?? null,
      guardianName: grant.guardianName ?? student?.parentName ?? null,
      tickets,
    },
  };
}

function pdfFilename(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-+|-+$/g, "");
}

// GET /ticketing/grants/:grantId/tickets.pdf — front-office on-demand print of
// ANY family's tickets, regardless of email status. Marks printed_at. The
// client downloads this to disk (authed blobs can't open in the preview
// iframe — see replit.md Gotchas).
router.get(
  "/ticketing/grants/:grantId/tickets.pdf",
  requireStaff,
  requireTicketManager,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const grantId = Number(req.params.grantId);
    if (!Number.isInteger(grantId)) {
      res.status(400).json({ error: "Invalid grant id" });
      return;
    }
    const built = await buildSheetForGrant(schoolId, grantId);
    if (!built) {
      res.status(404).json({ error: "Grant not found" });
      return;
    }
    // Need event header info.
    const [grantEv] = await db
      .select({ eventId: ticketGrantsTable.eventId })
      .from(ticketGrantsTable)
      .where(eq(ticketGrantsTable.id, grantId));
    const ev = grantEv ? await loadEvent(schoolId, grantEv.eventId, res) : null;
    if (!ev) return;
    const [settings] = await db
      .select({ schoolName: schoolSettingsTable.schoolName })
      .from(schoolSettingsTable)
      .where(eq(schoolSettingsTable.schoolId, schoolId));

    const pdf = await renderTicketsPdf({
      schoolName: settings?.schoolName ?? "PulseEDU",
      eventName: ev.name,
      eventDate: ev.eventDate,
      startTime: ev.startTime,
      location: ev.location,
      sheets: [built.sheet],
    });

    await db
      .update(ticketGrantsTable)
      .set({
        printedAt: new Date(),
        // Mark printed delivery for grants that had no email path.
        emailStatus: sql`CASE WHEN ${ticketGrantsTable.emailStatus} IN ('no_email','pending','failed','bounced') THEN 'printed' ELSE ${ticketGrantsTable.emailStatus} END`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(ticketGrantsTable.id, grantId),
          eq(ticketGrantsTable.schoolId, schoolId),
        ),
      );

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="tickets-${pdfFilename(built.studentName)}.pdf"`,
    );
    res.send(pdf);
  },
);

// GET /ticketing/events/:id/handout.pdf — office handout. By default only the
// students with NO guardian email on file (so the office can hand paper tickets
// to those families); pass ?all=1 to print every family's tickets at once.
router.get(
  "/ticketing/events/:id/handout.pdf",
  requireStaff,
  requireTicketManager,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const eventId = Number(req.params.id);
    const ev = await loadEvent(schoolId, eventId, res);
    if (!ev) return;
    const all = req.query.all === "1" || req.query.all === "true";

    const grants = await db
      .select({
        id: ticketGrantsTable.id,
        guardianEmail: ticketGrantsTable.guardianEmail,
      })
      .from(ticketGrantsTable)
      .where(
        and(
          eq(ticketGrantsTable.schoolId, schoolId),
          eq(ticketGrantsTable.eventId, ev.id),
        ),
      );
    const targetGrants = all
      ? grants
      : grants.filter((g) => !g.guardianEmail);

    const sheets: TicketPdfSheet[] = [];
    const printedGrantIds: number[] = [];
    for (const g of targetGrants) {
      const built = await buildSheetForGrant(schoolId, g.id);
      if (built && built.sheet.tickets.length > 0) {
        sheets.push(built.sheet);
        printedGrantIds.push(g.id);
      }
    }

    const [settings] = await db
      .select({ schoolName: schoolSettingsTable.schoolName })
      .from(schoolSettingsTable)
      .where(eq(schoolSettingsTable.schoolId, schoolId));

    const pdf = await renderTicketsPdf({
      schoolName: settings?.schoolName ?? "PulseEDU",
      eventName: ev.name,
      eventDate: ev.eventDate,
      startTime: ev.startTime,
      location: ev.location,
      sheets,
    });

    if (printedGrantIds.length > 0) {
      await db
        .update(ticketGrantsTable)
        .set({
          printedAt: new Date(),
          emailStatus: sql`CASE WHEN ${ticketGrantsTable.emailStatus} IN ('no_email','pending','failed','bounced') THEN 'printed' ELSE ${ticketGrantsTable.emailStatus} END`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(ticketGrantsTable.schoolId, schoolId),
            inArray(ticketGrantsTable.id, printedGrantIds),
          ),
        );
    }

    const suffix = all ? "all-families" : "no-email";
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="handout-${pdfFilename(ev.name)}-${suffix}.pdf"`,
    );
    res.send(pdf);
  },
);

// GET /ticketing/events/:id/report/delivery — "couldn't send" report. Lists,
// per student, the grants that did NOT reach a guardian inbox: no_email,
// failed, bounced, or still pending. The office works this list (print +
// hand out, or fix the email and resend).
router.get(
  "/ticketing/events/:id/report/delivery",
  requireStaff,
  requireTicketManager,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const eventId = Number(req.params.id);
    const ev = await loadEvent(schoolId, eventId, res);
    if (!ev) return;

    const rows = await db
      .select({
        grantId: ticketGrantsTable.id,
        studentId: ticketGrantsTable.studentId,
        quota: ticketGrantsTable.quota,
        guardianEmail: ticketGrantsTable.guardianEmail,
        emailStatus: ticketGrantsTable.emailStatus,
        emailError: ticketGrantsTable.emailError,
        emailSentAt: ticketGrantsTable.emailSentAt,
        printedAt: ticketGrantsTable.printedAt,
        firstName: studentsTable.firstName,
        lastName: studentsTable.lastName,
        grade: studentsTable.grade,
        studentExtId: studentsTable.studentId,
      })
      .from(ticketGrantsTable)
      .innerJoin(
        studentsTable,
        eq(studentsTable.id, ticketGrantsTable.studentId),
      )
      .where(
        and(
          eq(ticketGrantsTable.schoolId, schoolId),
          eq(ticketGrantsTable.eventId, ev.id),
        ),
      )
      .orderBy(studentsTable.grade, studentsTable.lastName);

    const undelivered = rows
      .filter(
        (r) =>
          r.emailStatus === "no_email" ||
          r.emailStatus === "failed" ||
          r.emailStatus === "bounced" ||
          r.emailStatus === "pending",
      )
      .map((r) => ({
        grantId: r.grantId,
        studentId: r.studentId,
        studentExtId: r.studentExtId,
        name: `${r.firstName} ${r.lastName}`,
        grade: r.grade,
        quota: r.quota,
        guardianEmail: r.guardianEmail,
        emailStatus: r.emailStatus,
        emailError: r.emailError,
        printedAt: r.printedAt,
        reason:
          r.emailStatus === "no_email"
            ? "No guardian email on file"
            : r.emailStatus === "pending"
              ? "Not sent yet"
              : r.emailError || "Delivery failed",
      }));

    res.json({
      event: { id: ev.id, name: ev.name },
      counts: {
        total: rows.length,
        noEmail: rows.filter((r) => r.emailStatus === "no_email").length,
        failed: rows.filter(
          (r) => r.emailStatus === "failed" || r.emailStatus === "bounced",
        ).length,
        pending: rows.filter((r) => r.emailStatus === "pending").length,
        printed: rows.filter((r) => r.printedAt).length,
      },
      undelivered,
    });
  },
);

// ===========================================================================
// T004 — Scanning (gate admission)
// ===========================================================================

// Public-facing origin for the no-login scanner link (volunteers open it on
// their own phones, OUTSIDE the workspace). Same resolution order as tours.ts:
// PUBLIC_APP_URL -> first REPLIT_DOMAINS host -> forwarded request host ->
// localhost. Never trust REPLIT_DEV_DOMAIN first (unset in prod).
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

function hashScannerToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function localTodayYmd(): string {
  // Local server day as YYYY-MM-DD (matches the eventDate text format).
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Live admitted/capacity snapshot for an event.
async function liveCounts(
  schoolId: number,
  eventId: number,
): Promise<{ admitted: number; total: number; capacity: number | null }> {
  const [row] = (await db.execute(
    sql`SELECT
          COUNT(*) FILTER (WHERE status <> 'void')::int AS total,
          COUNT(*) FILTER (WHERE status = 'used')::int AS admitted
        FROM tickets WHERE school_id = ${schoolId} AND event_id = ${eventId}`,
  )).rows as { total: number; admitted: number }[];
  const [ev] = await db
    .select({ capacity: ticketEventsTable.capacity })
    .from(ticketEventsTable)
    .where(
      and(
        eq(ticketEventsTable.id, eventId),
        eq(ticketEventsTable.schoolId, schoolId),
      ),
    );
  return {
    admitted: row?.admitted ?? 0,
    total: row?.total ?? 0,
    capacity: ev?.capacity ?? null,
  };
}

const NEAR_FULL_RATIO = 0.9;

function capacityFlags(admitted: number, capacity: number | null) {
  if (capacity === null || capacity <= 0) {
    return { capacityWarning: false, atCapacity: false, overCapacity: false };
  }
  return {
    capacityWarning: admitted >= Math.floor(capacity * NEAR_FULL_RATIO),
    atCapacity: admitted >= capacity,
    overCapacity: admitted > capacity,
  };
}

type ScanResult =
  | "admitted"
  | "already_used"
  | "invalid"
  | "void"
  | "wrong_event"
  | "outside_window";

type ScanContext = {
  schoolId: number;
  eventId: number;
  via: "staff" | "scanner_link";
  staffId?: number | null;
  scannerLinkId?: number | null;
  gateLabel?: string | null;
};

// Core scan logic shared by the staff endpoint and the no-login link endpoint.
// First-scan-wins is enforced by a conditional UPDATE (status='valid' guard) so
// two simultaneous scans of the same code can never both admit. Every scan —
// admit, rescan, invalid — is recorded in the append-only audit table.
async function performScan(rawToken: string, ctx: ScanContext) {
  const token = (rawToken ?? "").trim();
  const recordAudit = async (ticketId: number | null, result: ScanResult) => {
    await db.insert(ticketScanEventsTable).values({
      schoolId: ctx.schoolId,
      eventId: ctx.eventId,
      ticketId,
      tokenScanned: token.slice(0, 128),
      result,
      gateLabel: ctx.gateLabel ?? null,
      scannedByStaffId: ctx.staffId ?? null,
      scannerLinkId: ctx.scannerLinkId ?? null,
    });
  };

  const counts = await liveCounts(ctx.schoolId, ctx.eventId);
  const baseMeta = {
    admitted: counts.admitted,
    total: counts.total,
    capacity: counts.capacity,
    ...capacityFlags(counts.admitted, counts.capacity),
  };

  if (!token) {
    await recordAudit(null, "invalid");
    return { result: "invalid" as ScanResult, ...baseMeta };
  }

  const [t] = await db
    .select()
    .from(ticketsTable)
    .where(
      and(
        eq(ticketsTable.schoolId, ctx.schoolId),
        eq(ticketsTable.token, token),
      ),
    );
  if (!t) {
    await recordAudit(null, "invalid");
    return { result: "invalid" as ScanResult, ...baseMeta };
  }
  if (t.eventId !== ctx.eventId) {
    await recordAudit(t.id, "wrong_event");
    return { result: "wrong_event" as ScanResult, ...baseMeta };
  }
  if (t.status === "void") {
    await recordAudit(t.id, "void");
    return { result: "void" as ScanResult, ...baseMeta };
  }

  // Resolve student + total for the display card.
  const [info] = await db
    .select({
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      grade: studentsTable.grade,
    })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.id, t.studentId),
        eq(studentsTable.schoolId, ctx.schoolId),
      ),
    );
  const [{ total }] = (await db.execute(
    sql`SELECT COUNT(*)::int AS total FROM tickets WHERE school_id = ${ctx.schoolId} AND grant_id = ${t.grantId} AND status <> 'void'`,
  )).rows as { total: number }[];
  const studentName = info ? `${info.firstName} ${info.lastName}` : "Student";
  const ticketCard = {
    studentName,
    grade: info?.grade ?? null,
    seq: t.seq,
    total,
  };

  // Optional event-day-only validity window.
  const [ev] = await db
    .select({
      eventDayOnly: ticketEventsTable.eventDayOnly,
      eventDate: ticketEventsTable.eventDate,
    })
    .from(ticketEventsTable)
    .where(
      and(
        eq(ticketEventsTable.id, ctx.eventId),
        eq(ticketEventsTable.schoolId, ctx.schoolId),
      ),
    );
  if (ev?.eventDayOnly && ev.eventDate && ev.eventDate !== localTodayYmd()) {
    await recordAudit(t.id, "outside_window");
    return {
      result: "outside_window" as ScanResult,
      ticket: ticketCard,
      eventDate: ev.eventDate,
      ...baseMeta,
    };
  }

  // Atomic first-scan-wins.
  const upd = await db.execute(
    sql`UPDATE tickets SET status='used', used_at=now(),
          used_gate=${ctx.gateLabel ?? null},
          used_by_staff_id=${ctx.staffId ?? null},
          used_via=${ctx.via}
        WHERE id=${t.id} AND status='valid' RETURNING id`,
  );
  const won = (upd.rows as unknown[]).length === 1;

  if (won) {
    await recordAudit(t.id, "admitted");
    const after = await liveCounts(ctx.schoolId, ctx.eventId);
    return {
      result: "admitted" as ScanResult,
      ticket: ticketCard,
      admitted: after.admitted,
      total: after.total,
      capacity: after.capacity,
      ...capacityFlags(after.admitted, after.capacity),
    };
  }

  // Lost the race (or already used earlier) — return when/where/who.
  const [used] = await db
    .select({
      usedAt: ticketsTable.usedAt,
      usedGate: ticketsTable.usedGate,
      usedByStaffId: ticketsTable.usedByStaffId,
      usedVia: ticketsTable.usedVia,
    })
    .from(ticketsTable)
    .where(eq(ticketsTable.id, t.id));
  let usedByName: string | null = null;
  if (used?.usedByStaffId) {
    const [s] = await db
      .select({ name: staffTable.displayName })
      .from(staffTable)
      .where(eq(staffTable.id, used.usedByStaffId));
    usedByName = s?.name ?? null;
  }
  await recordAudit(t.id, "already_used");
  return {
    result: "already_used" as ScanResult,
    ticket: ticketCard,
    usedAt: used?.usedAt ?? null,
    usedGate: used?.usedGate ?? null,
    usedVia: used?.usedVia ?? null,
    usedByName,
    ...baseMeta,
  };
}

// POST /ticketing/events/:id/scan — staff (logged-in) gate scan.
router.post(
  "/ticketing/events/:id/scan",
  requireStaff,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const staff = staffOf(req);
    const eventId = Number(req.params.id);
    const ev = await loadEvent(schoolId, eventId, res);
    if (!ev) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const token = typeof body.token === "string" ? body.token : "";
    const gateLabel =
      typeof body.gateLabel === "string" && body.gateLabel.trim()
        ? body.gateLabel.trim()
        : null;
    const result = await performScan(token, {
      schoolId,
      eventId: ev.id,
      via: "staff",
      staffId: staff.id,
      gateLabel,
    });
    res.json(result);
  },
);

// GET /ticketing/events/:id/counts — live admitted/capacity (for dashboards).
router.get(
  "/ticketing/events/:id/counts",
  requireStaff,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const eventId = Number(req.params.id);
    const ev = await loadEvent(schoolId, eventId, res);
    if (!ev) return;
    const counts = await liveCounts(schoolId, ev.id);
    res.json({ ...counts, ...capacityFlags(counts.admitted, counts.capacity) });
  },
);

// GET /ticketing/events/:id/lookup?q= — manual lookup fallback (staff). Search
// the event's grants by student name and return each ticket's status so the
// gate can admit by name when a code won't scan.
router.get(
  "/ticketing/events/:id/lookup",
  requireStaff,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const eventId = Number(req.params.id);
    const ev = await loadEvent(schoolId, eventId, res);
    if (!ev) return;
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q.length < 2) {
      res.json({ results: [] });
      return;
    }
    const like = `%${q.toLowerCase()}%`;
    const grants = await db
      .select({
        grantId: ticketGrantsTable.id,
        studentId: ticketGrantsTable.studentId,
        firstName: studentsTable.firstName,
        lastName: studentsTable.lastName,
        grade: studentsTable.grade,
      })
      .from(ticketGrantsTable)
      .innerJoin(
        studentsTable,
        eq(studentsTable.id, ticketGrantsTable.studentId),
      )
      .where(
        and(
          eq(ticketGrantsTable.schoolId, schoolId),
          eq(ticketGrantsTable.eventId, ev.id),
          sql`LOWER(${studentsTable.firstName} || ' ' || ${studentsTable.lastName}) LIKE ${like}`,
        ),
      )
      .orderBy(studentsTable.lastName)
      .limit(25);

    const results = [];
    for (const g of grants) {
      const tks = await db
        .select({
          id: ticketsTable.id,
          seq: ticketsTable.seq,
          status: ticketsTable.status,
        })
        .from(ticketsTable)
        .where(
          and(
            eq(ticketsTable.schoolId, schoolId),
            eq(ticketsTable.grantId, g.grantId),
            sql`${ticketsTable.status} <> 'void'`,
          ),
        )
        .orderBy(ticketsTable.seq);
      results.push({
        grantId: g.grantId,
        studentId: g.studentId,
        name: `${g.firstName} ${g.lastName}`,
        grade: g.grade,
        tickets: tks,
      });
    }
    res.json({ results });
  },
);

// POST /ticketing/tickets/:ticketId/admit — manual admit by ticket id (staff),
// used by the lookup fallback. Same atomic guard as a scan.
router.post(
  "/ticketing/tickets/:ticketId/admit",
  requireStaff,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const staff = staffOf(req);
    const ticketId = Number(req.params.ticketId);
    if (!Number.isInteger(ticketId)) {
      res.status(400).json({ error: "Invalid ticket id" });
      return;
    }
    const [t] = await db
      .select({ token: ticketsTable.token, eventId: ticketsTable.eventId })
      .from(ticketsTable)
      .where(
        and(
          eq(ticketsTable.id, ticketId),
          eq(ticketsTable.schoolId, schoolId),
        ),
      );
    if (!t) {
      res.status(404).json({ error: "Ticket not found" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const gateLabel =
      typeof body.gateLabel === "string" && body.gateLabel.trim()
        ? body.gateLabel.trim()
        : "Manual (name lookup)";
    const result = await performScan(t.token, {
      schoolId,
      eventId: t.eventId,
      via: "staff",
      staffId: staff.id,
      gateLabel,
    });
    res.json(result);
  },
);

// ---- scanner links (no-login volunteer scanning) --------------------------

function serializeScannerLink(
  row: typeof ticketScannerLinksTable.$inferSelect,
  req?: Request,
  plaintext?: string,
) {
  return {
    id: row.id,
    eventId: row.eventId,
    label: row.label,
    gateLabel: row.gateLabel,
    active: row.active,
    createdAt: row.createdAt,
    deactivatedAt: row.deactivatedAt,
    // The raw token is only ever returned ONCE, at creation time.
    scanUrl: plaintext
      ? `${publicAppOrigin(req)}/scan/${plaintext}`
      : undefined,
  };
}

// POST /ticketing/events/:id/scanner-links — mint a no-login scanner link.
router.post(
  "/ticketing/events/:id/scanner-links",
  requireStaff,
  requireTicketManager,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const staff = staffOf(req);
    const eventId = Number(req.params.id);
    const ev = await loadEvent(schoolId, eventId, res);
    if (!ev) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const label =
      typeof body.label === "string" && body.label.trim()
        ? body.label.trim()
        : "Gate scanner";
    const gateLabel =
      typeof body.gateLabel === "string" && body.gateLabel.trim()
        ? body.gateLabel.trim()
        : label;
    const plaintext = randomBytes(18).toString("base64url");
    const [created] = await db
      .insert(ticketScannerLinksTable)
      .values({
        schoolId,
        eventId: ev.id,
        label,
        gateLabel,
        tokenHash: hashScannerToken(plaintext),
        createdByStaffId: staff.id,
      })
      .returning();
    res
      .status(201)
      .json({ link: serializeScannerLink(created, req, plaintext) });
  },
);

// GET /ticketing/events/:id/scanner-links — list links (no plaintext tokens).
router.get(
  "/ticketing/events/:id/scanner-links",
  requireStaff,
  requireTicketManager,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const eventId = Number(req.params.id);
    const ev = await loadEvent(schoolId, eventId, res);
    if (!ev) return;
    const links = await db
      .select()
      .from(ticketScannerLinksTable)
      .where(
        and(
          eq(ticketScannerLinksTable.schoolId, schoolId),
          eq(ticketScannerLinksTable.eventId, ev.id),
        ),
      )
      .orderBy(desc(ticketScannerLinksTable.createdAt));
    res.json({ links: links.map((l) => serializeScannerLink(l)) });
  },
);

// POST /ticketing/scanner-links/:linkId/deactivate — revoke a link.
router.post(
  "/ticketing/scanner-links/:linkId/deactivate",
  requireStaff,
  requireTicketManager,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const linkId = Number(req.params.linkId);
    if (!Number.isInteger(linkId)) {
      res.status(400).json({ error: "Invalid link id" });
      return;
    }
    const [updated] = await db
      .update(ticketScannerLinksTable)
      .set({ active: false, deactivatedAt: new Date() })
      .where(
        and(
          eq(ticketScannerLinksTable.id, linkId),
          eq(ticketScannerLinksTable.schoolId, schoolId),
        ),
      )
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Link not found" });
      return;
    }
    res.json({ link: serializeScannerLink(updated) });
  },
);

// Resolve a scanner link by its plaintext token (public). Returns the active
// link row or null.
async function resolveScannerLink(plaintext: string) {
  const hash = hashScannerToken((plaintext ?? "").trim());
  const [link] = await db
    .select()
    .from(ticketScannerLinksTable)
    .where(eq(ticketScannerLinksTable.tokenHash, hash));
  if (!link || !link.active) return null;
  return link;
}

// GET /ticketing/scan/:linkToken/info — PUBLIC. Lets the volunteer scanner page
// show the event name + live "X of Y admitted" without any login or roster
// exposure.
router.get("/ticketing/scan/:linkToken/info", async (req, res) => {
  const link = await resolveScannerLink(req.params.linkToken);
  if (!link) {
    res.status(404).json({ error: "Scanner link not found or deactivated" });
    return;
  }
  const [ev] = await db
    .select({
      name: ticketEventsTable.name,
      eventDate: ticketEventsTable.eventDate,
      startTime: ticketEventsTable.startTime,
      location: ticketEventsTable.location,
    })
    .from(ticketEventsTable)
    .where(
      and(
        eq(ticketEventsTable.id, link.eventId),
        eq(ticketEventsTable.schoolId, link.schoolId),
      ),
    );
  const counts = await liveCounts(link.schoolId, link.eventId);
  res.setHeader("Cache-Control", "no-store");
  res.json({
    event: {
      name: ev?.name ?? "Event",
      eventDate: ev?.eventDate ?? null,
      startTime: ev?.startTime ?? null,
      location: ev?.location ?? null,
    },
    gateLabel: link.gateLabel,
    ...counts,
    ...capacityFlags(counts.admitted, counts.capacity),
  });
});

// POST /ticketing/scan/:linkToken — PUBLIC no-login scan via a volunteer link.
router.post("/ticketing/scan/:linkToken", async (req, res) => {
  const link = await resolveScannerLink(req.params.linkToken);
  if (!link) {
    res.status(404).json({ error: "Scanner link not found or deactivated" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const token = typeof body.token === "string" ? body.token : "";
  const result = await performScan(token, {
    schoolId: link.schoolId,
    eventId: link.eventId,
    via: "scanner_link",
    scannerLinkId: link.id,
    gateLabel: link.gateLabel,
  });
  res.setHeader("Cache-Control", "no-store");
  res.json(result);
});

// ---- void / reissue --------------------------------------------------------

// POST /ticketing/grants/:grantId/void — void this family's UNUSED tickets
// (e.g. a code leaked). Used tickets are left intact (attendance record).
// Body: { reason?, seq? } — seq voids a single ticket, otherwise all valid.
router.post(
  "/ticketing/grants/:grantId/void",
  requireStaff,
  requireTicketManager,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const grantId = Number(req.params.grantId);
    if (!Number.isInteger(grantId)) {
      res.status(400).json({ error: "Invalid grant id" });
      return;
    }
    const [grant] = await db
      .select({ id: ticketGrantsTable.id })
      .from(ticketGrantsTable)
      .where(
        and(
          eq(ticketGrantsTable.id, grantId),
          eq(ticketGrantsTable.schoolId, schoolId),
        ),
      );
    if (!grant) {
      res.status(404).json({ error: "Grant not found" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const reason =
      typeof body.reason === "string" && body.reason.trim()
        ? body.reason.trim()
        : "Voided by office";
    const seq =
      body.seq === undefined || body.seq === null ? null : Number(body.seq);

    const conds = [
      eq(ticketsTable.schoolId, schoolId),
      eq(ticketsTable.grantId, grantId),
      eq(ticketsTable.status, "valid"),
    ];
    if (seq !== null && Number.isInteger(seq)) {
      conds.push(eq(ticketsTable.seq, seq));
    }
    const voided = await db
      .update(ticketsTable)
      .set({ status: "void", voidReason: reason })
      .where(and(...conds))
      .returning({ id: ticketsTable.id });
    res.json({ ok: true, voided: voided.length });
  },
);

// POST /ticketing/grants/:grantId/reissue — void all currently-valid tickets
// and mint the same number of fresh tokens (a lost/leaked set is killed and the
// family gets new codes). Used tickets are untouched. Resets email status to
// pending so the office knows to re-send/re-print.
router.post(
  "/ticketing/grants/:grantId/reissue",
  requireStaff,
  requireTicketManager,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const grantId = Number(req.params.grantId);
    if (!Number.isInteger(grantId)) {
      res.status(400).json({ error: "Invalid grant id" });
      return;
    }
    const [grant] = await db
      .select()
      .from(ticketGrantsTable)
      .where(
        and(
          eq(ticketGrantsTable.id, grantId),
          eq(ticketGrantsTable.schoolId, schoolId),
        ),
      );
    if (!grant) {
      res.status(404).json({ error: "Grant not found" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const reason =
      typeof body.reason === "string" && body.reason.trim()
        ? body.reason.trim()
        : "Reissued (lost/leaked codes)";

    const existing = await db
      .select({ id: ticketsTable.id, seq: ticketsTable.seq, status: ticketsTable.status })
      .from(ticketsTable)
      .where(
        and(
          eq(ticketsTable.schoolId, schoolId),
          eq(ticketsTable.grantId, grantId),
        ),
      );
    const valid = existing.filter((t) => t.status === "valid");
    const maxSeq = existing.reduce((m, t) => Math.max(m, t.seq), 0);

    if (valid.length > 0) {
      await db
        .update(ticketsTable)
        .set({ status: "void", voidReason: reason })
        .where(
          and(
            eq(ticketsTable.schoolId, schoolId),
            eq(ticketsTable.grantId, grantId),
            eq(ticketsTable.status, "valid"),
          ),
        );
    }
    const fresh: (typeof ticketsTable.$inferInsert)[] = [];
    for (let i = 1; i <= valid.length; i++) {
      fresh.push({
        schoolId,
        eventId: grant.eventId,
        grantId,
        studentId: grant.studentId,
        token: genTicketToken(),
        seq: maxSeq + i,
        status: "valid",
      });
    }
    if (fresh.length > 0) await db.insert(ticketsTable).values(fresh);

    await db
      .update(ticketGrantsTable)
      .set({
        emailStatus: grant.guardianEmail ? "pending" : "no_email",
        emailSentAt: null,
        emailError: null,
        printedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(ticketGrantsTable.id, grantId));

    res.json({ ok: true, voided: valid.length, reissued: fresh.length });
  },
);

export default router;
