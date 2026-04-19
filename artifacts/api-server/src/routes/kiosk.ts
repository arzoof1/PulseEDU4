import { Router, type IRouter } from "express";
import {
  db,
  hallPassesTable,
  locationsTable,
  locationAllowedDestinationsTable,
  staffDefaultsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import { config } from "../data/config";

const router: IRouter = Router();

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
