import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { randomBytes, createHash } from "node:crypto";
import { Readable } from "node:stream";
import { genUrlSafeToken } from "../lib/urlSafeToken.js";
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
  teacherDestinationAllowlistTable,
  attendanceCheckinsTable,
  onTimeRejectedScansTable,
  classSectionsTable,
  sectionRosterTable,
} from "@workspace/db";
import { renderKioskCardsPdf } from "../lib/kioskCardsPdf.js";
import { encryptSecret, decryptSecret } from "../lib/secretCrypto.js";
import {
  renderTeacherBadgesPdf,
  type TeacherBadgeInput,
  type CardDesign,
} from "../lib/teacherBadgesPdf.js";
import {
  ObjectStorageService,
  ObjectNotFoundError,
} from "../lib/objectStorage.js";
import {
  headStoredObject,
  openStoredObjectWebStream,
} from "../lib/storedObject.js";
import { and, eq, inArray, isNull, gt, gte, lt, desc, sql, ne, asc, like, or } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import { config } from "../data/config";
import { requireSchool } from "../lib/scope.js";
import { bcryptCompare, bcryptHash } from "../lib/bcrypt.js";
import {
  checkLoginAllowed,
  recordLoginFailure,
  recordLoginSuccess,
  sendLoginRateLimited,
} from "../lib/loginThrottle.js";
import { autoEndStalePasses } from "../lib/hallPassLifecycle.js";
import { loadSchoolWideDefaults } from "../lib/restroomAreas.js";
import { getSchoolTimezone, startOfDayUtc } from "../lib/schoolYear.js";
import { loadBrandingForSchool } from "./schoolBranding.js";
import {
  loadKioskTeacherDisplayName,
  loadRestroomDestinationNames,
  passHeadsToKiosk,
} from "../lib/oneWayPass.js";
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
import {
  loadAttendanceWindow,
  computePoints,
  type AttendanceWindow,
} from "../lib/onTimeAttendance.js";

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

// Domain-separation tag for the reversibly-encrypted kiosk PIN. Keeps the
// derived key distinct from the parent-TOTP encryption (secretCrypto's
// default purpose) — a value encrypted under one cannot be read under the
// other. Encrypt + decrypt of pin_encrypted MUST both use this tag.
const KIOSK_PIN_PURPOSE = "kiosk-pin-v1";

// Trailing subject descriptors that some rosters bake into the display name
// (e.g. "Marcus Hayes ELA" or "Jane Doe G6"). Stripped only when building the
// student-facing kiosk teacher label so it reads cleanly; the stored
// displayName is never modified.
const SUBJECT_NAME_SUFFIXES = new Set([
  "ela",
  "math",
  "science",
  "reading",
  "writing",
  "civics",
  "history",
  "ss",
]);

// Build the student-facing "teacher of record" label for a kiosk destination.
//   - With a title:  "Mr." + "Marcus Hayes ELA"  -> "Mr. Hayes"  (last name)
//   - Without title: "Marcus Hayes ELA"          -> "Marcus Hayes" (full name)
// We only collapse to a last name when a title is present, because "Mr. Hayes"
// reads naturally while a bare "Hayes" does not.
function teacherOfRecordLabel(
  displayName: string,
  title: string | null,
): string {
  // Drop a " - Subject" suffix (the documented roster format) up front.
  let base = displayName;
  const dash = base.indexOf(" - ");
  if (dash !== -1) base = base.slice(0, dash);
  let tokens = base.trim().split(/\s+/).filter(Boolean);
  // Drop a single trailing standalone subject token (e.g. "... Hayes ELA").
  if (
    tokens.length > 1 &&
    SUBJECT_NAME_SUFFIXES.has(tokens[tokens.length - 1].toLowerCase())
  ) {
    tokens = tokens.slice(0, -1);
  }
  const cleanName = tokens.join(" ") || displayName.trim();
  const t = (title ?? "").trim();
  if (!t) return cleanName;
  const lastName = tokens[tokens.length - 1] ?? cleanName;
  return `${t} ${lastName}`;
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
  // Two columns end up holding a teacher's home room:
  //   staff_defaults.default_location_name  ← set by the kiosk default-room
  //                                            picker, scoped via the
  //                                            settings tile
  //   staff.default_room                    ← set by the admin staff editor
  //                                            (where most rooms actually
  //                                            get entered today)
  // Either one is authoritative for "which room does this teacher's
  // kiosk card open in?", so we prefer the kiosk-specific value and
  // fall back to the staff-record value. Without the fallback, every
  // teacher whose room was only set via the staff editor (the common
  // path) gets the room-picker prompt on every kiosk-card scan, even
  // though the system already knows their room.
  const rawStaffDefaultRoom = staff.defaultRoom?.trim() || null;
  const defaultRoom =
    defaultRow?.defaultLocationName?.trim() || rawStaffDefaultRoom;

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
  } else if (defaultRoom && originLocations.includes(defaultRoom)) {
    chosenRoom = defaultRoom;
  } else if (defaultRoom) {
    // The teacher's stored default room is no longer a valid kiosk
    // origin (renamed, deactivated, or never matched a real location).
    // Don't fail the activation — surface the picker so the user can
    // recover. Mark it as a fallback-picker case for the admin
    // notification trail below.
    return {
      kind: "needs_room",
      body: {
        error: `Saved default room "${defaultRoom}" is no longer a valid kiosk room`,
        needsRoom: true,
        locations: originLocations,
      },
    };
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
  const token = genUrlSafeToken(43); // ~256 bits, linkifier-safe (lib/urlSafeToken)
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

  const blocked = await checkLoginAllowed(req, "staff", normalizedEmail);
  if (blocked) {
    sendLoginRateLimited(res, blocked);
    return;
  }

  const [staff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.email, normalizedEmail));

  if (!staff || !staff.active) {
    await recordLoginFailure(req, "staff", normalizedEmail);
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }
  const ok = await bcryptCompare(password, staff.passwordHash);
  if (!ok) {
    await recordLoginFailure(req, "staff", normalizedEmail);
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  await recordLoginSuccess(req, "staff", normalizedEmail);

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

// Destinations available from this kiosk, computed for the activating
// teacher and their room. Returns the UNION of:
//   • origin-room × destination pairs from `location_allowed_destinations`
//     (the school-wide "from this room you may go to…" matrix), AND
//   • the activating teacher's per-staff allowlist from
//     `teacher_destination_allowlist` (configured in the Teacher Allowlist
//     admin tile).
// History: the client originally fetched `/api/locations` +
// `/api/location-allowed-destinations` directly and intersected, which
// meant the per-teacher allowlist was silently invisible at the kiosk —
// admins who set a teacher's destinations there saw nothing change on
// the floor. This single token-authed endpoint is the source of truth so
// either admin path lights up the right list, with no staff session
// required (the kiosk device usually has none).
router.get("/kiosk/destinations/:token", async (req, res) => {
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
    res
      .status(401)
      .json({ error: "Activation not found, revoked, or expired" });
    return;
  }
  const [actStaff] = await db
    .select({ displayName: staffTable.displayName })
    .from(staffTable)
    .where(eq(staffTable.id, act.staffId));

  const [origin] = await db
    .select({ id: locationsTable.id })
    .from(locationsTable)
    .where(
      and(
        eq(locationsTable.name, act.room),
        eq(locationsTable.schoolId, act.schoolId),
      ),
    );

  // Both queries are independent — run them in parallel to keep the
  // kiosk's initial destinations fetch snappy.
  const [roomPairRows, teacherRows] = await Promise.all([
    origin
      ? db
          .select({
            id: locationAllowedDestinationsTable.destinationLocationId,
          })
          .from(locationAllowedDestinationsTable)
          .where(
            and(
              eq(locationAllowedDestinationsTable.schoolId, act.schoolId),
              eq(
                locationAllowedDestinationsTable.originLocationId,
                origin.id,
              ),
            ),
          )
      : Promise.resolve([] as { id: number }[]),
    // SIS-safe match: prefer the canonical staff_id (rename-proof); fall back
    // to the legacy null-staffId name match so un-backfilled rows still resolve.
    db
      .select({
        id: teacherDestinationAllowlistTable.destinationLocationId,
      })
      .from(teacherDestinationAllowlistTable)
      .where(
        and(
          eq(teacherDestinationAllowlistTable.schoolId, act.schoolId),
          or(
            eq(teacherDestinationAllowlistTable.staffId, act.staffId),
            actStaff?.displayName
              ? and(
                  isNull(teacherDestinationAllowlistTable.staffId),
                  eq(
                    teacherDestinationAllowlistTable.staffName,
                    actStaff.displayName,
                  ),
                )
              : sql`false`,
          ),
        ),
      ),
  ]);
  const roomPairDestIds = roomPairRows.map((r) => r.id);
  const teacherDestIds = teacherRows.map((r) => r.id);

  // School-wide facility defaults (office/clinic/nurse) are granted to EVERY
  // teacher automatically — they are unioned on top of whatever the precedence
  // below resolves, so facilities never need an allowlist row and never
  // disappear when a teacher curates a narrow list.
  const schoolWideDefaults = await loadSchoolWideDefaults(act.schoolId);
  const schoolWideDefaultIds = schoolWideDefaults.map((d) => d.id);

  // Precedence (teacher list is AUTHORITATIVE when set):
  //   1. If the activating teacher HAS a per-teacher allowlist (set via the
  //      self-serve gear or the admin tile) → show ONLY those destinations.
  //      The teacher's curated list wins; the room-pair matrix is ignored so
  //      a teacher can genuinely narrow what students see.
  //   2. Otherwise fall back to the school-wide room-pair matrix.
  //   3. If that's also empty, show every student-visible non-classroom
  //      destination so day-one kiosks aren't empty.
  // Keep this precedence in sync with the POST /kiosk pass-creation check.
  let resolvedIds: number[];
  if (teacherDestIds.length > 0) {
    resolvedIds = teacherDestIds;
  } else if (roomPairDestIds.length > 0) {
    resolvedIds = roomPairDestIds;
  } else {
    const defaults = await db
      .select({ id: locationsTable.id })
      .from(locationsTable)
      .where(
        and(
          eq(locationsTable.schoolId, act.schoolId),
          eq(locationsTable.active, true),
          eq(locationsTable.studentVisible, true),
          eq(locationsTable.isDestination, true),
          ne(locationsTable.kind, "classroom"),
        ),
      );
    resolvedIds = defaults.map((r) => r.id);
  }
  // School-wide facility defaults are ALWAYS unioned on top of the resolved set
  // (even when a teacher curated a narrow list) so office/clinic/nurse never
  // need an allowlist row and never vanish from the kiosk.
  const allIds = Array.from(new Set([...resolvedIds, ...schoolWideDefaultIds]));

  if (allIds.length === 0) {
    res.json({ originRoom: act.room, destinations: [] });
    return;
  }
  const rows = await db
    .select({
      id: locationsTable.id,
      name: locationsTable.name,
      kind: locationsTable.kind,
      active: locationsTable.active,
      studentVisible: locationsTable.studentVisible,
      isDestination: locationsTable.isDestination,
    })
    .from(locationsTable)
    .where(
      and(
        eq(locationsTable.schoolId, act.schoolId),
        inArray(locationsTable.id, allIds),
      ),
    );
  const visibleRows = rows
    .filter((r) => r.active && r.studentVisible && r.isDestination)
    .sort((a, b) => a.name.localeCompare(b.name));

  // Teacher of record per destination room, so students see "Mr. Hayes —
  // Room 204" instead of a bare room. The teacher is the active staff member
  // whose default room matches the destination's name (same school). A room
  // with no — or more than one — match shows no teacher (we can't pick "the"
  // teacher of record unambiguously, so we stay silent rather than guess).
  const teacherByRoom = new Map<string, string>();
  const roomNames = visibleRows.map((r) => r.name);
  if (roomNames.length > 0) {
    const staffRows = await db
      .select({
        displayName: staffTable.displayName,
        title: staffTable.title,
        defaultRoom: staffTable.defaultRoom,
      })
      .from(staffTable)
      .where(
        and(
          eq(staffTable.schoolId, act.schoolId),
          eq(staffTable.active, true),
          inArray(staffTable.defaultRoom, roomNames),
        ),
      );
    // Count matches per room first; only rooms with exactly one teacher get a
    // label (avoids misattributing a shared room to one of several teachers).
    const countByRoom = new Map<string, number>();
    for (const s of staffRows) {
      const room = s.defaultRoom ?? "";
      countByRoom.set(room, (countByRoom.get(room) ?? 0) + 1);
    }
    for (const s of staffRows) {
      const room = s.defaultRoom ?? "";
      if (countByRoom.get(room) !== 1) continue;
      teacherByRoom.set(room, teacherOfRecordLabel(s.displayName, s.title));
    }
  }

  const visible = visibleRows.map((r) => ({
    id: r.id,
    name: r.name,
    // Exposed so the kiosk can hide restroom-kind destinations from the
    // "Go now" line-bypass picker (restrooms must stay line-only).
    kind: r.kind,
    teacherName: teacherByRoom.get(r.name) ?? null,
  }));
  res.json({ originRoom: act.room, destinations: visible });
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

// Bulk-revoke every currently-live kiosk activation in the caller's
// school. Use case: stale activations from earlier testing are blocking
// fresh kiosk-card scans with "Room already has a kiosk." This frees
// every room in one click. Returns the number of rows revoked so the
// admin UI can show a confirmation toast.
router.post(
  "/kiosk/activations/deactivate-all",
  requireAdmin,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
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
          eq(kioskActivationsTable.schoolId, schoolId),
          isNull(kioskActivationsTable.deactivatedAt),
        ),
      )
      .returning({ id: kioskActivationsTable.id });
    req.log.info(
      { schoolId, count: result.length, actorStaffId: staff.id },
      "kiosk_activations_bulk_deactivate",
    );
    res.json({ deactivated: result.length });
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

// Resolve a kiosk-entered identifier to the canonical student record for
// this school. Students scan/type their human-facing Local SIS id (the value
// the badge QR + Code128 barcode now encode) — never the internal,
// FLEID-style student_id. We match on local_sis_id, school-scoped (it is
// 100%-populated and unique per (school_id, local_sis_id)), and hand back the
// full row so every caller uses the canonical student_id for downstream
// storage + matching. Returns null when no student matches.
async function resolveKioskStudent(
  rawId: string,
  schoolId: number,
): Promise<typeof studentsTable.$inferSelect | null> {
  const sisId = rawId.trim();
  if (!sisId) return null;
  const [student] = await db
    .select()
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.localSisId, sisId),
        eq(studentsTable.schoolId, schoolId),
      ),
    );
  return student ?? null;
}

router.post("/kiosk/hall-passes", async (req, res) => {
  const { studentId, destination, token } = req.body ?? {};
  // "Go now" line bypass: student summoned to the office/guidance/clinic who
  // can't wait in the queue. Skips the waiting line and the daily limit, but
  // keep-apart is still enforced (it alerts instead of silently queuing) and
  // restroom-kind destinations are never bypassable.
  const bypassQueue = req.body?.bypassQueue === true;

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
  // Restrooms can never skip the line — the queue exists precisely to meter
  // bathroom traffic. Mirror of the client, which hides restrooms from the
  // "Go now" picker; this rejects a crafted bypass POST for one.
  if (bypassQueue && dest.kind === "restroom") {
    res.status(400).json({
      error: "Restroom passes can't skip the line — please get in line.",
    });
    return;
  }

  // Hard-gate the single pick using the SAME precedence as
  // /kiosk/destinations/:token above (teacher list authoritative when set):
  //   1. teacher per-staff allowlist set → allow ONLY its members
  //      (room matrix ignored so the teacher can genuinely narrow).
  //   2. else → allow if the school-wide room-pair matrix has this pair.
  //   3. else (origin has no matrix rows at all) → allow any student-visible
  //      non-classroom destination (mirror of the show-all default).
  // Resolve the activating teacher's per-staff allowlist first so we can both
  // check membership and detect whether they've set a list at all.
  // SIS-safe match: prefer canonical staff_id, fall back to the legacy
  // null-staffId name match. Mirrors GET /kiosk/destinations/:token.
  const teacherRows = await db
    .select({
      destinationLocationId:
        teacherDestinationAllowlistTable.destinationLocationId,
    })
    .from(teacherDestinationAllowlistTable)
    .where(
      and(
        eq(teacherDestinationAllowlistTable.schoolId, act.schoolId),
        or(
          eq(teacherDestinationAllowlistTable.staffId, act.staffId),
          actStaff?.displayName
            ? and(
                isNull(teacherDestinationAllowlistTable.staffId),
                eq(
                  teacherDestinationAllowlistTable.staffName,
                  actStaff.displayName,
                ),
              )
            : sql`false`,
        ),
      ),
    );
  const teacherDestIdSet = new Set(
    teacherRows.map((r) => r.destinationLocationId),
  );
  const teacherHasList = teacherDestIdSet.size > 0;

  // School-wide facility defaults are granted to everyone — short-circuit allow
  // regardless of the teacher list / room matrix. Mirrors the GET union.
  const schoolWideDefaults = await loadSchoolWideDefaults(act.schoolId);
  const schoolWideDefaultIds = new Set(schoolWideDefaults.map((d) => d.id));

  let allowed: boolean;
  if (schoolWideDefaultIds.has(dest.id)) {
    allowed = true;
  } else if (teacherHasList) {
    allowed = teacherDestIdSet.has(dest.id);
  } else {
    const originPairRows = await db
      .select({
        destinationLocationId:
          locationAllowedDestinationsTable.destinationLocationId,
      })
      .from(locationAllowedDestinationsTable)
      .where(
        and(
          eq(locationAllowedDestinationsTable.schoolId, act.schoolId),
          eq(locationAllowedDestinationsTable.originLocationId, origin.id),
        ),
      );
    if (originPairRows.length > 0) {
      allowed = originPairRows.some((r) => r.destinationLocationId === dest.id);
    } else {
      allowed =
        dest.active &&
        dest.studentVisible &&
        dest.isDestination &&
        dest.kind !== "classroom";
    }
  }
  // Final eligibility parity with the GET /kiosk/destinations/:token listing,
  // which always post-filters to `active && studentVisible && isDestination`.
  // Re-apply it here so a crafted POST can never create a pass to a
  // destination the listing would have hidden (e.g. one still in a teacher's
  // list or the room matrix but since deactivated / un-flagged as a
  // destination). studentVisible is already gated above; this also covers
  // active + isDestination in the teacher/matrix branches.
  if (allowed && !(dest.active && dest.studentVisible && dest.isDestination)) {
    allowed = false;
  }
  if (!allowed) {
    res.status(403).json({
      error: `${destination} is not an allowed destination from ${originRoom}`,
    });
    return;
  }

  // Students scan/type their human-facing Local SIS id. Resolve it to the
  // canonical roster row up front; every downstream check + insert below uses
  // the internal student_id (via normalizedStudentId) so foreign keys stay
  // stable while no FLEID ever surfaces to the student.
  const student = await resolveKioskStudent(studentId, act.schoolId);
  if (!student) {
    res.status(404).json({
      error: "Student not found — check your ID and try again.",
    });
    return;
  }
  const normalizedStudentId = student.studentId;

  // Close forgotten passes first so a student who never ended a prior pass
  // isn't wrongly blocked by a stale "already has an active pass" row.
  await autoEndStalePasses(act.schoolId);

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
      error: `You already have an active pass to ${open.destination}. Tap "I'm back" to end it before starting another.`,
    });
    return;
  }

  // Polarity / keep-apart enforcement. The kiosk activation carries the
  // school it was bound to, so the daily limit is read from that school's
  // settings (not the singleton row).
  // A "Go now" bypass is for an involuntary summons (office/guidance/clinic),
  // so it is exempt from the per-student daily pass limit.
  const limitConflict = bypassQueue
    ? null
    : await findDailyLimitConflict(normalizedStudentId, act.schoolId);
  if (limitConflict) {
    res.status(409).json({ error: dailyLimitConflictMessage(limitConflict) });
    return;
  }
  const conflict = await findPolarityConflict(
    normalizedStudentId,
    act.schoolId,
  );
  if (conflict) {
    // A "Go now" bypass must NOT silently queue on a keep-apart hit — that
    // would defeat the bypass. Safety still wins over the summons: block and
    // alert so the teacher resolves it (the two kept-apart students can't be
    // in the hall together regardless of who called the student down).
    if (bypassQueue) {
      res.status(409).json({
        error:
          "You can't leave right now — please see your teacher. (A keep-apart rule is active.)",
      });
      return;
    }
    // Keep-apart at the kiosk: instead of bouncing the student with an
    // error that names the other kid, drop them silently into THIS kiosk's
    // queue and tell them they're on hold. The companion queue panel and
    // the kiosk's "next up" prompt both skip blocked entries until the
    // partner's pass ends, at which point the hold clears automatically.
    // We deliberately don't echo the partner's name in the response.
    try {
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
      priorityBypass: bypassQueue,
    })
    .returning();

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

  // Students type/scan their human-facing Local SIS id; resolve it to the
  // canonical student_id stored on the pass row.
  const student = await resolveKioskStudent(studentId, act.schoolId);
  if (!student) {
    res.status(404).json({
      error: `No active hall pass found from ${act.room}.`,
    });
    return;
  }
  const trimmedId = student.studentId;
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
      error: `No active hall pass found from ${act.room}.`,
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

// Destination check-in (one-way arrival). A kiosk standing AT the destination
// room receives an inbound student: this ENDS the pass, stamps arrivedAt, and
// records endedBy as the destination room. Idempotent — a second tap (or a
// pass already received by a staff member from the app) returns ok rather than
// erroring. Restroom passes never use this path (they're round-trip).
router.post("/kiosk/hall-passes/arrive", async (req, res) => {
  const { passId, token } = req.body ?? {};

  if (typeof token !== "string" || token.length < 16) {
    res.status(401).json({
      error: "Kiosk activation token is required",
      revoked: true,
    });
    return;
  }
  const numericPassId = Number(passId);
  if (!Number.isFinite(numericPassId) || numericPassId <= 0) {
    res.status(400).json({ error: "passId is required" });
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

  const [pass] = await db
    .select()
    .from(hallPassesTable)
    .where(
      and(
        eq(hallPassesTable.id, numericPassId),
        eq(hallPassesTable.schoolId, act.schoolId),
      ),
    );
  if (!pass) {
    res.status(404).json({ error: "Hall pass not found." });
    return;
  }
  // Restroom passes are round-trip: the student taps "I'm back" at their own
  // room, they are never checked in at a destination kiosk. Mirrors the
  // "Heading here" list, which excludes restrooms, so the two stay in lockstep.
  const restroomNames = await loadRestroomDestinationNames(act.schoolId);
  if (restroomNames.has(pass.destination)) {
    res.status(400).json({
      error: `Restroom passes return to the student's own room — there's no destination check-in.`,
    });
    return;
  }
  // The kiosk can receive students whose pass is headed here — either the
  // destination IS this room, or it is addressed to the activating teacher
  // (destinations are often named after the teacher, not the room string).
  // Kept in lockstep with the "Heading here" list via passHeadsToKiosk.
  const kioskTeacher = await loadKioskTeacherDisplayName(
    act.schoolId,
    act.staffId,
  );
  if (!passHeadsToKiosk(pass, act.room, kioskTeacher)) {
    res.status(403).json({
      error: `That pass is headed to ${pass.destination}, not ${act.room}.`,
    });
    return;
  }
  // Self-check-in identity gate. When the arriving student confirms by
  // scanning/typing their badge, the resolved Local SIS id must belong to
  // THIS pass — so a mis-tap on the wrong chip can never check in another
  // student. studentId is optional for backward compatibility; when present
  // it is enforced. Mirrors the "I'm back" return flow's scan requirement.
  const arriveStudentId = req.body?.studentId;
  if (typeof arriveStudentId === "string" && arriveStudentId.trim()) {
    const scanned = await resolveKioskStudent(arriveStudentId, act.schoolId);
    if (!scanned || scanned.studentId !== pass.studentId) {
      res.status(403).json({
        error:
          "That badge doesn't match this student. Scan the badge of the student checking in.",
      });
      return;
    }
  }
  // Idempotent: already received / ended → return as-is.
  if (pass.status !== "active") {
    res.json({ ...pass, alreadyReceived: true });
    return;
  }

  const nowIso = new Date().toISOString();
  const [updated] = await db
    .update(hallPassesTable)
    .set({
      status: "ended",
      endedAt: nowIso,
      arrivedAt: nowIso,
      endedBy: `${act.room} (kiosk)`,
    })
    .where(eq(hallPassesTable.id, pass.id))
    .returning();

  res.json(updated);
});

// Token-scoped student photo for kiosk surfaces. The kiosk is an
// UNAUTHENTICATED device (no staff session) — it only holds a kiosk
// activation token. So a plain <img src> can't reach the authed
// /api/storage path. This GET resolves the activation → school, then
// streams the photo bytes ONLY if a CONSENTING student in that same
// school actually owns the requested object key. That double gate
// (school match + consent + ownership) prevents a kiosk token from
// being used to enumerate arbitrary objects. Missing/!consent/!owned
// all 404 → the client falls back to the initials disc.
const kioskPhotoStorage = new ObjectStorageService();
router.get("/kiosk/photo/:token", async (req, res) => {
  const token = req.params.token;
  const key = typeof req.query.key === "string" ? req.query.key : "";
  if (typeof token !== "string" || token.length < 16 || !key) {
    res.status(404).end();
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
    res.status(404).end();
    return;
  }

  // Confirm a consenting student in this school owns the key.
  const [owner] = await db
    .select({ studentId: studentsTable.studentId })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.schoolId, act.schoolId),
        eq(studentsTable.photoObjectKey, key),
        eq(studentsTable.photoConsent, true),
      ),
    );
  if (!owner) {
    res.status(404).end();
    return;
  }

  try {
    const ref = await kioskPhotoStorage.getObjectEntityFile(key);
    const metadata = await headStoredObject(ref);
    res.setHeader(
      "Content-Type",
      metadata.contentType || "application/octet-stream",
    );
    res.setHeader("Cache-Control", "private, max-age=3600");
    const webStream = await openStoredObjectWebStream(ref);
    const nodeStream = Readable.fromWeb(webStream as import("stream/web").ReadableStream);
    nodeStream.on("error", () => {
      if (!res.headersSent) res.status(404);
      res.end();
    });
    nodeStream.pipe(res);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      res.status(404).end();
      return;
    }
    res.status(404).end();
  }
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
    if (await bcryptCompare(pin, row.pinHash)) return row;
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
  // base62, not base64url: this token rides in the kiosk-enroll QR/URL, where a
  // trailing '-'/'_' would be stripped by linkifiers. See lib/urlSafeToken.
  return genUrlSafeToken(32); // ~190 bits, parity with randomBytes(24)
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
    // Resolve the preview room with the SAME fallback chain as
    // resolveActivation (kiosk default-room picker → admin staff-editor
    // room). Without the staff.default_room fallback, a teacher whose
    // room was only set in the staff editor gets previewRoom:null here,
    // the client can't auto-confirm, and the QR/PIN scan drops to the
    // manual room-entry screen — even though the password sign-in path
    // (which calls resolveActivation) already knows the room. This kept
    // the four sign-in methods from agreeing on the room assignment.
    const previewRoom =
      (room && room.trim()) ||
      defaultRow?.defaultLocationName?.trim() ||
      teacher.defaultRoom?.trim() ||
      null;
    // Ship the valid origin rooms too, so when manual entry IS needed
    // (no default configured, or a sub) the QR/PIN confirm screen can
    // render the SAME searchable room picker as the password sign-in
    // path instead of a free-text box.
    const locations = (
      await db
        .select()
        .from(locationsTable)
        .where(
          and(
            eq(locationsTable.isOrigin, true),
            eq(locationsTable.active, true),
            eq(locationsTable.schoolId, teacher.schoolId),
          ),
        )
    ).map((l) => l.name);
    res.status(200).json({
      requiresConfirm: true,
      staffId: teacher.id,
      staffName: teacher.displayName,
      previewRoom,
      locations,
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
// Phase 4 — GET /api/class-signins/today[?date=YYYY-MM-DD]
// Staff-facing roll-call list: a day's class sign-ins for the
// current school, joined to students + the staff who owned the
// kiosk activation at sign-in time (the "teacher" of the room).
// The day defaults to today and is computed in the school's own
// IANA timezone (schools.timezone); an optional ?date= lets staff
// look back at any prior day. Each row also carries an INFERRED
// bell-schedule period, derived from the sign-in's time-of-day
// against the school's default bell schedule (the class_signins
// ledger itself stores no period). READ-ONLY: this endpoint never
// writes and is wholly separate from the on-time points ledger
// (attendance_checkins) — filtering here cannot affect points.
router.get(
  "/class-signins/today",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const tz = await getSchoolTimezone(schoolId);
    // Resolve the requested day. A valid ?date=YYYY-MM-DD anchors on
    // noon UTC of that date (safe for US timezones) so startOfDayUtc
    // lands on the intended calendar day; otherwise default to today.
    const dateParam =
      typeof req.query.date === "string" ? req.query.date.trim() : "";
    const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateParam);
    let anchor = new Date();
    if (dm) {
      const y = Number(dm[1]);
      const mo = Number(dm[2]);
      const d = Number(dm[3]);
      const cand = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
      // Reject normalized/invalid dates (e.g. 2026-02-31 → Mar 3) by
      // round-tripping the parsed parts; fall back to today otherwise.
      if (
        cand.getUTCFullYear() === y &&
        cand.getUTCMonth() === mo - 1 &&
        cand.getUTCDate() === d
      ) {
        anchor = cand;
      }
    }
    const startOfDay = startOfDayUtc(anchor, tz);
    // Next local midnight (add 36h then re-floor to absorb any DST hop).
    const endOfDay = startOfDayUtc(
      new Date(startOfDay.getTime() + 36 * 60 * 60 * 1000),
      tz,
    );
    const dateStr = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(startOfDay);

    const periods = await loadDefaultBellPeriods(schoolId);

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
          gte(classSigninsTable.signedInAt, startOfDay),
          lt(classSigninsTable.signedInAt, endOfDay),
        ),
      )
      .orderBy(asc(classSigninsTable.signedInAt));

    const signins = rows.map((r) => {
      const p = r.signedInAt
        ? periodForTime(periods, hhmmInTz(r.signedInAt, tz))
        : null;
      return {
        ...r,
        periodNumber: p?.periodNumber ?? null,
        periodName: p?.name ?? "",
      };
    });
    res.json({ signins, date: dateStr });
  },
);

// Phase 4 (date+period filters) — load the school's default+active
// bell-schedule periods once, normalized to HH:MM bounds, for
// inferring a sign-in's period from its time-of-day. Best-effort:
// any error or missing schedule yields an empty list (period renders
// blank, never blocks the roll-call list).
async function loadDefaultBellPeriods(
  schoolId: number,
): Promise<
  { periodNumber: number; name: string; start: string; end: string }[]
> {
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
    if (!schedule) return [];
    const periods = await db
      .select({
        periodNumber: bellSchedulePeriodsTable.periodNumber,
        name: bellSchedulePeriodsTable.name,
        startTime: bellSchedulePeriodsTable.startTime,
        endTime: bellSchedulePeriodsTable.endTime,
      })
      .from(bellSchedulePeriodsTable)
      .where(eq(bellSchedulePeriodsTable.scheduleId, schedule.id));
    return periods
      .map((p) => ({
        periodNumber: p.periodNumber ?? 0,
        name:
          p.name ?? (p.periodNumber != null ? `Period ${p.periodNumber}` : ""),
        start: (p.startTime ?? "").slice(0, 5),
        end: (p.endTime ?? "").slice(0, 5),
      }))
      .filter((p) => p.start && p.end);
  } catch {
    return [];
  }
}

// HH:MM for a timestamp in the given IANA timezone (NOT the server
// clock). Normalizes the "24" midnight quirk some runtimes emit.
function hhmmInTz(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(d);
  let hh = parts.find((p) => p.type === "hour")?.value ?? "00";
  const mm = parts.find((p) => p.type === "minute")?.value ?? "00";
  if (hh === "24") hh = "00";
  return `${hh.padStart(2, "0")}:${mm.padStart(2, "0")}`;
}

// First period whose [start, end) window contains hhmm; null if none.
function periodForTime(
  periods: { periodNumber: number; name: string; start: string; end: string }[],
  hhmm: string,
): { periodNumber: number; name: string } | null {
  for (const p of periods) {
    if (hhmm >= p.start && hhmm < p.end) {
      return { periodNumber: p.periodNumber, name: p.name };
    }
  }
  return null;
}

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

  // Students scan/type their human-facing Local SIS id (the value the badge
  // QR encodes). Resolve to the canonical roster row, scoped to the kiosk's
  // school so a leaked id from another tenant can't trigger a sign-in.
  const [student] = await db
    .select()
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.localSisId, studentId.trim()),
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

// ===========================================================================
// On-Time Attendance (classroom-door kiosk auto-flip)
//
// During the passing window before a class, an activated kiosk flips from
// hall-pass mode to Attendance mode. Students scan their Local SIS id to earn
// on-time points (server-authoritative). Points land in a SEPARATE ledger
// (attendance_checkins) that DOES count toward house standings but is NEVER
// part of the Invisible-Student calc. All three endpoints are token-authed
// (no session) like the rest of the kiosk surface.
// ===========================================================================

// Resolve the kiosk activation + the class the kiosk runs attendance for this
// passing window. Returns null pieces rather than throwing so each route can
// shape its own response.
async function resolveAttendanceContext(token: unknown): Promise<
  | { error: { status: number; body: Record<string, unknown> } }
  | {
      act: InferSelectModel<typeof kioskActivationsTable>;
      enabled: boolean;
      maxPoints: number;
      win: AttendanceWindow;
      // Roster gate result for the incoming class:
      //   sectionId  — the teacher's class_sections row for the incoming
      //                period (null = no section → OPEN FALLBACK, accept all).
      //   isPlanning — the section is the teacher's planning period (no class).
      sectionId: number | null;
      isPlanning: boolean;
      endedByTeacher: boolean;
    }
> {
  if (typeof token !== "string" || token.length < 16) {
    return {
      error: { status: 401, body: { error: "Kiosk token required", revoked: true } },
    };
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
    return {
      error: {
        status: 401,
        body: { error: "Kiosk activation not found, revoked, or expired", revoked: true },
      },
    };
  }

  const [settings] = await db
    .select({
      enabled: schoolSettingsTable.onTimeAttendanceEnabled,
      maxPoints: schoolSettingsTable.onTimeMaxPoints,
    })
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, act.schoolId));

  const win = await loadAttendanceWindow(act.schoolId);

  // Test loop is a self-contained admin demo: when its synthetic window is
  // active (periodKey prefixed "testloop:") the kiosk must flip to Attendance
  // mode even if the school hasn't turned the On-Time Attendance feature on —
  // the whole point is to demo without any setup. In normal operation the
  // periodKey is never "testloop:" so this never relaxes the real gate.
  const isTestLoopWindow = win.periodKey?.startsWith("testloop:") ?? false;

  // Roster gate context: does the kiosk's teacher have a class for the
  // incoming period, and is it their planning period?
  let sectionId: number | null = null;
  let isPlanning = false;
  if (win.incomingPeriodNumber !== null) {
    const [section] = await db
      .select({ id: classSectionsTable.id, isPlanning: classSectionsTable.isPlanning })
      .from(classSectionsTable)
      .where(
        and(
          eq(classSectionsTable.schoolId, act.schoolId),
          eq(classSectionsTable.teacherStaffId, act.staffId),
          eq(classSectionsTable.period, win.incomingPeriodNumber),
        ),
      );
    if (section) {
      sectionId = section.id;
      isPlanning = section.isPlanning;
    }
  }

  const endedByTeacher =
    win.periodKey !== null && act.onTimeEndedKey === win.periodKey;

  return {
    act,
    enabled: (settings?.enabled ?? false) || isTestLoopWindow,
    maxPoints: settings?.maxPoints ?? 4,
    win,
    sectionId,
    isPlanning,
    endedByTeacher,
  };
}

// GET /api/kiosk/attendance/state?token=...
// Polled by the kiosk (a few-second cadence) to know whether to show the
// Attendance screen, the countdown, the post-bell "Done" button, and the
// recent-scan list. Read-only.
router.get("/kiosk/attendance/state", async (req, res) => {
  const ctx = await resolveAttendanceContext(req.query.token);
  if ("error" in ctx) {
    res.status(ctx.error.status).json(ctx.error.body);
    return;
  }
  const { act, enabled, win, isPlanning, endedByTeacher } = ctx;

  const attendanceActive =
    enabled && win.phase !== "off" && !isPlanning && !endedByTeacher;

  if (!attendanceActive) {
    res.json({ enabled, mode: "hallpass" as const });
    return;
  }

  // Recent scans (newest first) for the on-screen slide-down name list.
  // During a test loop the periodKey changes every cycle (~4 min), which would
  // otherwise wipe the list each rollover. Span all of today's test-loop cycles
  // so names persist and accumulate; a real period keeps its single periodKey.
  const isTestLoop = (win.periodKey ?? "").startsWith("testloop:");
  const FEED_LIMIT = 8;
  const recentRows = await db
    .select({
      studentId: attendanceCheckinsTable.studentId,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      localSisId: studentsTable.localSisId,
      points: attendanceCheckinsTable.points,
      postBell: attendanceCheckinsTable.postBell,
      createdAt: attendanceCheckinsTable.createdAt,
    })
    .from(attendanceCheckinsTable)
    .leftJoin(
      studentsTable,
      and(
        eq(studentsTable.studentId, attendanceCheckinsTable.studentId),
        eq(studentsTable.schoolId, attendanceCheckinsTable.schoolId),
      ),
    )
    .where(
      and(
        eq(attendanceCheckinsTable.schoolId, act.schoolId),
        eq(attendanceCheckinsTable.kioskActivationId, act.id),
        isTestLoop
          ? like(attendanceCheckinsTable.periodKey, `testloop:%:${win.dayKey}`)
          : eq(attendanceCheckinsTable.periodKey, win.periodKey as string),
        eq(attendanceCheckinsTable.kind, "checkin"),
      ),
    )
    .orderBy(desc(attendanceCheckinsTable.createdAt))
    .limit(FEED_LIMIT * 4);

  // Newest scan per student, capped — so a student re-scanning across cycles
  // appears once (at the top) and older names slide off the bottom.
  const seenStudents = new Set<string>();
  const recent: {
    firstName: string;
    lastName: string;
    points: number;
    postBell: boolean;
  }[] = [];
  for (const r of recentRows) {
    const key = r.studentId ?? `${r.firstName ?? ""}|${r.lastName ?? ""}`;
    if (seenStudents.has(key)) continue;
    seenStudents.add(key);
    recent.push({
      firstName: r.firstName ?? "",
      lastName: r.lastName ?? "",
      points: r.points,
      postBell: r.postBell,
    });
    if (recent.length >= FEED_LIMIT) break;
  }

  res.json({
    enabled: true,
    mode: "attendance" as const,
    phase: win.phase,
    incomingPeriodNumber: win.incomingPeriodNumber,
    incomingPeriodName: win.incomingPeriodName,
    minutesRemaining: win.minutesRemaining,
    periodKey: win.periodKey,
    // The big Done button only appears once the bell has rung.
    showDone: win.phase === "post_bell",
    recent,
  });
});

// POST /api/kiosk/attendance/checkin  { token, studentId, source? }
// studentId is the human-facing Local SIS id (what the badge QR encodes).
router.post("/kiosk/attendance/checkin", async (req, res) => {
  const { studentId, token, source } = req.body ?? {};
  if (typeof studentId !== "string" || !studentId.trim()) {
    res.status(400).json({ error: "studentId is required" });
    return;
  }
  const ctx = await resolveAttendanceContext(token);
  if ("error" in ctx) {
    res.status(ctx.error.status).json(ctx.error.body);
    return;
  }
  const { act, enabled, maxPoints, win, sectionId, isPlanning, endedByTeacher } =
    ctx;

  if (!enabled || win.phase === "off" || isPlanning || endedByTeacher) {
    res.status(409).json({ status: "closed", error: "Attendance is not open" });
    return;
  }
  if (!checkSigninRate(act.id)) {
    res.status(429).json({ error: "Too many scans on this kiosk" });
    return;
  }

  const scanned = studentId.trim();
  const [student] = await db
    .select()
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.localSisId, scanned),
        eq(studentsTable.schoolId, act.schoolId),
      ),
    );

  if (!student) {
    await db.insert(onTimeRejectedScansTable).values({
      schoolId: act.schoolId,
      studentId: null,
      scannedLocalSisId: scanned,
      kioskActivationId: act.id,
      staffId: act.staffId,
      periodNumber: win.incomingPeriodNumber,
      periodKey: win.periodKey,
      day: win.dayKey,
      reason: "unknown_student",
    });
    res.status(404).json({ status: "unknown", error: "Student not found" });
    return;
  }

  // Roster gate: when the teacher HAS a roster for the incoming class, only
  // its students earn credit. No section row → open fallback (shared rooms /
  // schools that don't load class_sections).
  if (sectionId !== null) {
    const [rostered] = await db
      .select({ id: sectionRosterTable.id })
      .from(sectionRosterTable)
      .where(
        and(
          eq(sectionRosterTable.schoolId, act.schoolId),
          eq(sectionRosterTable.sectionId, sectionId),
          eq(sectionRosterTable.studentId, student.studentId),
        ),
      );
    if (!rostered) {
      await db.insert(onTimeRejectedScansTable).values({
        schoolId: act.schoolId,
        studentId: student.studentId,
        scannedLocalSisId: scanned,
        kioskActivationId: act.id,
        staffId: act.staffId,
        periodNumber: win.incomingPeriodNumber,
        periodKey: win.periodKey,
        day: win.dayKey,
        reason: "not_rostered",
      });
      res.status(200).json({
        status: "rejected",
        firstName: student.firstName,
        message: "Wrong door — this isn't your class right now.",
      });
      return;
    }
  }

  const points = computePoints(win, maxPoints);
  const inserted = await db
    .insert(attendanceCheckinsTable)
    .values({
      schoolId: act.schoolId,
      studentId: student.studentId,
      kioskActivationId: act.id,
      staffId: act.staffId,
      scheduleId: win.scheduleId,
      periodNumber: win.incomingPeriodNumber ?? 0,
      periodKey: win.periodKey as string,
      day: win.dayKey,
      kind: "checkin",
      points,
      minutesRemaining: win.phase === "passing" ? win.minutesRemaining : null,
      postBell: win.phase === "post_bell",
      source: typeof source === "string" ? source.slice(0, 16) : null,
    })
    .onConflictDoNothing()
    .returning({ id: attendanceCheckinsTable.id });

  let house: { id: number; name: string; color: string } | null = null;
  if (student.houseId !== null && student.houseId !== undefined) {
    const [h] = await db
      .select({ id: housesTable.id, name: housesTable.name, color: housesTable.color })
      .from(housesTable)
      .where(
        and(
          eq(housesTable.id, student.houseId),
          eq(housesTable.schoolId, act.schoolId),
        ),
      );
    if (h) house = h;
  }

  res.status(inserted.length > 0 ? 201 : 200).json({
    status: inserted.length > 0 ? "ok" : "already",
    firstName: student.firstName,
    lastName: student.lastName,
    points,
    postBell: win.phase === "post_bell",
    house,
  });
});

// POST /api/kiosk/attendance/done  { token }
// Teacher taps the big Done button at the bell to close attendance for this
// passing window and revert the kiosk to hall-pass mode early.
router.post("/kiosk/attendance/done", async (req, res) => {
  const ctx = await resolveAttendanceContext(req.body?.token);
  if ("error" in ctx) {
    res.status(ctx.error.status).json(ctx.error.body);
    return;
  }
  const { act, win } = ctx;
  // Server-authoritative "no End before bell": the teacher Done button only
  // appears post-bell on the client, but a crafted request must not be able
  // to close attendance early and shrink the on-time scoring window. Only
  // honor Done once the bell has rung (phase === "post_bell").
  if (win.phase !== "post_bell" || !win.periodKey) {
    res.status(409).json({ error: "Attendance can only be ended after the bell." });
    return;
  }
  await db
    .update(kioskActivationsTable)
    .set({ onTimeEndedKey: win.periodKey })
    .where(eq(kioskActivationsTable.id, act.id));
  res.json({ ok: true });
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

// Owner-only reveal of the caller's OWN 6-digit kiosk PIN — the same code
// printed on their badge. Surfaced in the Hall Pass gear ("Get kiosk URL"
// tab) so a teacher who lost their badge can still activate a classroom
// device. Scoped strictly to (req.staff.schoolId, req.staff.id): there is
// no staffId parameter, so one teacher can never read another's PIN.
// Response status distinguishes the three states so the UI can message
// accurately (a legacy badge is NOT the same as having no badge):
//   "ok"     — pin present, revealed.
//   "legacy" — a live badge exists, but its PIN was stored one-way (bcrypt)
//              before reversible encryption existed, OR can no longer be
//              decrypted (e.g. SESSION_SECRET rotated). The printed badge
//              STILL WORKS on the kiosk; it just can't be read back here.
//              Admin must reprint to surface a fresh, revealable code.
//   "none"   — the teacher has no live enrollment token at all.
router.get("/kiosk/my-pin", requireStaff, async (req, res) => {
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  const [row] = await db
    .select({ pinEncrypted: kioskEnrollTokensTable.pinEncrypted })
    .from(kioskEnrollTokensTable)
    .where(
      and(
        eq(kioskEnrollTokensTable.schoolId, staff.schoolId),
        eq(kioskEnrollTokensTable.staffId, staff.id),
        isNull(kioskEnrollTokensTable.revokedAt),
      ),
    );
  if (!row) {
    res.json({ pin: null, status: "none" });
    return;
  }
  if (!row.pinEncrypted) {
    res.json({ pin: null, status: "legacy" });
    return;
  }
  try {
    res.json({
      pin: decryptSecret(row.pinEncrypted, KIOSK_PIN_PURPOSE),
      status: "ok",
    });
  } catch (err) {
    // A decrypt failure (e.g. SESSION_SECRET rotated since issuance) is not
    // fatal — the badge still works on the kiosk. Treat it like a legacy
    // row so the UI shows the reprint hint rather than erroring.
    req.log.warn({ err, staffId: staff.id }, "kiosk my-pin decrypt failed");
    res.json({ pin: null, status: "legacy" });
  }
});

// Teacher self-service: rotate the caller's OWN enrollment token. Kills
// the old code (any previously printed card / on-screen code stops
// working for FUTURE activations) and mints a fresh one. Scoped strictly
// to (req.staff.schoolId, req.staff.id) — there is no staffId parameter,
// so a teacher can only ever rotate their own code. Works whether the
// teacher has no token yet ("generate my first code"), a live token
// ("rotate"), or a legacy badge ("replace with a readable code").
// Returns the RAW token + RAW PIN ONCE so the client can render an
// on-screen QR + PIN; never re-displayable after this response. Audit
// row is tagged reason "self_regenerate" so admins keep full visibility.
router.post("/kiosk/my-code/regenerate", requireStaff, async (req, res) => {
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  const issued = await issueEnrollToken({
    schoolId: staff.schoolId,
    staffId: staff.id,
    actorStaffId: staff.id,
    reason: "self_regenerate",
  });
  res.status(201).json({
    enrollToken: issued.rawToken,
    pin: issued.rawPin,
    tokenId: issued.tokenId,
  });
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
  reason: "regenerate" | "bulk_generate" | "card_print" | "self_regenerate";
  bulkContext?: string;
}): Promise<{ rawToken: string; rawPin: string; tokenId: number }> {
  const rawToken = generateEnrollToken();
  const tokenHash = hashToken(rawToken);
  const rawPin = generatePin();
  const pinHash = await bcryptHash(rawPin, 10);
  // Reversibly-encrypted copy so the owning teacher can read this exact
  // code back from the Hall Pass gear ("Get kiosk URL" tab). Owner-only
  // reveal — see GET /kiosk/my-pin. Distinct purpose tag from parent TOTP.
  const pinEncrypted = encryptSecret(rawPin, KIOSK_PIN_PURPOSE);

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
        pinEncrypted,
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
      const pinOk = await bcryptCompare(p.pin, row.pinHash);
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

// ---- Admin: printable TEACHER ID BADGE PDF -------------------------
// Lanyard-style staff ID badge that ALSO carries the live kiosk
// activation payload (QR + Code 128 + 6-digit PIN), so one worn card
// both identifies the teacher and activates their room kiosk. Shares
// the per-school CardDesign + photo pipeline with student badges, and
// the same enroll-token modes (presupplied / all / staffIds) as
// /kiosk/cards.pdf above. POST so the mutating (rotation) modes can't
// be triggered by a cross-site navigation.
const teacherBadgeObjectStorage = new ObjectStorageService();

// Fetch raw object bytes for embedding in the PDF. Returns null on any
// failure (missing object, network glitch) — the renderer falls back
// to the initials disc silently.
async function fetchTeacherPhotoBytes(
  objectPath: string,
): Promise<Buffer | null> {
  return teacherBadgeObjectStorage.readObjectAsBuffer(objectPath);
}

// Resolve the per-school card design once per batch (shared with the
// student badge route). Image-mode top background is fetched a single
// time; SVG is filtered out (pdfkit can't rasterize it).
async function buildTeacherCardDesign(schoolId: number): Promise<CardDesign> {
  const b = await loadBrandingForSchool(schoolId);
  let bgImageBytes: Buffer | null = null;
  if (b.cardBgMode === "image" && b.cardBgObjectPath) {
    const MAX_BG_BYTES = 5 * 1024 * 1024;
    const bytes = await fetchTeacherPhotoBytes(b.cardBgObjectPath);
    if (bytes && bytes.length <= MAX_BG_BYTES) {
      const head = bytes.slice(0, 16).toString("utf8").trimStart();
      if (!head.startsWith("<")) bgImageBytes = bytes;
    }
  }
  return {
    orientation: b.cardOrientation,
    bgMode: b.cardBgMode,
    bgColors: b.cardBgColors.slice(0, 2),
    bgAngle: b.cardBgAngle,
    bgImageBytes,
    headerTextMode: b.cardHeaderTextMode,
    headerTextColor: b.cardHeaderTextColor,
    showHouse: b.cardShowHouse,
    houseBgMode: b.cardHouseBgMode,
    houseBgColor: b.cardHouseBgColor,
    houseTextMode: b.cardHouseTextMode,
    houseTextColor: b.cardHouseTextColor,
  };
}

router.post("/kiosk/teacher-badges.pdf", requireAdmin, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const actor = (req as Request & {
    staff: typeof staffTable.$inferSelect;
  }).staff;

  const body = (req.body ?? {}) as {
    all?: boolean;
    staffIds?: number[];
    presupplied?: Array<{
      staffId?: unknown;
      enrollToken?: unknown;
      pin?: unknown;
    }>;
  };

  // Mode 1: presupplied raw token/PIN values — validate shape + verify
  // each maps to a LIVE row with a matching PIN (same gate as cards.pdf).
  type Presupplied = { staffId: number; enrollToken: string; pin: string };
  const presupplied: Presupplied[] = [];
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
        res.status(400).json({ error: "Invalid presupplied entry shape" });
        return;
      }
      presupplied.push({
        staffId: raw.staffId,
        enrollToken: raw.enrollToken,
        pin: raw.pin,
      });
    }
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
      const pinOk = await bcryptCompare(p.pin, row.pinHash);
      if (!pinOk) {
        res.status(400).json({
          error: "Supplied PIN does not match the live card for this teacher.",
        });
        return;
      }
    }
  }

  const all =
    body.all === true || req.query.all === "1" || req.query.all === "true";
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

  // Per-teacher default room.
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

  // Per-teacher house (color + name + icon + optional uploaded logo bytes).
  const houseIds = Array.from(
    new Set(
      teachers
        .map((t) => (t as { houseId: number | null }).houseId)
        .filter((id): id is number => typeof id === "number"),
    ),
  );
  const houseById = new Map<
    number,
    {
      name: string;
      color: string;
      iconKey: string | null;
      logoObjectPath: string | null;
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
    for (const r of rows) {
      // SVG house logos can't be rasterized by pdfkit — skip them so the
      // renderer falls back to the colored letter emblem.
      const logoPath =
        r.iconObjectKey && !r.iconObjectKey.toLowerCase().endsWith(".svg")
          ? r.iconObjectKey
          : null;
      houseById.set(r.id, {
        name: r.name,
        color: r.color,
        iconKey: r.iconKey,
        logoObjectPath: logoPath,
      });
    }
  }

  // Resolve the shared card design + house logo bytes once for the batch.
  const design = await buildTeacherCardDesign(schoolId);
  const houseLogoBytesByPath = new Map<string, Buffer | null>();
  for (const h of houseById.values()) {
    if (h.logoObjectPath && !houseLogoBytesByPath.has(h.logoObjectPath)) {
      // eslint-disable-next-line no-await-in-loop
      const bytes = await fetchTeacherPhotoBytes(h.logoObjectPath);
      const MAX = 4 * 1024 * 1024;
      let usable: Buffer | null = null;
      if (bytes && bytes.length <= MAX) {
        const head = bytes.slice(0, 16).toString("utf8").trimStart();
        if (!head.startsWith("<")) usable = bytes;
      }
      houseLogoBytesByPath.set(h.logoObjectPath, usable);
    }
  }

  // Fetch teacher photos with bounded concurrency (cap 6, max 4MB each).
  const photoByStaffId = new Map<number, Buffer | null>();
  const withPhotos = teachers.filter(
    (t) => (t as { photoObjectKey: string | null }).photoObjectKey,
  );
  const CONCURRENCY = 6;
  const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
  for (let i = 0; i < withPhotos.length; i += CONCURRENCY) {
    const slice = withPhotos.slice(i, i + CONCURRENCY);
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(
      slice.map(async (t) => {
        const key = (t as { photoObjectKey: string | null }).photoObjectKey;
        if (!key) return;
        const bytes = await fetchTeacherPhotoBytes(key);
        photoByStaffId.set(
          t.id,
          bytes && bytes.length <= MAX_PHOTO_BYTES ? bytes : null,
        );
      }),
    );
  }

  const baseUrl = kioskBaseUrl(req);
  const bulkContext = `teacher_badge:${randomBytes(6).toString("hex")}`;
  const presuppliedByStaffId = new Map<number, Presupplied>();
  for (const p of presupplied) presuppliedByStaffId.set(p.staffId, p);

  const badges: TeacherBadgeInput[] = [];
  for (const t of teachers) {
    const pre = presuppliedByStaffId.get(t.id);
    let rawToken: string;
    let rawPin: string;
    if (pre) {
      rawToken = pre.enrollToken;
      rawPin = pre.pin;
    } else {
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
    const house =
      teacherHouseId !== null && teacherHouseId !== undefined
        ? houseById.get(teacherHouseId) ?? null
        : null;
    badges.push({
      teacherName: t.displayName,
      room: roomByStaffId.get(t.id) ?? null,
      schoolName,
      enrollToken: rawToken,
      pin: rawPin,
      baseUrl,
      house: house
        ? {
            name: house.name,
            color: house.color,
            iconKey: house.iconKey,
            logoBytes: house.logoObjectPath
              ? houseLogoBytesByPath.get(house.logoObjectPath) ?? null
              : null,
          }
        : null,
      photoBytes: photoByStaffId.get(t.id) ?? null,
      design,
    });
  }

  const pdf = await renderTeacherBadgesPdf(badges);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="teacher-id-badges-${new Date().toISOString().slice(0, 10)}.pdf"`,
  );
  res.send(pdf);
});

export default router;
