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
} from "@workspace/db";
import { and, eq, isNull, gt } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import { config } from "../data/config";

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
  const staffId = req.session.staffId;
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
    if (!staff.isAdmin) {
      res.status(403).json({ error: "Admin only" });
      return;
    }
    next();
  });
}

router.post("/kiosk/activate", async (req, res) => {
  const { email, password, room, deviceLabel, deviceFingerprint } =
    req.body ?? {};

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

  const [defaultRow] = await db
    .select()
    .from(staffDefaultsTable)
    .where(eq(staffDefaultsTable.staffName, staff.displayName));
  const defaultRoom = defaultRow?.defaultLocationName ?? null;

  const originLocations = (
    await db
      .select()
      .from(locationsTable)
      .where(
        and(
          eq(locationsTable.isOrigin, true),
          eq(locationsTable.active, true),
        ),
      )
  ).map((l) => l.name);

  let chosenRoom: string;
  let usedFallbackPicker = false;

  if (typeof room === "string" && room.trim()) {
    const candidate = room.trim();
    if (!originLocations.includes(candidate)) {
      res.status(400).json({
        error: `Room "${candidate}" is not a valid kiosk room`,
      });
      return;
    }
    chosenRoom = candidate;
    if (!defaultRoom) usedFallbackPicker = true;
  } else if (defaultRoom) {
    chosenRoom = defaultRoom;
  } else {
    res.status(409).json({
      error: "No default room set",
      needsRoom: true,
      locations: originLocations,
    });
    return;
  }

  if (usedFallbackPicker) {
    await db.insert(adminNotificationsTable).values({
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

  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);

  const expiresAt = new Date(Date.now() + ACTIVATION_TTL_MS);

  const cleanDeviceLabel =
    typeof deviceLabel === "string" && deviceLabel.trim()
      ? deviceLabel.trim().slice(0, 200)
      : null;
  const cleanDeviceFingerprint =
    typeof deviceFingerprint === "string" && deviceFingerprint.trim()
      ? deviceFingerprint.trim().slice(0, 100)
      : null;

  await db.insert(kioskActivationsTable).values({
    tokenHash,
    room: chosenRoom,
    staffId: staff.id,
    expiresAt,
    deviceLabel: cleanDeviceLabel,
    deviceFingerprint: cleanDeviceFingerprint,
  });

  res.status(201).json({
    token,
    room: chosenRoom,
    staffName: staff.displayName,
    expiresAt: expiresAt.toISOString(),
  });
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

router.get("/kiosk/activations", requireAdmin, async (_req, res) => {
  const rows = await db
    .select({
      id: kioskActivationsTable.id,
      room: kioskActivationsTable.room,
      staffId: kioskActivationsTable.staffId,
      activatedAt: kioskActivationsTable.activatedAt,
      deactivatedAt: kioskActivationsTable.deactivatedAt,
      deactivatedByStaffId: kioskActivationsTable.deactivatedByStaffId,
      activatedByName: staffTable.displayName,
    })
    .from(kioskActivationsTable)
    .leftJoin(staffTable, eq(staffTable.id, kioskActivationsTable.staffId))
    .orderBy(kioskActivationsTable.activatedAt);
  res.json(rows);
});

router.get("/admin/notifications", requireAdmin, async (_req, res) => {
  const rows = await db
    .select()
    .from(adminNotificationsTable)
    .where(isNull(adminNotificationsTable.resolvedAt))
    .orderBy(adminNotificationsTable.createdAt);
  res.json(rows);
});

router.post(
  "/admin/notifications/:id/resolve",
  requireAdmin,
  async (req, res) => {
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

  const [origin] = await db
    .select()
    .from(locationsTable)
    .where(eq(locationsTable.name, originRoom));
  if (!origin) {
    res.status(400).json({ error: `Unknown origin room: ${originRoom}` });
    return;
  }

  const [dest] = await db
    .select()
    .from(locationsTable)
    .where(eq(locationsTable.name, destination));
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

  const existingActive = (await db
    .select()
    .from(hallPassesTable)
    .where(
      and(
        eq(hallPassesTable.studentId, studentId.trim()),
        eq(hallPassesTable.status, "active"),
      ),
    )) as Array<InferSelectModel<typeof hallPassesTable>>;
  if (existingActive.length > 0) {
    const open = existingActive[0];
    res.status(409).json({
      error: `Student ${studentId.trim()} already has an active pass to ${open.destination}. End it before issuing another.`,
    });
    return;
  }

  const [pass] = await db
    .insert(hallPassesTable)
    .values({
      studentId: studentId.trim(),
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

  res.status(201).json(pass);
});

export default router;
