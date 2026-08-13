// Hall Pass waiting queue — room anchoring.
//
// The district blocked kiosk devices, so teacher-created passes are now the
// only path to a hall pass. The queue was built for the kiosk: every row was
// anchored to `kiosk_activation_id`, a row that only exists when a physical
// device is activated. That anchor carried four separate guarantees:
//
//   1. the cap of 5 (a row lock scoped to the activation),
//   2. "one student per line" (unique index on activation + student),
//   3. authorization (canManageRoomQueue reads activation.staffId/room), and
//   4. visibility (staff read/delete INNER JOIN kiosk_activations).
//
// (4) is the trap: an entry with no activation wasn't an error, it was
// INVISIBLE — the join dropped it, so a teacher could neither see nor delete
// a student they had queued. Nothing would have surfaced in a log.
//
// These tests pin the room-anchored behavior: the queue is keyed on
// (school_id, room), teacher-created entries with NO kiosk are first-class,
// and a live kiosk in the same room shares one line with the teacher app
// rather than keeping a private one.
//
// Requires DATABASE_URL; skipped otherwise.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import request from "supertest";

const HAS_DB = !!process.env.DATABASE_URL;

const ROOM = "Room 214";
const OTHER_ROOM = "Room 300";

describe.skipIf(!HAS_DB)("hall pass queue — room anchor", () => {
  let db: typeof import("@workspace/db").db;
  let hallPassQueueTable: typeof import("@workspace/db").hallPassQueueTable;
  let studentsTable: typeof import("@workspace/db").studentsTable;
  let staffTable: typeof import("@workspace/db").staffTable;
  let locationsTable: typeof import("@workspace/db").locationsTable;
  let app: import("express").Express;
  let fx: typeof import("./support/authFixtures");

  let tenant: { districtId: number; schoolId: number };
  let teacher: { id: number; email: string };
  let otherTeacher: { id: number; email: string };

  // Local SIS ids students type at a kiosk; the canonical student_id differs.
  const S = (n: number) => ({ sis: `SIS-Q${n}`, sid: `FLQ${n}` });

  beforeAll(async () => {
    const dbMod = await import("@workspace/db");
    db = dbMod.db;
    hallPassQueueTable = dbMod.hallPassQueueTable;
    studentsTable = dbMod.studentsTable;
    staffTable = dbMod.staffTable;
    locationsTable = dbMod.locationsTable;
    fx = await import("./support/authFixtures");
    app = (await import("../app")).default;

    // testSchemaSync.mts builds tables from the schema snapshot and skips
    // indexes, so the new nullable column + the room-scoped unique index
    // aren't there yet. Run the same idempotent ensure the app runs at boot
    // (production relies on it too, since RUN_BOOT_SEED is off there).
    const { ensureHallPassQueueRoomAnchor } =
      await import("../lib/hallPassQueueAnchor");
    await ensureHallPassQueueRoomAnchor();

    tenant = await fx.createTenant("hpq");
    teacher = await fx.createStaff(tenant.schoolId, "teacher", "hpq1");
    otherTeacher = await fx.createStaff(tenant.schoolId, "teacher", "hpq2");

    // The queue is anchored to a room, and kiosk activation already requires
    // the room to exist as an active ORIGIN location. Mirror that here so the
    // teacher path enforces the same rule rather than inventing rooms.
    await db.insert(locationsTable).values([
      {
        schoolId: tenant.schoolId,
        name: ROOM,
        isOrigin: true,
        active: true,
      },
      {
        schoolId: tenant.schoolId,
        name: OTHER_ROOM,
        isOrigin: true,
        active: true,
      },
    ]);

    // Teachers are identified to the queue by their default room.
    await db
      .update(staffTable)
      .set({ defaultRoom: ROOM })
      .where(eq(staffTable.id, teacher.id));
    await db
      .update(staffTable)
      .set({ defaultRoom: OTHER_ROOM })
      .where(eq(staffTable.id, otherTeacher.id));

    // Six students: enough to prove the cap of 5 rejects the sixth.
    for (let i = 1; i <= 6; i++) {
      const s = S(i);
      await db.insert(studentsTable).values({
        schoolId: tenant.schoolId,
        studentId: s.sid,
        localSisId: s.sis,
        firstName: `First${i}`,
        lastName: `Last${i}`,
        grade: 9,
      });
    }
  });

  afterAll(async () => {
    await db
      .delete(hallPassQueueTable)
      .where(eq(hallPassQueueTable.schoolId, tenant.schoolId));
    await db
      .delete(studentsTable)
      .where(eq(studentsTable.schoolId, tenant.schoolId));
    await db
      .delete(locationsTable)
      .where(eq(locationsTable.schoolId, tenant.schoolId));
    await fx.cleanupTenants([tenant.schoolId], [tenant.districtId]);
  });

  // Every /api route is CSRF-protected, so a session needs its token for
  // POST/DELETE. Wrap the fixture so each test reads as one call.
  async function session(email: string) {
    const { agent, csrfToken } = await fx.loginAndCsrf(app, email);
    return {
      get: (url: string) => agent.get(url),
      post: (url: string, body: Record<string, unknown>) =>
        agent.post(url).set("x-csrf-token", csrfToken).send(body),
      del: (url: string) => agent.delete(url).set("x-csrf-token", csrfToken),
    };
  }

  async function clearQueue() {
    await db
      .delete(hallPassQueueTable)
      .where(eq(hallPassQueueTable.schoolId, tenant.schoolId));
  }

  // -- The core regression: no kiosk anywhere in this test file ------------

  it("lets a teacher add a student to their room's line with no kiosk activation", async () => {
    await clearQueue();
    const agent = await session(teacher.email);
    const res = await agent
      .post("/api/hall-pass-queue/add", {
        studentId: S(1).sis,
        destination: "Restroom",
      })
      .expect(200);

    expect(res.body.position).toBe(1);
    expect(res.body.capacity).toBe(5);

    // The row exists, is anchored to the room, and carries NO activation.
    const [row] = await db
      .select()
      .from(hallPassQueueTable)
      .where(eq(hallPassQueueTable.schoolId, tenant.schoolId));
    expect(row.room).toBe(ROOM);
    expect(row.kioskActivationId).toBeNull();
    // Stored canonical id, not the typed SIS id.
    expect(row.studentId).toBe(S(1).sid);
  });

  it("shows that teacher-created entry in the staff panel (the INNER JOIN trap)", async () => {
    // Before the re-anchor the staff read INNER JOINed kiosk_activations, so
    // an entry with a null activation silently vanished from this response —
    // undeletable and invisible. This is the assertion that would have caught
    // it: the entry must come back from the endpoint the panel actually calls.
    const agent = await session(teacher.email);
    const res = await agent.get("/api/hall-pass-queue").expect(200);

    const mine = res.body.entries.filter(
      (e: { room: string }) => e.room === ROOM,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0].studentId).toBe(S(1).sid);
    expect(mine[0].position).toBe(1);
  });

  it("lets the teacher remove an entry they created without a kiosk", async () => {
    const agent = await session(teacher.email);
    const list = await agent.get("/api/hall-pass-queue").expect(200);
    const entry = list.body.entries.find(
      (e: { room: string }) => e.room === ROOM,
    );

    await agent.del(`/api/hall-pass-queue/${entry.id}`).expect(200);

    const after = await db
      .select()
      .from(hallPassQueueTable)
      .where(eq(hallPassQueueTable.id, entry.id));
    expect(after).toHaveLength(0);
  });

  // -- Guarantees the activation anchor used to provide --------------------

  it("enforces the cap of 5 per room", async () => {
    await clearQueue();
    const agent = await session(teacher.email);
    for (let i = 1; i <= 5; i++) {
      await agent
        .post("/api/hall-pass-queue/add", {
          studentId: S(i).sis,
          destination: "Restroom",
        })
        .expect(200);
    }
    const sixth = await agent
      .post("/api/hall-pass-queue/add", {
        studentId: S(6).sis,
        destination: "Restroom",
      })
      .expect(409);
    expect(sixth.body.error).toMatch(/full/i);
  });

  it("holds the cap under concurrent adds to the same room", async () => {
    // The cap used to be atomic via a row lock scoped to the activation.
    // Re-anchored to the room, that lock has to key on (school_id, room) or
    // two students tapping at once both slip past 5.
    await clearQueue();
    const agent = await session(teacher.email);
    const results = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((i) =>
        agent.post("/api/hall-pass-queue/add", {
          studentId: S(i).sis,
          destination: "Restroom",
        }),
      ),
    );
    const ok = results.filter((r) => r.status === 200);
    expect(ok).toHaveLength(5);

    const rows = await db
      .select()
      .from(hallPassQueueTable)
      .where(eq(hallPassQueueTable.schoolId, tenant.schoolId));
    expect(rows).toHaveLength(5);
  });

  it("rejects the same student twice in one room's line", async () => {
    await clearQueue();
    const agent = await session(teacher.email);
    await agent
      .post("/api/hall-pass-queue/add", {
        studentId: S(1).sis,
        destination: "Restroom",
      })
      .expect(200);
    const dup = await agent
      .post("/api/hall-pass-queue/add", {
        studentId: S(1).sis,
        destination: "Water",
      })
      .expect(409);
    expect(dup.body.error).toMatch(/already in line/i);
  });

  it("keeps each room's line separate", async () => {
    await clearQueue();
    const a = await session(teacher.email);
    const b = await session(otherTeacher.email);
    await a
      .post("/api/hall-pass-queue/add", {
        studentId: S(1).sis,
        destination: "Restroom",
      })
      .expect(200);
    // Same student, different room: allowed. The unique index is scoped to
    // the room, not the school.
    await b
      .post("/api/hall-pass-queue/add", {
        studentId: S(1).sis,
        destination: "Restroom",
      })
      .expect(200);

    const rows = await db
      .select()
      .from(hallPassQueueTable)
      .where(eq(hallPassQueueTable.schoolId, tenant.schoolId));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.room))).toEqual(
      new Set([ROOM, OTHER_ROOM]),
    );
  });

  // -- Authorization, which used to be derived from the activation ---------

  it("does not let a teacher manage another room's line", async () => {
    await clearQueue();
    const a = await session(teacher.email);
    await a
      .post("/api/hall-pass-queue/add", {
        studentId: S(1).sis,
        destination: "Restroom",
      })
      .expect(200);
    const [row] = await db
      .select()
      .from(hallPassQueueTable)
      .where(eq(hallPassQueueTable.schoolId, tenant.schoolId));

    // otherTeacher's default room is OTHER_ROOM, so ROOM is not theirs.
    const b = await session(otherTeacher.email);
    await b.del(`/api/hall-pass-queue/${row.id}`).expect(403);

    // And it must not even appear in their panel.
    const list = await b.get("/api/hall-pass-queue").expect(200);
    expect(
      list.body.entries.filter((e: { room: string }) => e.room === ROOM),
    ).toHaveLength(0);
  });

  it("requires sign-in to add to a line", async () => {
    await request(app)
      .post("/api/hall-pass-queue/add")
      .send({ studentId: S(1).sis, destination: "Restroom" })
      .expect(401);
  });

  it("refuses a room that is not an active origin location", async () => {
    // Rooms are free text on staff.default_room and can drift from the
    // curated locations list. Kiosk activation already rejects a room that
    // isn't an active origin location; the teacher path must match, or the
    // queue starts inventing rooms the kiosk would never accept.
    const stray = await fx.createStaff(tenant.schoolId, "teacher", "hpq3");
    await db
      .update(staffTable)
      .set({ defaultRoom: "Portable 9 (not a location)" })
      .where(eq(staffTable.id, stray.id));
    const agent = await session(stray.email);
    const res = await agent
      .post("/api/hall-pass-queue/add", {
        studentId: S(1).sis,
        destination: "Restroom",
      })
      .expect(400);
    expect(res.body.error).toMatch(/room/i);
  });

  // -- Period rollover, which was already school-scoped --------------------

  it("clears entries from a previous period on the next read", async () => {
    await clearQueue();
    const agent = await session(teacher.email);
    await agent
      .post("/api/hall-pass-queue/add", {
        studentId: S(1).sis,
        destination: "Restroom",
      })
      .expect(200);

    // Force the stored key to a stale value; the next read must drop it.
    await db
      .update(hallPassQueueTable)
      .set({ periodKey: "stale:period:key" })
      .where(eq(hallPassQueueTable.schoolId, tenant.schoolId));

    const res = await agent.get("/api/hall-pass-queue").expect(200);
    expect(
      res.body.entries.filter((e: { room: string }) => e.room === ROOM),
    ).toHaveLength(0);
  });

  // -- Ordering ------------------------------------------------------------

  it("assigns positions in arrival order and renumbers after a removal", async () => {
    await clearQueue();
    const agent = await session(teacher.email);
    for (let i = 1; i <= 3; i++) {
      await agent
        .post("/api/hall-pass-queue/add", {
          studentId: S(i).sis,
          destination: "Restroom",
        })
        .expect(200);
    }
    let list = await agent.get("/api/hall-pass-queue").expect(200);
    let mine = list.body.entries.filter(
      (e: { room: string }) => e.room === ROOM,
    );
    expect(mine.map((e: { studentId: string }) => e.studentId)).toEqual([
      S(1).sid,
      S(2).sid,
      S(3).sid,
    ]);

    // Remove the first; the rest must present as 1..n, not 2..n.
    await agent.del(`/api/hall-pass-queue/${mine[0].id}`).expect(200);
    list = await agent.get("/api/hall-pass-queue").expect(200);
    mine = list.body.entries.filter((e: { room: string }) => e.room === ROOM);
    expect(mine.map((e: { position: number }) => e.position)).toEqual([1, 2]);
  });
});
