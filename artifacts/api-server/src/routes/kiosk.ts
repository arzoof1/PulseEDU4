import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import bcrypt from "bcryptjs";
import { randomBytes, createHash } from "node:crypto";
import {
  db,
  hallPassesTable,
  hallPassQueueTable,
  locationsTable,
  locationAllowedDestinationsTable,
  staffDefaultsTable,
  staffTable,
  kioskActivationsTable,
  kioskEnrollTokensTable,
  adminNotificationsTable,
  studentsTable,
  schoolsTable,
  housesTable,
  schoolSettingsTable,
  classSigninsTable,
  bellSchedulesTable,
  bellSchedulePeriodsTable,
} from "@workspace/db";
import { renderKioskCardsPdf } from "../lib/kioskCardsPdf.js";
import { and, eq, inArray, isNull, gt, desc, sql, ne, asc } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import { config } from "../data/config";
import { requireSchool } from "../lib/scope.js";
import { getSchoolTimezone, startOfDayUtc } from "../lib/schoolYear.js";
import { loadBrandingForSchool } from "./schoolBranding.js";
import {
  findPolarityConflict,
  polarityConflictMessage,
} from "./polarityPairs";
import {
  findDailyLimitConflict,
  dailyLimitConflictMessage,
} from "./studentHallPassLimits";
import {
  consumeQueueEntry,
  peekNextInQueue,
  QUEUE_CAP,
  getCurrentPeriodKey,
} from "./hallPassQueue";

// Default TTL for the legacy email-+-password activation flow. The
// printed-card path (`/kiosk/activate-by-enrollment`,
// `/kiosk/activate-by-pin`) uses ENROLL_TTL_MS; the Core Team sub /
// proxy path picks between END_OF_DAY and ENROLL based on the request.
const ACTIVATION_TTL_MS = 12 * 60 * 60 * 1000;
const ENROLL_TTL_MS = 14 * 24 * 60 * 60 * 1000;

// "End of school day" cutoff — used for sub/proxy activations whose
// default duration is "today only". Currently 11:59 PM local server
// time; refined later when per-school IANA timezone lands (replit.md
// future-work item). The TTL just needs to be a comfortable "until
// the building closes" boundary, not minute-perfect.
function endOfDayTtlMs(): number {
  const now = new Date();
  const endOfDay = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    23,
    59,
    0,
    0,
  );
  return Math.max(60 * 1000, endOfDay.getTime() - now.getTime());
}

const router: IRouter = Router();

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function requireStaff(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const staffId = req.staffId;
  if (!staffId) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const [staff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, staffId));
  if (!staff || !staff.active) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  (req as Request & { staff: typeof staff }).staff = staff;
  next();
}

async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  await requireStaff(req, res, () => {
    const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
      .staff;
    if (!staff.isAdmin && !staff.isSuperUser) {
      res.status(403).json({ error: "Admin only" });
      return;
    }
    next();
  });
}

// Shared room-resolution + activation creation. Used by the
// password-based public activate route so the conflict, dry-run, and
// fallback-picker semantics live in one place.
//
// Returns:
//  - { kind: "ok", body }                 → 201 (caller sends as-is)
//  - { kind: "needs_room", body }         → 409 (no default + no room picked)
//  - { kind: "room_taken", body }         → 409 (room already has live kiosk)
//  - { kind: "bad_room", body }           → 400 (room not a valid origin)
//  - { kind: "dry_run", body }            → 200 (just returning rooms+default)
type ActivateOutcome =
  | { kind: "ok"; body: Record<string, unknown> }
  | { kind: "needs_room"; body: Record<string, unknown> }
  | { kind: "room_taken"; body: Record<string, unknown> }
  | { kind: "bad_room"; body: Record<string, unknown> }
  | { kind: "dry_run"; body: Record<string, unknown> };

async function resolveActivation(args: {
  staff: typeof staffTable.$inferSelect;
  room: string | undefined;
  dryRun: boolean;
  replaceExisting: boolean;
  deviceLabel: string | null;
  deviceFingerprint: string | null;
  // Phase 1 additions. All optional so the legacy password path stays
  // unchanged. `staff` is the kiosk's *identity* (whose name shows on
  // the masthead and whose default room we pull); `actorStaffId` is
  // who actually triggered the activation (a Core Team sub-coverer for
  // proxy activations, otherwise == staff.id).
  ttlMs?: number;
  sessionKind?: "password" | "enroll" | "proxy";
  enrollTokenId?: number | null;
  actorStaffId?: number;
  proxyForStaffId?: number | null;
}): Promise<ActivateOutcome> {
  const { staff, dryRun, replaceExisting, deviceLabel, deviceFingerprint } =
    args;
  const ttlMs = args.ttlMs ?? ACTIVATION_TTL_MS;
  const sessionKind = args.sessionKind ?? "password";
  const enrollTokenId = args.enrollTokenId ?? null;
  const actorStaffId = args.actorStaffId ?? staff.id;
  const proxyForStaffId = args.proxyForStaffId ?? null;

  const [defaultRow] = await db
    .select()
    .from(staffDefaultsTable)
    .where(eq(staffDefaultsTable.staffId, staff.id));
  const defaultRoom = defaultRow?.defaultLocationName ?? null;

  // Origin rooms are scoped to the activating staff's school.
  const originLocations = (
    await db
      .select()
      .from(locationsTable)
      .where(
        and(
          eq(locationsTable.isOrigin, true),
          eq(locationsTable.active, true),
          eq(locationsTable.schoolId, staff.schoolId),
        ),
      )
  ).map((l) => l.name);

  // Dry-run is what the "Pick a different room" link calls so the client can
  // render a searchable dropdown without committing an activation. We still
  // require a valid staff record to reach this point so the room list isn't
  // exposed publicly.
  if (dryRun) {
    return {
      kind: "dry_run",
      body: {
        defaultRoom,
        locations: originLocations,
        staffName: staff.displayName,
      },
    };
  }

  let chosenRoom: string;
  let usedFallbackPicker = false;

  if (typeof args.room === "string" && args.room.trim()) {
    const candidate = args.room.trim();
    if (!originLocations.includes(candidate)) {
      return {
        kind: "bad_room",
        body: { error: `Room "${candidate}" is not a valid kiosk room` },
      };
    }
    chosenRoom = candidate;
    if (!defaultRoom) usedFallbackPicker = true;
  } else if (defaultRoom) {
    chosenRoom = defaultRoom;
  } else {
    return {
      kind: "needs_room",
      body: {
        error: "No default room set",
        needsRoom: true,
        locations: originLocations,
      },
    };
  }

  // Room-conflict check + replace + insert all run inside a single
  // transaction guarded by a per-(school, room) advisory lock. Without
  // this, two concurrent activates can both pass the SELECT and both
  // INSERT — the partial unique index on (school_id, room) WHERE
  // deactivated_at IS NULL would catch one of them, but the advisory
  // lock turns that error path into a clean serialized flow. Filter on
  // schoolId AND room so "Room 204" in two different schools never
  // collide.
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + ttlMs);

  type TxOutcome =
    | { kind: "ok"; replacedPriorStaffId: number | null }
    | {
        kind: "room_taken";
        existing: {
          activatedAt: Date;
          deviceLabel: string | null;
          activatedByName: string | null;
        };
      };

  const txOutcome: TxOutcome = await db.transaction(async (tx) => {
    // Two-int advisory lock keyed by (schoolId, hash(room)) so concurrent
    // activations for the same room serialize, but unrelated rooms run in
    // parallel. Released automatically at txn end.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${staff.schoolId}::int, hashtext(${chosenRoom})::int)`,
    );

    const livePriorRows = await tx
      .select({
        id: kioskActivationsTable.id,
        staffId: kioskActivationsTable.staffId,
        activatedAt: kioskActivationsTable.activatedAt,
        expiresAt: kioskActivationsTable.expiresAt,
        deviceLabel: kioskActivationsTable.deviceLabel,
        activatedByName: staffTable.displayName,
      })
      .from(kioskActivationsTable)
      .leftJoin(staffTable, eq(staffTable.id, kioskActivationsTable.staffId))
      .where(
        and(
          eq(kioskActivationsTable.schoolId, staff.schoolId),
          eq(kioskActivationsTable.room, chosenRoom),
          isNull(kioskActivationsTable.deactivatedAt),
        ),
      );

    const now = new Date();
    // Expired rows are zombies — they failed to deactivate cleanly but
    // are no longer "live" by the queue/branding routes. Cleaning them
    // up here also frees the partial-unique-index slot for our INSERT.
    const expiredRows = livePriorRows.filter((r) => r.expiresAt <= now);
    const stillLiveRows = livePriorRows.filter((r) => r.expiresAt > now);

    if (expiredRows.length > 0) {
      await tx
        .update(kioskActivationsTable)
        .set({ deactivatedAt: now, deactivatedByStaffId: staff.id })
        .where(
          and(
            eq(kioskActivationsTable.schoolId, staff.schoolId),
            eq(kioskActivationsTable.room, chosenRoom),
            isNull(kioskActivationsTable.deactivatedAt),
            sql`${kioskActivationsTable.expiresAt} <= ${now}`,
          ),
        );
    }

    const blocking = stillLiveRows[0] ?? null;
    if (blocking && !replaceExisting) {
      return {
        kind: "room_taken",
        existing: {
          activatedAt: blocking.activatedAt,
          deviceLabel: blocking.deviceLabel,
          activatedByName: blocking.activatedByName,
        },
      };
    }

    let replacedPriorStaffId: number | null = null;
    if (blocking && replaceExisting) {
      replacedPriorStaffId = blocking.staffId;
      await tx
        .update(kioskActivationsTable)
        .set({ deactivatedAt: now, deactivatedByStaffId: staff.id })
        .where(eq(kioskActivationsTable.id, blocking.id));
    }

    await tx.insert(kioskActivationsTable).values({
      schoolId: staff.schoolId,
      tokenHash,
      room: chosenRoom,
      staffId: staff.id,
      expiresAt,
      deviceLabel,
      deviceFingerprint,
      sessionKind,
      enrollTokenId,
      activatedByStaffId: actorStaffId,
      proxyForStaffId,
    });

    return { kind: "ok", replacedPriorStaffId };
  });

  if (txOutcome.kind === "room_taken") {
    return {
      kind: "room_taken",
      body: {
        error: `Room "${chosenRoom}" already has an active kiosk`,
        roomTaken: true,
        room: chosenRoom,
        existing: txOutcome.existing,
      },
    };
  }

  // Audit-trail notifications fire OUTSIDE the txn so they can't roll the
  // activation back. The fallback-picker case (no default room set) and
  // the cross-staff take-over case both want admin visibility — the
  // latter is the abuse signal: "did Mr. X take over Mrs. Y's kiosk in
  // the middle of the period?"
  if (usedFallbackPicker) {
    await db.insert(adminNotificationsTable).values({
      schoolId: staff.schoolId,
      type: "kiosk_default_room_missing",
      payload: {
        staffId: staff.id,
        staffEmail: staff.email,
        staffDisplayName: staff.displayName,
        chosenRoom,
        activatedAt: new Date().toISOString(),
      },
    });
  }

  if (
    txOutcome.replacedPriorStaffId !== null &&
    txOutcome.replacedPriorStaffId !== staff.id
  ) {
    const [priorStaff] = await db
      .select({
        id: staffTable.id,
        displayName: staffTable.displayName,
        email: staffTable.email,
      })
      .from(staffTable)
      .where(eq(staffTable.id, txOutcome.replacedPriorStaffId));
    await db.insert(adminNotificationsTable).values({
      schoolId: staff.schoolId,
      type: "kiosk_takeover_cross_staff",
      payload: {
        room: chosenRoom,
        takeoverByStaffId: staff.id,
        takeoverByName: staff.displayName,
        takeoverByEmail: staff.email,
        replacedStaffId: priorStaff?.id ?? null,
        replacedStaffName: priorStaff?.displayName ?? null,
        replacedStaffEmail: priorStaff?.email ?? null,
        at: new Date().toISOString(),
      },
    });
  }

  return {
    kind: "ok",
    body: {
      token,
      room: chosenRoom,
      staffName: staff.displayName,
      expiresAt: expiresAt.toISOString(),
      replacedPrior: txOutcome.replacedPriorStaffId !== null,
    },
  };
}

function cleanDeviceFields(req: Request) {
  const { deviceLabel, deviceFingerprint } = (req.body ?? {}) as {
    deviceLabel?: unknown;
    deviceFingerprint?: unknown;
  };
  return {
    deviceLabel:
      typeof deviceLabel === "string" && deviceLabel.trim()
        ? deviceLabel.trim().slice(0, 200)
        : null,
    deviceFingerprint:
      typeof deviceFingerprint === "string" && deviceFingerprint.trim()
        ? deviceFingerprint.trim().slice(0, 100)
        : null,
  };
}

router.post("/kiosk/activate", async (req, res) => {
  const { email, password, room, dryRun, replaceExisting } = req.body ?? {};

  if (
    typeof email !== "string" ||
    typeof password !== "string" ||
    !email.trim() ||
    !password
  ) {
    res.status(400).json({ error: "email and password are required" });
    return;
  }

  const normalizedEmail = email.trim().toLowerCase();
  const [staff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.email, normalizedEmail));

  if (!staff || !staff.active) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }
  const ok = await bcrypt.compare(password, staff.passwordHash);
  if (!ok) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  const { deviceLabel, deviceFingerprint } = cleanDeviceFields(req);
  const outcome = await resolveActivation({
    staff,
    room: typeof room === "string" ? room : undefined,
    dryRun: dryRun === true,
    replaceExisting: replaceExisting === true,
    deviceLabel,
    deviceFingerprint,
  });

  switch (outcome.kind) {
    case "ok":
      res.status(201).json(outcome.body);
      return;
    case "dry_run":
      res.status(200).json(outcome.body);
      return;
    case "needs_room":
    case "room_taken":
      res.status(409).json(outcome.body);
      return;
    case "bad_room":
      res.status(400).json(outcome.body);
      return;
  }
});

router.get("/kiosk/activation/:token", async (req, res) => {
  const token = req.params.token;
  if (!token || token.length < 16) {
    res.status(400).json({ error: "Invalid token" });
    return;
  }
  const [act] = await db
    .select()
    .from(kioskActivationsTable)
    .where(
      and(
        eq(kioskActivationsTable.tokenHash, hashToken(token)),
        isNull(kioskActivationsTable.deactivatedAt),
        gt(kioskActivationsTable.expiresAt, new Date()),
      ),
    );
  if (!act) {
    res.status(401).json({ error: "Activation not found, revoked, or expired" });
    return;
  }
  const [staff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, act.staffId));
  res.json({
    room: act.room,
    staffName: staff?.displayName ?? null,
    activatedAt: act.activatedAt,
    expiresAt: act.expiresAt,
    deviceLabel: act.deviceLabel,
  });
});

// Branding for an activated kiosk — uses the same activation token already
// stored on the device so the masthead can pull the school's gradient/logo
// without needing staff auth.
router.get("/kiosk/branding/:token", async (req, res) => {
  const token = req.params.token;
  if (!token || token.length < 16) {
    res.status(400).json({ error: "Invalid token" });
    return;
  }
  const [act] = await db
    .select({ schoolId: kioskActivationsTable.schoolId })
    .from(kioskActivationsTable)
    .where(
      and(
        eq(kioskActivationsTable.tokenHash, hashToken(token)),
        isNull(kioskActivationsTable.deactivatedAt),
        gt(kioskActivationsTable.expiresAt, new Date()),
      ),
    );
  if (!act) {
    res
      .status(401)
      .json({ error: "Activation not found, revoked, or expired" });
    return;
  }
  res.json(await loadBrandingForSchool(act.schoolId));
});

router.post("/kiosk/deactivate", requireStaff, async (req, res) => {
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  const { token } = req.body ?? {};
  if (typeof token !== "string" || token.length < 16) {
    res.status(400).json({ error: "token is required" });
    return;
  }
  const [act] = await db
    .select()
    .from(kioskActivationsTable)
    .where(
      and(
        eq(kioskActivationsTable.tokenHash, hashToken(token)),
        isNull(kioskActivationsTable.deactivatedAt),
      ),
    );
  if (!act) {
    res.status(404).json({ error: "Activation not found or already revoked" });
    return;
  }
  await db
    .update(kioskActivationsTable)
    .set({
      deactivatedAt: new Date(),
      deactivatedByStaffId: staff.id,
    })
    .where(eq(kioskActivationsTable.id, act.id));
  res.status(204).end();
});

router.get("/kiosk/activations", requireAdmin, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const onlyActive = (req.query.status ?? "active") === "active";
  const baseWhere = onlyActive
    ? and(
        eq(kioskActivationsTable.schoolId, schoolId),
        isNull(kioskActivationsTable.deactivatedAt),
        gt(kioskActivationsTable.expiresAt, new Date()),
      )
    : eq(kioskActivationsTable.schoolId, schoolId);

  const rows = await db
    .select({
      id: kioskActivationsTable.id,
      room: kioskActivationsTable.room,
      staffId: kioskActivationsTable.staffId,
      activatedAt: kioskActivationsTable.activatedAt,
      expiresAt: kioskActivationsTable.expiresAt,
      deactivatedAt: kioskActivationsTable.deactivatedAt,
      deactivatedByStaffId: kioskActivationsTable.deactivatedByStaffId,
      deviceLabel: kioskActivationsTable.deviceLabel,
      deviceFingerprint: kioskActivationsTable.deviceFingerprint,
      activatedByName: staffTable.displayName,
    })
    .from(kioskActivationsTable)
    .leftJoin(staffTable, eq(staffTable.id, kioskActivationsTable.staffId))
    .where(baseWhere as never)
    .orderBy(desc(kioskActivationsTable.activatedAt));
  res.json(rows);
});

router.post(
  "/kiosk/activations/:id/deactivate",
  requireAdmin,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
      .staff;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const result = await db
      .update(kioskActivationsTable)
      .set({
        deactivatedAt: new Date(),
        deactivatedByStaffId: staff.id,
      })
      .where(
        and(
          eq(kioskActivationsTable.id, id),
          eq(kioskActivationsTable.schoolId, schoolId),
          isNull(kioskActivationsTable.deactivatedAt),
        ),
      )
      .returning();
    if (result.length === 0) {
      res.status(404).json({ error: "Activation not found or already revoked" });
      return;
    }
    res.status(204).end();
  },
);

router.get("/admin/notifications", requireAdmin, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const rows = await db
    .select()
    .from(adminNotificationsTable)
    .where(
      and(
        eq(adminNotificationsTable.schoolId, schoolId),
        isNull(adminNotificationsTable.resolvedAt),
      ),
    )
    .orderBy(adminNotificationsTable.createdAt);
  res.json(rows);
});

router.post(
  "/admin/notifications/:id/resolve",
  requireAdmin,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
      .staff;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const result = await db
      .update(adminNotificationsTable)
      .set({ resolvedAt: new Date(), resolvedByStaffId: staff.id })
      .where(
        and(
          eq(adminNotificationsTable.id, id),
          eq(adminNotificationsTable.schoolId, schoolId),
          isNull(adminNotificationsTable.resolvedAt),
        ),
      )
      .returning();
    if (result.length === 0) {
      res.status(404).json({ error: "Notification not found" });
      return;
    }
    res.status(204).end();
  },
);

router.post("/kiosk/hall-passes", async (req, res) => {
  const { studentId, destination, token } = req.body ?? {};

  if (
    typeof studentId !== "string" ||
    typeof destination !== "string" ||
    !studentId.trim() ||
    !destination.trim()
  ) {
    res.status(400).json({
      error: "studentId and destination are required",
    });
    return;
  }

  if (typeof token !== "string" || token.length < 16) {
    res.status(401).json({
      error: "Kiosk activation token is required",
      revoked: true,
    });
    return;
  }

  const [act] = await db
    .select()
    .from(kioskActivationsTable)
    .where(
      and(
        eq(kioskActivationsTable.tokenHash, hashToken(token)),
        isNull(kioskActivationsTable.deactivatedAt),
        gt(kioskActivationsTable.expiresAt, new Date()),
      ),
    );
  if (!act) {
    res.status(401).json({
      error: "Kiosk activation not found, revoked, or expired",
      revoked: true,
    });
    return;
  }
  const [actStaff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, act.staffId));
  const originRoom = act.room;
  const kioskAttributionName = actStaff
    ? `${actStaff.displayName} (K)`
    : `Kiosk: ${act.room}`;

  // Resolve origin and destination by name *within the kiosk's school*.
  // Two schools may legitimately have a "Library" — without this filter
  // a kiosk in school A could end up issuing a pass to school B's room.
  const [origin] = await db
    .select()
    .from(locationsTable)
    .where(
      and(
        eq(locationsTable.name, originRoom),
        eq(locationsTable.schoolId, act.schoolId),
      ),
    );
  if (!origin) {
    res.status(400).json({ error: `Unknown origin room: ${originRoom}` });
    return;
  }

  const [dest] = await db
    .select()
    .from(locationsTable)
    .where(
      and(
        eq(locationsTable.name, destination),
        eq(locationsTable.schoolId, act.schoolId),
      ),
    );
  if (!dest) {
    res.status(400).json({ error: `Unknown destination: ${destination}` });
    return;
  }
  if (!dest.studentVisible) {
    res.status(403).json({
      error: "Destination not available from kiosk",
    });
    return;
  }

  const [allowed] = await db
    .select()
    .from(locationAllowedDestinationsTable)
    .where(
      and(
        eq(locationAllowedDestinationsTable.schoolId, act.schoolId),
        eq(locationAllowedDestinationsTable.originLocationId, origin.id),
        eq(
          locationAllowedDestinationsTable.destinationLocationId,
          dest.id,
        ),
      ),
    );
  if (!allowed) {
    res.status(403).json({
      error: `${destination} is not an allowed destination from ${originRoom}`,
    });
    return;
  }

  // Normalize the student-typed ID to uppercase so a kid who types "s2003"
  // matches the canonical "S2003" in the roster (and so the pass row, the
  // duplicate-active check, and the polarity check all use the same form).
  const normalizedStudentId = studentId.trim().toUpperCase();

  const existingActive = (await db
    .select()
    .from(hallPassesTable)
    .where(
      and(
        eq(hallPassesTable.schoolId, act.schoolId),
        eq(hallPassesTable.studentId, normalizedStudentId),
        eq(hallPassesTable.status, "active"),
      ),
    )) as Array<InferSelectModel<typeof hallPassesTable>>;
  if (existingActive.length > 0) {
    const open = existingActive[0];
    res.status(409).json({
      error: `Student ${normalizedStudentId} already has an active pass to ${open.destination}. End it before issuing another.`,
    });
    return;
  }

  // Polarity / keep-apart enforcement. The kiosk activation carries the
  // school it was bound to, so the daily limit is read from that school's
  // settings (not the singleton row).
  const limitConflict = await findDailyLimitConflict(
    normalizedStudentId,
    act.schoolId,
  );
  if (limitConflict) {
    res.status(409).json({ error: dailyLimitConflictMessage(limitConflict) });
    return;
  }
  const conflict = await findPolarityConflict(
    normalizedStudentId,
    act.schoolId,
  );
  if (conflict) {
    // Keep-apart at the kiosk: instead of bouncing the student with an
    // error that names the other kid, drop them silently into THIS kiosk's
    // queue and tell them they're on hold. The companion queue panel and
    // the kiosk's "next up" prompt both skip blocked entries until the
    // partner's pass ends, at which point the hold clears automatically.
    // We deliberately don't echo the partner's name in the response.
    try {
      const [student] = await db
        .select({
          firstName: studentsTable.firstName,
          lastName: studentsTable.lastName,
        })
        .from(studentsTable)
        .where(
          and(
            eq(studentsTable.studentId, normalizedStudentId),
            eq(studentsTable.schoolId, act.schoolId),
          ),
        );
      const periodKey = await getCurrentPeriodKey(act.schoolId);
      // Stale-clear before insert so a previous-period queue doesn't count
      // toward this period's cap. Mirrors /kiosk/queue/:token/add.
      await db
        .delete(hallPassQueueTable)
        .where(
          and(
            eq(hallPassQueueTable.kioskActivationId, act.id),
            ne(hallPassQueueTable.periodKey, periodKey),
          ),
        );
      const enqueueResult = await db.transaction(async (tx) => {
        // Serialize all enqueue attempts for this kiosk. `.for("update")`
        // alone doesn't help when the queue is empty (no rows to lock),
        // so two concurrent on-hold attempts could both pass the
        // QUEUE_CAP check. The advisory lock is released at COMMIT.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${act.id})`);
        const locked = await tx
          .select()
          .from(hallPassQueueTable)
          .where(eq(hallPassQueueTable.kioskActivationId, act.id))
          .orderBy(
            asc(hallPassQueueTable.position),
            asc(hallPassQueueTable.id),
          )
          .for("update");
        if (locked.some((r) => r.studentId === normalizedStudentId)) {
          return { kind: "duplicate" as const };
        }
        if (locked.length >= QUEUE_CAP) {
          return { kind: "full" as const };
        }
        const nextPos =
          locked.reduce((m, r) => (r.position > m ? r.position : m), 0) + 1;
        await tx.insert(hallPassQueueTable).values({
          schoolId: act.schoolId,
          kioskActivationId: act.id,
          room: act.room,
          studentId: normalizedStudentId,
          firstName: student?.firstName ?? null,
          lastName: student?.lastName ?? null,
          destination,
          position: nextPos,
          periodKey,
        });
        const after = await tx
          .select()
          .from(hallPassQueueTable)
          .where(eq(hallPassQueueTable.kioskActivationId, act.id))
          .orderBy(
            asc(hallPassQueueTable.position),
            asc(hallPassQueueTable.id),
          );
        const myIdx = after.findIndex(
          (r) => r.studentId === normalizedStudentId,
        );
        return { kind: "ok" as const, position: myIdx + 1 };
      });
      if (enqueueResult.kind === "full") {
        res.status(409).json({
          error: "You can't go right now and the line is full — try later.",
        });
        return;
      }
      // Whether duplicate (already in line on a prior attempt) or freshly
      // inserted, the student-facing message is the same generic hold.
      const position =
        enqueueResult.kind === "ok" ? enqueueResult.position : null;
      res.status(202).json({
        queued: true,
        reason: "on_hold",
        position,
        message:
          "You can't go right now. You're on hold and will be called when it's your turn.",
      });
      return;
    } catch (err) {
      req.log.error({ err }, "kiosk keep-apart enqueue failed");
      res.status(409).json({ error: polarityConflictMessage(conflict) });
      return;
    }
  }

  const [pass] = await db
    .insert(hallPassesTable)
    .values({
      schoolId: act.schoolId,
      studentId: normalizedStudentId,
      destination,
      originRoom,
      teacherName: kioskAttributionName,
      destinationTeacher: null,
      contactedAcknowledged: false,
      status: "active",
      createdAt: new Date().toISOString(),
      maxDurationMinutes: config.defaultHallPassDurationMinutes,
      endedAt: null,
    })
    .returning();

  const [student] = await db
    .select({ firstName: studentsTable.firstName })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.studentId, normalizedStudentId),
        eq(studentsTable.schoolId, act.schoolId),
      ),
    );

  // If this student was queued on this kiosk, remove their queue entry now
  // that the pass has started. Safe no-op if they weren't in the queue
  // (e.g. they walked up cold).
  await consumeQueueEntry(act.id, normalizedStudentId);

  res.status(201).json({
    ...pass,
    studentFirstName: student?.firstName ?? null,
  });
});

// Student "I'm back" flow: ends the student's currently-active hall pass from
// the kiosk. Validates the kiosk token the same way as pass creation does.
router.post("/kiosk/hall-passes/return", async (req, res) => {
  const { studentId, token } = req.body ?? {};

  if (typeof studentId !== "string" || !studentId.trim()) {
    res.status(400).json({ error: "studentId is required" });
    return;
  }
  if (typeof token !== "string" || token.length < 16) {
    res.status(401).json({
      error: "Kiosk activation token is required",
      revoked: true,
    });
    return;
  }

  const [act] = await db
    .select()
    .from(kioskActivationsTable)
    .where(
      and(
        eq(kioskActivationsTable.tokenHash, hashToken(token)),
        isNull(kioskActivationsTable.deactivatedAt),
        gt(kioskActivationsTable.expiresAt, new Date()),
      ),
    );
  if (!act) {
    res.status(401).json({
      error: "Kiosk activation not found, revoked, or expired",
      revoked: true,
    });
    return;
  }

  // Match the kiosk-create flow: uppercase the typed ID so a kid who types
  // "s2003" still finds their active "S2003" pass.
  const trimmedId = studentId.trim().toUpperCase();
  // Scope to passes that originated from THIS kiosk's room so "I'm back"
  // means "back to the room this kiosk is in." A pass from Room 102 can't
  // be ended from a Cafeteria kiosk — they have to use the right one.
  const activePasses = (await db
    .select()
    .from(hallPassesTable)
    .where(
      and(
        eq(hallPassesTable.schoolId, act.schoolId),
        eq(hallPassesTable.studentId, trimmedId),
        eq(hallPassesTable.status, "active"),
        eq(hallPassesTable.originRoom, act.room),
      ),
    )) as Array<InferSelectModel<typeof hallPassesTable>>;

  if (activePasses.length === 0) {
    res.status(404).json({
      error: `No active hall pass found for student ${trimmedId} from ${act.room}.`,
    });
    return;
  }

  // If multiple are somehow active, end the oldest one (the one they actually
  // left on first). Future passes will be cleaned up on next return tap.
  const target = activePasses.sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  )[0];

  const [updated] = await db
    .update(hallPassesTable)
    .set({
      status: "ended",
      endedAt: new Date().toISOString(),
    })
    .where(eq(hallPassesTable.id, target.id))
    .returning();

  const [student] = await db
    .select({ firstName: studentsTable.firstName })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.studentId, trimmedId),
        eq(studentsTable.schoolId, act.schoolId),
      ),
    );

  // Pop the next student off this kiosk's queue (if any) so the kiosk can
  // show a "Welcome [Name] — enter your ID to start your pass" prompt. We
  // do NOT auto-create the pass — the next student must scan/enter their
  // ID so they get their full allotted time.
  const nextInQueue = await peekNextInQueue({
    id: act.id,
    schoolId: act.schoolId,
  });

  res.json({
    ...updated,
    studentFirstName: student?.firstName ?? null,
    nextInQueue,
  });
});

// =====================================================================
// Phase 1 — Activation cards (per-teacher enrollment tokens).
//
// Three new activation paths, all eventually calling resolveActivation:
//   - /kiosk/activate-by-enrollment  → scanned QR / Code 128 token
//   - /kiosk/activate-by-pin         → typed 6-digit PIN
//   - /kiosk/activate-proxy          → Core Team sub coverage
//
// Plus admin management:
//   - GET  /kiosk/enroll-tokens
//   - POST /kiosk/enroll-tokens/regenerate/:staffId
//   - POST /kiosk/enroll-tokens/bulk-generate
//   - GET  /kiosk/cards.pdf
//   - POST /kiosk/my-active/revoke-all  (any staff)
// =====================================================================

// Linear bcrypt scan is fine at school scale (<300 staff). If this
// grows past ~1000 enroll tokens per school we'll add a pin_prefix
// indexed column to narrow the search before bcrypt.compare.
async function findEnrollTokenByPin(
  schoolId: number,
  pin: string,
): Promise<typeof kioskEnrollTokensTable.$inferSelect | null> {
  const candidates = await db
    .select()
    .from(kioskEnrollTokensTable)
    .where(
      and(
        eq(kioskEnrollTokensTable.schoolId, schoolId),
        isNull(kioskEnrollTokensTable.revokedAt),
      ),
    );
  for (const row of candidates) {
    if (!row.pinHash) continue;
    // eslint-disable-next-line no-await-in-loop
    if (await bcrypt.compare(pin, row.pinHash)) return row;
  }
  return null;
}

async function findEnrollTokenByRawToken(
  rawToken: string,
): Promise<typeof kioskEnrollTokensTable.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(kioskEnrollTokensTable)
    .where(
      and(
        eq(kioskEnrollTokensTable.tokenHash, hashToken(rawToken)),
        isNull(kioskEnrollTokensTable.revokedAt),
      ),
    );
  return row ?? null;
}

// Generate a fresh 6-digit PIN (no leading-zero collisions; ALL six
// digits are 0-9 so the printed PIN can really start with "0" — we just
// avoid the trivially-guessable "000000" / "123456" / "111111" set).
function generatePin(): string {
  const BANNED = new Set([
    "000000",
    "111111",
    "222222",
    "333333",
    "444444",
    "555555",
    "666666",
    "777777",
    "888888",
    "999999",
    "123456",
    "654321",
    "012345",
  ]);
  for (let i = 0; i < 20; i++) {
    const n = randomBytes(4).readUInt32BE(0) % 1_000_000;
    const candidate = n.toString().padStart(6, "0");
    if (!BANNED.has(candidate)) return candidate;
  }
  // Fallback — vanishingly rare.
  return "428193";
}

function generateEnrollToken(): string {
  return randomBytes(24).toString("base64url");
}

// Compute the public-facing kiosk URL the QR should encode. We trust
// the first $REPLIT_DOMAINS host in production; in dev we fall back to
// the inbound request host so the QR scans correctly on Replit dev URLs.
function kioskBaseUrl(req: Request): string {
  const replitDomains = (process.env.REPLIT_DOMAINS ?? "").trim();
  if (replitDomains) {
    const first = replitDomains.split(",")[0]?.trim();
    if (first) return `https://${first}/kiosk`;
  }
  const proto = (req.headers["x-forwarded-proto"] as string) ?? "https";
  const host = req.headers["x-forwarded-host"] ?? req.headers.host;
  return `${proto}://${host}/kiosk`;
}

// Shared helper: given a teacher and the activation context, do the
// confirm-on-first-scan dance + resolveActivation. Centralizes the
// confirm UX so PIN and token paths look identical to the kiosk.
async function activateForTeacher(args: {
  teacher: typeof staffTable.$inferSelect;
  enrollTokenId: number;
  room: string | undefined;
  deviceLabel: string | null;
  deviceFingerprint: string | null;
  replaceExisting: boolean;
  confirm: boolean;
  ttlMs: number;
  sessionKind: "enroll" | "proxy";
  actorStaffId: number;
  proxyForStaffId: number | null;
  res: Response;
}) {
  const {
    teacher,
    enrollTokenId,
    room,
    deviceLabel,
    deviceFingerprint,
    replaceExisting,
    confirm,
    ttlMs,
    sessionKind,
    actorStaffId,
    proxyForStaffId,
    res,
  } = args;

  // First-scan confirmation step (Security model A). If this device has
  // never been seen for this teacher (or the caller hasn't confirmed
  // yet), return a 200 with `requiresConfirm:true` so the kiosk can
  // render an "Activate kiosk for {staffName} in {room}?" modal.
  if (!confirm) {
    const [defaultRow] = await db
      .select()
      .from(staffDefaultsTable)
      .where(eq(staffDefaultsTable.staffId, teacher.id));
    const previewRoom = (room && room.trim()) || defaultRow?.defaultLocationName || null;
    res.status(200).json({
      requiresConfirm: true,
      staffId: teacher.id,
      staffName: teacher.displayName,
      previewRoom,
      ttlDays: Math.round(ttlMs / (24 * 60 * 60 * 1000)),
      sessionKind,
    });
    return;
  }

  const outcome = await resolveActivation({
    staff: teacher,
    room,
    dryRun: false,
    replaceExisting,
    deviceLabel,
    deviceFingerprint,
    ttlMs,
    sessionKind,
    enrollTokenId,
    actorStaffId,
    proxyForStaffId,
  });

  // Stamp last_used_at on the enrollment token so admins can spot
  // "I never use my kiosk card" gaps.
  if (outcome.kind === "ok") {
    await db
      .update(kioskEnrollTokensTable)
      .set({ lastUsedAt: new Date() })
      .where(eq(kioskEnrollTokensTable.id, enrollTokenId));
  }

  switch (outcome.kind) {
    case "ok":
      res.status(201).json(outcome.body);
      return;
    case "needs_room":
    case "room_taken":
      res.status(409).json(outcome.body);
      return;
    case "bad_room":
      res.status(400).json(outcome.body);
      return;
    case "dry_run":
      // Shouldn't happen (dryRun:false above) but keep TS exhaustive.
      res.status(500).json({ error: "unexpected dry-run outcome" });
      return;
  }
}

// -----------------------------------------------------------------------------
// Phase 3 — "Sign in to class" arrival flow.
//
// Authenticated by the kiosk's own activation token (same scheme as
// /kiosk/hall-passes). Looks up the student in the kiosk's school,
// appends a class_signins ledger row, and returns the substituted
// welcome message (per-house override → school default →
// hard-coded fallback). Per-student per-kiosk rate limit prevents a
// student from accidentally double-tapping into a runaway loop.
// -----------------------------------------------------------------------------

// Substitute {firstName}/{lastName}/{house}/{grade} into a template
// string. Unknown placeholders are left as-is so a typo in School
// Settings is visible to whoever's editing it, not silently dropped.
// Phase 4 — GET /api/class-signins/today
// Staff-facing roll-call list: today's class sign-ins for the
// current school, joined to students + the staff who owned the
// kiosk activation at sign-in time (the "teacher" of the room).
// Today is computed in the school's local timezone via the
// canonical DEFAULT_SCHOOL_TZ constant — same approach as the AST
// + lapse cron flows.
router.get(
  "/class-signins/today",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    // Local-midnight cutoff in the school's own IANA timezone (now
    // sourced from schools.timezone — see getSchoolTimezone). Uses
    // the shared startOfDayUtc helper which round-trips through Intl
    // to avoid the spring-forward hour gap.
    const tz = await getSchoolTimezone(schoolId);
    const startOfDay = startOfDayUtc(new Date(), tz);
    const rows = await db
      .select({
        id: classSigninsTable.id,
        studentRecordId: studentsTable.studentId,
        firstName: studentsTable.firstName,
        lastName: studentsTable.lastName,
        grade: studentsTable.grade,
        teacherName: sql<string>`COALESCE(${staffTable.displayName}, '')`.as("teacherName"),
        signedInAt: classSigninsTable.signedInAt,
      })
      .from(classSigninsTable)
      .leftJoin(
        studentsTable,
        and(
          eq(classSigninsTable.studentId, studentsTable.id),
          eq(studentsTable.schoolId, schoolId),
        ),
      )
      .leftJoin(staffTable, eq(classSigninsTable.signedInByStaffId, staffTable.id))
      .where(
        and(
          eq(classSigninsTable.schoolId, schoolId),
          gt(classSigninsTable.signedInAt, startOfDay),
        ),
      )
      .orderBy(asc(classSigninsTable.signedInAt));
    res.json({ signins: rows });
  },
);

function substituteWelcome(
  template: string,
  vars: {
    firstName: string;
    lastName: string;
    house: string;
    grade: string;
    teacher: string;
    period: string;
  },
): string {
  return template
    .replace(/\{firstName\}/g, vars.firstName)
    .replace(/\{lastName\}/g, vars.lastName)
    .replace(/\{house\}/g, vars.house)
    .replace(/\{grade\}/g, vars.grade)
    .replace(/\{teacher\}/g, vars.teacher)
    .replace(/\{period\}/g, vars.period);
}

// Phase 4 — look up the active bell-schedule period for the kiosk's
// school. Returns the period name + number if one is in progress
// right now, otherwise empty strings (welcome message renders
// "{period}" → "" rather than an awkward "Period —"). Best-effort:
// any DB error degrades to no period info, never blocks sign-in.
async function resolveActivePeriod(
  schoolId: number,
): Promise<{ name: string; number: string }> {
  try {
    const [schedule] = await db
      .select({ id: bellSchedulesTable.id })
      .from(bellSchedulesTable)
      .where(
        and(
          eq(bellSchedulesTable.schoolId, schoolId),
          eq(bellSchedulesTable.isDefault, true),
          eq(bellSchedulesTable.active, true),
        ),
      );
    if (!schedule) return { name: "", number: "" };
    const periods = await db
      .select({
        periodNumber: bellSchedulePeriodsTable.periodNumber,
        name: bellSchedulePeriodsTable.name,
        startTime: bellSchedulePeriodsTable.startTime,
        endTime: bellSchedulePeriodsTable.endTime,
      })
      .from(bellSchedulePeriodsTable)
      .where(eq(bellSchedulePeriodsTable.scheduleId, schedule.id));
    // Compute current HH:MM in the school's own IANA timezone (from
    // schools.timezone), NOT the server's local clock — Replit hosts
    // can drift to UTC and the period-name lookup would silently
    // mis-match for most of the day.
    const tz = await getSchoolTimezone(schoolId);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(new Date());
    const hh = parts.find((p) => p.type === "hour")?.value ?? "00";
    const mm = parts.find((p) => p.type === "minute")?.value ?? "00";
    const hhmm = `${hh.padStart(2, "0")}:${mm.padStart(2, "0")}`;
    for (const p of periods) {
      const start = (p.startTime ?? "").slice(0, 5);
      const end = (p.endTime ?? "").slice(0, 5);
      if (start && end && hhmm >= start && hhmm < end) {
        return {
          name: p.name ?? `Period ${p.periodNumber}`,
          number: String(p.periodNumber ?? ""),
        };
      }
    }
    return { name: "", number: "" };
  } catch {
    return { name: "", number: "" };
  }
}

// In-memory per-kiosk-activation rate limiter for class sign-ins. Keys
// are activation ids; values are arrays of recent signed-in-at ms
// timestamps. Allows up to MAX_SIGNINS_PER_WINDOW per WINDOW_MS per
// kiosk. Memory is bounded — we evict old keys lazily on each call.
const SIGNIN_RATE_WINDOW_MS = 60 * 1000;
const SIGNIN_RATE_MAX = 40;
const signinRateBuckets = new Map<number, number[]>();
function checkSigninRate(activationId: number): boolean {
  const now = Date.now();
  const cutoff = now - SIGNIN_RATE_WINDOW_MS;
  const bucket = (signinRateBuckets.get(activationId) ?? []).filter(
    (t) => t > cutoff,
  );
  if (bucket.length >= SIGNIN_RATE_MAX) {
    signinRateBuckets.set(activationId, bucket);
    return false;
  }
  bucket.push(now);
  signinRateBuckets.set(activationId, bucket);
  // Cheap GC: every ~500 calls, drop empty buckets.
  if (signinRateBuckets.size > 500) {
    for (const [k, v] of signinRateBuckets) {
      if (v.length === 0 || v[v.length - 1] < cutoff) signinRateBuckets.delete(k);
    }
  }
  return true;
}

router.post("/kiosk/class-signin", async (req, res) => {
  const { studentId, token } = req.body ?? {};

  if (typeof token !== "string" || token.length < 16) {
    res.status(401).json({
      error: "Kiosk activation token is required",
      revoked: true,
    });
    return;
  }
  if (typeof studentId !== "string" || !studentId.trim()) {
    res.status(400).json({ error: "studentId is required" });
    return;
  }

  const [act] = await db
    .select()
    .from(kioskActivationsTable)
    .where(
      and(
        eq(kioskActivationsTable.tokenHash, hashToken(token)),
        isNull(kioskActivationsTable.deactivatedAt),
        gt(kioskActivationsTable.expiresAt, new Date()),
      ),
    );
  if (!act) {
    res.status(401).json({
      error: "Kiosk activation not found, revoked, or expired",
      revoked: true,
    });
    return;
  }

  if (!checkSigninRate(act.id)) {
    res.status(429).json({ error: "Too many sign-ins on this kiosk" });
    return;
  }

  // Student must belong to the kiosk's school — students.student_id is
  // globally unique on the schema but we still enforce the school
  // filter so a leaked id from another tenant can't trigger a sign-in.
  const [student] = await db
    .select()
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.studentId, studentId.trim()),
        eq(studentsTable.schoolId, act.schoolId),
      ),
    );
  if (!student) {
    res.status(404).json({ error: "Student not found" });
    return;
  }

  // School welcome template + (optional) per-house override.
  const [settings] = await db
    .select({
      template: schoolSettingsTable.kioskWelcomeTemplate,
      overrides: schoolSettingsTable.kioskWelcomeMessages,
    })
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, act.schoolId));

  // Resolve house metadata for both the placeholder substitution and
  // the response payload (the kiosk uses the color as the welcome
  // background accent).
  let house: { id: number; name: string; color: string } | null = null;
  if (student.houseId !== null && student.houseId !== undefined) {
    const [h] = await db
      .select({
        id: housesTable.id,
        name: housesTable.name,
        color: housesTable.color,
      })
      .from(housesTable)
      .where(
        and(
          eq(housesTable.id, student.houseId),
          eq(housesTable.schoolId, act.schoolId),
        ),
      );
    if (h) house = h;
  }

  const baseTemplate = settings?.template ?? "Welcome, {firstName}!";
  const overrideMap = (settings?.overrides ?? {}) as Record<string, string>;
  const houseOverride = house ? overrideMap[String(house.id)] : undefined;
  const chosenTemplate = houseOverride || baseTemplate;

  // Phase 4 — resolve teacher (kiosk's staffId is the teacher whose
  // room this is) + active bell-schedule period for the new {teacher}
  // and {period} placeholders. Both fall back to empty string on miss.
  let teacherName = "";
  try {
    const [t] = await db
      .select({ displayName: staffTable.displayName })
      .from(staffTable)
      .where(eq(staffTable.id, act.staffId));
    teacherName = t?.displayName ?? "";
  } catch {
    teacherName = "";
  }
  const period = await resolveActivePeriod(act.schoolId);

  const welcomeMessage = substituteWelcome(chosenTemplate, {
    firstName: student.firstName,
    lastName: student.lastName,
    house: house?.name ?? "",
    grade: String(student.grade ?? ""),
    teacher: teacherName,
    period: period.name,
  });

  await db.insert(classSigninsTable).values({
    schoolId: act.schoolId,
    studentId: student.id,
    kioskActivationId: act.id,
    signedInByStaffId: act.staffId,
  });

  res.status(201).json({
    firstName: student.firstName,
    lastName: student.lastName,
    grade: student.grade,
    house,
    welcomeMessage,
  });
});

router.post("/kiosk/activate-by-enrollment", async (req, res) => {
  const { enrollToken, room, replaceExisting, confirm } = req.body ?? {};
  if (typeof enrollToken !== "string" || enrollToken.length < 16) {
    res.status(400).json({ error: "enrollToken is required" });
    return;
  }
  const tokenRow = await findEnrollTokenByRawToken(enrollToken);
  if (!tokenRow) {
    res.status(401).json({ error: "Card not recognized — ask an admin to reissue." });
    return;
  }
  const [teacher] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, tokenRow.staffId));
  if (!teacher || !teacher.active) {
    res.status(401).json({ error: "Teacher account is inactive — ask an admin to reissue." });
    return;
  }
  const { deviceLabel, deviceFingerprint } = cleanDeviceFields(req);
  await activateForTeacher({
    teacher,
    enrollTokenId: tokenRow.id,
    room: typeof room === "string" ? room : undefined,
    deviceLabel,
    deviceFingerprint,
    replaceExisting: replaceExisting === true,
    confirm: confirm === true,
    ttlMs: ENROLL_TTL_MS,
    sessionKind: "enroll",
    actorStaffId: teacher.id,
    proxyForStaffId: null,
    res,
  });
});

router.post("/kiosk/activate-by-pin", async (req, res) => {
  const { pin, room, replaceExisting, confirm, schoolId: bodySchoolId } =
    req.body ?? {};
  if (typeof pin !== "string" || !/^\d{6}$/.test(pin)) {
    res.status(400).json({ error: "pin must be 6 digits" });
    return;
  }

  // Abuse control: PIN endpoint is unauthenticated and a bcrypt
  // miss is expensive. Throttle per source IP. (See PIN_THROTTLE_*.)
  const clientIp =
    (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ??
    req.ip ??
    "unknown";
  if (isPinThrottled(clientIp)) {
    res
      .status(429)
      .json({
        error:
          "Too many PIN attempts from this device. Wait a minute and try again, or use the QR code on your card.",
      });
    return;
  }

  // PIN is per-school. We REQUIRE an unambiguous match to preserve
  // tenant isolation: if the caller provided a schoolId we scan only
  // that school; otherwise we scan all schools and accept only a
  // single live match. Multiple cross-school matches → 409 with a
  // hint to use the QR token (which is globally unique).
  let schoolIds: number[] = [];
  if (typeof bodySchoolId === "number" && Number.isInteger(bodySchoolId)) {
    schoolIds = [bodySchoolId];
  } else {
    const allSchools = await db
      .select({ id: schoolsTable.id })
      .from(schoolsTable);
    schoolIds = allSchools.map((s) => s.id);
  }

  const matches: Array<typeof kioskEnrollTokensTable.$inferSelect> = [];
  for (const sid of schoolIds) {
    // eslint-disable-next-line no-await-in-loop
    const m = await findEnrollTokenByPin(sid, pin);
    if (m) matches.push(m);
    if (matches.length > 1) break;
  }
  if (matches.length === 0) {
    recordPinFailure(clientIp);
    res.status(401).json({
      error:
        "PIN not recognized — check the digits or ask an admin to reissue.",
    });
    return;
  }
  if (matches.length > 1) {
    // Ambiguous across schools — refuse rather than guess. Caller
    // should re-attempt with explicit schoolId, or scan the QR.
    res.status(409).json({
      error:
        "That PIN is in use at more than one school. Scan the QR code on your card instead, or contact your admin.",
      ambiguous: true,
    });
    return;
  }
  const match = matches[0];
  const [teacher] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, match.staffId));
  if (!teacher || !teacher.active) {
    res.status(401).json({ error: "Teacher account is inactive — ask an admin to reissue." });
    return;
  }
  const { deviceLabel, deviceFingerprint } = cleanDeviceFields(req);
  await activateForTeacher({
    teacher,
    enrollTokenId: match.id,
    room: typeof room === "string" ? room : undefined,
    deviceLabel,
    deviceFingerprint,
    replaceExisting: replaceExisting === true,
    confirm: confirm === true,
    ttlMs: ENROLL_TTL_MS,
    sessionKind: "enroll",
    actorStaffId: teacher.id,
    proxyForStaffId: null,
    res,
  });
});

// Core Team picks a teacher + room and activates a kiosk on their
// behalf (sub coverage). The kiosk shows the absent teacher's name;
// activated_by_staff_id records who actually triggered it. Default
// duration: end of today. `durationKind:'14d'` overrides for a full
// two-week sub block.
router.post("/kiosk/activate-proxy", requireStaff, async (req, res) => {
  const actor = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  // Sub-activation is a Core Team responsibility (matches the
  // canManageRoomQueue gate already in hallPassQueue.ts).
  const isCore = Boolean(
    actor.isSuperUser ||
      actor.isDistrictAdmin ||
      actor.isAdmin ||
      actor.isBehaviorSpecialist ||
      actor.isMtssCoordinator ||
      actor.isSchoolPsychologist,
  );
  if (!isCore) {
    res
      .status(403)
      .json({ error: "Sub-activation requires Core Team membership" });
    return;
  }
  const { forStaffId, room, durationKind, replaceExisting } = req.body ?? {};
  if (!Number.isInteger(forStaffId) || forStaffId <= 0) {
    res.status(400).json({ error: "forStaffId is required" });
    return;
  }
  if (typeof room !== "string" || !room.trim()) {
    res
      .status(400)
      .json({ error: "room is required for sub-activation" });
    return;
  }
  const [teacher] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, forStaffId));
  if (
    !teacher ||
    !teacher.active ||
    teacher.schoolId !== actor.schoolId
  ) {
    res
      .status(404)
      .json({ error: "Teacher not found in your school" });
    return;
  }
  const ttlMs =
    durationKind === "14d" ? ENROLL_TTL_MS : endOfDayTtlMs();

  const { deviceLabel, deviceFingerprint } = cleanDeviceFields(req);
  const outcome = await resolveActivation({
    staff: teacher,
    room,
    dryRun: false,
    replaceExisting: replaceExisting === true,
    deviceLabel,
    deviceFingerprint,
    ttlMs,
    sessionKind: "proxy",
    enrollTokenId: null,
    actorStaffId: actor.id,
    proxyForStaffId: teacher.id,
  });

  // Audit trail: every sub coverage shows up in admin_notifications
  // so an admin can see "yesterday Mrs. Smith was out — covered by
  // Mr. Jones, Room 204, 1:14 PM."
  if (outcome.kind === "ok") {
    await db.insert(adminNotificationsTable).values({
      schoolId: actor.schoolId,
      type: "kiosk_proxy_activated",
      payload: {
        room,
        forStaffId: teacher.id,
        forStaffName: teacher.displayName,
        actorStaffId: actor.id,
        actorStaffName: actor.displayName,
        durationKind: durationKind === "14d" ? "14d" : "today",
        at: new Date().toISOString(),
      },
    });
  }

  switch (outcome.kind) {
    case "ok":
      res.status(201).json(outcome.body);
      return;
    case "needs_room":
    case "room_taken":
      res.status(409).json(outcome.body);
      return;
    case "bad_room":
      res.status(400).json(outcome.body);
      return;
    case "dry_run":
      res.status(500).json({ error: "unexpected dry-run outcome" });
      return;
  }
});

// "Sign me out everywhere" — used by a teacher whose card was stolen
// or who got a new device. Revokes every live activation where they
// are the kiosk identity (staff_id). Sub/proxy sessions issued for
// them are also wiped, since they're equally compromised if the
// teacher's identity is.
router.post("/kiosk/my-active/revoke-all", requireStaff, async (req, res) => {
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  const result = await db
    .update(kioskActivationsTable)
    .set({
      deactivatedAt: new Date(),
      deactivatedByStaffId: staff.id,
    })
    .where(
      and(
        eq(kioskActivationsTable.schoolId, staff.schoolId),
        eq(kioskActivationsTable.staffId, staff.id),
        isNull(kioskActivationsTable.deactivatedAt),
      ),
    )
    .returning({ id: kioskActivationsTable.id });
  res.json({ revoked: result.length });
});

// ---- Admin: enrollment-token management ----------------------------

// One row per active teacher with their enrollment-token status.
router.get("/kiosk/enroll-tokens", requireAdmin, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const rows = await db
    .select({
      staffId: staffTable.id,
      displayName: staffTable.displayName,
      email: staffTable.email,
      isAdmin: staffTable.isAdmin,
      defaultRoom: staffDefaultsTable.defaultLocationName,
      tokenId: kioskEnrollTokensTable.id,
      tokenCreatedAt: kioskEnrollTokensTable.createdAt,
      tokenLastUsedAt: kioskEnrollTokensTable.lastUsedAt,
    })
    .from(staffTable)
    .leftJoin(
      staffDefaultsTable,
      eq(staffDefaultsTable.staffId, staffTable.id),
    )
    .leftJoin(
      kioskEnrollTokensTable,
      and(
        eq(kioskEnrollTokensTable.staffId, staffTable.id),
        isNull(kioskEnrollTokensTable.revokedAt),
      ),
    )
    .where(
      and(eq(staffTable.schoolId, schoolId), eq(staffTable.active, true)),
    )
    .orderBy(asc(staffTable.displayName));
  res.json(rows);
});

// Issue (or rotate) the enrollment token for a single teacher. Returns
// the RAW token + RAW PIN ONCE — caller is expected to print them
// immediately, never re-displayable.
router.post(
  "/kiosk/enroll-tokens/regenerate/:staffId",
  requireAdmin,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const actor = (req as Request & {
      staff: typeof staffTable.$inferSelect;
    }).staff;
    const staffId = Number(req.params.staffId);
    if (!Number.isInteger(staffId) || staffId <= 0) {
      res.status(400).json({ error: "Invalid staffId" });
      return;
    }
    const [teacher] = await db
      .select()
      .from(staffTable)
      .where(eq(staffTable.id, staffId));
    if (!teacher || teacher.schoolId !== schoolId) {
      res.status(404).json({ error: "Teacher not in your school" });
      return;
    }
    const { rawToken, rawPin, tokenId } = await issueEnrollToken({
      schoolId,
      staffId,
      actorStaffId: actor.id,
      reason: "regenerate",
    });
    res.status(201).json({
      tokenId,
      enrollToken: rawToken,
      pin: rawPin,
      staffId: teacher.id,
      staffName: teacher.displayName,
    });
  },
);

// Bulk-issue: ensures every active teacher in the school has a live
// enrollment token. Teachers who already have one are skipped. Does
// NOT return raw tokens (they'd flood the response and aren't useful
// — the admin will go straight to "Print all cards (PDF)" after this).
router.post(
  "/kiosk/enroll-tokens/bulk-generate",
  requireAdmin,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const actor = (req as Request & {
      staff: typeof staffTable.$inferSelect;
    }).staff;
    // Eligible = active staff who teach OR run a classroom (anyone
    // who'd plausibly run a kiosk). For v1 we keep this generous —
    // any active staff, then admins can prune from the UI.
    const eligible = await db
      .select({ id: staffTable.id })
      .from(staffTable)
      .where(
        and(
          eq(staffTable.schoolId, schoolId),
          eq(staffTable.active, true),
        ),
      );
    const alreadyHave = new Set(
      (
        await db
          .select({ staffId: kioskEnrollTokensTable.staffId })
          .from(kioskEnrollTokensTable)
          .where(
            and(
              eq(kioskEnrollTokensTable.schoolId, schoolId),
              isNull(kioskEnrollTokensTable.revokedAt),
            ),
          )
      ).map((r) => r.staffId),
    );
    const bulkContext = `bulk:${randomBytes(6).toString("hex")}`;
    let created = 0;
    for (const s of eligible) {
      if (alreadyHave.has(s.id)) continue;
      // eslint-disable-next-line no-await-in-loop
      await issueEnrollToken({
        schoolId,
        staffId: s.id,
        actorStaffId: actor.id,
        reason: "bulk_generate",
        bulkContext,
      });
      created += 1;
    }
    res.json({
      created,
      alreadyHad: alreadyHave.size,
      eligible: eligible.length,
    });
  },
);

// Shared issuer used by regenerate + bulk-generate. Revokes any
// existing live token for (schoolId, staffId) in the same transaction
// so the partial unique index never sees two live rows.
//
// Also writes an append-only audit row to admin_notifications so a
// historical "who rotated whose card, when" is reconstructable. We
// roll up bulk operations under a single `bulkContext` key so admins
// can collapse them in the UI.
async function issueEnrollToken(args: {
  schoolId: number;
  staffId: number;
  actorStaffId: number;
  reason: "regenerate" | "bulk_generate" | "card_print";
  bulkContext?: string;
}): Promise<{ rawToken: string; rawPin: string; tokenId: number }> {
  const rawToken = generateEnrollToken();
  const tokenHash = hashToken(rawToken);
  const rawPin = generatePin();
  const pinHash = await bcrypt.hash(rawPin, 10);

  const tokenId = await db.transaction(async (tx) => {
    await tx
      .update(kioskEnrollTokensTable)
      .set({
        revokedAt: new Date(),
        revokedByStaffId: args.actorStaffId,
      })
      .where(
        and(
          eq(kioskEnrollTokensTable.schoolId, args.schoolId),
          eq(kioskEnrollTokensTable.staffId, args.staffId),
          isNull(kioskEnrollTokensTable.revokedAt),
        ),
      );
    const [inserted] = await tx
      .insert(kioskEnrollTokensTable)
      .values({
        schoolId: args.schoolId,
        staffId: args.staffId,
        tokenHash,
        pinHash,
        createdByStaffId: args.actorStaffId,
        rotatedAt: new Date(),
      })
      .returning({ id: kioskEnrollTokensTable.id });
    return inserted.id;
  });

  // Append-only audit row. We don't store the raw token/PIN — only the
  // fact that a rotation happened.
  await db.insert(adminNotificationsTable).values({
    schoolId: args.schoolId,
    type: "kiosk_enroll_token_rotated",
    payload: {
      staffId: args.staffId,
      tokenId,
      reason: args.reason,
      actorStaffId: args.actorStaffId,
      bulkContext: args.bulkContext ?? null,
      at: new Date().toISOString(),
    },
  });

  return { rawToken, rawPin, tokenId };
}

// Simple in-memory PIN attempt throttle. Per-IP bucket of recent
// failures; once a bucket exceeds the cap inside the window we refuse
// further attempts from that IP. Resets on process restart — fine for
// Phase 1 (the API server runs as a single process). If we ever
// scale horizontally this should move to Redis.
const PIN_THROTTLE_WINDOW_MS = 60 * 1000;
const PIN_THROTTLE_MAX_FAILS = 8;
const pinFailures = new Map<string, number[]>();
function recordPinFailure(ip: string): boolean {
  const now = Date.now();
  const arr = (pinFailures.get(ip) ?? []).filter(
    (t) => now - t < PIN_THROTTLE_WINDOW_MS,
  );
  arr.push(now);
  pinFailures.set(ip, arr);
  return arr.length >= PIN_THROTTLE_MAX_FAILS;
}
function isPinThrottled(ip: string): boolean {
  const now = Date.now();
  const arr = (pinFailures.get(ip) ?? []).filter(
    (t) => now - t < PIN_THROTTLE_WINDOW_MS,
  );
  pinFailures.set(ip, arr);
  return arr.length >= PIN_THROTTLE_MAX_FAILS;
}

// ---- Admin: printable card PDF -------------------------------------
// Two modes, controlled by request body:
//
//   1. `presupplied: [{staffId, enrollToken, pin}, ...]` — the caller
//      already has live raw token/PIN values (typically because they
//      JUST clicked "Reissue" and got them back from
//      /enroll-tokens/regenerate). We verify each token hash against a
//      live row for that (school, staff) and print THOSE values
//      verbatim. NO rotation. This is the path "Reissue → Print card"
//      should take so users never end up with a PDF whose PIN was
//      already revoked by the print step itself.
//
//   2. `all=true` or `staffIds=[...]` — bulk/first-issue path. We
//      rotate every selected teacher's enrollment token, because we
//      only store hashes and have no other way to obtain a printable
//      raw value. The admin UI MUST warn the user before doing this.
//
// IMPORTANT: mode 2 MUTATES state. Endpoint is POST so a browser
// navigation/img-tag cross-site request can't silently invalidate
// cards. requireAdmin enforces session auth.
router.post("/kiosk/cards.pdf", requireAdmin, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const actor = (req as Request & {
    staff: typeof staffTable.$inferSelect;
  }).staff;

  // Accept body params (POST). Legacy query-string params still work
  // for backwards compat with hand-tested URLs but the client must
  // POST so the browser includes credentials + CSRF protections.
  const body = (req.body ?? {}) as {
    all?: boolean;
    staffIds?: number[];
    presupplied?: Array<{
      staffId?: unknown;
      enrollToken?: unknown;
      pin?: unknown;
    }>;
  };

  // Mode 1: presupplied raw token/PIN values. Validate shape + verify
  // every token hash maps to a LIVE row for the right (school, staff).
  type Presupplied = {
    staffId: number;
    enrollToken: string;
    pin: string;
  };
  let presupplied: Presupplied[] = [];
  if (Array.isArray(body.presupplied) && body.presupplied.length > 0) {
    for (const raw of body.presupplied) {
      if (
        typeof raw.staffId !== "number" ||
        !Number.isInteger(raw.staffId) ||
        raw.staffId <= 0 ||
        typeof raw.enrollToken !== "string" ||
        raw.enrollToken.length === 0 ||
        typeof raw.pin !== "string" ||
        !/^\d{6}$/.test(raw.pin)
      ) {
        res
          .status(400)
          .json({ error: "Invalid presupplied entry shape" });
        return;
      }
      presupplied.push({
        staffId: raw.staffId,
        enrollToken: raw.enrollToken,
        pin: raw.pin,
      });
    }
    // Verify each token belongs to a LIVE enroll row for the right
    // (school, staff) AND that the supplied PIN matches the stored
    // pinHash. Both must hold — otherwise we'd happily print a PDF
    // whose token works but PIN doesn't (or vice versa), producing
    // broken cards. This is the security gate that lets us skip
    // rotation safely.
    for (const p of presupplied) {
      // eslint-disable-next-line no-await-in-loop
      const [row] = await db
        .select({
          id: kioskEnrollTokensTable.id,
          pinHash: kioskEnrollTokensTable.pinHash,
        })
        .from(kioskEnrollTokensTable)
        .where(
          and(
            eq(kioskEnrollTokensTable.schoolId, schoolId),
            eq(kioskEnrollTokensTable.staffId, p.staffId),
            eq(kioskEnrollTokensTable.tokenHash, hashToken(p.enrollToken)),
            isNull(kioskEnrollTokensTable.revokedAt),
          ),
        );
      if (!row || !row.pinHash) {
        res.status(409).json({
          error:
            "One of the supplied cards has been revoked or rotated. Reissue and try again.",
        });
        return;
      }
      // eslint-disable-next-line no-await-in-loop
      const pinOk = await bcrypt.compare(p.pin, row.pinHash);
      if (!pinOk) {
        res.status(400).json({
          error: "Supplied PIN does not match the live card for this teacher.",
        });
        return;
      }
    }
  }

  const all =
    body.all === true ||
    req.query.all === "1" ||
    req.query.all === "true";
  const bodyIds = Array.isArray(body.staffIds)
    ? body.staffIds.filter((n): n is number => Number.isInteger(n) && n > 0)
    : [];
  const queryIdsRaw =
    typeof req.query.staffIds === "string" ? req.query.staffIds : "";
  const queryIds = queryIdsRaw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  const staffIds = bodyIds.length ? bodyIds : queryIds;

  if (presupplied.length === 0 && !all && staffIds.length === 0) {
    res
      .status(400)
      .json({ error: "Provide presupplied=[...], staffIds=1,2,3, or all=1" });
    return;
  }

  const filterStaffIds =
    presupplied.length > 0 ? presupplied.map((p) => p.staffId) : staffIds;
  const useAllFilter = presupplied.length === 0 && all;
  const teachers = await db
    .select()
    .from(staffTable)
    .where(
      and(
        eq(staffTable.schoolId, schoolId),
        eq(staffTable.active, true),
        ...(useAllFilter ? [] : [inArray(staffTable.id, filterStaffIds)]),
      ),
    )
    .orderBy(asc(staffTable.displayName));

  if (teachers.length === 0) {
    res.status(404).json({ error: "No matching teachers" });
    return;
  }

  const [school] = await db
    .select({ name: schoolsTable.name })
    .from(schoolsTable)
    .where(eq(schoolsTable.id, schoolId));
  const schoolName = school?.name ?? "PulseEDU";

  // Pull each teacher's default room (if any) for the card.
  const teacherIds = teachers.map((t) => t.id);
  const roomByStaffId = new Map<number, string | null>();
  if (teacherIds.length) {
    const defaults = await db
      .select({
        staffId: staffDefaultsTable.staffId,
        defaultLocationName: staffDefaultsTable.defaultLocationName,
      })
      .from(staffDefaultsTable)
      .where(inArray(staffDefaultsTable.staffId, teacherIds));
    for (const d of defaults) {
      if (d.staffId == null) continue;
      roomByStaffId.set(d.staffId, d.defaultLocationName ?? null);
    }
  }

  // Pull each teacher's house affiliation (if any) so the printed card
  // shows the colored ribbon + house name. One small query keyed by
  // schoolId + the set of teacher.house_id values (filtered Nullable).
  const houseIds = Array.from(
    new Set(
      teachers
        .map((t) => (t as { houseId: number | null }).houseId)
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
          inArray(housesTable.id, houseIds),
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

  const cards: Array<{
    teacherName: string;
    room: string | null;
    schoolName: string;
    enrollToken: string;
    pin: string;
    baseUrl: string;
    house: {
      name: string;
      color: string;
      iconKey: string | null;
    } | null;
  }> = [];
  const baseUrl = kioskBaseUrl(req);
  const bulkContext = `print:${randomBytes(6).toString("hex")}`;
  const presuppliedByStaffId = new Map<number, Presupplied>();
  for (const p of presupplied) presuppliedByStaffId.set(p.staffId, p);
  for (const t of teachers) {
    const pre = presuppliedByStaffId.get(t.id);
    let rawToken: string;
    let rawPin: string;
    if (pre) {
      // Mode 1: use the already-live values the caller supplied.
      // We verified above that they map to a live row.
      rawToken = pre.enrollToken;
      rawPin = pre.pin;
    } else {
      // Mode 2: rotate.
      // eslint-disable-next-line no-await-in-loop
      const issued = await issueEnrollToken({
        schoolId,
        staffId: t.id,
        actorStaffId: actor.id,
        reason: "card_print",
        bulkContext,
      });
      rawToken = issued.rawToken;
      rawPin = issued.rawPin;
    }
    const teacherHouseId = (t as { houseId: number | null }).houseId;
    cards.push({
      teacherName: t.displayName,
      room: roomByStaffId.get(t.id) ?? null,
      schoolName,
      enrollToken: rawToken,
      pin: rawPin,
      baseUrl,
      house:
        teacherHouseId !== null && teacherHouseId !== undefined
          ? houseById.get(teacherHouseId) ?? null
          : null,
    });
  }

  const pdf = await renderKioskCardsPdf(cards);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="kiosk-cards-${new Date().toISOString().slice(0, 10)}.pdf"`,
  );
  res.send(pdf);
});

export default router;
