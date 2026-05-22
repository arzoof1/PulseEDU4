import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  pbisEntriesTable,
  tardiesTable,
  pulloutsTable,
  interventionEntriesTable,
  studentsTable,
} from "@workspace/db";
import { eq, and, gte, lt, desc, isNull, inArray } from "drizzle-orm";

// =============================================================================
// PULSE — School-wide signage feeds.
// -----------------------------------------------------------------------------
// These endpoints back the "Today's Heartbeat" hallway/TV signage screen.
// They are deliberately allowed to be unauthenticated when called with an
// explicit `?schoolId=N` query param, because signage displays usually run on
// kiosk hardware that isn't signed in. To avoid casual PII exposure the event
// feed always masks student names to "First L." (configurable per-school in
// the future).
//
// SECURITY NOTE: The unauthenticated mode trusts whoever knows the URL. A
// follow-up should swap `?schoolId=` for a per-school signed signage token
// (similar to parent invite tokens). For MVP signage on internal kiosks this
// is acceptable.
// =============================================================================

const router: IRouter = Router();

type EventKind = "positive" | "negative" | "neutral";
interface PulseEvent {
  id: string;
  kind: EventKind;
  source: "pbis" | "tardy" | "pullout" | "intervention";
  studentId: string;          // first name + last initial (masked)
  studentInitials: string;    // 2-char initials for avatar
  staffName: string;
  what: string;
  detail: string;
  points: number | null;
  createdAt: string;          // ISO
  // House the awarded student belongs to. Populated on positive PBIS
  // events so the houses signage can fire its rise-and-deliver animation
  // on the correct bar. Null for non-PBIS events or unaffiliated students.
  houseId: number | null;
}

function resolveSchoolId(req: Request, res: Response): number | null {
  if (req.schoolId) return req.schoolId;
  const raw = req.query.schoolId;
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isFinite(n) || n <= 0) {
    res.status(400).json({ error: "schoolId required (sign in or pass ?schoolId=N)" });
    return null;
  }
  return n;
}

function clampWindow(req: Request, def = 35, max = 1440): number {
  const raw = req.query.windowMinutes;
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.max(Math.floor(n), 1), max);
}

function maskName(first: string, last: string): { display: string; initials: string } {
  const f = first?.trim() || "?";
  const l = last?.trim() || "";
  return {
    display: l ? `${f} ${l.charAt(0)}.` : f,
    initials: ((f.charAt(0) || "?") + (l.charAt(0) || "")).toUpperCase(),
  };
}

async function loadStudentLookup(schoolId: number, studentIds: string[]) {
  if (studentIds.length === 0)
    return new Map<string, { firstName: string; lastName: string; houseId: number | null }>();
  const rows = await db
    .select({
      studentId: studentsTable.studentId,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      houseId: studentsTable.houseId,
    })
    .from(studentsTable)
    .where(and(eq(studentsTable.schoolId, schoolId), inArray(studentsTable.studentId, studentIds)));
  return new Map(
    rows.map((r) => [r.studentId, { firstName: r.firstName, lastName: r.lastName, houseId: r.houseId ?? null }]),
  );
}

// Strip sensitive free-text and staff names from a feed before sending it
// to an unauthenticated kiosk caller. We keep the kind/source/what/points
// so the screen still tells a story, but the rich `detail` notes (which
// can describe specific behaviors) and individual staff names stay private.
function redactForPublic(events: PulseEvent[]): PulseEvent[] {
  return events.map((e) => ({
    ...e,
    detail: "",
    staffName: "Staff",
  }));
}

async function gatherEvents(schoolId: number, sinceIso: string, untilIso: string): Promise<PulseEvent[]> {
  // Each source query is filtered by school + time window. Voided PBIS
  // entries are excluded so corrected mistakes don't keep blinking on the
  // signage screen.
  const [pbisRows, tardyRows, pulloutRows, interventionRows] = await Promise.all([
    db
      .select()
      .from(pbisEntriesTable)
      .where(
        and(
          eq(pbisEntriesTable.schoolId, schoolId),
          gte(pbisEntriesTable.createdAt, sinceIso),
          lt(pbisEntriesTable.createdAt, untilIso),
          isNull(pbisEntriesTable.voidedAt),
        ),
      ),
    db
      .select()
      .from(tardiesTable)
      .where(
        and(
          eq(tardiesTable.schoolId, schoolId),
          gte(tardiesTable.createdAt, sinceIso),
          lt(tardiesTable.createdAt, untilIso),
        ),
      ),
    db
      .select()
      .from(pulloutsTable)
      .where(
        and(
          eq(pulloutsTable.schoolId, schoolId),
          gte(pulloutsTable.requestedAt, sinceIso),
          lt(pulloutsTable.requestedAt, untilIso),
        ),
      ),
    db
      .select()
      .from(interventionEntriesTable)
      .where(
        and(
          eq(interventionEntriesTable.schoolId, schoolId),
          gte(interventionEntriesTable.createdAt, sinceIso),
          lt(interventionEntriesTable.createdAt, untilIso),
        ),
      ),
  ]);

  const studentIds = Array.from(
    new Set([
      ...pbisRows.map((r) => r.studentId),
      ...tardyRows.map((r) => r.studentId),
      ...pulloutRows.map((r) => r.studentId),
      ...interventionRows.map((r) => r.studentId),
    ]),
  );
  const lookup = await loadStudentLookup(schoolId, studentIds);
  const nameFor = (sid: string) => {
    const r = lookup.get(sid);
    return maskName(r?.firstName ?? "Student", r?.lastName ?? "");
  };
  const houseFor = (sid: string) => lookup.get(sid)?.houseId ?? null;

  const events: PulseEvent[] = [];

  for (const r of pbisRows) {
    const n = nameFor(r.studentId);
    events.push({
      id: `pbis-${r.id}`,
      kind: r.polarity === "negative" ? "negative" : "positive",
      source: "pbis",
      studentId: n.display,
      studentInitials: n.initials,
      staffName: r.staffName,
      what: r.reason,
      detail: r.note ?? "",
      points: r.points,
      createdAt: r.createdAt,
      houseId: houseFor(r.studentId),
    });
  }
  for (const r of tardyRows) {
    const n = nameFor(r.studentId);
    events.push({
      id: `tardy-${r.id}`,
      kind: "neutral",
      source: "tardy",
      studentId: n.display,
      studentInitials: n.initials,
      staffName: r.teacherName,
      what: r.entryType === "tardy" ? `Tardy · ${r.period}` : `${r.entryType.replace(/_/g, " ")} · ${r.period}`,
      detail: r.reason || "",
      points: null,
      createdAt: r.createdAt,
      houseId: null,
    });
  }
  for (const r of pulloutRows) {
    const n = nameFor(r.studentId);
    events.push({
      id: `pullout-${r.id}`,
      kind: "negative",
      source: "pullout",
      studentId: n.display,
      studentInitials: n.initials,
      staffName: r.requestedByName,
      what: "Pull-out · Restorative",
      detail: r.editedReason ?? r.reason ?? "",
      points: null,
      createdAt: r.requestedAt,
      houseId: null,
    });
  }
  for (const r of interventionRows) {
    const n = nameFor(r.studentId);
    events.push({
      id: `intervention-${r.id}`,
      kind: "positive",
      source: "intervention",
      studentId: n.display,
      studentInitials: n.initials,
      staffName: r.staffName,
      what: r.interventionType,
      detail: r.note ?? "",
      points: null,
      createdAt: r.createdAt,
      houseId: null,
    });
  }

  events.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return events;
}

// GET /api/pulse/events?schoolId=N&windowMinutes=35&limit=50
router.get("/pulse/events", async (req, res) => {
  // `isPublic` = served via ?schoolId= without an authenticated session.
  // We snapshot it BEFORE resolveSchoolId mutates anything because that
  // helper accepts both auth flavors.
  const isPublic = !req.schoolId;
  const schoolId = resolveSchoolId(req, res);
  if (schoolId === null) return;

  const windowMinutes = clampWindow(req, 35);
  const until = new Date();
  const since = new Date(until.getTime() - windowMinutes * 60_000);
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);

  try {
    const all = await gatherEvents(schoolId, since.toISOString(), until.toISOString());
    const events = (isPublic ? redactForPublic(all) : all).slice(0, limit);
    res.json({
      windowMinutes,
      since: since.toISOString(),
      until: until.toISOString(),
      events,
    });
  } catch (_err) {
    // Don't leak `String(err)` (stack/sql) to anonymous callers.
    res.status(500).json({ error: "Failed to load pulse events" });
  }
});

// GET /api/pulse/heartbeat?schoolId=N&windowMinutes=35
// Returns aggregate counts for the headline mood meter on the signage screen.
// Compares against the same-length window 24h earlier so the "Trending up
// vs. yesterday" chip has something to base its arrow on.
router.get("/pulse/heartbeat", async (req, res) => {
  const schoolId = resolveSchoolId(req, res);
  if (schoolId === null) return;

  const windowMinutes = clampWindow(req, 35);
  const until = new Date();
  const since = new Date(until.getTime() - windowMinutes * 60_000);
  const ydUntil = new Date(until.getTime() - 24 * 60 * 60_000);
  const ydSince = new Date(ydUntil.getTime() - windowMinutes * 60_000);

  function summarize(events: PulseEvent[]) {
    let pos = 0, neg = 0, neu = 0, netPts = 0;
    for (const e of events) {
      if (e.kind === "positive") pos++;
      else if (e.kind === "negative") neg++;
      else neu++;
      if (typeof e.points === "number") {
        netPts += e.kind === "negative" ? -Math.abs(e.points) : e.points;
      }
    }
    const total = pos + neg + neu;
    // Match the meter math used by HousesSignage + ParentMoodMeter:
    // positivePct = positive / (positive + negative). Neutral "concern"
    // events (tardies, etc.) are surfaced via their own count and don't
    // inflate the negative side of the bar.
    const polarized = pos + neg;
    return {
      positive: pos,
      negative: neg,
      concern: neu,
      total,
      netPoints: netPts,
      // When there are zero polarized signals (quiet morning, fresh day),
      // render the bar as a steady 50/50 resting state rather than slamming
      // it all-red. Matches the parent + student-timeline meters.
      positivePct: polarized > 0 ? Math.round((pos / polarized) * 100) : 50,
    };
  }

  try {
    const [todayEvents, yEvents] = await Promise.all([
      gatherEvents(schoolId, since.toISOString(), until.toISOString()),
      gatherEvents(schoolId, ydSince.toISOString(), ydUntil.toISOString()),
    ]);
    const today = summarize(todayEvents);
    const yesterday = summarize(yEvents);
    const trendDelta = today.netPoints - yesterday.netPoints;
    const mood: "positive" | "neutral" | "negative" =
      today.netPoints > 0 ? "positive" : today.netPoints < 0 ? "negative" : "neutral";

    res.json({
      schoolId,
      windowMinutes,
      since: since.toISOString(),
      until: until.toISOString(),
      mood,
      today,
      yesterday,
      trendDelta,
      trendDirection: trendDelta > 0 ? "up" : trendDelta < 0 ? "down" : "flat",
    });
  } catch (_err) {
    res.status(500).json({ error: "Failed to load heartbeat" });
  }
});

// GET /api/pulse/student-timeline?studentId=N&windowDays=14
//
// Per-student deep-dive timeline used by the staff-facing "Pulse · Student
// Timeline" signage screen (parent conferences, MTSS huddles, ISS check-ins).
// REQUIRES staff session — unlike the school-wide signage feeds this returns
// PII-bearing free-text and staff names, so we never honor `?schoolId=`
// alone.
router.get("/pulse/student-timeline", async (req, res) => {
  const schoolId = req.schoolId;
  if (!schoolId) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const studentRowId = Number(req.query.studentId);
  if (!Number.isFinite(studentRowId) || studentRowId <= 0) {
    res.status(400).json({ error: "studentId required" });
    return;
  }

  const rawDays = Number(req.query.windowDays);
  const windowDays =
    Number.isFinite(rawDays) && rawDays > 0 ? Math.min(Math.floor(rawDays), 90) : 14;
  const until = new Date();
  const since = new Date(until.getTime() - windowDays * 24 * 60 * 60_000);

  try {
    const [student] = await db
      .select()
      .from(studentsTable)
      .where(and(eq(studentsTable.id, studentRowId), eq(studentsTable.schoolId, schoolId)));
    if (!student) {
      res.status(404).json({ error: "Student not found" });
      return;
    }

    // Pull each event source for THIS student in the window.
    const [pbisRows, tardyRows, pulloutRows, interventionRows] = await Promise.all([
      db
        .select()
        .from(pbisEntriesTable)
        .where(
          and(
            eq(pbisEntriesTable.schoolId, schoolId),
            eq(pbisEntriesTable.studentId, student.studentId),
            gte(pbisEntriesTable.createdAt, since.toISOString()),
            lt(pbisEntriesTable.createdAt, until.toISOString()),
            isNull(pbisEntriesTable.voidedAt),
          ),
        ),
      db
        .select()
        .from(tardiesTable)
        .where(
          and(
            eq(tardiesTable.schoolId, schoolId),
            eq(tardiesTable.studentId, student.studentId),
            gte(tardiesTable.createdAt, since.toISOString()),
            lt(tardiesTable.createdAt, until.toISOString()),
          ),
        ),
      db
        .select()
        .from(pulloutsTable)
        .where(
          and(
            eq(pulloutsTable.schoolId, schoolId),
            eq(pulloutsTable.studentId, student.studentId),
            gte(pulloutsTable.requestedAt, since.toISOString()),
            lt(pulloutsTable.requestedAt, until.toISOString()),
          ),
        ),
      db
        .select()
        .from(interventionEntriesTable)
        .where(
          and(
            eq(interventionEntriesTable.schoolId, schoolId),
            eq(interventionEntriesTable.studentId, student.studentId),
            gte(interventionEntriesTable.createdAt, since.toISOString()),
            lt(interventionEntriesTable.createdAt, until.toISOString()),
          ),
        ),
    ]);

    const events: PulseEvent[] = [];
    const masked = maskName(student.firstName, student.lastName);

    for (const r of pbisRows) {
      events.push({
        id: `pbis-${r.id}`,
        kind: r.polarity === "negative" ? "negative" : "positive",
        source: "pbis",
        studentId: masked.display,
        studentInitials: masked.initials,
        staffName: r.staffName,
        what: r.reason,
        detail: r.note ?? "",
        points: r.points,
        createdAt: r.createdAt,
        houseId: student.houseId ?? null,
      });
    }
    for (const r of tardyRows) {
      events.push({
        id: `tardy-${r.id}`,
        kind: "neutral",
        source: "tardy",
        studentId: masked.display,
        studentInitials: masked.initials,
        staffName: r.teacherName,
        what:
          r.entryType === "tardy"
            ? `Tardy · ${r.period}`
            : `${r.entryType.replace(/_/g, " ")} · ${r.period}`,
        detail: r.reason || "",
        points: null,
        createdAt: r.createdAt,
        houseId: null,
      });
    }
    for (const r of pulloutRows) {
      events.push({
        id: `pullout-${r.id}`,
        kind: "negative",
        source: "pullout",
        studentId: masked.display,
        studentInitials: masked.initials,
        staffName: r.requestedByName,
        what: "Pull-out · Restorative",
        detail: r.editedReason ?? r.reason ?? "",
        points: null,
        createdAt: r.requestedAt,
        houseId: null,
      });
    }
    for (const r of interventionRows) {
      events.push({
        id: `intervention-${r.id}`,
        kind: "positive",
        source: "intervention",
        studentId: masked.display,
        studentInitials: masked.initials,
        staffName: r.staffName,
        what: r.interventionType,
        detail: r.note ?? "",
        points: null,
        createdAt: r.createdAt,
        houseId: null,
      });
    }

    events.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

    // Roll-ups for the header cards / mood meter.
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
    let totalPoints = 0;
    let weekPoints = 0;
    let weekPositive = 0;
    let weekNegative = 0;
    let weekConcern = 0;
    for (const e of events) {
      if (typeof e.points === "number") {
        const signed = e.kind === "negative" ? -Math.abs(e.points) : e.points;
        totalPoints += signed;
        if (e.createdAt >= weekAgo) weekPoints += signed;
      }
      if (e.createdAt >= weekAgo) {
        if (e.kind === "positive") weekPositive++;
        else if (e.kind === "negative") weekNegative++;
        else weekConcern++;
      }
    }

    res.json({
      schoolId,
      windowDays,
      since: since.toISOString(),
      until: until.toISOString(),
      student: {
        id: student.id,
        studentId: student.studentId,
        firstName: student.firstName,
        lastName: student.lastName,
        grade: student.grade,
        houseId: student.houseId,
      },
      summary: {
        totalPoints,
        weekPoints,
        weekPositive,
        weekNegative,
        weekConcern,
        eventCount: events.length,
      },
      events,
    });
  } catch (_err) {
    res.status(500).json({ error: "Failed to load student timeline" });
  }
});

export default router;
