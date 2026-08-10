import {
  db,
  districtIntegrationsTable,
  schoolsTable,
  studentsTable,
  staffTable,
  staffDefaultsTable,
  classSectionsTable,
  sectionRosterTable,
} from "@workspace/db";
import type { DistrictIntegrationRow } from "@workspace/db";
import {
  getRosterAdapter,
  type ResolvedSchoolOrg,
  type RosterAdapter,
  type SisClassSection,
  type SisStaff,
  type SisStudent,
} from "@workspace/sis-adapters";
import { resolveSisSchoolMapping } from "./sisSchoolMapping.js";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { bcryptHash } from "./bcrypt.js";
import { logger } from "./logger.js";
import { schoolCodeLookupKeys } from "@workspace/sis-adapters";

type DbExecutor = Pick<typeof db, "insert" | "update" | "delete" | "select">;

export type SisSyncStatus = "success" | "partial" | "failed";

export type SisSyncCounts = {
  studentsUpserted: number;
  staffUpserted: number;
  staffSkipped: number;
  sectionsWritten: number;
  enrollmentsWritten: number;
  roomsUpdated: number;
};

export type SisSyncSchoolMapping = {
  pulseStateSchoolCode: string | null;
  classLinkOrgSourcedId: string;
  classLinkOrgIdentifier: string | null;
  classLinkOrgName: string;
};

export type SisSyncResult = {
  ok: boolean;
  status: SisSyncStatus;
  integrationId: number;
  schoolId: number;
  schoolName: string;
  schoolMapping?: SisSyncSchoolMapping;
  counts: SisSyncCounts;
  errors: string[];
  message: string;
};

type SisConfig = {
  schoolId?: number;
  stateSchoolCode?: string;
  schoolOrgSourcedId?: string;
  schoolOrgIdentifier?: string;
  useFixtures?: boolean;
  rostersBaseUrl?: string;
  rostersClientIdEnvVar?: string;
  rostersClientSecretEnvVar?: string;
};

function parseSisConfig(
  raw: Record<string, unknown> | null | undefined,
): SisConfig {
  const c = raw ?? {};
  return {
    schoolId: typeof c.schoolId === "number" ? c.schoolId : undefined,
    stateSchoolCode:
      typeof c.stateSchoolCode === "string" ? c.stateSchoolCode : undefined,
    schoolOrgSourcedId:
      typeof c.schoolOrgSourcedId === "string"
        ? c.schoolOrgSourcedId
        : undefined,
    schoolOrgIdentifier:
      typeof c.schoolOrgIdentifier === "string"
        ? c.schoolOrgIdentifier
        : undefined,
    useFixtures: typeof c.useFixtures === "boolean" ? c.useFixtures : undefined,
    rostersBaseUrl:
      typeof c.rostersBaseUrl === "string" ? c.rostersBaseUrl : undefined,
    rostersClientIdEnvVar:
      typeof c.rostersClientIdEnvVar === "string"
        ? c.rostersClientIdEnvVar
        : undefined,
    rostersClientSecretEnvVar:
      typeof c.rostersClientSecretEnvVar === "string"
        ? c.rostersClientSecretEnvVar
        : undefined,
  };
}

function parseGrade(gradeLevel: string | null | undefined): number | null {
  if (gradeLevel == null || !String(gradeLevel).trim()) return null;
  const t = String(gradeLevel).trim().toUpperCase();
  if (t === "K" || t === "KG" || t === "KINDERGARTEN") return 0;
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : null;
}

function normalizeSisRole(role: string | null | undefined): string | null {
  if (role == null) return null;
  const t = String(role).trim().toLowerCase();
  return t.length > 0 ? t : null;
}

function summarizeStatus(errors: string[]): SisSyncStatus {
  if (errors.length === 0) return "success";
  return "partial";
}

function statusMessage(status: SisSyncStatus, errors: string[]): string {
  if (status === "success") return "Roster sync completed successfully.";
  if (status === "partial" && errors.length === 1) return errors[0]!;
  if (errors.length === 1) return errors[0]!;
  return `Roster sync completed with ${errors.length} warnings.`;
}

type ResolvedPulseSchool = {
  schoolId: number;
  schoolName: string;
  stateSchoolCode: string | null;
};

/** Resolve PulseEDU school id from integration row + sis_config. */
export async function resolveSchoolIdForIntegration(
  row: DistrictIntegrationRow,
): Promise<ResolvedPulseSchool | null> {
  const cfg = parseSisConfig(row.sisConfig);
  const schoolCols = {
    id: schoolsTable.id,
    name: schoolsTable.name,
    stateSchoolCode: schoolsTable.stateSchoolCode,
  };

  const toResolved = (school: {
    id: number;
    name: string;
    stateSchoolCode: string | null;
  }): ResolvedPulseSchool => ({
    schoolId: school.id,
    schoolName: school.name,
    stateSchoolCode: school.stateSchoolCode,
  });

  const [byIntegrationName] = row.schoolName?.trim()
    ? await db
        .select(schoolCols)
        .from(schoolsTable)
        .where(eq(schoolsTable.name, row.schoolName.trim()))
    : [];

  let byId: ResolvedPulseSchool | null = null;
  if (cfg.schoolId != null && cfg.schoolId > 0) {
    const [school] = await db
      .select(schoolCols)
      .from(schoolsTable)
      .where(eq(schoolsTable.id, cfg.schoolId));
    if (school) byId = toResolved(school);
  }

  // Prefer the integration's schoolName over a stale sis_config.schoolId when
  // they disagree (root cause of "Pace" cards writing into Bayonet Point).
  if (
    byIntegrationName &&
    byId &&
    byIntegrationName.id !== byId.schoolId
  ) {
    logger.warn(
      {
        integrationId: row.id,
        integrationSchoolName: row.schoolName,
        configSchoolId: cfg.schoolId,
        configSchoolName: byId.schoolName,
        nameMatchedId: byIntegrationName.id,
      },
      "SIS sync: sis_config.schoolId disagrees with district_integrations.schoolName — using name match",
    );
    return toResolved(byIntegrationName);
  }
  if (byId) return byId;
  if (byIntegrationName) return toResolved(byIntegrationName);

  // Prefer explicit identifier, then state code — try every ENT/pad variant
  // so ENT0342 finds a Pulse school stored as 0342 (and vice versa).
  const codeHints = [
    cfg.schoolOrgIdentifier,
    cfg.stateSchoolCode,
  ].filter((c): c is string => typeof c === "string" && c.trim().length > 0);

  const codeKeys = Array.from(
    new Set(codeHints.flatMap((c) => schoolCodeLookupKeys(c))),
  );
  if (codeKeys.length > 0) {
    const matches = await db
      .select(schoolCols)
      .from(schoolsTable)
      .where(inArray(schoolsTable.stateSchoolCode, codeKeys));
    if (matches.length === 1) {
      return toResolved(matches[0]!);
    }
    if (matches.length > 1) {
      const prefer = cfg.stateSchoolCode?.trim();
      const exact = prefer
        ? matches.find((m) => m.stateSchoolCode === prefer)
        : undefined;
      const school = exact ?? matches[0]!;
      logger.warn(
        {
          integrationId: row.id,
          schoolName: row.schoolName,
          codeKeys,
          matchedIds: matches.map((m) => m.id),
          chosenId: school.id,
        },
        "SIS sync: multiple Pulse schools matched state code variants; using one",
      );
      return toResolved(school);
    }
  }

  return null;
}

function buildAdapter(
  row: DistrictIntegrationRow,
  configOverride?: Record<string, unknown>,
): RosterAdapter | null {
  if (row.sisProvider !== "classlink" && row.sisProvider !== "skyward") {
    return null;
  }
  return getRosterAdapter(row.sisProvider as "classlink" | "skyward", {
    ...(row.sisConfig ?? {}),
    ...(configOverride ?? {}),
  });
}

function toSyncSchoolMapping(
  pulse: ResolvedPulseSchool,
  org: ResolvedSchoolOrg,
): SisSyncSchoolMapping {
  return {
    pulseStateSchoolCode: pulse.stateSchoolCode,
    classLinkOrgSourcedId: org.sourcedId,
    classLinkOrgIdentifier: org.identifier,
    classLinkOrgName: org.name,
  };
}

function studentDemographicPatch(
  s: SisStudent,
): Partial<{
  gender: string | null;
  ell: boolean;
  ese: boolean;
  is504: boolean;
  race: string | null;
  ethnicity: string | null;
}> {
  const patch: ReturnType<typeof studentDemographicPatch> = {};
  if (s.gender !== undefined) patch.gender = s.gender ?? null;
  if (s.ell !== undefined) patch.ell = s.ell;
  if (s.ese !== undefined) patch.ese = s.ese;
  if (s.is504 !== undefined) patch.is504 = s.is504;
  if (s.race !== undefined) patch.race = s.race ?? null;
  if (s.ethnicity !== undefined) patch.ethnicity = s.ethnicity ?? null;
  return patch;
}

async function upsertStudents(
  ex: DbExecutor,
  schoolId: number,
  rows: SisStudent[],
  errors: string[],
): Promise<number> {
  let count = 0;
  for (const s of rows) {
    const grade = parseGrade(s.gradeLevel);
    if (grade == null) {
      errors.push(
        `Skipped student ${s.studentId}: missing or invalid grade "${s.gradeLevel ?? ""}".`,
      );
      continue;
    }
    if (!s.studentId.trim() || !s.firstName.trim() || !s.lastName.trim()) {
      errors.push(`Skipped student with incomplete identity (external ${s.externalId}).`);
      continue;
    }

    const demo = studentDemographicPatch(s);
    await ex
      .insert(studentsTable)
      .values({
        schoolId,
        studentId: s.studentId.trim(),
        firstName: s.firstName.trim(),
        lastName: s.lastName.trim(),
        grade,
        gender: demo.gender ?? null,
        ell: demo.ell ?? false,
        ese: demo.ese ?? false,
        is504: demo.is504 ?? false,
        race: demo.race ?? null,
        ethnicity: demo.ethnicity ?? null,
      })
      .onConflictDoUpdate({
        target: studentsTable.studentId,
        set: {
          schoolId,
          firstName: s.firstName.trim(),
          lastName: s.lastName.trim(),
          grade,
          ...demo,
        },
      });
    count++;
  }
  return count;
}

async function upsertStaff(
  ex: DbExecutor,
  schoolId: number,
  staffRows: SisStaff[],
  errors: string[],
): Promise<{
  upserted: number;
  skipped: number;
  staffExternalToId: Map<string, number>;
}> {
  const existing = await ex
    .select({
      id: staffTable.id,
      email: staffTable.email,
      externalId: staffTable.externalId,
      displayName: staffTable.displayName,
    })
    .from(staffTable)
    .where(eq(staffTable.schoolId, schoolId));

  const byExternal = new Map<string, (typeof existing)[number]>();
  const byEmail = new Map<string, (typeof existing)[number]>();
  for (const row of existing) {
    if (row.externalId) byExternal.set(row.externalId, row);
    byEmail.set(row.email.toLowerCase(), row);
  }

  // staff.email is GLOBALLY unique. A district shares teachers across schools
  // (itinerant / ESE / district staff), so many incoming rows already exist
  // under a different school_id. Pre-load every existing row for the incoming
  // emails ACROSS ALL SCHOOLS, so we reuse those accounts instead of issuing an
  // insert that would hit the unique constraint and abort the whole school's
  // transaction (Postgres poisons the txn on the first error — catching after
  // the fact can't recover it).
  const incomingEmails = Array.from(
    new Set(
      staffRows
        .map((s) => s.email.trim().toLowerCase())
        .filter((e) => e.length > 0),
    ),
  );
  const globalByEmail = new Map<string, { id: number; email: string }>();
  for (let i = 0; i < incomingEmails.length; i += 500) {
    const chunk = incomingEmails.slice(i, i + 500);
    const rows = await ex
      .select({ id: staffTable.id, email: staffTable.email })
      .from(staffTable)
      .where(inArray(staffTable.email, chunk));
    for (const r of rows) globalByEmail.set(r.email.toLowerCase(), r);
  }

  // External-id -> staff.id for EVERY staff row this feed touches (in-school
  // matches, brand-new inserts, and reused cross-school accounts). Scheduling
  // relies on this map, and shared teachers live under another school_id, so a
  // school-scoped re-query would silently drop them.
  const staffExternalToId = new Map<string, number>();
  let upserted = 0;
  let skipped = 0;

  for (const s of staffRows) {
    const email = s.email.trim().toLowerCase();
    if (!email) {
      errors.push(
        `Skipped staff ${s.displayName} (${s.externalId}): no email from SIS.`,
      );
      skipped++;
      continue;
    }

    const sisRole = normalizeSisRole(s.role);

    // 1. Already a staff row for THIS school — update in place.
    const localMatch = byExternal.get(s.externalId) ?? byEmail.get(email) ?? null;
    if (localMatch) {
      await ex
        .update(staffTable)
        .set({
          externalId: s.externalId,
          displayName: s.displayName,
          ...(sisRole ? { sisRole } : {}),
          // Never touch passwordHash on sync.
        })
        .where(and(eq(staffTable.id, localMatch.id), eq(staffTable.schoolId, schoolId)));
      byExternal.set(s.externalId, { ...localMatch, externalId: s.externalId });
      byEmail.set(email, localMatch);
      staffExternalToId.set(s.externalId, localMatch.id);
      upserted++;
      continue;
    }

    // 2. Teacher already exists under ANOTHER school (shared / itinerant staff).
    //    Reuse that account — link this school's class sections to it rather than
    //    creating a duplicate (which the global email constraint forbids).
    const globalMatch = globalByEmail.get(email);
    if (globalMatch) {
      if (sisRole) {
        await ex
          .update(staffTable)
          .set({ sisRole, externalId: s.externalId })
          .where(eq(staffTable.id, globalMatch.id));
      }
      staffExternalToId.set(s.externalId, globalMatch.id);
      skipped++;
      continue;
    }

    // 3. Brand-new staff for the district. Placeholder password + must_set_password
    //    until they complete invite / forgot-password. ClassLink administrator
    //    → isAdmin on insert only (never downgrade on later syncs).
    const passwordHash = await bcryptHash(
      `sis-sync-no-login-${randomUUID()}`,
      10,
    );
    const [inserted] = await ex
      .insert(staffTable)
      .values({
        schoolId,
        email,
        passwordHash,
        displayName: s.displayName,
        externalId: s.externalId,
        sisRole,
        mustSetPassword: true,
        isAdmin: sisRole === "administrator",
        active: true,
      })
      .onConflictDoNothing({ target: staffTable.email })
      .returning({
        id: staffTable.id,
        email: staffTable.email,
        externalId: staffTable.externalId,
        displayName: staffTable.displayName,
      });
    if (inserted) {
      byExternal.set(s.externalId, inserted);
      byEmail.set(email, inserted);
      globalByEmail.set(email, inserted);
      staffExternalToId.set(s.externalId, inserted.id);
      upserted++;
      continue;
    }

    // Lost an insert race (row appeared between the pre-load and now). Resolve
    // it so scheduling still maps, and never crash the run.
    const [raced] = await ex
      .select({ id: staffTable.id })
      .from(staffTable)
      .where(eq(staffTable.email, email))
      .limit(1);
    if (raced) {
      globalByEmail.set(email, { id: raced.id, email });
      staffExternalToId.set(s.externalId, raced.id);
    }
    skipped++;
  }

  return { upserted, skipped, staffExternalToId };
}

async function upsertStaffRooms(
  ex: DbExecutor,
  schoolId: number,
  staffRows: SisStaff[],
  staffExternalToId: Map<string, number>,
): Promise<number> {
  let count = 0;
  for (const s of staffRows) {
    const room = s.primaryRoom?.trim();
    if (!room) continue;
    const staffId = staffExternalToId.get(s.externalId);
    if (!staffId) continue;

    await ex
      .update(staffDefaultsTable)
      .set({ staffId, schoolId, defaultLocationName: room, staffName: s.displayName })
      .where(
        and(
          eq(staffDefaultsTable.schoolId, schoolId),
          eq(staffDefaultsTable.staffName, s.displayName),
          sql`${staffDefaultsTable.staffId} IS NULL`,
        ),
      );

    await ex
      .insert(staffDefaultsTable)
      .values({
        schoolId,
        staffId,
        staffName: s.displayName,
        defaultLocationName: room,
      })
      .onConflictDoUpdate({
        target: staffDefaultsTable.staffId,
        set: {
          schoolId,
          defaultLocationName: room,
          staffName: s.displayName,
        },
      });
    count++;
  }
  return count;
}

async function rebuildSchedules(
  ex: DbExecutor,
  schoolId: number,
  sections: SisClassSection[],
  enrollments: { classExternalId: string; studentId: string }[],
  staffExternalToId: Map<string, number>,
  validStudentIds: Set<string>,
  errors: string[],
): Promise<{ sections: number; enrollments: number }> {
  await ex
    .delete(sectionRosterTable)
    .where(eq(sectionRosterTable.schoolId, schoolId));

  await ex
    .delete(classSectionsTable)
    .where(
      and(
        eq(classSectionsTable.schoolId, schoolId),
        eq(classSectionsTable.isPlanning, false),
      ),
    );

  const classExternalToSectionId = new Map<string, number>();
  const sectionInserts: Array<typeof classSectionsTable.$inferInsert> = [];
  // De-dupe on the section's business identity (teacher, period, course). A
  // teacher legitimately runs several distinct courses in one period (ESE /
  // self-contained), which the unique index now allows; two roster rows with
  // the SAME identity collapse into one section and pool their enrollments,
  // so the batch can never trip class_sections_teacher_period_course_unique.
  const keyToInsertIndex = new Map<string, number>();
  const externalToKey = new Map<string, string>();

  for (const sec of sections) {
    const teacherStaffId = staffExternalToId.get(sec.teacherExternalId);
    if (!teacherStaffId) {
      errors.push(
        `Skipped class ${sec.externalId}: teacher ${sec.teacherExternalId} not found in school staff.`,
      );
      continue;
    }
    if (!Number.isFinite(sec.period) || sec.period < 0) {
      errors.push(`Skipped class ${sec.externalId}: invalid period.`);
      continue;
    }
    const key = `${teacherStaffId}|${sec.period}|${sec.courseName}`;
    externalToKey.set(sec.externalId, key);
    if (!keyToInsertIndex.has(key)) {
      keyToInsertIndex.set(key, sectionInserts.length);
      sectionInserts.push({
        schoolId,
        teacherStaffId,
        period: sec.period,
        courseName: sec.courseName,
        isPlanning: sec.isPlanning ?? false,
      });
    }
  }

  if (sectionInserts.length === 0) {
    return { sections: 0, enrollments: 0 };
  }

  const insertedSections = await ex
    .insert(classSectionsTable)
    .values(sectionInserts)
    .returning({ id: classSectionsTable.id });

  // insertedSections aligns positionally with sectionInserts → key → section id,
  // then every external class id (including de-duped ones) maps to its section.
  const keyToSectionId = new Map<string, number>();
  for (const [key, idx] of keyToInsertIndex) {
    const row = insertedSections[idx];
    if (row) keyToSectionId.set(key, row.id);
  }
  for (const [externalId, key] of externalToKey) {
    const sectionId = keyToSectionId.get(key);
    if (sectionId != null) classExternalToSectionId.set(externalId, sectionId);
  }

  const rosterRows: Array<typeof sectionRosterTable.$inferInsert> = [];
  const seen = new Set<string>();

  for (const enr of enrollments) {
    if (!validStudentIds.has(enr.studentId)) continue;
    const sectionId = classExternalToSectionId.get(enr.classExternalId);
    if (!sectionId) continue;
    const key = `${sectionId}:${enr.studentId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rosterRows.push({
      schoolId,
      sectionId,
      studentId: enr.studentId,
    });
  }

  for (let i = 0; i < rosterRows.length; i += 500) {
    await ex
      .insert(sectionRosterTable)
      .values(rosterRows.slice(i, i + 500))
      .onConflictDoNothing();
  }

  return {
    sections: insertedSections.length,
    enrollments: rosterRows.length,
  };
}

async function persistSyncStatus(
  integrationId: number,
  status: SisSyncStatus,
  errors: string[],
): Promise<void> {
  const payload =
    errors.length === 0
      ? status
      : `${status}: ${errors.slice(0, 5).join(" | ")}`.slice(0, 2000);

  await db
    .update(districtIntegrationsTable)
    .set({
      sisLastSyncAt: new Date(),
      sisLastSyncStatus: payload,
      updatedAt: new Date(),
    })
    .where(eq(districtIntegrationsTable.id, integrationId));
}

export async function runSisSyncForIntegration(
  integrationId: number,
): Promise<SisSyncResult> {
  const [row] = await db
    .select()
    .from(districtIntegrationsTable)
    .where(eq(districtIntegrationsTable.id, integrationId));

  if (!row) {
    return {
      ok: false,
      status: "failed",
      integrationId,
      schoolId: 0,
      schoolName: "",
      counts: {
        studentsUpserted: 0,
        staffUpserted: 0,
        staffSkipped: 0,
        sectionsWritten: 0,
        enrollmentsWritten: 0,
        roomsUpdated: 0,
      },
      errors: ["Integration row not found."],
      message: "Integration row not found.",
    };
  }

  return runSisSync(row);
}

export async function runSisSyncForSchool(
  schoolId: number,
): Promise<SisSyncResult | null> {
  const [school] = await db
    .select({ name: schoolsTable.name })
    .from(schoolsTable)
    .where(eq(schoolsTable.id, schoolId));
  if (!school) return null;

  const integrations = await db
    .select()
    .from(districtIntegrationsTable)
    .where(eq(districtIntegrationsTable.sisProvider, "classlink"));

  for (const row of integrations) {
    const resolved = await resolveSchoolIdForIntegration(row);
    if (resolved?.schoolId === schoolId) {
      return runSisSync(row);
    }
  }

  // Also try matching by school name directly.
  const [byName] = await db
    .select()
    .from(districtIntegrationsTable)
    .where(eq(districtIntegrationsTable.schoolName, school.name));

  if (byName && byName.sisProvider !== "none") {
    return runSisSync(byName);
  }

  return null;
}

export async function runSisSync(
  row: DistrictIntegrationRow,
): Promise<SisSyncResult> {
  const errors: string[] = [];
  const counts: SisSyncCounts = {
    studentsUpserted: 0,
    staffUpserted: 0,
    staffSkipped: 0,
    sectionsWritten: 0,
    enrollmentsWritten: 0,
    roomsUpdated: 0,
  };

  const resolved = await resolveSchoolIdForIntegration(row);
  if (!resolved) {
    const fail: SisSyncResult = {
      ok: false,
      status: "failed",
      integrationId: row.id,
      schoolId: 0,
      schoolName: row.schoolName,
      counts,
      errors: [
        `Could not map integration to a PulseEDU school (set sis_config.stateSchoolCode or schoolId).`,
      ],
      message: "School mapping failed.",
    };
    await persistSyncStatus(row.id, "failed", fail.errors);
    return fail;
  }

  const { schoolId, schoolName } = resolved;
  const probeAdapter = buildAdapter(row);
  if (!probeAdapter) {
    const fail: SisSyncResult = {
      ok: false,
      status: "failed",
      integrationId: row.id,
      schoolId,
      schoolName,
      counts,
      errors: [`Unsupported or missing SIS provider "${row.sisProvider}".`],
      message: "No roster adapter configured.",
    };
    await persistSyncStatus(row.id, "failed", fail.errors);
    return fail;
  }

  try {
    const ping = await probeAdapter.ping();
    if (!ping.ok) {
      throw new Error(ping.message);
    }

    const mappingResult = await resolveSisSchoolMapping(
      row,
      {
        id: schoolId,
        name: schoolName,
        stateSchoolCode: resolved.stateSchoolCode,
      },
      probeAdapter,
    );

    if (!mappingResult.ok) {
      const fail: SisSyncResult = {
        ok: false,
        status: "failed",
        integrationId: row.id,
        schoolId,
        schoolName,
        counts,
        errors: mappingResult.errors,
        message: "ClassLink school org mapping failed.",
      };
      await persistSyncStatus(row.id, "failed", fail.errors);
      return fail;
    }

    const { mapping } = mappingResult;
    for (const w of mappingResult.warnings) {
      errors.push(w);
    }
    const adapter =
      buildAdapter(row, mapping.adapterConfig) ?? probeAdapter;
    const schoolMapping = toSyncSchoolMapping(resolved, mapping.classLinkOrg);

    const [students, staff, sections, enrollments] = await Promise.all([
      adapter.listStudents(),
      adapter.listStaff(),
      adapter.listClassSections(),
      adapter.listEnrollments(),
    ]);

    const feedEmpty =
      students.length === 0 &&
      staff.length === 0 &&
      sections.length === 0;

    if (feedEmpty) {
      errors.push(
        `ClassLink returned no students, staff, or classes for org "${mapping.classLinkOrg.name}" (${mapping.classLinkOrg.sourcedId}` +
          (mapping.classLinkOrg.identifier
            ? `, identifier ${mapping.classLinkOrg.identifier}`
            : "") +
          "). Existing PulseEDU roster was left unchanged.",
      );
      const status = summarizeStatus(errors);
      const result: SisSyncResult = {
        ok: true,
        status,
        integrationId: row.id,
        schoolId,
        schoolName,
        schoolMapping,
        counts,
        errors,
        message: statusMessage(status, errors),
      };
      await persistSyncStatus(row.id, status, errors);
      logger.warn(
        {
          schoolId,
          integrationId: row.id,
          org: mapping.classLinkOrg,
          warnings: mappingResult.warnings,
        },
        "SIS roster sync: empty ClassLink feed — skipped writes",
      );
      return result;
    }

    await db.transaction(async (tx) => {
      counts.studentsUpserted = await upsertStudents(
        tx,
        schoolId,
        students,
        errors,
      );

      const staffResult = await upsertStaff(tx, schoolId, staff, errors);
      counts.staffUpserted = staffResult.upserted;
      counts.staffSkipped = staffResult.skipped;

      const staffExternalToId = staffResult.staffExternalToId;
      counts.roomsUpdated = await upsertStaffRooms(
        tx,
        schoolId,
        staff,
        staffExternalToId,
      );

      const validStudentIds = new Set(students.map((s) => s.studentId.trim()));
      const schedule = await rebuildSchedules(
        tx,
        schoolId,
        sections,
        enrollments,
        staffExternalToId,
        validStudentIds,
        errors,
      );
      counts.sectionsWritten = schedule.sections;
      counts.enrollmentsWritten = schedule.enrollments;
    });

    const status = summarizeStatus(errors);
    const result: SisSyncResult = {
      ok: status !== "failed",
      status,
      integrationId: row.id,
      schoolId,
      schoolName,
      schoolMapping,
      counts,
      errors,
      message: statusMessage(status, errors),
    };
    await persistSyncStatus(row.id, status, errors);
    logger.info({ schoolId, integrationId: row.id, counts, status }, "SIS roster sync finished");
    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, schoolId, integrationId: row.id }, "SIS roster sync failed");
    const fail: SisSyncResult = {
      ok: false,
      status: "failed",
      integrationId: row.id,
      schoolId,
      schoolName,
      counts,
      errors: [msg],
      message: msg,
    };
    await persistSyncStatus(row.id, "failed", fail.errors);
    return fail;
  }
}

export async function listSisSyncIntegrations(): Promise<
  Array<{
    id: number;
    schoolName: string;
    sisProvider: string;
    sisLastSyncAt: Date | null;
    sisLastSyncStatus: string | null;
    resolvedSchoolId: number | null;
    resolvedSchoolName: string | null;
    resolvedStateSchoolCode: string | null;
    configuredSchoolOrgSourcedId: string | null;
    configuredStateSchoolCode: string | null;
  }>
> {
  const rows = await db.select().from(districtIntegrationsTable);
  const out = [];
  for (const row of rows) {
    const resolved = await resolveSchoolIdForIntegration(row);
    const cfg = parseSisConfig(row.sisConfig);
    out.push({
      id: row.id,
      schoolName: row.schoolName,
      sisProvider: row.sisProvider,
      sisLastSyncAt: row.sisLastSyncAt,
      sisLastSyncStatus: row.sisLastSyncStatus,
      resolvedSchoolId: resolved?.schoolId ?? null,
      resolvedSchoolName: resolved?.schoolName ?? null,
      resolvedStateSchoolCode: resolved?.stateSchoolCode ?? null,
      configuredSchoolOrgSourcedId: cfg.schoolOrgSourcedId ?? null,
      configuredStateSchoolCode: cfg.stateSchoolCode ?? null,
    });
  }
  return out;
}

export type ScheduledSisSyncRowResult = {
  integrationId: number;
  schoolId: number;
  schoolName: string;
  ok: boolean;
  status: SisSyncStatus;
  message: string;
  counts: SisSyncCounts;
  errorCount: number;
};

const emptyScheduledCounts = (): SisSyncCounts => ({
  studentsUpserted: 0,
  staffUpserted: 0,
  staffSkipped: 0,
  sectionsWritten: 0,
  enrollmentsWritten: 0,
  roomsUpdated: 0,
});

/**
 * Run roster sync for every configured ClassLink integration.
 * Used by the nightly cron — failures on one school do not abort the rest.
 */
export async function runScheduledSisRosterSyncs(): Promise<
  ScheduledSisSyncRowResult[]
> {
  const integrations = await db
    .select({ id: districtIntegrationsTable.id })
    .from(districtIntegrationsTable)
    .where(eq(districtIntegrationsTable.sisProvider, "classlink"));

  if (integrations.length === 0) {
    logger.info("Scheduled SIS roster sync: no ClassLink integrations configured");
    return [];
  }

  const results: ScheduledSisSyncRowResult[] = [];

  for (const { id } of integrations) {
    try {
      const result = await runSisSyncForIntegration(id);
      results.push({
        integrationId: result.integrationId,
        schoolId: result.schoolId,
        schoolName: result.schoolName,
        ok: result.ok,
        status: result.status,
        message: result.message,
        counts: result.counts,
        errorCount: result.errors.length,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, integrationId: id }, "Scheduled SIS roster sync threw");
      results.push({
        integrationId: id,
        schoolId: 0,
        schoolName: "",
        ok: false,
        status: "failed",
        message: msg,
        counts: emptyScheduledCounts(),
        errorCount: 1,
      });
    }
  }

  return results;
}

export type SisSchoolLiveCounts = {
  students: number;
  staffActive: number;
  teachers: number;
  admins: number;
  otherStaff: number;
  pulseAdmins: number;
  needingPassword: number;
  sections: number;
  enrollments: number;
};

export type SisDistrictDashboardRow = {
  id: number;
  schoolName: string;
  sisProvider: string;
  sisLastSyncAt: Date | null;
  sisLastSyncStatus: string | null;
  resolvedSchoolId: number | null;
  resolvedSchoolName: string | null;
  resolvedStateSchoolCode: string | null;
  configuredSchoolOrgSourcedId: string | null;
  configuredStateSchoolCode: string | null;
  live: SisSchoolLiveCounts | null;
};

async function loadSchoolLiveCounts(
  schoolId: number,
): Promise<SisSchoolLiveCounts> {
  const [studentRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(studentsTable)
    .where(eq(studentsTable.schoolId, schoolId));

  const staffRows = await db
    .select({
      sisRole: staffTable.sisRole,
      isAdmin: staffTable.isAdmin,
      mustSetPassword: staffTable.mustSetPassword,
      active: staffTable.active,
    })
    .from(staffTable)
    .where(eq(staffTable.schoolId, schoolId));

  let staffActive = 0;
  let teachers = 0;
  let admins = 0;
  let otherStaff = 0;
  let pulseAdmins = 0;
  let needingPassword = 0;
  for (const row of staffRows) {
    if (!row.active) continue;
    staffActive++;
    const role = (row.sisRole ?? "").trim().toLowerCase();
    if (role === "teacher") teachers++;
    else if (role === "administrator") admins++;
    else otherStaff++;
    if (row.isAdmin) pulseAdmins++;
    if (row.mustSetPassword) needingPassword++;
  }

  const [sectionRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(classSectionsTable)
    .where(eq(classSectionsTable.schoolId, schoolId));

  const [enrollmentRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(sectionRosterTable)
    .where(eq(sectionRosterTable.schoolId, schoolId));

  return {
    students: Number(studentRow?.n ?? 0),
    staffActive,
    teachers,
    admins,
    otherStaff,
    pulseAdmins,
    needingPassword,
    sections: Number(sectionRow?.n ?? 0),
    enrollments: Number(enrollmentRow?.n ?? 0),
  };
}

/**
 * District ClassLink control-panel payload: integrations + live PulseEDU counts.
 */
export async function getSisDistrictDashboard(): Promise<SisDistrictDashboardRow[]> {
  const integrations = await listSisSyncIntegrations();
  const out: SisDistrictDashboardRow[] = [];
  for (const row of integrations) {
    if (row.sisProvider !== "classlink" && row.sisProvider !== "mock") {
      // Still include non-classlink if configured for SIS so ops can see them.
    }
    const live =
      row.resolvedSchoolId != null
        ? await loadSchoolLiveCounts(row.resolvedSchoolId)
        : null;
    out.push({ ...row, live });
  }
  return out;
}

export async function ensureParrottClasslinkIntegration(): Promise<number> {
  const [existing] = await db
    .select()
    .from(districtIntegrationsTable)
    .where(eq(districtIntegrationsTable.schoolName, "D. S. Parrott Middle School"));

  const sisConfig = {
    useFixtures: true,
    stateSchoolCode: "0241",
    schoolOrgSourcedId: "org-parrott-0241",
    rostersClientIdEnvVar: "CLASSLINK_ONEROSTER_CLIENT_ID",
    rostersClientSecretEnvVar: "CLASSLINK_ONEROSTER_CLIENT_SECRET",
  };

  if (existing) {
    await db
      .update(districtIntegrationsTable)
      .set({
        sisProvider: "classlink",
        sisConfig,
        updatedAt: new Date(),
      })
      .where(eq(districtIntegrationsTable.id, existing.id));
    return existing.id;
  }

  const [inserted] = await db
    .insert(districtIntegrationsTable)
    .values({
      schoolName: "D. S. Parrott Middle School",
      sisProvider: "classlink",
      sisConfig,
      ssoProvider: "none",
    })
    .returning({ id: districtIntegrationsTable.id });

  return inserted!.id;
}
