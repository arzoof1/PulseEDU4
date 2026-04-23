import {
  db,
  districtsTable,
  schoolsTable,
  hallPassesTable,
  tardiesTable,
  pbisEntriesTable,
  supportNotesTable,
  accommodationLogsTable,
  studentsTable,
  classSectionsTable,
  sectionRosterTable,
  schoolAccommodationsTable,
  studentAccommodationsTable,
  locationsTable,
  staffDefaultsTable,
  locationAllowedDestinationsTable,
  staffTable,
  kioskActivationsTable,
  recordEditsTable,
  adminNotificationsTable,
} from "@workspace/db";
import bcrypt from "bcryptjs";
import { sql } from "drizzle-orm";
import { generateSeedData } from "./data/seedGen";

const TEMP_PASSWORD = "pulseed-temp";

// Idempotent. Always runs at boot. Ensures the Hernando County district and
// the five pre-seeded schools exist so the Tenancy panel and Day 2 backfill
// always have a stable home, even after a fresh DB reset.
export async function seedTenancy() {
  const HERNANDO_SCHOOLS = [
    { name: "D. S. Parrott Middle School",        shortName: "Parrott",      stateSchoolCode: "0241", isPrimary: true },
    { name: "F. W. Springstead High School",      shortName: "Springstead",  stateSchoolCode: "0181", isPrimary: false },
    { name: "Nature Coast Technical High School", shortName: "Nature Coast", stateSchoolCode: "0351", isPrimary: false },
    { name: "Weeki Wachee High School",           shortName: "Weeki Wachee", stateSchoolCode: "0391", isPrimary: false },
    { name: "Powell Middle School",               shortName: "Powell",       stateSchoolCode: "0221", isPrimary: false },
  ];

  await db
    .insert(districtsTable)
    .values({
      name: "Hernando County School District",
      slug: "hernando",
      stateDistrictCode: "27",
      timezone: "America/New_York",
    })
    .onConflictDoNothing({ target: districtsTable.slug });

  const [district] = await db
    .select()
    .from(districtsTable)
    .where(sql`slug = 'hernando'`);
  if (!district) return;

  for (const s of HERNANDO_SCHOOLS) {
    await db
      .insert(schoolsTable)
      .values({ districtId: district.id, ...s })
      .onConflictDoNothing();
  }
}

export async function seedIfEmpty() {
  const [marker] = await db
    .select()
    .from(schoolAccommodationsTable)
    .limit(1);
  if (marker) return; // Already seeded

  console.log("[seed] Resetting and rebuilding school data...");

  // Wipe order respects dependencies (children first).
  await db.delete(kioskActivationsTable);
  await db.delete(adminNotificationsTable);
  await db.delete(recordEditsTable);
  await db.delete(hallPassesTable);
  await db.delete(tardiesTable);
  await db.delete(pbisEntriesTable);
  await db.delete(supportNotesTable);
  await db.delete(accommodationLogsTable);
  await db.delete(studentAccommodationsTable);
  await db.delete(schoolAccommodationsTable);
  await db.delete(sectionRosterTable);
  await db.delete(classSectionsTable);
  await db.delete(staffDefaultsTable);
  await db.delete(locationAllowedDestinationsTable);
  await db.delete(locationsTable);
  await db.delete(studentsTable);
  await db.delete(staffTable);

  const data = generateSeedData();
  const tempHash = await bcrypt.hash(TEMP_PASSWORD, 10);

  // ---- Staff: 30 generated teachers + Mr. Davis (admin) + Ms. Garcia (ESE coord)
  // All seed data lives at school 1 (D. S. Parrott — the primary Hernando school).
  // Stamped explicitly so this still works after the DB DEFAULT 1 is dropped.
  const SEED_SCHOOL_ID = 1;
  const staffInsert: (typeof staffTable.$inferInsert)[] = data.teachers.map(
    (t) => ({
      schoolId: SEED_SCHOOL_ID,
      email: t.email,
      displayName: t.displayName,
      passwordHash: tempHash,
      isAdmin: false,
      isEseCoordinator: false,
    }),
  );
  staffInsert.push({
    schoolId: SEED_SCHOOL_ID,
    email: "mr.davis@school.local",
    displayName: "Mr. Davis (Admin)",
    passwordHash: tempHash,
    isAdmin: true,
    isEseCoordinator: false,
  });
  staffInsert.push({
    schoolId: SEED_SCHOOL_ID,
    email: "ms.garcia@school.local",
    displayName: "Ms. Garcia (ESE Coordinator)",
    passwordHash: tempHash,
    isAdmin: false,
    isEseCoordinator: true,
  });
  const insertedStaff = await db
    .insert(staffTable)
    .values(staffInsert)
    .returning();

  // Map index in data.teachers -> staff.id
  const teacherStaffIds: number[] = [];
  for (let i = 0; i < data.teachers.length; i++) {
    teacherStaffIds.push(insertedStaff[i].id);
  }
  const adminStaffId = insertedStaff[data.teachers.length].id;
  const eseStaffId = insertedStaff[data.teachers.length + 1].id;

  // ---- Students
  const insertedStudents = await db
    .insert(studentsTable)
    .values(
      data.students.map((s) => ({
        schoolId: SEED_SCHOOL_ID,
        studentId: s.studentId,
        firstName: s.firstName,
        lastName: s.lastName,
        grade: s.grade,
        parentName: s.parentName,
        parentEmail: s.parentEmail,
        parentPhone: s.parentPhone,
      })),
    )
    .returning();
  void insertedStudents;

  // ---- Sections (7 per teacher, including planning marker)
  const sectionInserts: (typeof classSectionsTable.$inferInsert)[] = [];
  for (let t = 0; t < data.teachers.length; t++) {
    const teacher = data.teachers[t];
    for (let p = 1; p <= 7; p++) {
      sectionInserts.push({
        schoolId: SEED_SCHOOL_ID,
        teacherStaffId: teacherStaffIds[t],
        period: p,
        courseName:
          p === teacher.planningPeriod
            ? `Planning P${p}`
            : `Section P${p}`,
        isPlanning: p === teacher.planningPeriod,
      });
    }
  }
  const insertedSections = await db
    .insert(classSectionsTable)
    .values(sectionInserts)
    .returning();

  // Lookup: (teacherStaffId, period) -> sectionId
  const sectionLookup = new Map<string, number>();
  for (const s of insertedSections) {
    sectionLookup.set(`${s.teacherStaffId}:${s.period}`, s.id);
  }

  // ---- Section roster: walk each student's schedule
  const rosterInserts: (typeof sectionRosterTable.$inferInsert)[] = [];
  for (const student of data.students) {
    for (const [periodStr, teacherIdx] of Object.entries(student.schedule)) {
      const period = Number(periodStr);
      const teacher = data.teachers[teacherIdx];
      // Skip students assigned to a teacher's planning period (shouldn't happen
      // since generateSeedData filters, but defensive)
      if (period === teacher.planningPeriod) continue;
      const sectionId = sectionLookup.get(
        `${teacherStaffIds[teacherIdx]}:${period}`,
      );
      if (sectionId) {
        rosterInserts.push({
          schoolId: SEED_SCHOOL_ID,
          sectionId,
          studentId: student.studentId,
        });
      }
    }
  }
  // Insert in chunks
  const CHUNK = 1000;
  for (let i = 0; i < rosterInserts.length; i += CHUNK) {
    await db
      .insert(sectionRosterTable)
      .values(rosterInserts.slice(i, i + CHUNK));
  }

  // ---- Master accommodations
  const insertedAccs = await db
    .insert(schoolAccommodationsTable)
    .values(
      data.accommodations.map((a) => ({
        schoolId: SEED_SCHOOL_ID,
        name: a.name,
        category: a.category,
        active: true,
      })),
    )
    .returning();

  // ---- Per-student accommodation assignments
  const assignInserts: (typeof studentAccommodationsTable.$inferInsert)[] = [];
  for (const student of data.students) {
    for (const idx of student.accommodationIndices) {
      assignInserts.push({
        schoolId: SEED_SCHOOL_ID,
        studentId: student.studentId,
        accommodationId: insertedAccs[idx].id,
        assignedByStaffId: eseStaffId,
      });
    }
  }
  for (let i = 0; i < assignInserts.length; i += CHUNK) {
    await db
      .insert(studentAccommodationsTable)
      .values(assignInserts.slice(i, i + CHUNK));
  }

  // ---- Locations + allowed destinations + a couple of staff defaults
  await db.insert(locationsTable).values(
    [
      { name: "Room 101", kind: "classroom", isOrigin: true, isDestination: false },
      { name: "Room 102", kind: "classroom", isOrigin: true, isDestination: false },
      { name: "Room 201", kind: "classroom", isOrigin: true, isDestination: false },
      { name: "Room 202", kind: "classroom", isOrigin: true, isDestination: false },
      { name: "Room 204", kind: "classroom", isOrigin: true, isDestination: false },
      { name: "Room 305", kind: "classroom", isOrigin: true, isDestination: false },
      { name: "Gym", kind: "common_area", isOrigin: true, isDestination: false },
      { name: "Cafeteria", kind: "common_area", isOrigin: true, isDestination: true },
      { name: "Library", kind: "common_area", isOrigin: false, isDestination: true },
      { name: "Media Center", kind: "common_area", isOrigin: false, isDestination: true },
      { name: "Boys Restroom", kind: "restroom", isOrigin: false, isDestination: true, studentVisible: true },
      { name: "Girls Restroom", kind: "restroom", isOrigin: false, isDestination: true, studentVisible: true },
      { name: "Nurse", kind: "office", isOrigin: false, isDestination: true, studentVisible: true },
      { name: "Front Office", kind: "office", isOrigin: false, isDestination: true, studentVisible: true },
      { name: "Guidance", kind: "office", isOrigin: false, isDestination: true, studentVisible: true },
    ].map((l) => ({ schoolId: SEED_SCHOOL_ID, ...l })),
  );

  const allLocs = await db.select().from(locationsTable);
  const origins = allLocs.filter((l) => l.isOrigin);
  const destinations = allLocs.filter((l) => l.isDestination);
  const ladRows: {
    schoolId: number;
    originLocationId: number;
    destinationLocationId: number;
  }[] = [];
  for (const o of origins) {
    for (const d of destinations) {
      ladRows.push({
        schoolId: SEED_SCHOOL_ID,
        originLocationId: o.id,
        destinationLocationId: d.id,
      });
    }
  }
  if (ladRows.length > 0) {
    await db.insert(locationAllowedDestinationsTable).values(ladRows);
  }

  // staff_defaults is now keyed by staff.id (SIS-safe). Look up the seeded
  // staff rows by display name and write the FK alongside the legacy name.
  const staffByName = new Map(
    insertedStaff.map((s) => [s.displayName, s.id] as const),
  );
  const defaultRows = [
    { name: "Mr. Davis (Admin)", room: "Front Office" },
    { name: "Ms. Garcia (ESE Coordinator)", room: "Room 305" },
  ]
    .map((r) => {
      const id = staffByName.get(r.name);
      return id == null
        ? null
        : {
            schoolId: SEED_SCHOOL_ID,
            staffId: id,
            staffName: r.name,
            defaultLocationName: r.room,
          };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
  if (defaultRows.length > 0) {
    await db.insert(staffDefaultsTable).values(defaultRows);
  }

  // Reset sequences so subsequent inserts don't collide if we ever re-seed
  // partially. Safe no-ops if not needed.
  await db.execute(
    sql`SELECT setval(pg_get_serial_sequence('students','id'), (SELECT COALESCE(MAX(id),1) FROM students))`,
  );
  await db.execute(
    sql`SELECT setval(pg_get_serial_sequence('staff','id'), (SELECT COALESCE(MAX(id),1) FROM staff))`,
  );

  console.log(
    `[seed] Done. Staff: ${insertedStaff.length}, Students: ${data.students.length}, ` +
      `Sections: ${insertedSections.length}, Roster rows: ${rosterInserts.length}, ` +
      `Master accommodations: ${insertedAccs.length}, Assignments: ${assignInserts.length}.`,
  );
}
