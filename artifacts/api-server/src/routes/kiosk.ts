import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import bcrypt from "bcryptjs";
import { randomBytes, createHash } from "node:crypto";
import {
  db,
  hallPassesTable,
  locationsTable,
  locationAllowedDestinationsTable,
  staffDefaultsTable,
  staffTable,
  kioskActivationsTable,
  adminNotificationsTable,
  studentsTable,
} from "@workspace/db";
import { and, eq, isNull, gt, desc, sql } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import { config } from "../data/config";
import { requireSchool } from "../lib/scope.js";
import { loadBrandingForSchool } from "./schoolBranding.js";
import {
  findPolarityConflict,
  polarityConflictMessage,
} from "./polarityPairs";
import {
  findDailyLimitConflict,
  dailyLimitConflictMessage,
} from "./studentHallPassLimits";
import { consumeQueueEntry, peekNextInQueue } from "./hallPassQueue";

const ACTIVATION_TTL_MS = 12 * 60 * 60 * 1000;

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

// Shared room-resolution + activation creation. Used by both the
// password-based public activate route and the session-based quick-activate
// route so the conflict, dry-run, and fallback-picker semantics stay in
// lockstep.
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
}): Promise<ActivateOutcome> {
  const { staff, dryRun, replaceExisting, deviceLabel, deviceFingerprint } =
    args;

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
  const expiresAt = new Date(Date.now() + ACTIVATION_TTL_MS);

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

// Session-authenticated activation — same outcomes as /kiosk/activate but
// trusts the existing staff session instead of asking for the password
// again. This is the entry point for the "Open Kiosk Mode" button inside
// the staff app: a teacher already signed in to PulseEDU can spin up a
// kiosk on their laptop in one click.
router.post("/kiosk/quick-activate", requireStaff, async (req, res) => {
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  const { room, dryRun, replaceExisting } = req.body ?? {};
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
    res.status(409).json({ error: polarityConflictMessage(conflict) });
    return;
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

export default router;
