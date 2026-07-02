// Data Chat Campaigns — admin-pushed, template-based structured student
// check-ins ("data chats").
//
// Model:
//   - Templates (Core Team CRUD): reusable blueprints. One built-in
//     "FAST Data Chat" per school (kind='fast_data', non-deletable, lazily
//     seeded on first Core Team read). Custom templates carry an admin-built
//     checklist + optional suggested goal chips.
//   - Campaigns: a template LAUNCHED at a teacher set with a deadline. The
//     checklist / goal chips / share-with-families flag are SNAPSHOTTED onto
//     the campaign so later template edits never rewrite history.
//   - Logs: one row per (campaign, teacher, student). Discussed topics +
//     family-visible goal + staff-only private note.
//
// Assignment:
//   - fast_data campaigns -> assignment_mode 'subject_teachers': pairs come
//     from class_sections whose course name infers to the campaign subject
//     (ela | math | both) joined to section_roster. A student with different
//     ELA and Math teachers in a 'both' campaign appears in BOTH queues —
//     each subject teacher owns their own chat.
//   - custom campaigns -> assignment_mode 'selected': admin picks teachers;
//     each teacher's students at responsible_period (Call Campaign pattern).
//
// Family sharing: when the campaign's share flag is on, the discussed topics
// + goal surface on the family HeartBEAT (parentSnapshot). The private note
// NEVER leaves the staff side.
//
// FLEID-safe: student_id is the FK; student-facing fields render localSisId.
// Every query is school-scoped.

import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  db,
  staffTable,
  studentsTable,
  classSectionsTable,
  sectionRosterTable,
  studentFastScoresTable,
  dataChatTemplatesTable,
  dataChatCampaignsTable,
  dataChatCampaignStudentsTable,
  dataChatLogsTable,
} from "@workspace/db";
import { and, eq, ne, inArray, desc } from "drizzle-orm";
import { loadStudentGrades } from "../lib/studentMetrics.js";
import { requireSchool } from "../lib/scope.js";
import { isCoreTeam } from "../lib/coreTeam.js";
import { DEFAULT_SCHOOL_TZ } from "../lib/schoolYear.js";
import { resolveCurrentFastYear } from "../lib/fastHistory.js";
import {
  placePmSet,
  withGap,
  type Subject,
  type PmPlacementSetWithGap,
} from "../lib/fastCutScores.js";

const router: IRouter = Router();

type Staff = typeof staffTable.$inferSelect;

async function loadStaff(req: Request, res: Response): Promise<Staff | null> {
  const staffId = req.staffId;
  if (!staffId) {
    res.status(401).json({ error: "Sign-in required" });
    return null;
  }
  const [staff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, staffId));
  if (!staff || !staff.active) {
    res.status(401).json({ error: "Sign-in required" });
    return null;
  }
  // Tenant guard: a non-SuperUser actor must belong to the request's active
  // school. Middleware normally keeps these aligned, but every query in this
  // router scopes by req.schoolId, so a mismatched actor must never pass.
  if (!staff.isSuperUser && req.schoolId != null && staff.schoolId !== req.schoolId) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  return staff;
}

async function requireStaff(req: Request, res: Response, next: NextFunction) {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  (req as Request & { staff: Staff }).staff = staff;
  next();
}

function getStaff(req: Request): Staff {
  return (req as Request & { staff: Staff }).staff;
}

// Who may manage templates + campaigns: admin tier or Core Team (mirrors the
// Call Campaign gate next door in the Family nav group).
function canManage(staff: Staff): boolean {
  return Boolean(staff.isSuperUser || staff.isAdmin) || isCoreTeam(staff);
}

// Neutralize CSV formula injection: a cell starting with = + - @ (or a
// control char) can execute in Excel/Sheets. Prefix with an apostrophe and
// always quote.
function csvCell(value: unknown): string {
  let s = value == null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

function todayISO(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: DEFAULT_SCHOOL_TZ });
}

// Whole-day difference between two local YYYY-MM-DD strings (b - a).
function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  const utcA = Date.UTC(ay, am - 1, ad);
  const utcB = Date.UTC(by, bm - 1, bd);
  return Math.round((utcB - utcA) / 86400000);
}

interface ChecklistItem {
  id: string;
  label: string;
}

function parseChecklist(raw: string): ChecklistItem[] {
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(
        (x): x is ChecklistItem =>
          x &&
          typeof x === "object" &&
          typeof x.id === "string" &&
          typeof x.label === "string",
      )
      .map((x) => ({ id: x.id, label: x.label }));
  } catch {
    return [];
  }
}

function parseStringArray(raw: string): string[] {
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

function parseNumberArray(raw: string): number[] {
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is number => Number.isInteger(x));
  } catch {
    return [];
  }
}

// Sanitize a client-supplied checklist into { id, label } items. Ids are
// slugs derived from position when missing.
function normalizeChecklist(raw: unknown): ChecklistItem[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ChecklistItem[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== "object") return null;
    const label = String((item as { label?: unknown }).label ?? "").trim();
    if (!label) continue;
    let id = String((item as { id?: unknown }).id ?? "").trim();
    if (!id) id = `item_${i + 1}`;
    if (seen.has(id)) id = `${id}_${i + 1}`;
    seen.add(id);
    out.push({ id, label: label.slice(0, 200) });
  }
  return out;
}

function normalizeChips(raw: unknown): string[] | null {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return null;
  return raw
    .map((x) => String(x ?? "").trim())
    .filter(Boolean)
    .map((s) => s.slice(0, 160))
    .slice(0, 20);
}

// Course-name subject sniff for FAST teacher-of-record routing. Same
// convention as the benchmark-delivery attribution: no clear match ->
// excluded (never a false match). Only ela/math matter here.
function inferFastSubject(courseName: string): "ela" | "math" | null {
  const c = courseName.toLowerCase();
  if (/\bsocial\s*studies|civics|us\s*history|world\s*history|geography\b/.test(c))
    return null;
  if (/\bscience|biology|chemistry|physics|earth\b/.test(c)) return null;
  // "lang arts" + trailing "mat" cover the gradebook import's 15-char
  // truncated course_desc values ("M/J LANG ARTS 2", "M/J GRADE 7 MAT").
  if (/\bela\b|reading|literature|english\s*lang|lang\s*arts/.test(c))
    return "ela";
  if (/\bmath|\bmat\b|algebra|geometry|pre-?calc|calculus|statistics\b/.test(c))
    return "math";
  return null;
}

// ---------------------------------------------------------------------------
// Built-in FAST template (lazily ensured per school)
// ---------------------------------------------------------------------------

const FAST_TEMPLATE_NAME = "FAST Data Chat";
const FAST_CHECKLIST: ChecklistItem[] = [
  { id: "growth", label: "Reviewed PM1 → PM2 growth" },
  { id: "current_level", label: "Current level & what it means" },
  { id: "pts_next", label: "Points to next sub-level" },
  { id: "lg_target", label: "Learning-gain target for PM3" },
  { id: "strengths", label: "Celebrated strengths" },
  { id: "focus_areas", label: "Focus areas / weak standards" },
  { id: "goal_set", label: "Student set a goal in their own words" },
];
const FAST_GOAL_CHIPS: string[] = [
  "Grow my scale score by PM3",
  "Reach the next sub-level",
  "Reach Level 3 (proficient)",
  "Earn my learning gain",
];

async function ensureBuiltInTemplate(schoolId: number) {
  const existing = await db
    .select({ id: dataChatTemplatesTable.id })
    .from(dataChatTemplatesTable)
    .where(
      and(
        eq(dataChatTemplatesTable.schoolId, schoolId),
        eq(dataChatTemplatesTable.builtIn, true),
      ),
    )
    .limit(1);
  if (existing.length > 0) return;
  await db.insert(dataChatTemplatesTable).values({
    schoolId,
    name: FAST_TEMPLATE_NAME,
    kind: "fast_data",
    builtIn: true,
    checklistJson: JSON.stringify(FAST_CHECKLIST),
    goalChipsJson: JSON.stringify(FAST_GOAL_CHIPS),
    shareWithFamilies: true,
  });
}

// ---------------------------------------------------------------------------
// Pair resolution (who chats with whom for a campaign)
// ---------------------------------------------------------------------------

interface CampaignRow {
  id: number;
  schoolId: number;
  kind: string;
  subject: string | null;
  assignmentMode: string;
  selectedTeacherIdsJson: string;
  responsiblePeriod: number;
  scopeJson: string | null;
}

interface Pair {
  teacherStaffId: number;
  studentId: string;
  subject: "ela" | "math" | null;
}

// Compute the full (teacher, student) worklist for a campaign. Dedup key is
// (teacher, student) — the unique log constraint matches — keeping the first
// subject label encountered.
async function computePairs(campaign: CampaignRow): Promise<Pair[]> {
  const schoolId = campaign.schoolId;
  let sections: Array<{
    id: number;
    teacherStaffId: number;
    courseName: string;
  }> = [];

  if (campaign.assignmentMode === "subject_teachers") {
    const wanted =
      campaign.subject === "both"
        ? new Set(["ela", "math"])
        : new Set([campaign.subject]);
    const all = await db
      .select({
        id: classSectionsTable.id,
        teacherStaffId: classSectionsTable.teacherStaffId,
        courseName: classSectionsTable.courseName,
      })
      .from(classSectionsTable)
      .where(
        and(
          eq(classSectionsTable.schoolId, schoolId),
          eq(classSectionsTable.isPlanning, false),
        ),
      );
    sections = all.filter((s) => {
      const subj = inferFastSubject(s.courseName);
      return subj !== null && wanted.has(subj);
    });
  } else {
    const teacherIds = parseNumberArray(campaign.selectedTeacherIdsJson);
    if (teacherIds.length === 0) return [];
    sections = await db
      .select({
        id: classSectionsTable.id,
        teacherStaffId: classSectionsTable.teacherStaffId,
        courseName: classSectionsTable.courseName,
      })
      .from(classSectionsTable)
      .where(
        and(
          eq(classSectionsTable.schoolId, schoolId),
          eq(classSectionsTable.isPlanning, false),
          eq(classSectionsTable.period, campaign.responsiblePeriod),
          inArray(classSectionsTable.teacherStaffId, teacherIds),
        ),
      );
  }

  if (sections.length === 0) return [];
  const sectionIds = sections.map((s) => s.id);
  const roster = await db
    .select({
      sectionId: sectionRosterTable.sectionId,
      studentId: sectionRosterTable.studentId,
    })
    .from(sectionRosterTable)
    .where(
      and(
        eq(sectionRosterTable.schoolId, schoolId),
        inArray(sectionRosterTable.sectionId, sectionIds),
      ),
    );

  const bySection = new Map<number, { teacherStaffId: number; subject: "ela" | "math" | null }>();
  for (const s of sections) {
    bySection.set(s.id, {
      teacherStaffId: s.teacherStaffId,
      subject:
        campaign.assignmentMode === "subject_teachers"
          ? inferFastSubject(s.courseName)
          : null,
    });
  }

  const seen = new Set<string>();
  const pairs: Pair[] = [];
  for (const r of roster) {
    const sec = bySection.get(r.sectionId);
    if (!sec) continue;
    const key = `${sec.teacherStaffId}:${r.studentId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({
      teacherStaffId: sec.teacherStaffId,
      studentId: r.studentId,
      subject: sec.subject,
    });
  }
  return pairs;
}

async function loadCampaign(
  schoolId: number,
  id: number,
): Promise<typeof dataChatCampaignsTable.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(dataChatCampaignsTable)
    .where(
      and(
        eq(dataChatCampaignsTable.id, id),
        eq(dataChatCampaignsTable.schoolId, schoolId),
      ),
    );
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Student scope (launch-time narrowing) + snapshot resolution
// ---------------------------------------------------------------------------

const SELF_SERVE_KIND = "self_serve";
// Sentinel deadline for the per-school self-serve bucket campaign — the
// column is NOT NULL and the bucket never appears anywhere a deadline
// renders (it is excluded from campaign lists, my-queue, and the reminder).
const SELF_SERVE_DEADLINE = "9999-12-31";

type ScopeType = "all" | "flags" | "df" | "handpicked";
const SCOPE_FLAG_KEYS = ["ese", "is504", "ell"] as const;
type ScopeFlag = (typeof SCOPE_FLAG_KEYS)[number];

interface CampaignScope {
  type: ScopeType;
  flags?: ScopeFlag[];
  // Unique students snapshotted at launch (display only).
  studentCount?: number;
}

function parseScope(raw: string | null | undefined): CampaignScope {
  if (!raw) return { type: "all" };
  try {
    const p = JSON.parse(raw) as CampaignScope;
    if (
      p &&
      typeof p === "object" &&
      ["all", "flags", "df", "handpicked"].includes(p.type)
    ) {
      return p;
    }
  } catch {
    /* fall through */
  }
  return { type: "all" };
}

// Narrow a live-derived pair list by the requested scope. Returns the kept
// pairs. 'df' = current grade below 70 in the latest committed gradebook:
// for subject pairs (FAST campaigns) the failing course must infer to the
// pair's subject (that teacher's own class); for custom campaigns (subject
// null) any failing course counts.
async function filterPairsByScope(
  schoolId: number,
  pairs: Pair[],
  scope: { type: ScopeType; flags: ScopeFlag[]; studentIds: string[] },
): Promise<Pair[]> {
  if (scope.type === "all" || pairs.length === 0) return pairs;
  if (scope.type === "handpicked") {
    const wanted = new Set(scope.studentIds);
    return pairs.filter((p) => wanted.has(p.studentId));
  }
  const ids = [...new Set(pairs.map((p) => p.studentId))];
  if (scope.type === "flags") {
    const rows = await db
      .select({
        studentId: studentsTable.studentId,
        ese: studentsTable.ese,
        is504: studentsTable.is504,
        ell: studentsTable.ell,
      })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.schoolId, schoolId),
          inArray(studentsTable.studentId, ids),
        ),
      );
    const keep = new Set<string>();
    for (const r of rows) {
      if (scope.flags.some((f) => r[f])) keep.add(r.studentId);
    }
    return pairs.filter((p) => keep.has(p.studentId));
  }
  // 'df' — needs the latest committed gradebook import.
  const gradesMap = await loadStudentGrades(schoolId, ids);
  const failingBySubject = new Map<string, Set<"ela" | "math">>();
  const failingAny = new Set<string>();
  for (const [sid, g] of gradesMap) {
    for (const cg of g.currentGrades) {
      if (cg.grade === null || cg.grade >= 70) continue;
      failingAny.add(sid);
      const subj = inferFastSubject(cg.courseDesc ?? cg.courseCode);
      if (subj) {
        let set = failingBySubject.get(sid);
        if (!set) {
          set = new Set();
          failingBySubject.set(sid, set);
        }
        set.add(subj);
      }
    }
  }
  return pairs.filter((p) =>
    p.subject
      ? (failingBySubject.get(p.studentId)?.has(p.subject) ?? false)
      : failingAny.has(p.studentId),
  );
}

// Validate + normalize the scope input from the launch/preview body.
// Returns null (and responds 400) on invalid input.
function readScopeInput(
  req: Request,
  res: Response,
): { type: ScopeType; flags: ScopeFlag[]; studentIds: string[] } | null {
  const body = req.body?.scope;
  if (body === undefined || body === null) {
    return { type: "all", flags: [], studentIds: [] };
  }
  const type = String((body as { type?: unknown }).type ?? "all") as ScopeType;
  if (!["all", "flags", "df", "handpicked"].includes(type)) {
    res.status(400).json({ error: "Invalid student scope" });
    return null;
  }
  let flags: ScopeFlag[] = [];
  if (type === "flags") {
    const raw = Array.isArray((body as { flags?: unknown }).flags)
      ? ((body as { flags: unknown[] }).flags as unknown[])
      : [];
    flags = raw
      .map((f) => String(f))
      .filter((f): f is ScopeFlag =>
        (SCOPE_FLAG_KEYS as readonly string[]).includes(f),
      );
    if (flags.length === 0) {
      res.status(400).json({ error: "Pick at least one support flag" });
      return null;
    }
  }
  let studentIds: string[] = [];
  if (type === "handpicked") {
    const raw = Array.isArray((body as { studentIds?: unknown }).studentIds)
      ? ((body as { studentIds: unknown[] }).studentIds as unknown[])
      : [];
    studentIds = [...new Set(raw.map((s) => String(s)).filter(Boolean))];
    if (studentIds.length === 0) {
      res.status(400).json({ error: "Pick at least one student" });
      return null;
    }
    if (studentIds.length > 500) {
      res.status(400).json({ error: "Too many students selected" });
      return null;
    }
  }
  return { type, flags, studentIds };
}

// Resolve the (teacher, student) worklist for a campaign. Scoped campaigns
// (scope type != 'all') read the launch-time snapshot; 'all' campaigns stay
// live-derived (new enrollments join, withdrawn students drop) — the
// pre-scope behavior, unchanged.
async function resolvePairs(campaign: CampaignRow): Promise<Pair[]> {
  const scope = parseScope(campaign.scopeJson);
  if (scope.type === "all") return computePairs(campaign);
  const rows = await db
    .select({
      teacherStaffId: dataChatCampaignStudentsTable.teacherStaffId,
      studentId: dataChatCampaignStudentsTable.studentId,
      subject: dataChatCampaignStudentsTable.subject,
    })
    .from(dataChatCampaignStudentsTable)
    .where(
      and(
        eq(dataChatCampaignStudentsTable.schoolId, campaign.schoolId),
        eq(dataChatCampaignStudentsTable.campaignId, campaign.id),
      ),
    );
  return rows.map((r) => ({
    teacherStaffId: r.teacherStaffId,
    studentId: r.studentId,
    subject: r.subject === "ela" || r.subject === "math" ? r.subject : null,
  }));
}

// ---------------------------------------------------------------------------
// Templates (Core Team)
// ---------------------------------------------------------------------------

// GET /data-chats/templates — Core Team. Lazily seeds the built-in FAST
// template.
router.get("/data-chats/templates", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId === null) return;
  if (!canManage(getStaff(req))) {
    res.status(403).json({ error: "Core Team access required" });
    return;
  }
  await ensureBuiltInTemplate(schoolId);
  const rows = await db
    .select()
    .from(dataChatTemplatesTable)
    .where(
      and(
        eq(dataChatTemplatesTable.schoolId, schoolId),
        eq(dataChatTemplatesTable.archived, false),
      ),
    )
    .orderBy(desc(dataChatTemplatesTable.builtIn), dataChatTemplatesTable.name);
  res.json(
    rows.map((t) => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      builtIn: t.builtIn,
      checklist: parseChecklist(t.checklistJson),
      goalChips: parseStringArray(t.goalChipsJson),
      shareWithFamilies: t.shareWithFamilies,
    })),
  );
});

// POST /data-chats/templates — Core Team. Custom templates only.
router.post("/data-chats/templates", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId === null) return;
  const staff = getStaff(req);
  if (!canManage(staff)) {
    res.status(403).json({ error: "Core Team access required" });
    return;
  }
  const name = String(req.body?.name ?? "").trim();
  if (!name) {
    res.status(400).json({ error: "Template name is required" });
    return;
  }
  const checklist = normalizeChecklist(req.body?.checklist);
  if (!checklist || checklist.length === 0) {
    res.status(400).json({ error: "At least one checklist topic is required" });
    return;
  }
  const chips = normalizeChips(req.body?.goalChips);
  if (chips === null) {
    res.status(400).json({ error: "Invalid goal chips" });
    return;
  }
  const [row] = await db
    .insert(dataChatTemplatesTable)
    .values({
      schoolId,
      name: name.slice(0, 120),
      kind: "custom",
      builtIn: false,
      checklistJson: JSON.stringify(checklist),
      goalChipsJson: JSON.stringify(chips),
      shareWithFamilies: req.body?.shareWithFamilies !== false,
      createdByStaffId: staff.id,
    })
    .returning({ id: dataChatTemplatesTable.id });
  res.json({ ok: true, id: row.id });
});

// PUT /data-chats/templates/:id — Core Team. The built-in template's
// checklist/chips/share flag are editable; its name and kind are locked.
router.put("/data-chats/templates/:id", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId === null) return;
  if (!canManage(getStaff(req))) {
    res.status(403).json({ error: "Core Team access required" });
    return;
  }
  const id = Number(req.params.id);
  const [tpl] = await db
    .select()
    .from(dataChatTemplatesTable)
    .where(
      and(
        eq(dataChatTemplatesTable.id, id),
        eq(dataChatTemplatesTable.schoolId, schoolId),
      ),
    );
  if (!tpl || tpl.archived) {
    res.status(404).json({ error: "Template not found" });
    return;
  }
  const checklist = normalizeChecklist(req.body?.checklist);
  if (!checklist || checklist.length === 0) {
    res.status(400).json({ error: "At least one checklist topic is required" });
    return;
  }
  const chips = normalizeChips(req.body?.goalChips);
  if (chips === null) {
    res.status(400).json({ error: "Invalid goal chips" });
    return;
  }
  const updates: Partial<typeof dataChatTemplatesTable.$inferInsert> = {
    checklistJson: JSON.stringify(checklist),
    goalChipsJson: JSON.stringify(chips),
    shareWithFamilies: req.body?.shareWithFamilies !== false,
    updatedAt: new Date(),
  };
  if (!tpl.builtIn) {
    const name = String(req.body?.name ?? tpl.name).trim();
    if (!name) {
      res.status(400).json({ error: "Template name is required" });
      return;
    }
    updates.name = name.slice(0, 120);
  }
  await db
    .update(dataChatTemplatesTable)
    .set(updates)
    .where(eq(dataChatTemplatesTable.id, tpl.id));
  res.json({ ok: true });
});

// DELETE /data-chats/templates/:id — archive (soft). Built-in is protected.
router.delete("/data-chats/templates/:id", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId === null) return;
  if (!canManage(getStaff(req))) {
    res.status(403).json({ error: "Core Team access required" });
    return;
  }
  const id = Number(req.params.id);
  const [tpl] = await db
    .select()
    .from(dataChatTemplatesTable)
    .where(
      and(
        eq(dataChatTemplatesTable.id, id),
        eq(dataChatTemplatesTable.schoolId, schoolId),
      ),
    );
  if (!tpl) {
    res.status(404).json({ error: "Template not found" });
    return;
  }
  if (tpl.builtIn) {
    res.status(400).json({ error: "The built-in FAST template can't be deleted" });
    return;
  }
  await db
    .update(dataChatTemplatesTable)
    .set({ archived: true, updatedAt: new Date() })
    .where(eq(dataChatTemplatesTable.id, tpl.id));
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Campaigns (Core Team)
// ---------------------------------------------------------------------------

// POST /data-chats/campaigns — launch a template.
router.post("/data-chats/campaigns", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId === null) return;
  const staff = getStaff(req);
  if (!canManage(staff)) {
    res.status(403).json({ error: "Core Team access required" });
    return;
  }
  const templateId = Number(req.body?.templateId);
  const [tpl] = await db
    .select()
    .from(dataChatTemplatesTable)
    .where(
      and(
        eq(dataChatTemplatesTable.id, templateId),
        eq(dataChatTemplatesTable.schoolId, schoolId),
        eq(dataChatTemplatesTable.archived, false),
      ),
    );
  if (!tpl) {
    res.status(400).json({ error: "Template not found" });
    return;
  }

  const name = String(req.body?.name ?? "").trim() || tpl.name;
  const deadline = String(req.body?.deadline ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline)) {
    res.status(400).json({ error: "Deadline (YYYY-MM-DD) is required" });
    return;
  }
  const today = todayISO();
  if (deadline < today) {
    res.status(400).json({ error: "Deadline must be today or later" });
    return;
  }

  let subject: string | null = null;
  let assignmentMode: string;
  let selectedTeacherIds: number[] = [];
  let responsiblePeriod = 1;

  if (tpl.kind === "fast_data") {
    assignmentMode = "subject_teachers";
    const s = String(req.body?.subject ?? "both").toLowerCase();
    if (!["ela", "math", "both"].includes(s)) {
      res.status(400).json({ error: "Subject must be ela, math, or both" });
      return;
    }
    subject = s;
  } else {
    assignmentMode = "selected";
    const ids = Array.isArray(req.body?.teacherIds)
      ? (req.body.teacherIds as unknown[])
          .map(Number)
          .filter((n) => Number.isInteger(n))
      : [];
    if (ids.length === 0) {
      res.status(400).json({ error: "Pick at least one teacher" });
      return;
    }
    // Verify every teacher belongs to this school (active staff).
    const found = await db
      .select({ id: staffTable.id })
      .from(staffTable)
      .where(
        and(
          eq(staffTable.schoolId, schoolId),
          eq(staffTable.active, true),
          inArray(staffTable.id, ids),
        ),
      );
    if (found.length !== ids.length) {
      res.status(400).json({ error: "One or more teachers not found" });
      return;
    }
    selectedTeacherIds = ids;
    const p = Number(req.body?.responsiblePeriod ?? 1);
    responsiblePeriod = Number.isInteger(p) && p >= 1 && p <= 10 ? p : 1;
  }

  // Optional checklist subset: admin can trim topics at launch. Ids must be
  // a subset of the template checklist; empty/absent = full template list.
  const tplChecklist = parseChecklist(tpl.checklistJson);
  let checklist = tplChecklist;
  if (Array.isArray(req.body?.checklistItemIds)) {
    const wanted = new Set(
      (req.body.checklistItemIds as unknown[]).map((x) => String(x)),
    );
    const subset = tplChecklist.filter((c) => wanted.has(c.id));
    if (subset.length > 0) checklist = subset;
  }

  const shareWithFamilies =
    typeof req.body?.shareWithFamilies === "boolean"
      ? req.body.shareWithFamilies
      : tpl.shareWithFamilies;

  // Student scope. Narrower-than-all scopes are resolved NOW and the
  // resulting (teacher, student) worklist is snapshotted — the list the
  // admin previewed is exactly the list teachers work.
  const scopeInput = readScopeInput(req, res);
  if (!scopeInput) return;
  let scopedPairs: Pair[] = [];
  if (scopeInput.type !== "all") {
    if (scopeInput.type === "handpicked") {
      // Every picked student must exist in this school.
      const found = await db
        .select({ studentId: studentsTable.studentId })
        .from(studentsTable)
        .where(
          and(
            eq(studentsTable.schoolId, schoolId),
            inArray(studentsTable.studentId, scopeInput.studentIds),
          ),
        );
      if (found.length !== scopeInput.studentIds.length) {
        res.status(400).json({ error: "One or more students not found" });
        return;
      }
    }
    const livePairs = await computePairs({
      id: 0,
      schoolId,
      kind: tpl.kind,
      subject,
      assignmentMode,
      selectedTeacherIdsJson: JSON.stringify(selectedTeacherIds),
      responsiblePeriod,
      scopeJson: null,
    });
    scopedPairs = await filterPairsByScope(schoolId, livePairs, scopeInput);
    if (scopedPairs.length === 0) {
      res.status(400).json({
        error:
          scopeInput.type === "df"
            ? "No students match — check that a gradebook has been imported"
            : "No students match the selected scope",
      });
      return;
    }
  }
  const scopeJson =
    scopeInput.type === "all"
      ? null
      : JSON.stringify({
          type: scopeInput.type,
          ...(scopeInput.type === "flags" ? { flags: scopeInput.flags } : {}),
          studentCount: new Set(scopedPairs.map((p) => p.studentId)).size,
        } satisfies CampaignScope);

  const [row] = await db
    .insert(dataChatCampaignsTable)
    .values({
      schoolId,
      templateId: tpl.id,
      name: name.slice(0, 160),
      kind: tpl.kind,
      subject,
      assignmentMode,
      selectedTeacherIdsJson: JSON.stringify(selectedTeacherIds),
      responsiblePeriod,
      scopeJson,
      checklistJson: JSON.stringify(checklist),
      goalChipsJson: tpl.goalChipsJson,
      shareWithFamilies,
      startDate: today,
      deadline,
      active: true,
      createdByStaffId: staff.id,
      createdByName: staff.displayName,
    })
    .returning({ id: dataChatCampaignsTable.id });

  if (scopeJson !== null && scopedPairs.length > 0) {
    // Snapshot the scoped worklist (chunked inserts).
    for (let i = 0; i < scopedPairs.length; i += 500) {
      await db.insert(dataChatCampaignStudentsTable).values(
        scopedPairs.slice(i, i + 500).map((p) => ({
          schoolId,
          campaignId: row.id,
          studentId: p.studentId,
          teacherStaffId: p.teacherStaffId,
          subject: p.subject,
        })),
      );
    }
  }
  res.json({ ok: true, id: row.id });
});

// POST /data-chats/campaigns/preview — Core Team. Dry-run pair resolution
// for the launcher: same inputs as launch, returns counts (no insert).
router.post(
  "/data-chats/campaigns/preview",
  requireStaff,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    if (!canManage(getStaff(req))) {
      res.status(403).json({ error: "Core Team access required" });
      return;
    }
    const templateId = Number(req.body?.templateId);
    const [tpl] = await db
      .select()
      .from(dataChatTemplatesTable)
      .where(
        and(
          eq(dataChatTemplatesTable.id, templateId),
          eq(dataChatTemplatesTable.schoolId, schoolId),
          eq(dataChatTemplatesTable.archived, false),
        ),
      );
    if (!tpl) {
      res.status(400).json({ error: "Template not found" });
      return;
    }
    let subject: string | null = null;
    let assignmentMode: string;
    let selectedTeacherIds: number[] = [];
    let responsiblePeriod = 1;
    if (tpl.kind === "fast_data") {
      assignmentMode = "subject_teachers";
      const s = String(req.body?.subject ?? "both").toLowerCase();
      subject = ["ela", "math", "both"].includes(s) ? s : "both";
    } else {
      assignmentMode = "selected";
      selectedTeacherIds = Array.isArray(req.body?.teacherIds)
        ? (req.body.teacherIds as unknown[])
            .map(Number)
            .filter((n) => Number.isInteger(n))
        : [];
      const p = Number(req.body?.responsiblePeriod ?? 1);
      responsiblePeriod = Number.isInteger(p) && p >= 1 && p <= 10 ? p : 1;
    }
    const scopeInput = readScopeInput(req, res);
    if (!scopeInput) return;
    const livePairs = await computePairs({
      id: 0,
      schoolId,
      kind: tpl.kind,
      subject,
      assignmentMode,
      selectedTeacherIdsJson: JSON.stringify(selectedTeacherIds),
      responsiblePeriod,
      scopeJson: null,
    });
    const pairs = await filterPairsByScope(schoolId, livePairs, scopeInput);
    const students = new Set(pairs.map((p) => p.studentId));
    const teachers = new Set(pairs.map((p) => p.teacherStaffId));
    // Handpicked students who didn't land in any pair (not on a selected
    // teacher's roster / no matching subject section) — surfaced loudly so
    // the admin isn't surprised at launch.
    const unmatchedStudentIds =
      scopeInput.type === "handpicked"
        ? scopeInput.studentIds.filter((sid) => !students.has(sid))
        : [];
    res.json({
      students: students.size,
      pairs: pairs.length,
      teachers: teachers.size,
      unmatchedStudentIds,
    });
  },
);

// GET /data-chats/campaigns — Core Team list (active + history) with
// completion aggregates.
router.get("/data-chats/campaigns", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId === null) return;
  if (!canManage(getStaff(req))) {
    res.status(403).json({ error: "Core Team access required" });
    return;
  }
  const rows = await db
    .select()
    .from(dataChatCampaignsTable)
    .where(
      and(
        eq(dataChatCampaignsTable.schoolId, schoolId),
        // The per-school self-serve bucket is plumbing, not a campaign —
        // compliance/coverage would be meaningless noise.
        ne(dataChatCampaignsTable.kind, SELF_SERVE_KIND),
      ),
    )
    .orderBy(desc(dataChatCampaignsTable.id));

  const out = [];
  for (const c of rows) {
    const pairs = await resolvePairs(c);
    const logs = await db
      .select({
        teacherStaffId: dataChatLogsTable.teacherStaffId,
        studentId: dataChatLogsTable.studentId,
      })
      .from(dataChatLogsTable)
      .where(
        and(
          eq(dataChatLogsTable.schoolId, schoolId),
          eq(dataChatLogsTable.campaignId, c.id),
        ),
      );
    const logged = new Set(logs.map((l) => `${l.teacherStaffId}:${l.studentId}`));
    const done = pairs.filter((p) =>
      logged.has(`${p.teacherStaffId}:${p.studentId}`),
    ).length;
    out.push({
      id: c.id,
      name: c.name,
      kind: c.kind,
      subject: c.subject,
      assignmentMode: c.assignmentMode,
      responsiblePeriod: c.responsiblePeriod,
      shareWithFamilies: c.shareWithFamilies,
      startDate: c.startDate,
      deadline: c.deadline,
      active: c.active,
      total: pairs.length,
      done,
      teacherCount: new Set(pairs.map((p) => p.teacherStaffId)).size,
      createdByName: c.createdByName,
      scope: parseScope(c.scopeJson),
    });
  }
  res.json(out);
});

// GET /data-chats/campaigns/:id — Core Team detail: per-teacher compliance +
// checkbox-topic coverage.
router.get("/data-chats/campaigns/:id", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId === null) return;
  if (!canManage(getStaff(req))) {
    res.status(403).json({ error: "Core Team access required" });
    return;
  }
  const campaign = await loadCampaign(schoolId, Number(req.params.id));
  if (!campaign) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }
  const pairs = await resolvePairs(campaign);
  const logs = await db
    .select()
    .from(dataChatLogsTable)
    .where(
      and(
        eq(dataChatLogsTable.schoolId, schoolId),
        eq(dataChatLogsTable.campaignId, campaign.id),
      ),
    );
  const loggedByKey = new Map(
    logs.map((l) => [`${l.teacherStaffId}:${l.studentId}`, l]),
  );

  const teacherIds = [...new Set(pairs.map((p) => p.teacherStaffId))];
  const teachers = teacherIds.length
    ? await db
        .select({ id: staffTable.id, displayName: staffTable.displayName })
        .from(staffTable)
        .where(
          and(
            eq(staffTable.schoolId, schoolId),
            inArray(staffTable.id, teacherIds),
          ),
        )
    : [];
  const teacherName = new Map(teachers.map((t) => [t.id, t.displayName]));

  const perTeacher = new Map<
    number,
    { total: number; done: number; subjects: Set<string> }
  >();
  for (const p of pairs) {
    let t = perTeacher.get(p.teacherStaffId);
    if (!t) {
      t = { total: 0, done: 0, subjects: new Set() };
      perTeacher.set(p.teacherStaffId, t);
    }
    t.total += 1;
    if (p.subject) t.subjects.add(p.subject);
    if (loggedByKey.has(`${p.teacherStaffId}:${p.studentId}`)) t.done += 1;
  }

  const checklist = parseChecklist(campaign.checklistJson);
  const topicCounts = new Map<string, number>(checklist.map((c) => [c.id, 0]));
  for (const l of logs) {
    for (const id of parseStringArray(l.discussedJson)) {
      if (topicCounts.has(id)) topicCounts.set(id, (topicCounts.get(id) ?? 0) + 1);
    }
  }

  res.json({
    id: campaign.id,
    name: campaign.name,
    kind: campaign.kind,
    subject: campaign.subject,
    assignmentMode: campaign.assignmentMode,
    responsiblePeriod: campaign.responsiblePeriod,
    shareWithFamilies: campaign.shareWithFamilies,
    startDate: campaign.startDate,
    deadline: campaign.deadline,
    active: campaign.active,
    scope: parseScope(campaign.scopeJson),
    checklist,
    total: pairs.length,
    done: logs.length > 0 ? pairs.filter((p) => loggedByKey.has(`${p.teacherStaffId}:${p.studentId}`)).length : 0,
    teachers: [...perTeacher.entries()]
      .map(([id, t]) => ({
        staffId: id,
        name: teacherName.get(id) ?? `Staff #${id}`,
        subjects: [...t.subjects],
        total: t.total,
        done: t.done,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    topicCoverage: checklist.map((c) => ({
      id: c.id,
      label: c.label,
      count: topicCounts.get(c.id) ?? 0,
      loggedTotal: logs.length,
    })),
  });
});

// POST /data-chats/campaigns/:id/end — Core Team.
router.post("/data-chats/campaigns/:id/end", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId === null) return;
  if (!canManage(getStaff(req))) {
    res.status(403).json({ error: "Core Team access required" });
    return;
  }
  const campaign = await loadCampaign(schoolId, Number(req.params.id));
  if (!campaign) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }
  if (campaign.active) {
    await db
      .update(dataChatCampaignsTable)
      .set({ active: false, endedAt: new Date() })
      .where(eq(dataChatCampaignsTable.id, campaign.id));
  }
  res.json({ ok: true });
});

// GET /data-chats/campaigns/:id/export.csv — Core Team. Formula-injection
// safe; localSisId only (never FLEID).
router.get(
  "/data-chats/campaigns/:id/export.csv",
  requireStaff,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    if (!canManage(getStaff(req))) {
      res.status(403).json({ error: "Core Team access required" });
      return;
    }
    const campaign = await loadCampaign(schoolId, Number(req.params.id));
    if (!campaign) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }
    const pairs = await resolvePairs(campaign);
    const logs = await db
      .select()
      .from(dataChatLogsTable)
      .where(
        and(
          eq(dataChatLogsTable.schoolId, schoolId),
          eq(dataChatLogsTable.campaignId, campaign.id),
        ),
      );
    const logByKey = new Map(
      logs.map((l) => [`${l.teacherStaffId}:${l.studentId}`, l]),
    );

    const teacherIds = [...new Set(pairs.map((p) => p.teacherStaffId))];
    const teachers = teacherIds.length
      ? await db
          .select({ id: staffTable.id, displayName: staffTable.displayName })
          .from(staffTable)
          .where(
            and(
              eq(staffTable.schoolId, schoolId),
              inArray(staffTable.id, teacherIds),
            ),
          )
      : [];
    const teacherName = new Map(teachers.map((t) => [t.id, t.displayName]));

    const studentIds = [...new Set(pairs.map((p) => p.studentId))];
    const students = studentIds.length
      ? await db
          .select({
            studentId: studentsTable.studentId,
            firstName: studentsTable.firstName,
            lastName: studentsTable.lastName,
            grade: studentsTable.grade,
            localSisId: studentsTable.localSisId,
          })
          .from(studentsTable)
          .where(
            and(
              eq(studentsTable.schoolId, schoolId),
              inArray(studentsTable.studentId, studentIds),
            ),
          )
      : [];
    const studentById = new Map(students.map((s) => [s.studentId, s]));

    const checklist = parseChecklist(campaign.checklistJson);
    const labelById = new Map(checklist.map((c) => [c.id, c.label]));

    const header = [
      "Teacher",
      "Subject",
      "Student",
      "Student ID",
      "Grade",
      "Status",
      "Topics discussed",
      "Goal",
      "Logged at",
    ];
    const lines = [header.map(csvCell).join(",")];
    const sorted = [...pairs].sort((a, b) => {
      const ta = teacherName.get(a.teacherStaffId) ?? "";
      const tb = teacherName.get(b.teacherStaffId) ?? "";
      if (ta !== tb) return ta.localeCompare(tb);
      const sa = studentById.get(a.studentId);
      const sb = studentById.get(b.studentId);
      return `${sa?.lastName ?? ""} ${sa?.firstName ?? ""}`.localeCompare(
        `${sb?.lastName ?? ""} ${sb?.firstName ?? ""}`,
      );
    });
    for (const p of sorted) {
      const s = studentById.get(p.studentId);
      const log = logByKey.get(`${p.teacherStaffId}:${p.studentId}`);
      const topics = log
        ? parseStringArray(log.discussedJson)
            .map((id) => labelById.get(id) ?? id)
            .join("; ")
        : "";
      lines.push(
        [
          teacherName.get(p.teacherStaffId) ?? `Staff #${p.teacherStaffId}`,
          p.subject ?? "",
          s ? `${s.lastName}, ${s.firstName}` : "(unknown)",
          s?.localSisId ?? "",
          s?.grade ?? "",
          log ? "Logged" : "Pending",
          topics,
          log?.goal ?? "",
          log
            ? log.updatedAt.toLocaleDateString("en-CA", {
                timeZone: DEFAULT_SCHOOL_TZ,
              })
            : "",
        ]
          .map(csvCell)
          .join(","),
      );
    }
    const safeName = campaign.name.replace(/[^a-z0-9-_]+/gi, "_").slice(0, 60);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="data-chats-${safeName || campaign.id}.csv"`,
    );
    res.send(lines.join("\r\n"));
  },
);

// ---------------------------------------------------------------------------
// Teacher queue + logging (any staff)
// ---------------------------------------------------------------------------

// Batch FAST loader for a fast_data campaign queue. Light on purpose: one
// scores query + placePmSet/withGap per row (same single-source helpers as
// the Teacher Roster pills) — no learning-gain/history query, the queue
// panel doesn't render the green-check.
async function loadQueueFast(
  schoolId: number,
  students: Array<{ studentId: string; grade: number }>,
): Promise<
  Map<string, Partial<Record<"ela" | "math", {
    pm1: number | null;
    pm2: number | null;
    pm3: number | null;
    levels: PmPlacementSetWithGap;
  }>>>
> {
  const out = new Map<
    string,
    Partial<Record<"ela" | "math", {
      pm1: number | null;
      pm2: number | null;
      pm3: number | null;
      levels: PmPlacementSetWithGap;
    }>>
  >();
  if (students.length === 0) return out;
  const currentSchoolYear = await resolveCurrentFastYear(schoolId);
  const rows = await db
    .select({
      studentId: studentFastScoresTable.studentId,
      subject: studentFastScoresTable.subject,
      pm1: studentFastScoresTable.pm1,
      pm2: studentFastScoresTable.pm2,
      pm3: studentFastScoresTable.pm3,
      priorYearScore: studentFastScoresTable.priorYearScore,
    })
    .from(studentFastScoresTable)
    .where(
      and(
        eq(studentFastScoresTable.schoolId, schoolId),
        eq(studentFastScoresTable.schoolYear, currentSchoolYear),
        eq(studentFastScoresTable.isHistorical, false),
        inArray(
          studentFastScoresTable.studentId,
          students.map((s) => s.studentId),
        ),
      ),
    );
  const gradeById = new Map(students.map((s) => [s.studentId, s.grade]));
  for (const r of rows) {
    if (r.subject !== "ela" && r.subject !== "math") continue;
    const grade = gradeById.get(r.studentId);
    if (grade == null || !Number.isInteger(grade)) continue;
    const base = placePmSet(r.subject as Subject, grade, {
      priorYearScore: r.priorYearScore,
      pm1: r.pm1,
      pm2: r.pm2,
      pm3: r.pm3,
    });
    const subj = r.subject as Subject;
    const levels: PmPlacementSetWithGap = {
      priorYearScore: withGap(base.priorYearScore, r.priorYearScore, subj, grade),
      pm1: withGap(base.pm1, r.pm1, subj, grade),
      pm2: withGap(base.pm2, r.pm2, subj, grade),
      pm3: withGap(base.pm3, r.pm3, subj, grade),
    };
    let entry = out.get(r.studentId);
    if (!entry) {
      entry = {};
      out.set(r.studentId, entry);
    }
    entry[r.subject] = { pm1: r.pm1, pm2: r.pm2, pm3: r.pm3, levels };
  }
  return out;
}

// GET /data-chats/my-queue — the signed-in teacher's active-campaign queues:
// roster + FAST data (fast_data kind) + prior campaign goals + own logs.
router.get("/data-chats/my-queue", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId === null) return;
  const staff = getStaff(req);

  const campaigns = await db
    .select()
    .from(dataChatCampaignsTable)
    .where(
      and(
        eq(dataChatCampaignsTable.schoolId, schoolId),
        eq(dataChatCampaignsTable.active, true),
        ne(dataChatCampaignsTable.kind, SELF_SERVE_KIND),
      ),
    )
    .orderBy(dataChatCampaignsTable.deadline);

  const today = todayISO();
  const out = [];
  for (const c of campaigns) {
    const pairs = (await resolvePairs(c)).filter(
      (p) => p.teacherStaffId === staff.id,
    );
    if (pairs.length === 0) continue;

    const studentIds = [...new Set(pairs.map((p) => p.studentId))];
    const students = await db
      .select({
        studentId: studentsTable.studentId,
        firstName: studentsTable.firstName,
        lastName: studentsTable.lastName,
        grade: studentsTable.grade,
        localSisId: studentsTable.localSisId,
      })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.schoolId, schoolId),
          inArray(studentsTable.studentId, studentIds),
        ),
      );
    const studentById = new Map(students.map((s) => [s.studentId, s]));

    const logs = await db
      .select()
      .from(dataChatLogsTable)
      .where(
        and(
          eq(dataChatLogsTable.schoolId, schoolId),
          eq(dataChatLogsTable.campaignId, c.id),
          eq(dataChatLogsTable.teacherStaffId, staff.id),
        ),
      );
    const logByStudent = new Map(logs.map((l) => [l.studentId, l]));

    // Prior goals: this student's most recent goals from OTHER campaigns
    // (any teacher) — continuity across chats.
    const priorLogs = studentIds.length
      ? await db
          .select({
            studentId: dataChatLogsTable.studentId,
            campaignId: dataChatLogsTable.campaignId,
            goal: dataChatLogsTable.goal,
            updatedAt: dataChatLogsTable.updatedAt,
          })
          .from(dataChatLogsTable)
          .where(
            and(
              eq(dataChatLogsTable.schoolId, schoolId),
              inArray(dataChatLogsTable.studentId, studentIds),
            ),
          )
          .orderBy(desc(dataChatLogsTable.updatedAt))
      : [];
    const campaignNames = new Map<number, string>();
    {
      const cids = [...new Set(priorLogs.map((l) => l.campaignId))].filter(
        (id) => id !== c.id,
      );
      if (cids.length) {
        const rows = await db
          .select({
            id: dataChatCampaignsTable.id,
            name: dataChatCampaignsTable.name,
          })
          .from(dataChatCampaignsTable)
          .where(
            and(
              eq(dataChatCampaignsTable.schoolId, schoolId),
              inArray(dataChatCampaignsTable.id, cids),
            ),
          );
        for (const r of rows) campaignNames.set(r.id, r.name);
      }
    }
    const pastGoalsByStudent = new Map<
      string,
      Array<{ campaignName: string; goal: string; date: string }>
    >();
    for (const l of priorLogs) {
      if (l.campaignId === c.id || !l.goal.trim()) continue;
      let arr = pastGoalsByStudent.get(l.studentId);
      if (!arr) {
        arr = [];
        pastGoalsByStudent.set(l.studentId, arr);
      }
      if (arr.length < 3) {
        arr.push({
          campaignName: campaignNames.get(l.campaignId) ?? "Earlier chat",
          goal: l.goal,
          date: l.updatedAt.toLocaleDateString("en-CA", {
            timeZone: DEFAULT_SCHOOL_TZ,
          }),
        });
      }
    }

    const fastByStudent =
      c.kind === "fast_data"
        ? await loadQueueFast(
            schoolId,
            students.map((s) => ({ studentId: s.studentId, grade: s.grade })),
          )
        : new Map<string, Partial<Record<"ela" | "math", {
            pm1: number | null;
            pm2: number | null;
            pm3: number | null;
            levels: PmPlacementSetWithGap;
          }>>>();

    out.push({
      campaign: {
        id: c.id,
        name: c.name,
        kind: c.kind,
        subject: c.subject,
        deadline: c.deadline,
        daysLeft: daysBetween(today, c.deadline),
        shareWithFamilies: c.shareWithFamilies,
        checklist: parseChecklist(c.checklistJson),
        goalChips: parseStringArray(c.goalChipsJson),
      },
      students: pairs
        .map((p) => {
          const s = studentById.get(p.studentId);
          const log = logByStudent.get(p.studentId);
          const fast = fastByStudent.get(p.studentId);
          return {
            studentId: p.studentId,
            name: s ? `${s.firstName} ${s.lastName}` : "(unknown)",
            lastFirst: s ? `${s.lastName}, ${s.firstName}` : "(unknown)",
            localSisId: s?.localSisId ?? null,
            grade: s?.grade ?? null,
            subject: p.subject,
            fast:
              c.kind === "fast_data" && p.subject && fast?.[p.subject]
                ? { [p.subject]: fast[p.subject] }
                : c.kind === "fast_data" && !p.subject
                  ? (fast ?? null)
                  : null,
            pastGoals: pastGoalsByStudent.get(p.studentId) ?? [],
            logged: log
              ? {
                  discussed: parseStringArray(log.discussedJson),
                  goal: log.goal,
                  privateNote: log.privateNote,
                  at: log.updatedAt.toLocaleDateString("en-CA", {
                    timeZone: DEFAULT_SCHOOL_TZ,
                  }),
                }
              : null,
          };
        })
        .sort((a, b) => a.lastFirst.localeCompare(b.lastFirst)),
    });
  }
  res.json(out);
});

// GET /data-chats/reminder — light poll for the top-bar icon + deadline
// banner. Only campaigns where THIS teacher still has students remaining.
router.get("/data-chats/reminder", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId === null) return;
  const staff = getStaff(req);
  const campaigns = await db
    .select()
    .from(dataChatCampaignsTable)
    .where(
      and(
        eq(dataChatCampaignsTable.schoolId, schoolId),
        eq(dataChatCampaignsTable.active, true),
        ne(dataChatCampaignsTable.kind, SELF_SERVE_KIND),
      ),
    );
  const today = todayISO();
  const out = [];
  for (const c of campaigns) {
    const pairs = (await resolvePairs(c)).filter(
      (p) => p.teacherStaffId === staff.id,
    );
    if (pairs.length === 0) continue;
    const logs = await db
      .select({ studentId: dataChatLogsTable.studentId })
      .from(dataChatLogsTable)
      .where(
        and(
          eq(dataChatLogsTable.schoolId, schoolId),
          eq(dataChatLogsTable.campaignId, c.id),
          eq(dataChatLogsTable.teacherStaffId, staff.id),
        ),
      );
    const logged = new Set(logs.map((l) => l.studentId));
    const remaining = pairs.filter((p) => !logged.has(p.studentId)).length;
    if (remaining === 0) continue;
    out.push({
      campaignId: c.id,
      name: c.name,
      deadline: c.deadline,
      daysLeft: daysBetween(today, c.deadline),
      remaining,
      total: pairs.length,
    });
  }
  res.json(out);
});

// POST /data-chats/logs — teacher logs (or updates) a chat. The actor is the
// teacher; the (campaign, actor, student) pair must exist in the campaign's
// computed worklist — client filtering alone is bypassable.
router.post("/data-chats/logs", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId === null) return;
  const staff = getStaff(req);
  const campaignId = Number(req.body?.campaignId);
  const studentId = String(req.body?.studentId ?? "");
  const campaign = await loadCampaign(schoolId, campaignId);
  if (!campaign || !campaign.active) {
    res.status(400).json({ error: "Campaign not found or ended" });
    return;
  }
  const pairs = await resolvePairs(campaign);
  const pair = pairs.find(
    (p) => p.teacherStaffId === staff.id && p.studentId === studentId,
  );
  if (!pair) {
    res.status(403).json({ error: "This student isn't in your queue for this campaign" });
    return;
  }
  const checklist = parseChecklist(campaign.checklistJson);
  const validIds = new Set(checklist.map((c) => c.id));
  const discussed = Array.isArray(req.body?.discussed)
    ? (req.body.discussed as unknown[])
        .map((x) => String(x))
        .filter((id) => validIds.has(id))
    : [];
  if (discussed.length === 0) {
    res.status(400).json({ error: "Check at least one topic you discussed" });
    return;
  }
  const goal = String(req.body?.goal ?? "").trim().slice(0, 500);
  const privateNote = String(req.body?.privateNote ?? "").trim().slice(0, 2000);

  await db
    .insert(dataChatLogsTable)
    .values({
      schoolId,
      campaignId: campaign.id,
      studentId,
      teacherStaffId: staff.id,
      subject: pair.subject,
      discussedJson: JSON.stringify(discussed),
      goal,
      privateNote,
    })
    .onConflictDoUpdate({
      // Campaign logs are always entry_seq 0 (insert default) — re-logging
      // the same pair upserts in place, matching the 4-column unique index.
      target: [
        dataChatLogsTable.campaignId,
        dataChatLogsTable.teacherStaffId,
        dataChatLogsTable.studentId,
        dataChatLogsTable.entrySeq,
      ],
      set: {
        discussedJson: JSON.stringify(discussed),
        goal,
        privateNote,
        subject: pair.subject,
        updatedAt: new Date(),
      },
    });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Self-serve teacher-initiated chats (Teacher Roster inline icon)
// ---------------------------------------------------------------------------

// Lazily create (or refresh) the per-school self-serve bucket campaign.
// Every teacher-initiated chat logs against this row so the existing
// storage, family-sharing, and history plumbing all apply. Checklist /
// goal chips / share flag are refreshed from the built-in FAST template on
// each touch so template edits flow through (unlike launched campaigns,
// which snapshot on purpose).
async function ensureSelfServeCampaign(schoolId: number) {
  await ensureBuiltInTemplate(schoolId);
  const [tpl] = await db
    .select()
    .from(dataChatTemplatesTable)
    .where(
      and(
        eq(dataChatTemplatesTable.schoolId, schoolId),
        eq(dataChatTemplatesTable.builtIn, true),
      ),
    )
    .limit(1);
  if (!tpl) throw new Error("built-in template missing");
  const [existing] = await db
    .select()
    .from(dataChatCampaignsTable)
    .where(
      and(
        eq(dataChatCampaignsTable.schoolId, schoolId),
        eq(dataChatCampaignsTable.kind, SELF_SERVE_KIND),
      ),
    )
    .limit(1);
  if (existing) {
    await db
      .update(dataChatCampaignsTable)
      .set({
        checklistJson: tpl.checklistJson,
        goalChipsJson: tpl.goalChipsJson,
        shareWithFamilies: tpl.shareWithFamilies,
        active: true,
      })
      .where(eq(dataChatCampaignsTable.id, existing.id));
    return {
      ...existing,
      checklistJson: tpl.checklistJson,
      goalChipsJson: tpl.goalChipsJson,
      shareWithFamilies: tpl.shareWithFamilies,
      active: true,
    };
  }
  const [row] = await db
    .insert(dataChatCampaignsTable)
    .values({
      schoolId,
      templateId: tpl.id,
      name: "Teacher check-in",
      kind: SELF_SERVE_KIND,
      subject: null,
      assignmentMode: "self",
      selectedTeacherIdsJson: "[]",
      responsiblePeriod: 1,
      scopeJson: null,
      checklistJson: tpl.checklistJson,
      goalChipsJson: tpl.goalChipsJson,
      shareWithFamilies: tpl.shareWithFamilies,
      startDate: todayISO(),
      deadline: SELF_SERVE_DEADLINE,
      active: true,
      createdByStaffId: null,
      createdByName: "System",
    })
    .returning();
  return row;
}

// Is this student on the acting teacher's roster (any non-planning section)?
async function teacherHasStudent(
  schoolId: number,
  teacherStaffId: number,
  studentId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: sectionRosterTable.id })
    .from(sectionRosterTable)
    .innerJoin(
      classSectionsTable,
      eq(sectionRosterTable.sectionId, classSectionsTable.id),
    )
    .where(
      and(
        eq(sectionRosterTable.schoolId, schoolId),
        eq(sectionRosterTable.studentId, studentId),
        eq(classSectionsTable.schoolId, schoolId),
        eq(classSectionsTable.teacherStaffId, teacherStaffId),
        eq(classSectionsTable.isPlanning, false),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

// GET /data-chats/pending-students — light per-teacher map for the Teacher
// Roster inline icon: which of my students still need a campaign chat.
router.get("/data-chats/pending-students", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId === null) return;
  const staff = getStaff(req);
  const campaigns = await db
    .select()
    .from(dataChatCampaignsTable)
    .where(
      and(
        eq(dataChatCampaignsTable.schoolId, schoolId),
        eq(dataChatCampaignsTable.active, true),
        ne(dataChatCampaignsTable.kind, SELF_SERVE_KIND),
      ),
    );
  const pending = new Set<string>();
  for (const c of campaigns) {
    const pairs = (await resolvePairs(c)).filter(
      (p) => p.teacherStaffId === staff.id,
    );
    if (pairs.length === 0) continue;
    const logs = await db
      .select({ studentId: dataChatLogsTable.studentId })
      .from(dataChatLogsTable)
      .where(
        and(
          eq(dataChatLogsTable.schoolId, schoolId),
          eq(dataChatLogsTable.campaignId, c.id),
          eq(dataChatLogsTable.teacherStaffId, staff.id),
        ),
      );
    const logged = new Set(logs.map((l) => l.studentId));
    for (const p of pairs) {
      if (!logged.has(p.studentId)) pending.add(p.studentId);
    }
  }
  res.json({ studentIds: [...pending] });
});

// GET /data-chats/self-context/:studentId — everything the roster-row chat
// modal needs. If the student is PENDING in one of this teacher's active
// campaigns, returns that campaign (mode 'campaign') so the chat counts
// toward it; otherwise returns the self-serve bucket (mode 'self').
router.get(
  "/data-chats/self-context/:studentId",
  requireStaff,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const staff = getStaff(req);
    const studentId = String(req.params.studentId);

    const [student] = await db
      .select({
        studentId: studentsTable.studentId,
        firstName: studentsTable.firstName,
        lastName: studentsTable.lastName,
        grade: studentsTable.grade,
        localSisId: studentsTable.localSisId,
      })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.schoolId, schoolId),
          eq(studentsTable.studentId, studentId),
        ),
      );
    if (!student) {
      res.status(404).json({ error: "Student not found" });
      return;
    }
    if (!(await teacherHasStudent(schoolId, staff.id, studentId))) {
      res.status(403).json({ error: "This student isn't on your roster" });
      return;
    }

    // Pending campaign for this (teacher, student)? Earliest deadline wins.
    const campaigns = await db
      .select()
      .from(dataChatCampaignsTable)
      .where(
        and(
          eq(dataChatCampaignsTable.schoolId, schoolId),
          eq(dataChatCampaignsTable.active, true),
          ne(dataChatCampaignsTable.kind, SELF_SERVE_KIND),
        ),
      )
      .orderBy(dataChatCampaignsTable.deadline);
    let pendingCampaign: typeof campaigns[number] | null = null;
    let pendingSubject: "ela" | "math" | null = null;
    for (const c of campaigns) {
      const pairs = await resolvePairs(c);
      const pair = pairs.find(
        (p) => p.teacherStaffId === staff.id && p.studentId === studentId,
      );
      if (!pair) continue;
      const [logged] = await db
        .select({ id: dataChatLogsTable.id })
        .from(dataChatLogsTable)
        .where(
          and(
            eq(dataChatLogsTable.schoolId, schoolId),
            eq(dataChatLogsTable.campaignId, c.id),
            eq(dataChatLogsTable.teacherStaffId, staff.id),
            eq(dataChatLogsTable.studentId, studentId),
          ),
        )
        .limit(1);
      if (!logged) {
        pendingCampaign = c;
        pendingSubject = pair.subject;
        break;
      }
    }

    const bucket = pendingCampaign ?? (await ensureSelfServeCampaign(schoolId));
    const today = todayISO();

    // FAST mini-context (same shape my-queue uses).
    const fastMap = await loadQueueFast(schoolId, [
      { studentId: student.studentId, grade: student.grade },
    ]);
    const fast = fastMap.get(student.studentId) ?? null;

    // Past goals across campaigns (any teacher), most recent 3.
    const priorLogs = await db
      .select({
        campaignId: dataChatLogsTable.campaignId,
        goal: dataChatLogsTable.goal,
        updatedAt: dataChatLogsTable.updatedAt,
      })
      .from(dataChatLogsTable)
      .where(
        and(
          eq(dataChatLogsTable.schoolId, schoolId),
          eq(dataChatLogsTable.studentId, studentId),
        ),
      )
      .orderBy(desc(dataChatLogsTable.updatedAt))
      .limit(10);
    const cids = [...new Set(priorLogs.map((l) => l.campaignId))];
    const cname = new Map<number, string>();
    if (cids.length) {
      const rows = await db
        .select({
          id: dataChatCampaignsTable.id,
          name: dataChatCampaignsTable.name,
        })
        .from(dataChatCampaignsTable)
        .where(
          and(
            eq(dataChatCampaignsTable.schoolId, schoolId),
            inArray(dataChatCampaignsTable.id, cids),
          ),
        );
      for (const r of rows) cname.set(r.id, r.name);
    }
    const pastGoals: Array<{ campaignName: string; goal: string; date: string }> = [];
    for (const l of priorLogs) {
      if (!l.goal.trim()) continue;
      if (pastGoals.length >= 3) break;
      pastGoals.push({
        campaignName: cname.get(l.campaignId) ?? "Earlier chat",
        goal: l.goal,
        date: l.updatedAt.toLocaleDateString("en-CA", {
          timeZone: DEFAULT_SCHOOL_TZ,
        }),
      });
    }

    res.json({
      mode: pendingCampaign ? "campaign" : "self",
      campaign: {
        id: bucket.id,
        name: pendingCampaign ? bucket.name : "Teacher check-in",
        deadline: pendingCampaign ? bucket.deadline : null,
        daysLeft: pendingCampaign ? daysBetween(today, bucket.deadline) : null,
        shareWithFamilies: bucket.shareWithFamilies,
        checklist: parseChecklist(bucket.checklistJson),
        goalChips: parseStringArray(bucket.goalChipsJson),
      },
      subject: pendingSubject,
      student: {
        studentId: student.studentId,
        name: `${student.firstName} ${student.lastName}`,
        grade: student.grade,
        localSisId: student.localSisId,
      },
      fast,
      pastGoals,
    });
  },
);

// POST /data-chats/self-log — teacher-initiated chat (no campaign pending).
// Inserts a NEW row each time (entry_seq = max+1) so repeat check-ins keep
// full history. The student must be on the acting teacher's roster.
router.post("/data-chats/self-log", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId === null) return;
  const staff = getStaff(req);
  const studentId = String(req.body?.studentId ?? "");
  if (!studentId) {
    res.status(400).json({ error: "studentId required" });
    return;
  }
  if (!(await teacherHasStudent(schoolId, staff.id, studentId))) {
    res.status(403).json({ error: "This student isn't on your roster" });
    return;
  }
  const bucket = await ensureSelfServeCampaign(schoolId);
  const checklist = parseChecklist(bucket.checklistJson);
  const validIds = new Set(checklist.map((c) => c.id));
  const discussed = Array.isArray(req.body?.discussed)
    ? (req.body.discussed as unknown[])
        .map((x) => String(x))
        .filter((id) => validIds.has(id))
    : [];
  if (discussed.length === 0) {
    res.status(400).json({ error: "Check at least one topic you discussed" });
    return;
  }
  const goal = String(req.body?.goal ?? "").trim().slice(0, 500);
  const privateNote = String(req.body?.privateNote ?? "").trim().slice(0, 2000);

  // Next sequence for this (bucket, teacher, student). Retry once on the
  // (rare) concurrent-insert unique violation.
  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = await db
      .select({ entrySeq: dataChatLogsTable.entrySeq })
      .from(dataChatLogsTable)
      .where(
        and(
          eq(dataChatLogsTable.campaignId, bucket.id),
          eq(dataChatLogsTable.teacherStaffId, staff.id),
          eq(dataChatLogsTable.studentId, studentId),
        ),
      )
      .orderBy(desc(dataChatLogsTable.entrySeq))
      .limit(1);
    const nextSeq = (existing[0]?.entrySeq ?? -1) + 1;
    try {
      await db.insert(dataChatLogsTable).values({
        schoolId,
        campaignId: bucket.id,
        studentId,
        teacherStaffId: staff.id,
        entrySeq: nextSeq,
        subject: null,
        discussedJson: JSON.stringify(discussed),
        goal,
        privateNote,
      });
      res.json({ ok: true });
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "23505" && attempt === 0) continue;
      throw err;
    }
  }
});

export default router;
