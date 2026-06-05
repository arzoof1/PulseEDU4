/* eslint-disable no-console */
// =============================================================================
// dspParrottReseed — one-shot destructive reseed of D. S. Parrott Middle School
// (school_id=1) using uploaded Florida FAST xlsx files as the canonical source.
//
// What it does:
//   1. Asserts we're targeting DSP Parrott (school_id=1, name match)
//   2. Wipes every student-touching table at school_id=1
//   3. Inserts ~671 new students from .local/dsp-reseed/roster.json (FLEIDs as
//      students.student_id, district "Local ID" → students.local_sis_id)
//   4. Seeds one dummy teacher + 6 sections (ELA/Math × G6/G7/G8) and enrolls
//      every student in their grade's two sections (period 1 ELA, period 2 Math)
//   5. Synthesizes high-priority behavior data so existing dashboards keep
//      lighting up: hall_passes, tardies, safety_plans, student_accommodations,
//      student_mtss_plans (T2 + T3), student_pickup_authorizations,
//      student_attendance_day (60 school days), pbis_entries
//   6. Loads every .xlsx in .local/dsp-reseed/file-inventory.json via inline
//      FAST parser + commit logic (matches /data-imports/fast_florida/commit)
//
// Skipped tables (long-tail / regenerate on use / low demo value):
//   assessments (legacy — FAST is the new truth), spotlight_history,
//   pickup_queue_events, iss_admin_logs, oss_logs, witness_statements,
//   interaction_*, badge_print_events, parent_invites, teacher_watchlist_entries,
//   tier2_intervention_entries, tier3_*, accommodation_logs, support_notes,
//   pullouts, intervention_entries
//
// Run: pnpm --filter @workspace/scripts run reseed-dsp
//
// THIS IS DESTRUCTIVE. The user took a project checkpoint immediately before
// the first run; rollback via the workspace if anything looks off.
// =============================================================================

import {
  classSectionsTable,
  db,
  hallPassesTable,
  housesTable,
  pbisEntriesTable,
  safetyPlansTable,
  schoolsTable,
  sectionRosterTable,
  staffTable,
  studentAccommodationsTable,
  studentAttendanceDayTable,
  studentFastItemResponsesTable,
  studentFastScoresTable,
  studentMtssPlansTable,
  studentPickupAuthorizationsTable,
  studentsTable,
  tardiesTable,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import ExcelJS from "exceljs";
import path from "node:path";
import rosterJson from "../data/dspReseed/roster.json";
import inventoryJson from "../data/dspReseed/file-inventory.json";

const SCHOOL_ID = 1;
// attached_assets/ lives at the repo root. Prod runs from there (see
// artifact.toml: `node ... artifacts/api-server/dist/index.mjs`), and dev
// (tsx watch) also runs from repo root via pnpm --filter. So cwd is the
// right anchor in both environments.
const ASSETS_DIR = path.resolve(process.cwd(), "attached_assets");
const SCHOOL_YEAR = "25-26"; // May 2026 → current SY for America/New_York

// Inserted into staff for the per-section teacher of record. Email is the
// stable lookup key on re-run.
const DUMMY_TEACHER_EMAIL = "demo.fast.teacher@dsparrott.test";
const DUMMY_TEACHER_NAME = "Demo Teacher";

// Accommodation library IDs at school_id=1 (verified from school_accommodations).
const ACCOMMODATION_IDS = [33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46];
const HOUSE_IDS = [1, 2, 3, 4]; // Falcon, Phoenix, Stag, Wolf

// =============================================================================
// Roster loading + flag derivation
// =============================================================================

type RosterRow = {
  student_id: string;
  name: string;
  grade: string;
  dob: string;
  sex: string;
  ethnicity: string;
  ell: string;
  sec504: string;
  exceptionality: string;
  local_id: string;
};

type Inventoried = {
  f: string;
  pm: string;
  subj: "ela" | "math";
  grade: string;
};

function splitName(raw: string): { first: string; last: string } {
  const s = (raw || "").trim();
  if (s.includes(",")) {
    const [last, first] = s.split(",", 2);
    return { last: (last || "").trim(), first: (first || "").trim() };
  }
  // Fallback: treat whole string as last name.
  return { last: s, first: "Student" };
}

function deriveRace(ethnicityRaw: string): string | null {
  const e = (ethnicityRaw || "").toLowerCase();
  if (e.includes("white")) return "white";
  if (e.includes("hispanic")) return "hispanic";
  if (e.includes("black") || e.includes("african")) return "black";
  if (e.includes("asian")) return "asian";
  if (e.includes("multi") || e.includes("two or more")) return "multi";
  if (e.includes("native") || e.includes("american indian")) return "native";
  if (e.includes("pacific") || e.includes("hawaiian")) return "pacific";
  return null;
}

function deriveEthnicity(race: string | null): string | null {
  if (race === "hispanic") return "hispanic";
  if (race != null) return "non_hispanic";
  return null;
}

function deriveGender(sex: string): string | null {
  const s = (sex || "").trim().toUpperCase();
  if (s === "M") return "male";
  if (s === "F") return "female";
  return null;
}

function isYes(s: string): boolean {
  return /^y(es)?$/i.test((s || "").trim());
}

function isEse(exc: string): boolean {
  // "N - N/A" means no exceptionality; anything else (S - SLD, E - EBD, ...)
  // is an ESE designation.
  const e = (exc || "").trim();
  if (!e) return false;
  if (/^n\s*-\s*n\/?a$/i.test(e)) return false;
  return true;
}

// =============================================================================
// Tiny deterministic-ish RNG (seeded by index) so re-runs aren't wildly
// different. Not cryptographic. Good enough for demo data.
// =============================================================================
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
const RNG = mulberry32(20260518); // today's date seed

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(RNG() * arr.length)]!;
}
function shuffled<T>(arr: readonly T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(RNG() * (i + 1));
    const tmp = a[i] as T;
    a[i] = a[j] as T;
    a[j] = tmp;
  }
  return a;
}

// =============================================================================
// FAST xlsx parser (inlined from artifacts/api-server/src/routes/dataImports.ts
// — kept self-contained so this script doesn't pull api-server as a dep)
// =============================================================================

type FloridaItemResponse = {
  category: string | null;
  benchmarkCode: string;
  pointsEarned: number | null;
  pointsPossible: number | null;
  itemSeq: number;
};
type FloridaStudentRow = {
  studentId: string;
  window: "pm1" | "pm2" | "pm3";
  administeredAt: Date | null;
  scaleScore: number | null;
  items: FloridaItemResponse[];
};
type FloridaParse =
  | { ok: false; error: string }
  | {
      ok: true;
      subject: "ela" | "math";
      windowsSeen: Set<string>;
      students: FloridaStudentRow[];
    };

function cellStr(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  if (v instanceof Date) return v.toISOString();
  const o = v as { text?: unknown; result?: unknown };
  if (o && typeof o.text === "string") return o.text.trim();
  if (o && typeof o.result === "string") return o.result.trim();
  return String(v).trim();
}
function cellNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = Number(cellStr(v));
  return Number.isFinite(n) ? n : null;
}
function cellDate(v: unknown): Date | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v : null;
  const t = Date.parse(cellStr(v));
  return Number.isFinite(t) ? new Date(t) : null;
}
function stripStrand(raw: string): string {
  const i = raw.indexOf("|");
  return (i >= 0 ? raw.slice(i + 1) : raw).trim();
}
function detectWindow(testReason: string): "pm1" | "pm2" | "pm3" | null {
  const m = /(?:^|[^A-Za-z])PM\s*([123])\b/i.exec(testReason);
  return m ? (`pm${m[1]}` as "pm1" | "pm2" | "pm3") : null;
}

async function parseFloridaXlsx(filePath: string): Promise<FloridaParse> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  if (!ws || ws.rowCount < 2) return { ok: false, error: "empty xlsx" };
  const hdr = ws.getRow(1);
  const headers: string[] = [];
  for (let c = 1; c <= ws.columnCount; c++) {
    headers.push(cellStr(hdr.getCell(c).value));
  }
  const findIdx = (re: RegExp) => headers.findIndex((h) => re.test(h));
  const idxSid = findIdx(/^student id$/i);
  const idxReason = findIdx(/^test reason$/i);
  const idxDate = findIdx(/^test completion date$|^date taken$/i);
  const idxScale = findIdx(/FAST.*Scale Score/i);
  if (idxSid < 0 || idxReason < 0 || idxScale < 0) {
    return { ok: false, error: "missing required header(s)" };
  }
  // Subject detect
  const scaleHdr = headers[idxScale]!;
  let subject: "ela" | "math";
  if (/ELA\s+Reading/i.test(scaleHdr)) subject = "ela";
  else if (/Mathematics|\bMath\b/i.test(scaleHdr)) subject = "math";
  else return { ok: false, error: `cannot detect subject from "${scaleHdr}"` };
  // Quad starts
  const quads: number[] = [];
  for (let i = 0; i + 3 < headers.length; i++) {
    if (
      /^category$/i.test(headers[i]!) &&
      /^benchmark$/i.test(headers[i + 1]!) &&
      /^points earned$/i.test(headers[i + 2]!) &&
      /^points possible$/i.test(headers[i + 3]!)
    ) {
      quads.push(i);
    }
  }
  if (!quads.length) return { ok: false, error: "no benchmark quads" };

  const students: FloridaStudentRow[] = [];
  const windowsSeen = new Set<string>();
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const sid = cellStr(row.getCell(idxSid + 1).value);
    if (!sid) continue;
    const reason = cellStr(row.getCell(idxReason + 1).value);
    const w = detectWindow(reason);
    if (!w) return { ok: false, error: `row ${r}: bad Test Reason "${reason}"` };
    windowsSeen.add(w);
    const items: FloridaItemResponse[] = [];
    for (let qi = 0; qi < quads.length; qi++) {
      const base = quads[qi]!;
      const bench = cellStr(row.getCell(base + 2).value);
      if (!bench) continue;
      const cat = cellStr(row.getCell(base + 1).value) || null;
      const pe = cellNum(row.getCell(base + 3).value);
      const pp = cellNum(row.getCell(base + 4).value);
      items.push({
        category: cat,
        benchmarkCode: stripStrand(bench),
        pointsEarned: pe !== null ? Math.round(pe) : null,
        pointsPossible: pp !== null ? Math.round(pp) : null,
        itemSeq: qi,
      });
    }
    students.push({
      studentId: sid,
      window: w,
      administeredAt: idxDate >= 0 ? cellDate(row.getCell(idxDate + 1).value) : null,
      scaleScore: cellNum(row.getCell(idxScale + 1).value),
      items,
    });
  }
  if (!students.length) return { ok: false, error: "no data rows" };
  return { ok: true, subject, windowsSeen, students };
}

// =============================================================================
// Step 1: Safety preconditions
// =============================================================================
async function assertPreconditions() {
  const [school] = await db
    .select({ id: schoolsTable.id, name: schoolsTable.name })
    .from(schoolsTable)
    .where(eq(schoolsTable.id, SCHOOL_ID));
  if (!school) throw new Error(`School id=${SCHOOL_ID} not found.`);
  if (!/parrott/i.test(school.name)) {
    throw new Error(`school_id=${SCHOOL_ID} name "${school.name}" does not look like DSP Parrott — aborting.`);
  }
  const [{ n: existing }] = (await db.execute(
    sql`SELECT COUNT(*)::int AS n FROM students WHERE school_id = ${SCHOOL_ID}`,
  )).rows as Array<{ n: number }>;
  console.log(`  school=${school.name} id=${SCHOOL_ID} existing students=${existing}`);
  if (existing < 50) {
    throw new Error(
      `Refusing to wipe — only ${existing} students at school_id=${SCHOOL_ID}. ` +
      `Looks like the wipe already ran or this isn't the right school.`,
    );
  }
}

// =============================================================================
// Step 2: Wipe everything student-touching at school_id=1
// =============================================================================
async function wipeAll(): Promise<void> {
  console.log("Wiping student-touching tables at school_id=1 …");
  // Schemas with school_id column — straight DELETE.
  const tables = [
    "accommodation_logs", "assessments", "badge_print_events", "case_mentions",
    "case_video_evidence_players", "case_video_evidence", "class_signins",
    "hall_pass_queue", "hall_passes",
    "interaction_case_player_impact", "interaction_participants",
    "interaction_case_notes", "interaction_cases", "interactions",
    "intervention_entries", "iss_admin_logs", "iss_assignment_acknowledgements",
    "iss_attendance_day", "iss_roster", "mtss_fast_suggestion_dismissals",
    "oss_log_days", "oss_logs",
    "pbis_entries", "pbis_goals", "pbis_milestone_emails", "pickup_queue_events",
    "pullouts", "safety_plan_audit", "safety_plans", "section_roster",
    "spotlight_history", "student_accommodations", "student_attendance_day",
    "student_emergency_contacts", "student_fast_item_responses",
    "student_fast_scores", "student_hall_pass_limits", "student_import_snapshots",
    "student_mtss_plans", "student_pickup_authorizations", "student_retentions",
    "student_trusted_adults", "support_notes", "tardies",
    "teacher_watchlist_entries", "tier2_intervention_entries", "tier3_goals",
    "tier3_weekly_records", "witness_statements", "parent_invites",
  ];
  for (const t of tables) {
    const r = await db.execute(
      sql.raw(`DELETE FROM ${t} WHERE school_id = ${SCHOOL_ID}`),
    );
    if (r.rowCount && r.rowCount > 0) {
      console.log(`  · ${t}: ${r.rowCount} rows`);
    }
  }
  // parent_heartbeat_prefs has no school_id — scope via student_id (integer PK).
  const php = await db.execute(
    sql`DELETE FROM parent_heartbeat_prefs WHERE student_id IN (SELECT id FROM students WHERE school_id = ${SCHOOL_ID})`,
  );
  if (php.rowCount && php.rowCount > 0) console.log(`  · parent_heartbeat_prefs: ${php.rowCount} rows`);

  // parent_students has no school_id — scope via student integer PK.
  const ps = await db.execute(
    sql`DELETE FROM parent_students WHERE student_id IN (SELECT id FROM students WHERE school_id = ${SCHOOL_ID})`,
  );
  if (ps.rowCount && ps.rowCount > 0) console.log(`  · parent_students: ${ps.rowCount} rows`);

  // class_sections at this school + their planning rows.
  const cs = await db
    .delete(classSectionsTable)
    .where(eq(classSectionsTable.schoolId, SCHOOL_ID));
  console.log(`  · class_sections: deleted`);
  void cs;

  // Finally — the students themselves.
  const st = await db.delete(studentsTable).where(eq(studentsTable.schoolId, SCHOOL_ID));
  console.log(`  · students: deleted`);
  void st;
}

// =============================================================================
// Step 3: Insert 671 new students from roster.json
// =============================================================================
async function insertStudents(roster: RosterRow[]): Promise<Map<string, number>> {
  console.log(`Inserting ${roster.length} students from FAST roster …`);
  const rows = roster.map((s, idx) => {
    const { first, last } = splitName(s.name);
    const gradeInt = parseInt(s.grade, 10);
    if (!Number.isFinite(gradeInt)) {
      throw new Error(`Bad grade for FLEID ${s.student_id}: "${s.grade}"`);
    }
    const race = deriveRace(s.ethnicity);
    return {
      schoolId: SCHOOL_ID,
      studentId: s.student_id,
      firstName: first || "Student",
      lastName: last || s.student_id,
      grade: gradeInt,
      gender: deriveGender(s.sex),
      ell: isYes(s.ell),
      ese: isEse(s.exceptionality),
      is504: isYes(s.sec504),
      ctEla: false,
      ctMath: false,
      race,
      ethnicity: deriveEthnicity(race),
      dismissalMode: "car_rider" as const,
      photoConsent: true,
      localSisId: s.local_id && s.local_id !== "N/A" ? s.local_id : null,
      houseId: HOUSE_IDS[idx % HOUSE_IDS.length]!,
    };
  });
  // Chunked insert returning {id, studentId} so we can build the FLEID→PK map.
  const map = new Map<string, number>();
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const out = await db
      .insert(studentsTable)
      .values(chunk)
      .returning({ id: studentsTable.id, studentId: studentsTable.studentId });
    for (const r of out) map.set(r.studentId, r.id);
  }
  console.log(`  · inserted ${map.size} students`);
  return map;
}

// =============================================================================
// Step 4: Seed dummy teacher + 6 sections + roster enrollments
// =============================================================================
async function seedSections(roster: RosterRow[]): Promise<void> {
  console.log("Seeding dummy teacher + 6 sections …");
  // Upsert dummy teacher (lookup by email).
  let [teacher] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.email, DUMMY_TEACHER_EMAIL));
  if (!teacher) {
    [teacher] = await db
      .insert(staffTable)
      .values({
        schoolId: SCHOOL_ID,
        email: DUMMY_TEACHER_EMAIL,
        passwordHash: "!disabled!", // login is gated elsewhere; rotation script can fix later
        displayName: DUMMY_TEACHER_NAME,
        active: true,
      })
      .returning();
  }
  if (!teacher) throw new Error("Failed to upsert dummy teacher.");
  console.log(`  · teacher staff_id=${teacher.id}`);

  // 6 sections: periods 1–6. Period 1=ELA G6, 2=Math G6, 3=ELA G7, 4=Math G7,
  // 5=ELA G8, 6=Math G8. course_name encodes both for readability.
  const sectionDefs: Array<{ period: number; course: string; grade: number }> = [
    { period: 1, course: "ELA Reading — Grade 6", grade: 6 },
    { period: 2, course: "Mathematics — Grade 6", grade: 6 },
    { period: 3, course: "ELA Reading — Grade 7", grade: 7 },
    { period: 4, course: "Mathematics — Grade 7", grade: 7 },
    { period: 5, course: "ELA Reading — Grade 8", grade: 8 },
    { period: 6, course: "Mathematics — Grade 8", grade: 8 },
  ];
  const sections = await db
    .insert(classSectionsTable)
    .values(
      sectionDefs.map((d) => ({
        schoolId: SCHOOL_ID,
        teacherStaffId: teacher!.id,
        period: d.period,
        courseName: d.course,
        isPlanning: false,
      })),
    )
    .returning();
  const byGrade = new Map<number, number[]>();
  for (const s of sections) {
    const def = sectionDefs.find((d) => d.period === s.period)!;
    if (!byGrade.has(def.grade)) byGrade.set(def.grade, []);
    byGrade.get(def.grade)!.push(s.id);
  }
  console.log(`  · sections inserted: ${sections.length}`);

  // Enroll each student in BOTH sections for their grade (ELA + Math).
  const rosterRows: Array<typeof sectionRosterTable.$inferInsert> = [];
  for (const s of roster) {
    const g = parseInt(s.grade, 10);
    const sectionIds = byGrade.get(g) ?? [];
    for (const sectionId of sectionIds) {
      rosterRows.push({ schoolId: SCHOOL_ID, sectionId, studentId: s.student_id });
    }
  }
  for (let i = 0; i < rosterRows.length; i += 500) {
    await db.insert(sectionRosterTable).values(rosterRows.slice(i, i + 500));
  }
  console.log(`  · section_roster inserted: ${rosterRows.length}`);
}

// =============================================================================
// Step 5: Synthesize high-priority behavior data
// =============================================================================
function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}
function dateOnlyDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}
function schoolDaysBackward(count: number): string[] {
  // Walk back from today, skipping Sat/Sun, until we have `count` days.
  const out: string[] = [];
  const d = new Date();
  while (out.length < count) {
    const day = d.getDay(); // 0=Sun, 6=Sat
    if (day !== 0 && day !== 6) out.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() - 1);
  }
  return out;
}

async function synthBehavior(
  roster: RosterRow[],
  pkMap: Map<string, number>,
): Promise<void> {
  console.log("Synthesizing behavior data …");
  const shuffled1 = shuffled(roster);

  // ---- Hall passes (~410): 10% × 5 + 12% × 1 ≈ 415 ----
  {
    const frequent = shuffled1.slice(0, Math.floor(roster.length * 0.1));
    const moderate = shuffled1.slice(
      Math.floor(roster.length * 0.1),
      Math.floor(roster.length * 0.22),
    );
    const rows: Array<typeof hallPassesTable.$inferInsert> = [];
    const destinations = ["Restroom", "Nurse", "Office", "Counselor", "Locker"];
    const teachers = [DUMMY_TEACHER_NAME, "Ms. Carter", "Mr. Davies", "Mrs. Patel"];
    for (const s of frequent) {
      for (let i = 0; i < 5; i++) {
        rows.push({
          schoolId: SCHOOL_ID,
          studentId: s.student_id,
          destination: pick(destinations),
          originRoom: "Room " + (100 + Math.floor(RNG() * 30)),
          teacherName: pick(teachers),
          status: "completed",
          createdAt: isoDaysAgo(Math.floor(RNG() * 60) + 1),
          maxDurationMinutes: 10,
          endedAt: isoDaysAgo(Math.floor(RNG() * 60)),
          isTardyReturn: false,
          contactedAcknowledged: true,
        });
      }
    }
    for (const s of moderate) {
      rows.push({
        schoolId: SCHOOL_ID,
        studentId: s.student_id,
        destination: pick(destinations),
        originRoom: "Room " + (100 + Math.floor(RNG() * 30)),
        teacherName: pick(teachers),
        status: "completed",
        createdAt: isoDaysAgo(Math.floor(RNG() * 60) + 1),
        maxDurationMinutes: 10,
        endedAt: isoDaysAgo(Math.floor(RNG() * 60)),
        isTardyReturn: false,
        contactedAcknowledged: true,
      });
    }
    for (let i = 0; i < rows.length; i += 500) {
      await db.insert(hallPassesTable).values(rows.slice(i, i + 500));
    }
    console.log(`  · hall_passes: ${rows.length}`);
  }

  // ---- Tardies (~210): 7% × 4 + 8% × 1 ≈ 197 ----
  {
    const chronic = shuffled(roster).slice(0, Math.floor(roster.length * 0.07));
    const occasional = shuffled(roster).slice(0, Math.floor(roster.length * 0.08));
    const reasons = ["Bus late", "Overslept", "Family emergency", "Stopped at locker", "Unexcused"];
    const periods = ["1", "2", "3", "4", "5", "6"];
    const rows: Array<typeof tardiesTable.$inferInsert> = [];
    const push = (s: RosterRow) => rows.push({
      schoolId: SCHOOL_ID,
      studentId: s.student_id,
      teacherName: pick([DUMMY_TEACHER_NAME, "Ms. Carter", "Mr. Davies"]),
      period: pick(periods),
      reason: pick(reasons),
      entryType: "manual",
      notes: "",
      checkInWith: null,
      createdBy: DUMMY_TEACHER_NAME,
      createdAt: isoDaysAgo(Math.floor(RNG() * 60) + 1),
    });
    for (const s of chronic) for (let i = 0; i < 4; i++) push(s);
    for (const s of occasional) push(s);
    for (let i = 0; i < rows.length; i += 500) {
      await db.insert(tardiesTable).values(rows.slice(i, i + 500));
    }
    console.log(`  · tardies: ${rows.length}`);
  }

  // ---- Safety plans (~10% = ~67) ----
  {
    const picks = shuffled(roster).slice(0, Math.floor(roster.length * 0.1));
    const itemLib = [
      "Clear backpack only",
      "No sharp objects",
      "Escort to/from bathroom",
      "Seated near classroom door",
      "Daily check-in with counselor",
      "No physical contact with peers",
    ];
    const rows: Array<typeof safetyPlansTable.$inferInsert> = picks.map((s) => {
      const items = shuffled(itemLib)
        .slice(0, 2 + Math.floor(RNG() * 2))
        .map((label) => ({ label, active: true }));
      return {
        schoolId: SCHOOL_ID,
        studentId: s.student_id,
        status: "active" as const,
        items,
        notes: "Demo plan — re-created on FAST reseed.",
        startDate: dateOnlyDaysAgo(60),
        createdByStaffId: null,
        createdByName: "Guidance (demo)",
      };
    });
    for (let i = 0; i < rows.length; i += 200) {
      await db.insert(safetyPlansTable).values(rows.slice(i, i + 200));
    }
    console.log(`  · safety_plans: ${rows.length}`);
  }

  // ---- Accommodations (~80% × 1 + ESE/504 students × extra 1) ----
  {
    const eseStudents = roster.filter((s) => isEse(s.exceptionality) || isYes(s.sec504));
    const baseEligible = shuffled(roster).slice(0, Math.floor(roster.length * 0.8));
    const rows: Array<typeof studentAccommodationsTable.$inferInsert> = [];
    for (const s of baseEligible) {
      rows.push({
        schoolId: SCHOOL_ID,
        studentId: s.student_id,
        accommodationId: pick(ACCOMMODATION_IDS),
        assignedByStaffId: null,
      });
    }
    for (const s of eseStudents) {
      rows.push({
        schoolId: SCHOOL_ID,
        studentId: s.student_id,
        accommodationId: pick(ACCOMMODATION_IDS),
        assignedByStaffId: null,
      });
    }
    for (let i = 0; i < rows.length; i += 500) {
      await db.insert(studentAccommodationsTable).values(rows.slice(i, i + 500));
    }
    console.log(`  · student_accommodations: ${rows.length}`);
  }

  // ---- MTSS plans (~25% T2 + ~5% T3 = ~30%) ----
  {
    const shuf = shuffled(roster);
    const tier2 = shuf.slice(0, Math.floor(roster.length * 0.25));
    const tier3 = shuf.slice(
      Math.floor(roster.length * 0.25),
      Math.floor(roster.length * 0.30),
    );
    const goalsLib = [
      "Submit 80% of assignments on time across all classes this 6-week window.",
      "Reduce hall-pass requests during instructional minutes by 50%.",
      "Demonstrate self-regulation during conflict (use cool-down strategy 3+ times).",
      "Increase active participation (volunteers, completes warm-ups) 4 of 5 days.",
    ];
    const titlesT2 = [
      "Behavior Check-In/Check-Out",
      "Academic Goal Tracking",
      "Attendance Recovery Plan",
    ];
    const titlesT3 = [
      "Individualized Behavior Plan",
      "Wraparound Support Plan",
      "Crisis Recovery Plan",
    ];
    const rows: Array<typeof studentMtssPlansTable.$inferInsert> = [];
    for (const s of tier2) {
      rows.push({
        schoolId: SCHOOL_ID,
        studentId: s.student_id,
        title: pick(titlesT2),
        goals: pick(goalsLib),
        tier: 2,
        notes: "Re-seeded for FAST roster.",
        interventionSubType: RNG() < 0.6 ? "cico" : "group",
        autoAssignScheduleTeachers: true,
      });
    }
    for (const s of tier3) {
      rows.push({
        schoolId: SCHOOL_ID,
        studentId: s.student_id,
        title: pick(titlesT3),
        goals: pick(goalsLib),
        tier: 3,
        notes: "Re-seeded for FAST roster.",
        autoAssignScheduleTeachers: true,
        tier3GoalSlots: 2,
      });
    }
    for (let i = 0; i < rows.length; i += 200) {
      await db.insert(studentMtssPlansTable).values(rows.slice(i, i + 200));
    }
    console.log(`  · student_mtss_plans: ${rows.length} (T2=${tier2.length} T3=${tier3.length})`);
  }

  // ---- Pickup authorizations (~25% × 1) ----
  {
    const picks = shuffled(roster).slice(0, Math.floor(roster.length * 0.25));
    const guardians = ["Mom", "Dad", "Grandma", "Grandpa", "Aunt", "Uncle"];
    const used = new Set<string>();
    const rows: Array<typeof studentPickupAuthorizationsTable.$inferInsert> = [];
    let next = 1001;
    for (const s of picks) {
      const intId = pkMap.get(s.student_id);
      if (!intId) continue;
      while (used.has(String(next)) && next <= 9999) next++;
      if (next > 9999) break;
      used.add(String(next));
      rows.push({
        schoolId: SCHOOL_ID,
        studentId: intId,
        parentId: null,
        guardianLabel: pick(guardians),
        pickupNumber: String(next),
        restrictedFrom: false,
        active: true,
      });
      next++;
    }
    for (let i = 0; i < rows.length; i += 500) {
      await db.insert(studentPickupAuthorizationsTable).values(rows.slice(i, i + 500));
    }
    console.log(`  · student_pickup_authorizations: ${rows.length}`);
  }

  // ---- Attendance (60 school days × ~95% present) ----
  {
    const days = schoolDaysBackward(60);
    const chronicSet = new Set(
      shuffled(roster).slice(0, Math.floor(roster.length * 0.1))
        .map((s) => s.student_id),
    );
    const rows: Array<typeof studentAttendanceDayTable.$inferInsert> = [];
    for (const s of roster) {
      const absentRate = chronicSet.has(s.student_id) ? 0.22 : 0.04;
      for (const d of days) {
        const status = RNG() < absentRate ? (RNG() < 0.7 ? "absent" : "tardy") : "present";
        rows.push({
          schoolId: SCHOOL_ID,
          studentId: s.student_id,
          day: d,
          status,
          absentPeriods: [],
          notes: null,
        });
      }
    }
    for (let i = 0; i < rows.length; i += 1000) {
      await db.insert(studentAttendanceDayTable).values(rows.slice(i, i + 1000));
    }
    console.log(`  · student_attendance_day: ${rows.length}`);
  }

  // ---- PBIS entries (~36, scattered positives) ----
  {
    const reasons = ["Respect", "Responsibility", "Kindness", "Effort", "Leadership"];
    const rows: Array<typeof pbisEntriesTable.$inferInsert> = [];
    const picks = shuffled(roster).slice(0, 36);
    for (const s of picks) {
      rows.push({
        schoolId: SCHOOL_ID,
        studentId: s.student_id,
        reason: pick(reasons),
        points: 1,
        staffId: null,
        staffName: pick([DUMMY_TEACHER_NAME, "Ms. Carter", "Mr. Davies"]),
        createdAt: isoDaysAgo(Math.floor(RNG() * 30) + 1),
        polarity: "positive",
      });
    }
    if (rows.length) await db.insert(pbisEntriesTable).values(rows);
    console.log(`  · pbis_entries: ${rows.length}`);
  }
}

// =============================================================================
// Step 6: Load 18 FAST files
// =============================================================================
async function loadFastFiles(): Promise<void> {
  const inventory = JSON.parse(
    JSON.stringify(inventoryJson),
  ) as Inventoried[];
  console.log(`Loading ${inventory.length} FAST xlsx files for SY ${SCHOOL_YEAR} …`);
  for (const p of inventory) {
    const parsed = await parseFloridaXlsx(path.join(ASSETS_DIR, p.f));
    if (!parsed.ok) {
      console.warn(`  ! ${p.f} — parse failed: ${parsed.error}`);
      continue;
    }
    await db.transaction(async (tx) => {
      // 1. student_fast_scores upsert
      const now = new Date();
      const scoreVals = parsed.students.map((s) => ({
        schoolId: SCHOOL_ID,
        studentId: s.studentId,
        subject: parsed.subject,
        schoolYear: SCHOOL_YEAR,
        pm1: s.window === "pm1" ? s.scaleScore : null,
        pm2: s.window === "pm2" ? s.scaleScore : null,
        pm3: s.window === "pm3" ? s.scaleScore : null,
        priorYearScore: null,
        priorYearBq: false,
        importJobId: null,
        updatedAt: now,
      }));
      for (let i = 0; i < scoreVals.length; i += 500) {
        await tx.insert(studentFastScoresTable)
          .values(scoreVals.slice(i, i + 500))
          .onConflictDoUpdate({
            target: [
              studentFastScoresTable.schoolId,
              studentFastScoresTable.studentId,
              studentFastScoresTable.subject,
              studentFastScoresTable.schoolYear,
            ],
            set: {
              pm1: sql`COALESCE(EXCLUDED.pm1, ${studentFastScoresTable.pm1})`,
              pm2: sql`COALESCE(EXCLUDED.pm2, ${studentFastScoresTable.pm2})`,
              pm3: sql`COALESCE(EXCLUDED.pm3, ${studentFastScoresTable.pm3})`,
              updatedAt: now,
            },
          });
      }
      // 2. Item responses — delete the (subject, year, window) slice for this
      //    student set, then bulk insert.
      const sids = Array.from(new Set(parsed.students.map((s) => s.studentId)));
      const wins = Array.from(parsed.windowsSeen);
      if (sids.length && wins.length) {
        for (let i = 0; i < sids.length; i += 1000) {
          await tx.delete(studentFastItemResponsesTable).where(
            and(
              eq(studentFastItemResponsesTable.schoolId, SCHOOL_ID),
              eq(studentFastItemResponsesTable.subject, parsed.subject),
              eq(studentFastItemResponsesTable.schoolYear, SCHOOL_YEAR),
              inArray(studentFastItemResponsesTable.window, wins),
              inArray(studentFastItemResponsesTable.studentId, sids.slice(i, i + 1000)),
            ),
          );
        }
      }
      const itemRows: Array<typeof studentFastItemResponsesTable.$inferInsert> = [];
      for (const s of parsed.students) {
        for (const it of s.items) {
          itemRows.push({
            schoolId: SCHOOL_ID,
            studentId: s.studentId,
            subject: parsed.subject,
            schoolYear: SCHOOL_YEAR,
            window: s.window,
            administeredAt: s.administeredAt,
            category: it.category,
            benchmarkCode: it.benchmarkCode,
            pointsEarned: it.pointsEarned,
            pointsPossible: it.pointsPossible,
            itemSeq: it.itemSeq,
            importJobId: null,
          });
        }
      }
      for (let i = 0; i < itemRows.length; i += 1000) {
        await tx.insert(studentFastItemResponsesTable).values(itemRows.slice(i, i + 1000));
      }
      console.log(
        `  · ${p.f}: subj=${parsed.subject} students=${parsed.students.length} items=${itemRows.length} windows=${Array.from(parsed.windowsSeen).join("/")}`,
      );
    });
  }
}

// =============================================================================
// Summary
// =============================================================================
async function buildSummary(): Promise<Record<string, number>> {
  const { rows: r } = await db.execute(sql`
    SELECT
      (SELECT COUNT(*) FROM students WHERE school_id=1) AS students,
      (SELECT COUNT(*) FROM hall_passes WHERE school_id=1) AS hall_passes,
      (SELECT COUNT(*) FROM tardies WHERE school_id=1) AS tardies,
      (SELECT COUNT(*) FROM safety_plans WHERE school_id=1) AS safety_plans,
      (SELECT COUNT(*) FROM student_accommodations WHERE school_id=1) AS accommodations,
      (SELECT COUNT(*) FROM student_mtss_plans WHERE school_id=1) AS mtss_plans,
      (SELECT COUNT(*) FROM student_pickup_authorizations WHERE school_id=1) AS pickup_auths,
      (SELECT COUNT(*) FROM student_attendance_day WHERE school_id=1) AS attendance_days,
      (SELECT COUNT(*) FROM section_roster WHERE school_id=1) AS section_enroll,
      (SELECT COUNT(*) FROM class_sections WHERE school_id=1) AS sections,
      (SELECT COUNT(*) FROM student_fast_scores WHERE school_id=1) AS fast_scores,
      (SELECT COUNT(*) FROM student_fast_item_responses WHERE school_id=1) AS fast_items
  `);
  const row = (r[0] ?? {}) as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = Number(v);
  }
  return out;
}

// =============================================================================
// Public entrypoint
// =============================================================================
export async function runDspParrottReseed(): Promise<{
  summary: Record<string, number>;
  rosterSize: number;
}> {
  await assertPreconditions();
  const roster = rosterJson as unknown as RosterRow[];

  await wipeAll();
  const pkMap = await insertStudents(roster);
  await seedSections(roster);
  await synthBehavior(roster, pkMap);
  await loadFastFiles();
  const summary = await buildSummary();
  return { summary, rosterSize: roster.length };
}
