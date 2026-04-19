import {
  db,
  hallPassesTable,
  tardiesTable,
  pbisEntriesTable,
  supportNotesTable,
  accommodationLogsTable,
} from "@workspace/db";
import { config } from "./data/config";

export async function seedIfEmpty() {
  const now = Date.now();
  const iso = (offsetMin: number) =>
    new Date(now - offsetMin * 60000).toISOString();

  const [hp] = await db.select().from(hallPassesTable).limit(1);
  if (!hp) {
    await db.insert(hallPassesTable).values([
      {
        studentId: "S1001",
        destination: "Restroom",
        originRoom: "Room 101",
        teacherName: "Ms. Rivera",
        status: "active",
        createdAt: iso(5),
        maxDurationMinutes: config.defaultHallPassDurationMinutes,
        endedAt: null,
      },
      {
        studentId: "S1002",
        destination: "Nurse",
        originRoom: "Room 204",
        teacherName: "Mr. Johnson",
        status: "ended",
        createdAt: iso(45),
        maxDurationMinutes: config.defaultHallPassDurationMinutes,
        endedAt: iso(35),
      },
    ]);
  }

  const [t] = await db.select().from(tardiesTable).limit(1);
  if (!t) {
    await db.insert(tardiesTable).values([
      {
        studentId: "S1003",
        teacherName: "Ms. Rivera",
        period: "1",
        reason: "Bus late",
        entryType: "tardy",
        checkInWith: null,
        notes: "",
        createdAt: iso(120),
      },
      {
        studentId: "S1004",
        teacherName: "Mr. Johnson",
        period: "2",
        reason: "Doctor appt",
        entryType: "checkin",
        checkInWith: "Front office",
        notes: "Returned with note",
        createdAt: iso(90),
      },
      {
        studentId: "S1005",
        teacherName: "Coach Lee",
        period: "7",
        reason: "Early dismissal",
        entryType: "checkout",
        checkInWith: "Parent: Karen Brown",
        notes: "",
        createdAt: iso(60),
      },
    ]);
  }

  const [p] = await db.select().from(pbisEntriesTable).limit(1);
  if (!p) {
    await db.insert(pbisEntriesTable).values([
      {
        studentId: "S1001",
        reason: "Helped a peer",
        points: 5,
        staffName: "Ms. Rivera",
        createdAt: iso(180),
      },
      {
        studentId: "S1006",
        reason: "On-time all week",
        points: 3,
        staffName: "Mr. Johnson",
        createdAt: iso(60),
      },
    ]);
  }

  const [n] = await db.select().from(supportNotesTable).limit(1);
  if (!n) {
    await db.insert(supportNotesTable).values([
      {
        studentId: "S1003",
        noteType: "Behavior",
        noteText: "Quiet today, seemed tired. Offered breakfast.",
        staffName: "Ms. Patel (Counselor)",
        createdAt: iso(240),
      },
    ]);
  }

  const [a] = await db.select().from(accommodationLogsTable).limit(1);
  if (!a) {
    await db.insert(accommodationLogsTable).values([
      {
        studentId: "S1001",
        accommodation: "Extended Time",
        period: 3,
        staffName: "Ms. Rivera",
        createdAt: iso(150),
      },
      {
        studentId: "S1004",
        accommodation: "Extended Time",
        period: null,
        staffName: "Ms. Garcia (Interventionist)",
        createdAt: iso(30),
      },
    ]);
  }
}
