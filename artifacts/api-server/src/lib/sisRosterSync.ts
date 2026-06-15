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
import { and, eq, sql } from "drizzle-orm";
import { bcryptHash } from "./bcrypt.js";
import { logger } from "./logger.js";

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

function summarizeStatus(errors: string[]): SisSyncStatus {
  if (errors.length === 0) return "success";
  return "partial";
}

function statusMessage(status: SisSyncStatus, errors: string[]): string {
  if (status === "success") return "Roster sync completed successfully.";
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

  if (cfg.schoolId != null && cfg.schoolId > 0) {
    const [school] = await db
      .select(schoolCols)
      .from(schoolsTable)
      .where(eq(schoolsTable.id, cfg.schoolId));
    if (school) {
      return {
        schoolId: school.id,
        schoolName: school.name,
        stateSchoolCode: school.stateSchoolCode,
      };
    }
  }

  if (cfg.stateSchoolCode?.trim()) {
    const code = cfg.stateSchoolCode.trim();
    const [school] = await db
      .select(schoolCols)
      .from(schoolsTable)
      .where(eq(schoolsTable.stateSchoolCode, code));
    if (school) {
      return {
        schoolId: school.id,
        schoolName: school.name,
        stateSchoolCode: school.stateSchoolCode,
      };
    }
  }

  const [byName] = await db
    .select(schoolCols)
    .from(schoolsTable)
    .where(eq(schoolsTable.name, row.schoolName));
  if (byName) {
    return {
      schoolId: byName.id,
      schoolName: byName.name,
      stateSchoolCode: byName.stateSchoolCode,
    };
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
): Promise<{ upserted: number; skipped: number }> {
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

    const match =
      byExternal.get(s.externalId) ?? byEmail.get(email) ?? null;

    if (match) {
      await ex
        .update(staffTable)
        .set({
          externalId: s.externalId,
          displayName: s.displayName,
          // Never touch passwordHash on sync.
        })
        .where(and(eq(staffTable.id, match.id), eq(staffTable.schoolId, schoolId)));
      byExternal.set(s.externalId, { ...match, externalId: s.externalId });
      byEmail.set(email, match);
      upserted++;
      continue;
    }

    const passwordHash = await bcryptHash(
      `sis-sync-no-login-${randomUUID()}`,
      10,
    );
    try {
      const [inserted] = await ex
        .insert(staffTable)
        .values({
          schoolId,
          email,
          passwordHash,
          displayName: s.displayName,
          externalId: s.externalId,
          active: true,
        })
        .returning({ id: staffTable.id, email: staffTable.email, externalId: staffTable.externalId, displayName: staffTable.displayName });
      if (inserted) {
        byExternal.set(s.externalId, inserted);
        byEmail.set(email, inserted);
        upserted++;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes("unique") || msg.includes("duplicate")) {
        errors.push(
          `Skipped new staff ${email}: email already used by another school account.`,
        );
        skipped++;
      } else {
        throw err;
      }
    }
  }

  return { upserted, skipped };
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
  const sectionMeta: SisClassSection[] = [];

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
    sectionInserts.push({
      schoolId,
      teacherStaffId,
      period: sec.period,
      courseName: sec.courseName,
      isPlanning: sec.isPlanning ?? false,
    });
    sectionMeta.push(sec);
  }

  if (sectionInserts.length === 0) {
    return { sections: 0, enrollments: 0 };
  }

  const insertedSections = await ex
    .insert(classSectionsTable)
    .values(sectionInserts)
    .returning({ id: classSectionsTable.id });

  for (let i = 0; i < sectionMeta.length; i++) {
    const meta = sectionMeta[i]!;
    const row = insertedSections[i];
    if (row) classExternalToSectionId.set(meta.externalId, row.id);
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

async function loadStaffExternalMap(
  ex: DbExecutor,
  schoolId: number,
): Promise<Map<string, number>> {
  const rows = await ex
    .select({ id: staffTable.id, externalId: staffTable.externalId })
    .from(staffTable)
    .where(
      and(
        eq(staffTable.schoolId, schoolId),
        sql`${staffTable.externalId} IS NOT NULL`,
      ),
    );
  const map = new Map<string, number>();
  for (const r of rows) {
    if (r.externalId) map.set(r.externalId, r.id);
  }
  return map;
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
    const adapter =
      buildAdapter(row, mapping.adapterConfig) ?? probeAdapter;
    const schoolMapping = toSyncSchoolMapping(resolved, mapping.classLinkOrg);

    const [students, staff, sections, enrollments] = await Promise.all([
      adapter.listStudents(),
      adapter.listStaff(),
      adapter.listClassSections(),
      adapter.listEnrollments(),
    ]);

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

      const staffExternalToId = await loadStaffExternalMap(tx, schoolId);
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
