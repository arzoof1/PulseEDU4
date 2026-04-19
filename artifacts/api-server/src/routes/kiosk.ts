import { Router, type IRouter } from "express";
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
import { and, eq, isNull } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import { config } from "../data/config";

const router: IRouter = Router();

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

router.post("/kiosk/activate", async (req, res) => {
  const { email, password, room } = req.body ?? {};

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

  await db.insert(kioskActivationsTable).values({
    tokenHash,
    room: chosenRoom,
    staffId: staff.id,
  });

  res.status(201).json({
    token,
    room: chosenRoom,
    staffName: staff.displayName,
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
      ),
    );
  if (!act) {
    res.status(401).json({ error: "Activation not found or revoked" });
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
  });
});

router.post("/kiosk/hall-passes", async (req, res) => {
  const { studentId, originRoom, destination } = req.body ?? {};

  if (
    typeof studentId !== "string" ||
    typeof originRoom !== "string" ||
    typeof destination !== "string" ||
    !studentId.trim() ||
    !originRoom.trim() ||
    !destination.trim()
  ) {
    res.status(400).json({
      error: "studentId, originRoom, and destination are required",
    });
    return;
  }

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

  const [defaultStaff] = await db
    .select()
    .from(staffDefaultsTable)
    .where(eq(staffDefaultsTable.defaultLocationName, originRoom));

  const teacherName = defaultStaff
    ? `${defaultStaff.staffName} (K)`
    : `Kiosk: ${originRoom}`;

  const [pass] = await db
    .insert(hallPassesTable)
    .values({
      studentId: studentId.trim(),
      destination,
      originRoom,
      teacherName,
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
