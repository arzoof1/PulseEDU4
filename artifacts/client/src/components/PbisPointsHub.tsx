import { useEffect, useMemo, useRef, useState } from "react";
import { authFetch } from "../lib/authToken";
import StudentPhoto from "./StudentPhoto";
import { HowToUseHelp, HowToSection, RoleSection, howtoListStyle } from "./HowToUseHelp";
import InterventionTypesAdmin from "./InterventionTypesAdmin";
import PulloutReasonsAdmin from "./PulloutReasonsAdmin";

// =============================================================================
// PBIS Points Hub
// =============================================================================
// Replaces the old single-screen PBIS Points awarding form. Now lives where
// "PBIS Points" used to render in the side nav. Shell uses the same gradient
// header treatment as the other hubs (BellSchedule, etc.). Internal sub-nav
// holds the future home for Rubric / Rewards / Reports / Settings — Classes
// is the first real implementation.
// =============================================================================

type Tab = "classes" | "rubric" | "rewards" | "reports" | "settings";

type Section = {
  id: number;
  period: number;
  courseName: string;
  isPlanning: boolean;
  teacherStaffId: number;
  teacherName: string;
  studentIds: string[];
};

type Student = {
  id: number;
  studentId: string;
  firstName: string;
  lastName: string;
  grade?: number | null;
  // Packet B — server-supplied; renders via <StudentPhoto/> which
  // falls back to the initials bubble when null or consent=false.
  photoObjectKey?: string | null;
  photoConsent?: boolean | null;
};

// ownerScope='school'  — visible to all staff, editable by admin/BS/MTSS only.
// ownerScope='teacher' — owned by a single teacher, editable by them or admin.
// The merged award picker shows BOTH and tags the school-wide ones.
type Reason = {
  id: number;
  name: string;
  category: string;
  defaultPoints: number;
  active: boolean;
  polarity: "positive" | "negative";
  sortOrder: number;
  ownerScope: "school" | "teacher";
  ownerStaffId: number | null;
};

type SchoolSettings = {
  pbisNegativeAffectsTotal: boolean;
  interventionEffectivenessDays: number;
};

type NoteTemplate = {
  id: number;
  title: string;
  body: string;
  sortOrder: number;
  ownerScope: "school" | "teacher";
  ownerStaffId: number | null;
};

type StoreItem = {
  id: number;
  schoolId: number;
  ownerStaffId: number;
  name: string;
  description: string;
  pointsCost: number;
  imageUrl: string | null;
  sortOrder: number;
  archived: boolean;
};

type PbisEntry = {
  id: number;
  studentId: string;
  points: number;
  voidedAt?: string | null;
};

type Me = {
  id: number;
  displayName?: string;
  isAdmin?: boolean;
  isSuperUser?: boolean;
  isEseCoordinator?: boolean;
  isMtssCoordinator?: boolean;
  isBehaviorSpecialist?: boolean;
  isPbisCoordinator?: boolean;
  isDean?: boolean;
};

type Teacher = { id: number; name: string };

// Classroom intervention types (the "Intervention(s) tried" list). Used by the
// Negative-behavior logging path, which mirrors the Teacher Roster quick-log.
type IvType = {
  id: number;
  name: string;
  category: string;
  requiresNote: boolean;
  active: boolean;
};

// Color-first entry mode. "choose" shows the green/red picker; the others
// render the positive award hub or the negative behavior+intervention flow.
type Mode = "choose" | "positive" | "negative";

const TAB_LABELS: { key: Tab; label: string }[] = [
  { key: "classes", label: "Classes" },
  { key: "rubric", label: "School Store" },
  { key: "rewards", label: "Classroom Store" },
  { key: "reports", label: "Reports" },
  { key: "settings", label: "Settings" },
];

export default function PbisPointsHub() {
  const [tab, setTab] = useState<Tab>("classes");
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [me, setMe] = useState<Me | null>(null);
  const [sections, setSections] = useState<Section[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [reasons, setReasons] = useState<Reason[]>([]);
  const [noteTemplates, setNoteTemplates] = useState<NoteTemplate[]>([]);
  // studentId -> total active points (sum of non-voided entries)
  const [totals, setTotals] = useState<Map<string, number>>(new Map());

  const [selectedTeacherId, setSelectedTeacherId] = useState<number | null>(
    null,
  );
  const [activePeriod, setActivePeriod] = useState<number | "all">("all");
  // Current bell-period (computed from school's default bell schedule by
  // matching today's clock-time to a window). Used as the default value of
  // `activePeriod` so a teacher landing on the page sees only the class
  // they're teaching right now. The "All" option remains available.
  const [currentBellPeriod, setCurrentBellPeriod] = useState<number | null>(
    null,
  );
  // True once we've applied the bell-period default for the current
  // teacher selection. Reset whenever the teacher changes so an admin
  // switching teachers gets the same "land on current period" behavior.
  const appliedBellDefaultRef = useRef(false);
  const [awardingFor, setAwardingFor] = useState<Student | null>(null);
  // Bulk selection — set of studentIds checked across all sections.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  // Color-first entry: teacher picks Positive or Negative before anything else.
  // Positive = the existing award hub; Negative = pick a student then log a
  // behavior + the intervention(s) tried (same write path as the Teacher
  // Roster quick-log).
  const [mode, setMode] = useState<Mode>("choose");
  const [interventionTypes, setInterventionTypes] = useState<IvType[]>([]);
  const [loggingNegFor, setLoggingNegFor] = useState<Student | null>(null);

  // Clear bulk selection whenever the visible roster changes (period filter
  // or admin's teacher picker). Otherwise a teacher could "Select all" in
  // Period 1, switch to Period 2, and accidentally bulk-award students who
  // are no longer on screen.
  useEffect(() => {
    setSelectedIds(new Set());
  }, [activePeriod, selectedTeacherId]);

  // Admins, ESE coords, MTSS coords, and behavior specialists can pull
  // every section in their school via ?all=1 — they all need cross-room
  // visibility for their roles. Everyone else only sees their own roster
  // (gated server-side too).
  const canViewAllTeachers = !!(
    me?.isSuperUser ||
    me?.isAdmin ||
    me?.isEseCoordinator ||
    me?.isMtssCoordinator ||
    me?.isBehaviorSpecialist
  );

  // ---- Initial data load
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErrorMsg(null);
      try {
        // First we need to know whether the viewer is an admin so we can
        // request the right schedule scope.
        const meRes = await authFetch("/api/auth/me");
        if (!meRes.ok) throw new Error("Failed to load your account");
        const meJson = (await meRes.json()) as Me;
        if (cancelled) return;

        const adminScope = !!(
          meJson.isSuperUser ||
          meJson.isAdmin ||
          meJson.isEseCoordinator
        );

        const [schedRes, studRes, reasonsRes, pbisRes, tplRes, ivRes] =
          await Promise.all([
            authFetch(adminScope ? "/api/schedule?all=1" : "/api/schedule"),
            authFetch("/api/students"),
            authFetch("/api/pbis-reasons"),
            authFetch("/api/pbis"),
            authFetch("/api/pbis-note-templates"),
            authFetch("/api/intervention-types"),
          ]);
        if (!schedRes.ok) throw new Error("Failed to load class schedule");
        if (!studRes.ok) throw new Error("Failed to load students");
        if (!reasonsRes.ok) throw new Error("Failed to load PBIS reasons");
        if (!pbisRes.ok) throw new Error("Failed to load PBIS entries");
        // Note templates are non-critical — if they fail, fall back to empty.

        const schedJson = (await schedRes.json()) as { sections: Section[] };
        const studJson = (await studRes.json()) as Student[];
        const reasonsJson = (await reasonsRes.json()) as Reason[];
        const pbisJson = (await pbisRes.json()) as PbisEntry[];
        const tplJson = tplRes.ok
          ? ((await tplRes.json()) as NoteTemplate[])
          : [];
        const ivJson = ivRes.ok ? ((await ivRes.json()) as IvType[]) : [];

        if (cancelled) return;

        const filteredSections = (schedJson.sections ?? []).filter(
          (s) => !s.isPlanning,
        );
        setMe(meJson);
        setSections(filteredSections);
        setStudents(studJson);
        setReasons(reasonsJson.filter((r) => r.active));
        setNoteTemplates(tplJson);
        setInterventionTypes(ivJson.filter((i) => i.active));

        // Default the teacher picker to the viewer when they have any
        // sections; otherwise pick the first teacher alphabetically so the
        // grid isn't empty for an admin who doesn't teach.
        if (adminScope) {
          const selfHasSections = filteredSections.some(
            (s) => s.teacherStaffId === meJson.id,
          );
          if (selfHasSections) {
            setSelectedTeacherId(meJson.id);
          } else {
            const firstTeacher = [...filteredSections]
              .sort((a, b) => a.teacherName.localeCompare(b.teacherName))[0];
            setSelectedTeacherId(firstTeacher?.teacherStaffId ?? null);
          }
        } else {
          setSelectedTeacherId(meJson.id);
        }

        const t = new Map<string, number>();
        for (const e of pbisJson) {
          if (e.voidedAt) continue;
          t.set(e.studentId, (t.get(e.studentId) ?? 0) + e.points);
        }
        setTotals(t);
      } catch (err) {
        if (!cancelled) {
          setErrorMsg(
            err instanceof Error ? err.message : "Failed to load data",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Distinct teachers represented in the loaded sections, alphabetized.
  const teachers = useMemo<Teacher[]>(() => {
    const m = new Map<number, string>();
    for (const s of sections) {
      if (!m.has(s.teacherStaffId)) {
        m.set(s.teacherStaffId, s.teacherName || `Staff #${s.teacherStaffId}`);
      }
    }
    return Array.from(m.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [sections]);

  // Split reasons by polarity. Positive feeds the green award hub; negative
  // feeds the red behavior-logging flow. This is what visually separates the
  // two paths the user asked for.
  const positiveReasons = useMemo(
    () => reasons.filter((r) => r.polarity === "positive"),
    [reasons],
  );
  const negativeReasons = useMemo(
    () => reasons.filter((r) => r.polarity === "negative"),
    [reasons],
  );

  // Sections to display in the Classes tab — narrowed to the selected
  // teacher (or all of the viewer's own when not admin).
  const visibleSectionsForTeacher = useMemo(() => {
    if (selectedTeacherId == null) return sections;
    return sections.filter((s) => s.teacherStaffId === selectedTeacherId);
  }, [sections, selectedTeacherId]);

  // Reset the period filter when switching teachers so we don't leave the
  // user filtered to a period the new teacher doesn't have. The
  // bell-default effect below will then re-apply the current period if it
  // exists in the new teacher's schedule.
  useEffect(() => {
    setActivePeriod("all");
    appliedBellDefaultRef.current = false;
  }, [selectedTeacherId]);

  // Fetch the school's active bell schedule once and compute the period
  // currently in session. Mirrors the pattern used in App.tsx (Class Log)
  // and SpotlightPanel so behavior stays consistent across the app.
  useEffect(() => {
    let cancelled = false;
    authFetch("/api/bell-schedules/active", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { periods: [] }))
      .then(
        (data: {
          periods?: {
            periodNumber: number;
            startTime: string;
            endTime: string;
          }[];
        }) => {
          if (cancelled) return;
          const ps = Array.isArray(data?.periods) ? data.periods : [];
          if (ps.length === 0) {
            setCurrentBellPeriod(null);
            return;
          }
          const now = new Date();
          const hh = String(now.getHours()).padStart(2, "0");
          const mm = String(now.getMinutes()).padStart(2, "0");
          const clock = `${hh}:${mm}`;
          let live: number | null = null;
          for (const p of ps) {
            if (clock >= p.startTime && clock <= p.endTime) {
              live = p.periodNumber;
              break;
            }
          }
          setCurrentBellPeriod(live);
        },
      )
      .catch(() => {
        if (cancelled) return;
        setCurrentBellPeriod(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Once sections are loaded and we know the current bell period, default
  // the period filter to it (if it exists in the visible roster). Run only
  // once per teacher selection so a teacher who manually picks "All" or a
  // different period isn't forced back to the live period on every render.
  useEffect(() => {
    if (appliedBellDefaultRef.current) return;
    if (currentBellPeriod == null) return;
    if (sections.length === 0) return;
    const periodsForVisibleTeacher = new Set<number>();
    for (const s of sections) {
      if (selectedTeacherId == null || s.teacherStaffId === selectedTeacherId) {
        periodsForVisibleTeacher.add(s.period);
      }
    }
    if (periodsForVisibleTeacher.has(currentBellPeriod)) {
      setActivePeriod(currentBellPeriod);
    }
    appliedBellDefaultRef.current = true;
  }, [sections, selectedTeacherId, currentBellPeriod]);

  // ---- Save the current note text as a personal note template. Scoped to
  // 'teacher' so it lands in the staffer's own template list rather than the
  // school-wide library. Used by both AwardModal and BulkAwardModal.
  async function saveNoteTemplate(
    title: string,
    body: string,
  ): Promise<void> {
    const res = await authFetch("/api/pbis-note-templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: title.trim(),
        body: body.trim(),
        scope: "teacher",
      }),
    });
    if (!res.ok) {
      let msg = "Failed to save template";
      try {
        const j = (await res.json()) as { error?: string };
        if (j?.error) msg = j.error;
      } catch {
        // ignore
      }
      throw new Error(msg);
    }
    const created = (await res.json()) as NoteTemplate;
    setNoteTemplates((prev) => [...prev, created]);
  }

  // ---- Award points (used by AwardModal)
  async function awardPoints(
    student: Student,
    reason: Reason,
    points: number,
    note?: string,
  ): Promise<void> {
    const res = await authFetch("/api/pbis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        studentId: student.studentId,
        reason: reason.name,
        reasonId: reason.id,
        points,
        ...(note && note.trim() ? { note: note.trim() } : {}),
      }),
    });
    if (!res.ok) throw new Error("Failed to award points");
    // Use the SERVER-stored points value, not the submitted value — the
    // server may zero or negate it for negative behaviors based on the
    // school's pbisNegativeAffectsTotal policy.
    const stored = (await res.json().catch(() => null)) as
      | { points?: number }
      | null;
    const delta = typeof stored?.points === "number" ? stored.points : points;
    setTotals((prev) => {
      const next = new Map(prev);
      next.set(student.studentId, (next.get(student.studentId) ?? 0) + delta);
      return next;
    });
  }

  // Bulk award: same reason+points (and optional note) to many students.
  // Server is authoritative on polarity and on whether negatives subtract,
  // so we read the canonical `points` back and use that for each row.
  async function bulkAward(
    studentIds: string[],
    reason: Reason,
    points: number,
    note: string,
  ): Promise<void> {
    const res = await authFetch("/api/pbis/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        studentIds,
        reason: reason.name,
        reasonId: reason.id,
        points,
        note,
      }),
    });
    if (!res.ok) {
      let msg = "Failed to award points";
      try {
        const j = (await res.json()) as { error?: string };
        if (j?.error) msg = j.error;
      } catch {
        // ignore
      }
      throw new Error(msg);
    }
    const body = (await res.json().catch(() => null)) as
      | { entries?: Array<{ studentId: string; points: number }> }
      | null;
    setTotals((prev) => {
      const next = new Map(prev);
      for (const e of body?.entries ?? []) {
        next.set(e.studentId, (next.get(e.studentId) ?? 0) + (e.points ?? 0));
      }
      return next;
    });
  }

  // Refetch PBIS totals after a negative behavior is logged (the quick-log
  // endpoint writes a negative entry server-side), so the roster badges stay
  // accurate without a full page reload.
  async function refreshTotals() {
    try {
      const res = await authFetch("/api/pbis");
      if (!res.ok) return;
      const rows = (await res.json()) as PbisEntry[];
      const t = new Map<string, number>();
      for (const e of rows) {
        if (e.voidedAt) continue;
        t.set(e.studentId, (t.get(e.studentId) ?? 0) + e.points);
      }
      setTotals(t);
    } catch {
      // ignore — totals will refresh on next full load
    }
  }

  return (
    <section className="card">
      <div className="section-header-bar-teal" />
      <div className="section-header-band-hub">
        <h2
          style={{
            margin: 0,
            color: "white",
            fontSize: "1.5rem",
            fontWeight: 700,
          }}
        >
          PBIS Points
        </h2>
        <div
          style={{
            color: "rgba(255,255,255,0.85)",
            fontSize: "0.85rem",
            marginTop: "0.15rem",
          }}
        >
          Award points, build rewards, and run your classroom rubric — all in
          one place.
        </div>
      </div>

      {mode === "choose" && <ModeChooser onPick={(m) => setMode(m)} />}

      {mode !== "choose" && (
        <div style={{ marginBottom: "0.75rem" }}>
          <button
            type="button"
            onClick={() => {
              setMode("choose");
              setAwardingFor(null);
              setBulkOpen(false);
              setLoggingNegFor(null);
            }}
            style={{
              background: "none",
              border: "none",
              color: "#0e7490",
              fontSize: "0.9rem",
              fontWeight: 600,
              cursor: "pointer",
              padding: 0,
            }}
          >
            ← Back to Positive / Negative
          </button>
        </div>
      )}

      {mode === "negative" &&
        (loading ? (
          <div
            style={{ padding: "2rem", textAlign: "center", color: "#64748b" }}
          >
            Loading…
          </div>
        ) : errorMsg ? (
          <div
            style={{
              padding: "1rem",
              background: "#fee2e2",
              color: "#991b1b",
              borderRadius: "0.4rem",
              margin: "1rem 0",
            }}
          >
            {errorMsg}
          </div>
        ) : (
          <>
            <div
              style={{
                margin: "0 0 1rem",
                padding: "0.6rem 0.85rem",
                background: "#fef2f2",
                border: "1px solid #fecaca",
                borderRadius: "0.5rem",
                color: "#991b1b",
                fontSize: "0.9rem",
                fontWeight: 600,
              }}
            >
              Pick a student to log a behavior and the intervention(s) you tried.
            </div>
            <ClassesView
              sections={visibleSectionsForTeacher}
              students={students}
              totals={totals}
              activePeriod={activePeriod}
              onChangePeriod={setActivePeriod}
              onSelectStudent={setLoggingNegFor}
              teachers={canViewAllTeachers ? teachers : null}
              selectedTeacherId={selectedTeacherId}
              onChangeTeacher={setSelectedTeacherId}
              selectedIds={selectedIds}
              onToggleSelect={() => {}}
              onSelectMany={() => {}}
              onUnselectMany={() => {}}
              onClearSelection={() => {}}
              onOpenBulk={() => {}}
              hideBulk
            />
          </>
        ))}

      {mode === "positive" && (
        <>
      <TabBar tab={tab} onChange={setTab} />

      <HowToUseHelp title="How to use PBIS Points">
        <HowToSection title="What this hub is">
          One page for awarding points, browsing the rewards catalogs,
          and (if you have permission) editing the rubric and store
          inventory. Use the tab bar above to switch between awarding,
          recent activity, the Classroom Store, and the School Store.
        </HowToSection>
        <RoleSection for="teacher" title="Awarding points (teachers)">
          <ul style={howtoListStyle}>
            <li>Pick a student from your roster, choose a category, set the magnitude (positive or negative), add an optional note, and submit.</li>
            <li>Your classroom store is private to you — kids can spend the points you've awarded on rewards you set.</li>
            <li>The School Store is read-only for teachers; you can browse what's available but only PBIS coordinators / admins edit inventory.</li>
          </ul>
        </RoleSection>
        <RoleSection for={["admin", "pbisCoordinator"]} title="Admin / PBIS coordinator tools">
          <ul style={howtoListStyle}>
            <li>School Store: add items, set point cost, upload a thumbnail, mark in/out of stock. All schools see only their own catalog.</li>
            <li>Categories &amp; reasons: edit the picklists teachers use when awarding. Renaming preserves history.</li>
            <li>Milestone emails: configure the auto-emails that fire when a student crosses point thresholds.</li>
          </ul>
        </RoleSection>
        <RoleSection for="coreTeam" title="Core Team monitoring">
          Keep an eye on the positive-to-negative ratio in the Behavior
          dashboard. Anything below 4:1 in a class signals a Tier 1
          conversation with the teacher; the named-student lists in
          recent activity tell you who to talk about first.
        </RoleSection>
      </HowToUseHelp>

      {loading ? (
        <div style={{ padding: "2rem", textAlign: "center", color: "#64748b" }}>
          Loading…
        </div>
      ) : errorMsg ? (
        <div
          style={{
            padding: "1rem",
            background: "#fee2e2",
            color: "#991b1b",
            borderRadius: "0.4rem",
            margin: "1rem 0",
          }}
        >
          {errorMsg}
        </div>
      ) : tab === "classes" ? (
        <ClassesView
          sections={visibleSectionsForTeacher}
          students={students}
          totals={totals}
          activePeriod={activePeriod}
          onChangePeriod={setActivePeriod}
          onSelectStudent={setAwardingFor}
          teachers={canViewAllTeachers ? teachers : null}
          selectedTeacherId={selectedTeacherId}
          onChangeTeacher={setSelectedTeacherId}
          selectedIds={selectedIds}
          onToggleSelect={(id) =>
            setSelectedIds((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })
          }
          onSelectMany={(ids) =>
            setSelectedIds((prev) => {
              const next = new Set(prev);
              for (const id of ids) next.add(id);
              return next;
            })
          }
          onUnselectMany={(ids) =>
            setSelectedIds((prev) => {
              const next = new Set(prev);
              for (const id of ids) next.delete(id);
              return next;
            })
          }
          onClearSelection={() => setSelectedIds(new Set())}
          onOpenBulk={() => setBulkOpen(true)}
        />
      ) : tab === "settings" ? (
        <SettingsView
          me={me}
          reasons={reasons}
          onReasonsChanged={setReasons}
          templates={noteTemplates}
          onTemplatesChanged={setNoteTemplates}
        />
      ) : tab === "rewards" ? (
        <ClassroomStoreView />
      ) : tab === "rubric" ? (
        // Read-only School Store tab in the teacher PBIS hub. Editing is
        // intentionally disabled here for everyone (including admins) — use
        // the BS hub, MTSS hub, or the "School Store" admin section instead.
        <SchoolStoreView canEdit={false} />
      ) : (
        <ComingSoon tab={tab} />
      )}
        </>
      )}

      {awardingFor && (
        <AwardModal
          student={awardingFor}
          reasons={positiveReasons}
          templates={noteTemplates}
          onSaveTemplate={saveNoteTemplate}
          onClose={() => setAwardingFor(null)}
          onSubmit={async (picks, note) => {
            // Award each picked behavior in sequence so totals & milestones
            // update once per row. If any one fails the modal surfaces the
            // error and stops; previously-awarded picks remain on the record.
            for (const p of picks) {
              await awardPoints(awardingFor, p.reason, p.points, note);
            }
            setAwardingFor(null);
          }}
        />
      )}

      {bulkOpen && (
        <BulkAwardModal
          studentIds={Array.from(selectedIds)}
          students={students}
          reasons={positiveReasons}
          templates={noteTemplates}
          onSaveTemplate={saveNoteTemplate}
          onClose={() => setBulkOpen(false)}
          onSubmit={async (picks, note) => {
            // One bulk call per selected behavior so polarity & negative
            // policy resolve independently for each rubric row.
            const ids = Array.from(selectedIds);
            for (const p of picks) {
              await bulkAward(ids, p.reason, p.points, note);
            }
            setBulkOpen(false);
            setSelectedIds(new Set());
          }}
        />
      )}

      {loggingNegFor && (
        <NegativeLogModal
          student={loggingNegFor}
          behaviors={negativeReasons}
          interventionTypes={interventionTypes}
          onClose={() => setLoggingNegFor(null)}
          onSaved={() => {
            setLoggingNegFor(null);
            void refreshTotals();
          }}
        />
      )}
    </section>
  );
}

// -----------------------------------------------------------------------------
// Sub-components
// -----------------------------------------------------------------------------

// Color-first entry screen. Two large buttons separate the positive award
// flow from the negative behavior+intervention flow.
function ModeChooser({
  onPick,
}: {
  onPick: (m: "positive" | "negative") => void;
}) {
  const base: React.CSSProperties = {
    flex: "1 1 220px",
    minHeight: 170,
    border: "none",
    borderRadius: 16,
    cursor: "pointer",
    padding: "1.5rem",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "0.5rem",
    color: "white",
  };
  return (
    <div
      style={{
        display: "flex",
        gap: "1rem",
        flexWrap: "wrap",
        padding: "1.5rem 0 0.75rem",
      }}
    >
      <button
        type="button"
        onClick={() => onPick("positive")}
        style={{
          ...base,
          background: "linear-gradient(135deg,#16a34a,#15803d)",
          boxShadow: "0 8px 22px rgba(22,163,74,0.32)",
        }}
      >
        <span style={{ fontSize: "2.75rem", lineHeight: 1, fontWeight: 800 }}>
          +
        </span>
        <span style={{ fontSize: "1.4rem", fontWeight: 800 }}>Positive</span>
        <span
          style={{ fontSize: "0.9rem", opacity: 0.92, textAlign: "center" }}
        >
          Award PBIS recognition points
        </span>
      </button>
      <button
        type="button"
        onClick={() => onPick("negative")}
        style={{
          ...base,
          background: "linear-gradient(135deg,#dc2626,#b91c1c)",
          boxShadow: "0 8px 22px rgba(220,38,38,0.32)",
        }}
      >
        <span style={{ fontSize: "2.75rem", lineHeight: 1, fontWeight: 800 }}>
          −
        </span>
        <span style={{ fontSize: "1.4rem", fontWeight: 800 }}>Negative</span>
        <span
          style={{ fontSize: "0.9rem", opacity: 0.92, textAlign: "center" }}
        >
          Log a behavior &amp; intervention tried
        </span>
      </button>
    </div>
  );
}

// Negative behavior logger. Mirrors the Teacher Roster quick-log: choose the
// behavior (a negative PBIS reason), check the intervention(s) tried, add an
// optional note, and submit atomically to /api/interventions/quick-log.
function NegativeLogModal({
  student,
  behaviors,
  interventionTypes,
  onClose,
  onSaved,
}: {
  student: Student;
  behaviors: Reason[];
  interventionTypes: IvType[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [behaviorId, setBehaviorId] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [note, setNote] = useState("");
  const [eff, setEff] = useState<Record<
    string,
    { worked: number; recurred: number }
  > | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedBehavior = behaviors.find((b) => b.id === behaviorId) ?? null;

  // Pull per-intervention effectiveness history for this student + behavior so
  // the teacher can see what has worked before (same endpoint the roster uses).
  useEffect(() => {
    setEff(null);
    if (!selectedBehavior) return;
    let cancelled = false;
    authFetch(
      `/api/interventions/effectiveness?studentId=${encodeURIComponent(
        student.studentId,
      )}&behaviorReason=${encodeURIComponent(selectedBehavior.name)}`,
    )
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (
          j: {
            byType?: Record<string, { worked: number; recurred: number }>;
          } | null,
        ) => {
          if (!cancelled && j) setEff(j.byType ?? {});
        },
      )
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [behaviorId, student.studentId, selectedBehavior]);

  function toggleIv(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const noteOver = note.length > 500;
  const canSubmit =
    !!selectedBehavior && selected.size > 0 && !noteOver && !submitting;

  async function submit() {
    if (!selectedBehavior || selected.size === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await authFetch("/api/interventions/quick-log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId: student.studentId,
          reasonId: selectedBehavior.id,
          interventionTypeIds: [...selected],
          ...(note.trim() ? { note: note.trim() } : {}),
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          (j && typeof j.error === "string" && j.error) ||
            "Could not save. Please try again.",
        );
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  // Group intervention types by category for a tidy checklist.
  const ivByCategory = useMemo(() => {
    const m = new Map<string, IvType[]>();
    for (const iv of interventionTypes) {
      const k = iv.category || "Other";
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(iv);
    }
    return Array.from(m.entries());
  }, [interventionTypes]);

  const labelStyle: React.CSSProperties = {
    display: "block",
    fontSize: "0.8rem",
    fontWeight: 700,
    color: "#334155",
    marginBottom: "0.3rem",
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
        padding: "1rem",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "white",
          borderRadius: 12,
          width: "min(560px, 100%)",
          maxHeight: "90vh",
          overflowY: "auto",
          boxShadow: "0 20px 50px rgba(0,0,0,0.3)",
        }}
      >
        <div
          style={{
            padding: "1rem 1.25rem",
            borderTop: "4px solid #dc2626",
            borderBottom: "1px solid #f1f5f9",
          }}
        >
          <div
            style={{
              fontSize: "0.78rem",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              color: "#dc2626",
            }}
          >
            Log negative behavior
          </div>
          <div
            style={{ fontSize: "1.15rem", fontWeight: 700, color: "#0f172a" }}
          >
            {student.firstName} {student.lastName}
          </div>
        </div>

        <div style={{ padding: "1.25rem" }}>
          <div style={{ marginBottom: "1rem" }}>
            <label style={labelStyle}>Behavior</label>
            <select
              value={behaviorId ?? ""}
              onChange={(e) =>
                setBehaviorId(e.target.value ? Number(e.target.value) : null)
              }
              style={{
                width: "100%",
                padding: "0.55rem 0.6rem",
                borderRadius: "0.5rem",
                border: "1px solid #cbd5e1",
                fontSize: "0.95rem",
                background: "white",
              }}
            >
              <option value="">Select a behavior…</option>
              {behaviors.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            {behaviors.length === 0 && (
              <div
                style={{
                  marginTop: "0.4rem",
                  fontSize: "0.8rem",
                  color: "#b45309",
                }}
              >
                No negative behaviors configured yet. Add some under Settings →
                Categories &amp; reasons.
              </div>
            )}
          </div>

          <div style={{ marginBottom: "1rem" }}>
            <label style={labelStyle}>Intervention(s) tried</label>
            {interventionTypes.length === 0 ? (
              <div style={{ fontSize: "0.85rem", color: "#64748b" }}>
                No intervention types configured yet.
              </div>
            ) : (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.75rem",
                }}
              >
                {ivByCategory.map(([cat, items]) => (
                  <div key={cat}>
                    <div
                      style={{
                        fontSize: "0.72rem",
                        fontWeight: 700,
                        textTransform: "uppercase",
                        letterSpacing: "0.04em",
                        color: "#94a3b8",
                        marginBottom: "0.3rem",
                      }}
                    >
                      {cat}
                    </div>
                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        gap: "0.4rem",
                      }}
                    >
                      {items.map((iv) => {
                        const on = selected.has(iv.id);
                        const stat = eff?.[iv.name];
                        return (
                          <button
                            key={iv.id}
                            type="button"
                            onClick={() => toggleIv(iv.id)}
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "0.35rem",
                              padding: "0.4rem 0.6rem",
                              borderRadius: "999px",
                              border: on
                                ? "1px solid #0e7490"
                                : "1px solid #cbd5e1",
                              background: on ? "#0e7490" : "white",
                              color: on ? "white" : "#334155",
                              fontSize: "0.85rem",
                              fontWeight: 600,
                              cursor: "pointer",
                            }}
                          >
                            {on ? "✓ " : ""}
                            {iv.name}
                            {stat && (stat.worked > 0 || stat.recurred > 0) && (
                              <span
                                style={{
                                  fontSize: "0.72rem",
                                  fontWeight: 700,
                                  color: on ? "rgba(255,255,255,0.85)" : "#64748b",
                                }}
                                title="Past results for this student + behavior"
                              >
                                ({stat.worked}✓/{stat.recurred}↻)
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ marginBottom: "1rem" }}>
            <label style={labelStyle}>Note (optional)</label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="What happened? (optional)"
              style={{
                width: "100%",
                padding: "0.55rem 0.6rem",
                borderRadius: "0.5rem",
                border: noteOver ? "1px solid #dc2626" : "1px solid #cbd5e1",
                fontSize: "0.92rem",
                resize: "vertical",
                fontFamily: "inherit",
              }}
            />
            {noteOver && (
              <div style={{ fontSize: "0.78rem", color: "#dc2626" }}>
                Note must be 500 characters or fewer.
              </div>
            )}
          </div>

          {error && (
            <div
              style={{
                marginBottom: "0.75rem",
                padding: "0.5rem 0.7rem",
                background: "#fee2e2",
                color: "#991b1b",
                borderRadius: "0.4rem",
                fontSize: "0.85rem",
              }}
            >
              {error}
            </div>
          )}

          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: "0.6rem",
            }}
          >
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: "0.55rem 1rem",
                borderRadius: "0.5rem",
                border: "1px solid #cbd5e1",
                background: "white",
                color: "#334155",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!canSubmit}
              style={{
                padding: "0.55rem 1.1rem",
                borderRadius: "0.5rem",
                border: "none",
                background: canSubmit ? "#dc2626" : "#fca5a5",
                color: "white",
                fontWeight: 700,
                cursor: canSubmit ? "pointer" : "not-allowed",
              }}
            >
              {submitting ? "Saving…" : "Log behavior"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function TabBar({
  tab,
  onChange,
  labels = TAB_LABELS,
}: {
  tab: Tab;
  onChange: (t: Tab) => void;
  labels?: { key: Tab; label: string }[];
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: "0.25rem",
        borderBottom: "1px solid #e2e8f0",
        marginBottom: "1rem",
        flexWrap: "wrap",
      }}
    >
      {labels.map(({ key, label }) => {
        const active = key === tab;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onChange(key)}
            style={{
              background: "none",
              border: "none",
              padding: "0.6rem 1rem",
              fontSize: "0.95rem",
              fontWeight: active ? 600 : 500,
              color: active ? "#0e7490" : "#64748b",
              borderBottom: active
                ? "2px solid #0e7490"
                : "2px solid transparent",
              cursor: "pointer",
              marginBottom: "-1px",
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function ClassesView({
  sections,
  students,
  totals,
  activePeriod,
  onChangePeriod,
  onSelectStudent,
  teachers,
  selectedTeacherId,
  onChangeTeacher,
  selectedIds,
  onToggleSelect,
  onSelectMany,
  onUnselectMany,
  onClearSelection,
  onOpenBulk,
  hideBulk = false,
}: {
  sections: Section[];
  students: Student[];
  totals: Map<string, number>;
  activePeriod: number | "all";
  onChangePeriod: (p: number | "all") => void;
  onSelectStudent: (s: Student) => void;
  // null = no teacher picker (regular teacher view).
  teachers: Teacher[] | null;
  selectedTeacherId: number | null;
  onChangeTeacher: (id: number) => void;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onSelectMany: (ids: string[]) => void;
  onUnselectMany: (ids: string[]) => void;
  onClearSelection: () => void;
  onOpenBulk: () => void;
  // When true (negative-logging picker) the bulk-award UI is suppressed —
  // negatives are logged one student at a time with their interventions.
  hideBulk?: boolean;
}) {
  // Build the period filter from the actual periods present in the schedule.
  const periods = useMemo(() => {
    const set = new Set<number>();
    for (const sec of sections) set.add(sec.period);
    return Array.from(set).sort((a, b) => a - b);
  }, [sections]);

  const studentById = useMemo(() => {
    const m = new Map<string, Student>();
    for (const s of students) m.set(s.studentId, s);
    return m;
  }, [students]);

  // Sections to show: filtered by period (or all).
  const visibleSections = useMemo(() => {
    if (activePeriod === "all") return sections;
    return sections.filter((s) => s.period === activePeriod);
  }, [sections, activePeriod]);

  const showTeacherPicker = teachers !== null && teachers.length > 0;

  const emptyState = sections.length === 0 ? (
    <div
      style={{
        padding: "2rem",
        textAlign: "center",
        color: "#64748b",
        background: "#f8fafc",
        borderRadius: "0.5rem",
      }}
    >
      {showTeacherPicker
        ? "This teacher doesn't have any sections rostered yet."
        : "You don't have any classes assigned yet. Once your schedule is set up, your students will show up here."}
    </div>
  ) : null;

  return (
    <div>
      {/* Teacher picker (admin/ESE coord only) */}
      {showTeacherPicker && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
            marginBottom: "0.75rem",
            padding: "0.6rem 0.75rem",
            background: "#f1f5f9",
            border: "1px solid #e2e8f0",
            borderRadius: "0.5rem",
            flexWrap: "wrap",
          }}
        >
          <span
            style={{
              fontSize: "0.8rem",
              color: "#475569",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
            }}
          >
            Admin view
          </span>
          <span style={{ fontSize: "0.85rem", color: "#475569" }}>
            Teacher:
          </span>
          <select
            value={selectedTeacherId ?? ""}
            onChange={(e) => onChangeTeacher(Number(e.target.value))}
            style={{
              padding: "0.35rem 0.5rem",
              border: "1px solid #cbd5e1",
              borderRadius: "0.35rem",
              fontSize: "0.9rem",
              background: "white",
              minWidth: "14rem",
            }}
          >
            {teachers!.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {emptyState}
      {emptyState !== null ? null : (<>
      {/* Filter row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          marginBottom: "1rem",
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontSize: "0.85rem", color: "#475569", fontWeight: 600 }}>
          Period:
        </span>
        <PeriodPill
          label="All"
          active={activePeriod === "all"}
          onClick={() => onChangePeriod("all")}
        />
        {periods.map((p) => (
          <PeriodPill
            key={p}
            label={`P${p}`}
            active={activePeriod === p}
            onClick={() => onChangePeriod(p)}
          />
        ))}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: "0.8rem", color: "#94a3b8" }}>
          Tap a student to award · check the box to bulk-award
        </span>
      </div>

      {/* Section list */}
      <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
        {visibleSections.map((sec) => {
          const sectionStudents = sec.studentIds
            .map((id) => studentById.get(id))
            .filter((s): s is Student => Boolean(s))
            .sort(
              (a, b) =>
                a.lastName.localeCompare(b.lastName) ||
                a.firstName.localeCompare(b.firstName),
            );
          const sectionIds = sectionStudents.map((s) => s.studentId);
          const selectedHere = sectionIds.filter((id) =>
            selectedIds.has(id),
          ).length;
          const allSelected =
            sectionIds.length > 0 && selectedHere === sectionIds.length;
          return (
            <div key={sec.id}>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: "0.5rem",
                  marginBottom: "0.5rem",
                  flexWrap: "wrap",
                }}
              >
                <span
                  style={{
                    fontSize: "0.95rem",
                    fontWeight: 600,
                    color: "#0f172a",
                  }}
                >
                  Period {sec.period}
                </span>
                <span style={{ color: "#64748b", fontSize: "0.85rem" }}>
                  · {sec.courseName}
                </span>
                <span style={{ color: "#94a3b8", fontSize: "0.8rem" }}>
                  · {sectionStudents.length} students
                </span>
                <div style={{ flex: 1 }} />
                {!hideBulk && sectionStudents.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      if (allSelected) onUnselectMany(sectionIds);
                      else onSelectMany(sectionIds);
                    }}
                    style={{
                      background: allSelected ? "#0e7490" : "white",
                      color: allSelected ? "white" : "#0e7490",
                      border: "1px solid #0e7490",
                      borderRadius: "0.35rem",
                      padding: "0.25rem 0.6rem",
                      fontSize: "0.78rem",
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    {allSelected
                      ? "Clear all"
                      : selectedHere > 0
                        ? `Select all (${selectedHere}/${sectionIds.length})`
                        : "Select all"}
                  </button>
                )}
              </div>
              {sectionStudents.length === 0 ? (
                <div
                  style={{
                    padding: "0.75rem",
                    background: "#f8fafc",
                    color: "#94a3b8",
                    borderRadius: "0.4rem",
                    fontSize: "0.85rem",
                  }}
                >
                  No students rostered.
                </div>
              ) : (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns:
                      "repeat(auto-fill, minmax(160px, 1fr))",
                    gap: "0.6rem",
                  }}
                >
                  {sectionStudents.map((s) => (
                    <StudentCard
                      key={s.studentId}
                      student={s}
                      total={totals.get(s.studentId) ?? 0}
                      onClick={() => onSelectStudent(s)}
                      selected={selectedIds.has(s.studentId)}
                      onToggleSelect={() => onToggleSelect(s.studentId)}
                      hideBulk={hideBulk}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      </>)}

      {/* Floating bulk-award action bar — shows whenever 1+ students are picked. */}
      {!hideBulk && selectedIds.size > 0 && (
        <div
          style={{
            position: "sticky",
            bottom: "1rem",
            marginTop: "1rem",
            display: "flex",
            alignItems: "center",
            gap: "0.75rem",
            padding: "0.6rem 0.9rem",
            background: "#0f172a",
            color: "white",
            borderRadius: "0.6rem",
            boxShadow: "0 6px 18px rgba(15,23,42,0.25)",
          }}
        >
          <span style={{ fontWeight: 700 }}>
            {selectedIds.size} student{selectedIds.size === 1 ? "" : "s"} selected
          </span>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            onClick={onClearSelection}
            style={{
              background: "transparent",
              color: "white",
              border: "1px solid rgba(255,255,255,0.4)",
              borderRadius: "0.35rem",
              padding: "0.35rem 0.75rem",
              fontSize: "0.85rem",
              cursor: "pointer",
            }}
          >
            Clear
          </button>
          <button
            type="button"
            onClick={onOpenBulk}
            style={{
              background: "#0e7490",
              color: "white",
              border: "1px solid #0e7490",
              borderRadius: "0.35rem",
              padding: "0.4rem 1rem",
              fontSize: "0.9rem",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Award {selectedIds.size}{" "}
            student{selectedIds.size === 1 ? "" : "s"}
          </button>
        </div>
      )}
    </div>
  );
}

function PeriodPill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "0.3rem 0.75rem",
        borderRadius: "9999px",
        border: active ? "1px solid #0e7490" : "1px solid #cbd5e1",
        background: active ? "#0e7490" : "white",
        color: active ? "white" : "#475569",
        fontSize: "0.8rem",
        fontWeight: 600,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

function StudentCard({
  student,
  total,
  onClick,
  selected,
  onToggleSelect,
  hideBulk = false,
}: {
  student: Student;
  total: number;
  onClick: () => void;
  selected: boolean;
  onToggleSelect: () => void;
  hideBulk?: boolean;
}) {
  // Color the bottom badge by point bucket. Green = positive momentum,
  // amber = a couple of points, gray = none yet.
  const badgeColor =
    total >= 5
      ? "#16a34a"
      : total >= 1
        ? "#f59e0b"
        : "#94a3b8";
  // Top accent stripe by the same buckets so the grid scans like the
  // ClassDojo-style screenshot the user referenced.
  const accent =
    total >= 5
      ? "#16a34a"
      : total >= 1
        ? "#3b82f6"
        : "#cbd5e1";

  return (
    <div
      style={{
        position: "relative",
        background: "white",
        border: selected ? "2px solid #0e7490" : "1px solid #e2e8f0",
        borderTop: selected ? "2px solid #0e7490" : `3px solid ${accent}`,
        borderRadius: "0.5rem",
        boxShadow: selected
          ? "0 0 0 3px rgba(14,116,144,0.15)"
          : "0 1px 2px rgba(15,23,42,0.04)",
        transition: "transform 0.05s ease, box-shadow 0.1s ease",
      }}
    >
      {/* Checkbox in top-right — its own click target, doesn't trigger award */}
      {!hideBulk && (
        <label
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            top: "0.3rem",
            right: "0.35rem",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: "1.4rem",
            height: "1.4rem",
            cursor: "pointer",
            zIndex: 1,
          }}
          title={selected ? "Deselect" : "Select for bulk award"}
        >
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelect}
            style={{
              width: "1rem",
              height: "1rem",
              cursor: "pointer",
              accentColor: "#0e7490",
            }}
          />
        </label>
      )}
      <button
        type="button"
        onClick={onClick}
        style={{
          width: "100%",
          textAlign: "left",
          padding: "0.6rem 1.9rem 0.7rem 0.7rem",
          background: "transparent",
          border: "none",
          borderRadius: "0.5rem",
          cursor: "pointer",
        }}
        onMouseDown={(e) => (e.currentTarget.style.transform = "scale(0.98)")}
        onMouseUp={(e) => (e.currentTarget.style.transform = "scale(1)")}
        onMouseLeave={(e) => (e.currentTarget.style.transform = "scale(1)")}
      >
        {/* Packet B — student photo above the name. Initials bubble
            when no photo or consent revoked, so existing cards keep
            their look until a yearbook ingest runs. */}
        <div style={{ marginBottom: "0.4rem" }}>
          <StudentPhoto
            firstName={student.firstName}
            lastName={student.lastName}
            photoObjectKey={student.photoObjectKey ?? null}
            photoConsent={student.photoConsent ?? true}
            size={56}
          />
        </div>
        <div
          style={{
            fontSize: "0.95rem",
            fontWeight: 600,
            color: "#0f172a",
            lineHeight: 1.15,
          }}
        >
          {student.firstName}
        </div>
        <div
          style={{
            fontSize: "0.8rem",
            color: "#64748b",
            marginTop: "0.1rem",
          }}
        >
          {student.lastName}
        </div>
        <div
          style={{
            marginTop: "0.6rem",
            display: "inline-flex",
            alignItems: "center",
            gap: "0.25rem",
            padding: "0.15rem 0.5rem",
            borderRadius: "9999px",
            background: badgeColor,
            color: "white",
            fontSize: "0.75rem",
            fontWeight: 700,
          }}
        >
          💬 {total}
        </div>
      </button>
    </div>
  );
}

function AwardModal({
  student,
  reasons,
  templates,
  onSaveTemplate,
  onClose,
  onSubmit,
}: {
  student: Student;
  reasons: Reason[];
  templates: NoteTemplate[];
  onSaveTemplate: (title: string, body: string) => Promise<void>;
  onClose: () => void;
  onSubmit: (
    picks: { reason: Reason; points: number }[],
    note: string,
  ) => Promise<void>;
}) {
  // Multi-select: map of reasonId -> points (per-pick, editable). Tiles toggle
  // on/off; the strip below shows each pick with its own points input.
  const [picks, setPicks] = useState<Record<number, number>>({});
  const [note, setNote] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Cap the note client-side at the same 500-char limit the server enforces.
  const noteOver = note.length > 500;

  const pickEntries = Object.entries(picks).map(([id, pts]) => ({
    id: Number(id),
    points: pts,
    reason: reasons.find((r) => r.id === Number(id)) ?? null,
  }));
  // All picks must have a positive whole-number points value.
  const allValid =
    pickEntries.length > 0 &&
    pickEntries.every(
      (p) => p.reason !== null && Number.isInteger(p.points) && p.points >= 1,
    );

  function togglePick(r: Reason) {
    setPicks((prev) => {
      if (prev[r.id] !== undefined) {
        const next = { ...prev };
        delete next[r.id];
        return next;
      }
      return { ...prev, [r.id]: r.defaultPoints };
    });
  }
  function setPickPoints(id: number, pts: number) {
    setPicks((prev) => ({ ...prev, [id]: pts }));
  }
  function removePick(id: number) {
    setPicks((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  // Close on ESC for keyboard users.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const reasonsByCategory = useMemo(() => {
    const m = new Map<string, Reason[]>();
    for (const r of reasons) {
      const arr = m.get(r.category) ?? [];
      arr.push(r);
      m.set(r.category, arr);
    }
    return Array.from(m.entries());
  }, [reasons]);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,0.55)",
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1rem",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Award points to ${student.firstName} ${student.lastName}`}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "white",
          borderRadius: "0.6rem",
          width: "100%",
          maxWidth: "30rem",
          maxHeight: "90vh",
          overflow: "auto",
          padding: "1.25rem",
          boxShadow: "0 20px 40px rgba(15,23,42,0.25)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", marginBottom: "0.5rem" }}>
          <h3 style={{ margin: 0, fontSize: "1.15rem" }}>
            Award {student.firstName} {student.lastName}
          </h3>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              fontSize: "1.4rem",
              cursor: "pointer",
              color: "#64748b",
              lineHeight: 1,
            }}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {reasons.length === 0 ? (
          <div
            style={{
              padding: "1rem",
              background: "#fef3c7",
              color: "#92400e",
              borderRadius: "0.4rem",
              fontSize: "0.9rem",
            }}
          >
            No active PBIS reasons are set up for this school yet. Ask an
            admin to add some in the PBIS list settings.
          </div>
        ) : (
          <>
            <div style={{ marginBottom: "1rem" }}>
              {reasonsByCategory.map(([cat, list]) => (
                <div key={cat} style={{ marginBottom: "0.6rem" }}>
                  <div
                    style={{
                      fontSize: "0.75rem",
                      fontWeight: 700,
                      color: "#94a3b8",
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                      marginBottom: "0.3rem",
                    }}
                  >
                    {cat}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: "0.35rem",
                    }}
                  >
                    {list.map((r) => {
                      const active = picks[r.id] !== undefined;
                      return (
                        <button
                          key={r.id}
                          type="button"
                          onClick={() => togglePick(r)}
                          style={{
                            padding: "0.4rem 0.7rem",
                            borderRadius: "0.4rem",
                            border: active
                              ? "1.5px solid #0e7490"
                              : "1px solid #cbd5e1",
                            background: active ? "#ecfeff" : "white",
                            color: active ? "#0e7490" : "#334155",
                            fontSize: "0.85rem",
                            fontWeight: 500,
                            cursor: "pointer",
                          }}
                        >
                          {active ? "✓ " : ""}{r.name}{" "}
                          <span
                            style={{
                              opacity: 0.65,
                              marginLeft: "0.25rem",
                              fontSize: "0.75rem",
                            }}
                          >
                            +{r.defaultPoints}
                          </span>
                          {r.ownerScope === "school" && (
                            <SchoolTag />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            <PicksEditor
              picks={pickEntries}
              onChangePoints={setPickPoints}
              onRemove={removePick}
            />

            <NoteSection
              note={note}
              setNote={setNote}
              templates={templates}
              onSaveTemplate={onSaveTemplate}
              noteOver={noteOver}
              placeholder={`Why is ${student.firstName} earning these points? (Saved on the student's record.)`}
            />

            {err && (
              <div
                style={{
                  marginBottom: "0.75rem",
                  padding: "0.5rem 0.75rem",
                  background: "#fee2e2",
                  color: "#991b1b",
                  borderRadius: "0.35rem",
                  fontSize: "0.85rem",
                }}
              >
                {err}
              </div>
            )}

            <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={onClose}
                style={{
                  padding: "0.5rem 1rem",
                  background: "white",
                  border: "1px solid #cbd5e1",
                  borderRadius: "0.4rem",
                  color: "#475569",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!allValid || submitting || noteOver}
                onClick={async () => {
                  if (!allValid) return;
                  setSubmitting(true);
                  setErr(null);
                  try {
                    const valid = pickEntries
                      .filter((p): p is typeof p & { reason: Reason } =>
                        p.reason !== null,
                      )
                      .map((p) => ({ reason: p.reason, points: p.points }));
                    await onSubmit(valid, note.trim());
                  } catch (e) {
                    setErr(e instanceof Error ? e.message : "Failed");
                  } finally {
                    setSubmitting(false);
                  }
                }}
                style={{
                  padding: "0.5rem 1rem",
                  background: "#0e7490",
                  border: "1px solid #0e7490",
                  borderRadius: "0.4rem",
                  color: "white",
                  fontWeight: 600,
                  cursor: submitting ? "wait" : "pointer",
                  opacity: !allValid || submitting || noteOver ? 0.6 : 1,
                }}
              >
                {submitting
                  ? "Awarding…"
                  : pickEntries.length > 1
                    ? `Award ${pickEntries.length} items`
                    : "Award Points"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// PicksEditor — strip of selected behaviors, each with its own editable points
// input and a remove button. Used by both AwardModal and BulkAwardModal so the
// UX is identical between single-student and multi-student award flows.
// -----------------------------------------------------------------------------
function PicksEditor({
  picks,
  onChangePoints,
  onRemove,
  perStudent,
}: {
  picks: { id: number; points: number; reason: Reason | null }[];
  onChangePoints: (id: number, pts: number) => void;
  onRemove: (id: number) => void;
  perStudent?: boolean;
}) {
  if (picks.length === 0) {
    return (
      <div
        style={{
          padding: "0.6rem 0.75rem",
          background: "#f8fafc",
          color: "#64748b",
          border: "1px dashed #cbd5e1",
          borderRadius: "0.4rem",
          fontSize: "0.85rem",
          marginBottom: "1rem",
        }}
      >
        Pick one or more behaviors above to award.
      </div>
    );
  }
  return (
    <div
      style={{
        marginBottom: "1rem",
        padding: "0.6rem",
        background: "#f8fafc",
        border: "1px solid #e2e8f0",
        borderRadius: "0.4rem",
      }}
    >
      <div
        style={{
          fontSize: "0.75rem",
          fontWeight: 700,
          color: "#475569",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          marginBottom: "0.4rem",
        }}
      >
        Selected ({picks.length}) — points {perStudent ? "each per student" : "each"}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
        {picks.map((p) => {
          if (!p.reason) return null;
          const isNeg = p.reason.polarity === "negative";
          const valid = Number.isInteger(p.points) && p.points >= 1;
          return (
            <div
              key={p.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                background: "white",
                border: "1px solid #e2e8f0",
                borderRadius: "0.35rem",
                padding: "0.3rem 0.5rem",
              }}
            >
              <span
                style={{
                  flex: 1,
                  fontSize: "0.88rem",
                  color: "#0f172a",
                  fontWeight: 500,
                }}
              >
                {p.reason.name}
                {p.reason.ownerScope === "school" && <SchoolTag />}
              </span>
              <span
                style={{
                  fontSize: "0.85rem",
                  color: isNeg ? "#dc2626" : "#16a34a",
                  fontWeight: 600,
                }}
              >
                {isNeg ? "−" : "+"}
              </span>
              <input
                type="number"
                min={1}
                step={1}
                value={p.points}
                onChange={(e) => onChangePoints(p.id, Number(e.target.value))}
                aria-label={`Points for ${p.reason.name}`}
                style={{
                  width: "4.5rem",
                  padding: "0.25rem 0.4rem",
                  border: valid ? "1px solid #cbd5e1" : "1px solid #dc2626",
                  borderRadius: "0.3rem",
                  fontSize: "0.88rem",
                }}
              />
              <button
                type="button"
                onClick={() => onRemove(p.id)}
                aria-label={`Remove ${p.reason.name}`}
                style={{
                  background: "none",
                  border: "none",
                  color: "#94a3b8",
                  cursor: "pointer",
                  fontSize: "1.1rem",
                  lineHeight: 1,
                  padding: "0 0.2rem",
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// NoteSection — optional note textarea with template picker AND a
// "Save as template" inline action that lets a teacher persist the current
// note text as a personal template (scope='teacher') without leaving the
// award modal. Shared between AwardModal and BulkAwardModal so the UX stays
// consistent.
// -----------------------------------------------------------------------------
function NoteSection({
  note,
  setNote,
  templates,
  onSaveTemplate,
  placeholder,
  noteOver,
}: {
  note: string;
  setNote: (v: string) => void;
  templates: NoteTemplate[];
  onSaveTemplate: (title: string, body: string) => Promise<void>;
  placeholder: string;
  noteOver: boolean;
}) {
  const [tplOpen, setTplOpen] = useState(false);
  const [tplName, setTplName] = useState("");
  const [savingTpl, setSavingTpl] = useState(false);
  const [tplErr, setTplErr] = useState<string | null>(null);

  // The save action only makes sense once the teacher has typed something.
  const canOpenSave = note.trim().length > 0 && !noteOver;
  const canSubmitTpl =
    tplName.trim().length > 0 && note.trim().length > 0 && !noteOver;

  async function handleSaveTpl() {
    if (!canSubmitTpl) return;
    setSavingTpl(true);
    setTplErr(null);
    try {
      await onSaveTemplate(tplName, note);
      setTplOpen(false);
      setTplName("");
    } catch (e) {
      setTplErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSavingTpl(false);
    }
  }

  return (
    <label
      style={{
        display: "block",
        marginBottom: "1rem",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          marginBottom: "0.3rem",
          flexWrap: "wrap",
          gap: "0.4rem",
        }}
      >
        <span style={{ fontSize: "0.9rem", color: "#475569" }}>
          Note (optional)
        </span>
        <div style={{ flex: 1 }} />
        {templates.length > 0 && (
          <select
            value=""
            onChange={(e) => {
              const id = Number(e.target.value);
              const t = templates.find((x) => x.id === id);
              if (t) setNote(t.body);
            }}
            style={{
              padding: "0.2rem 0.4rem",
              border: "1px solid #cbd5e1",
              borderRadius: "0.3rem",
              fontSize: "0.78rem",
              background: "white",
              color: "#0e7490",
              cursor: "pointer",
            }}
            aria-label="Insert note template"
          >
            <option value="">Use template…</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        )}
        {!tplOpen && (
          <button
            type="button"
            disabled={!canOpenSave}
            onClick={() => {
              setTplErr(null);
              setTplName("");
              setTplOpen(true);
            }}
            title={
              canOpenSave
                ? "Save this note to your template list"
                : "Type a note first"
            }
            style={{
              padding: "0.2rem 0.55rem",
              border: "1px solid #0e7490",
              borderRadius: "0.3rem",
              fontSize: "0.78rem",
              background: "white",
              color: "#0e7490",
              fontWeight: 600,
              cursor: canOpenSave ? "pointer" : "not-allowed",
              opacity: canOpenSave ? 1 : 0.5,
            }}
          >
            Save as template
          </button>
        )}
        <span
          style={{
            fontSize: "0.75rem",
            color: noteOver ? "#dc2626" : "#94a3b8",
          }}
        >
          {note.length}/500
        </span>
      </div>

      {tplOpen && (
        <div
          // Stop the click here from bubbling to the parent <label>, which
          // would otherwise refocus the textarea and steal focus from the
          // template-name input.
          onClick={(e) => e.preventDefault()}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.4rem",
            marginBottom: "0.45rem",
            padding: "0.4rem 0.5rem",
            background: "#ecfeff",
            border: "1px solid #a5f3fc",
            borderRadius: "0.35rem",
          }}
        >
          <input
            value={tplName}
            onChange={(e) => setTplName(e.target.value)}
            placeholder="Template name"
            autoFocus
            maxLength={80}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleSaveTpl();
              } else if (e.key === "Escape") {
                // Stop propagation so the modal-level Escape listener does
                // not also fire and close the entire award dialog.
                e.preventDefault();
                e.stopPropagation();
                setTplOpen(false);
                setTplName("");
                setTplErr(null);
              }
            }}
            style={{
              flex: 1,
              padding: "0.3rem 0.5rem",
              border: "1px solid #cbd5e1",
              borderRadius: "0.3rem",
              fontSize: "0.85rem",
              background: "white",
            }}
          />
          <button
            type="button"
            disabled={!canSubmitTpl || savingTpl}
            onClick={handleSaveTpl}
            style={{
              padding: "0.3rem 0.7rem",
              border: "1px solid #0e7490",
              borderRadius: "0.3rem",
              background: "#0e7490",
              color: "white",
              fontSize: "0.8rem",
              fontWeight: 600,
              cursor: !canSubmitTpl || savingTpl ? "not-allowed" : "pointer",
              opacity: !canSubmitTpl || savingTpl ? 0.6 : 1,
            }}
          >
            {savingTpl ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={() => {
              setTplOpen(false);
              setTplName("");
              setTplErr(null);
            }}
            style={{
              padding: "0.3rem 0.6rem",
              border: "1px solid #cbd5e1",
              borderRadius: "0.3rem",
              background: "white",
              color: "#475569",
              fontSize: "0.8rem",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
        </div>
      )}
      {tplErr && (
        <div
          style={{
            marginBottom: "0.45rem",
            fontSize: "0.78rem",
            color: "#991b1b",
          }}
        >
          {tplErr}
        </div>
      )}

      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={3}
        placeholder={placeholder}
        style={{
          width: "100%",
          padding: "0.5rem 0.6rem",
          border: noteOver ? "1px solid #dc2626" : "1px solid #cbd5e1",
          borderRadius: "0.35rem",
          fontSize: "0.9rem",
          fontFamily: "inherit",
          resize: "vertical",
          boxSizing: "border-box",
        }}
      />
    </label>
  );
}

// -----------------------------------------------------------------------------
// BulkAwardModal — same look as AwardModal but for many students + a note.
// -----------------------------------------------------------------------------
function BulkAwardModal({
  studentIds,
  students,
  reasons,
  templates,
  onSaveTemplate,
  onClose,
  onSubmit,
}: {
  studentIds: string[];
  students: Student[];
  reasons: Reason[];
  templates: NoteTemplate[];
  onSaveTemplate: (title: string, body: string) => Promise<void>;
  onClose: () => void;
  onSubmit: (
    picks: { reason: Reason; points: number }[],
    note: string,
  ) => Promise<void>;
}) {
  // Multi-select picks: reasonId -> points each (per-student).
  const [picks, setPicks] = useState<Record<number, number>>({});
  const [note, setNote] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const pickEntries = Object.entries(picks).map(([id, pts]) => ({
    id: Number(id),
    points: pts,
    reason: reasons.find((r) => r.id === Number(id)) ?? null,
  }));
  const allValid =
    pickEntries.length > 0 &&
    pickEntries.every(
      (p) => p.reason !== null && Number.isInteger(p.points) && p.points >= 1,
    );
  // Cap the note client-side at the same 500-char limit the server enforces.
  const noteOver = note.length > 500;

  function togglePick(r: Reason) {
    setPicks((prev) => {
      if (prev[r.id] !== undefined) {
        const next = { ...prev };
        delete next[r.id];
        return next;
      }
      return { ...prev, [r.id]: r.defaultPoints };
    });
  }
  function setPickPoints(id: number, pts: number) {
    setPicks((prev) => ({ ...prev, [id]: pts }));
  }
  function removePick(id: number) {
    setPicks((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Build a name preview for the chip strip at the top.
  const studentById = useMemo(() => {
    const m = new Map<string, Student>();
    for (const s of students) m.set(s.studentId, s);
    return m;
  }, [students]);
  const namesPreview = studentIds
    .map((id) => {
      const s = studentById.get(id);
      return s ? `${s.firstName} ${s.lastName}` : id;
    })
    .sort();

  const reasonsByCategory = useMemo(() => {
    const m = new Map<string, Reason[]>();
    for (const r of reasons) {
      const arr = m.get(r.category) ?? [];
      arr.push(r);
      m.set(r.category, arr);
    }
    return Array.from(m.entries());
  }, [reasons]);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,0.55)",
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1rem",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Award points to ${studentIds.length} students`}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "white",
          borderRadius: "0.6rem",
          width: "100%",
          maxWidth: "34rem",
          maxHeight: "90vh",
          overflow: "auto",
          padding: "1.25rem",
          boxShadow: "0 20px 40px rgba(15,23,42,0.25)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            marginBottom: "0.5rem",
          }}
        >
          <h3 style={{ margin: 0, fontSize: "1.15rem" }}>
            Award {studentIds.length} student{studentIds.length === 1 ? "" : "s"}
          </h3>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              fontSize: "1.4rem",
              cursor: "pointer",
              color: "#64748b",
              lineHeight: 1,
            }}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Selected students summary chip strip */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "0.3rem",
            padding: "0.5rem 0.6rem",
            background: "#f1f5f9",
            border: "1px solid #e2e8f0",
            borderRadius: "0.4rem",
            marginBottom: "1rem",
            maxHeight: "5.5rem",
            overflow: "auto",
          }}
        >
          {namesPreview.map((n) => (
            <span
              key={n}
              style={{
                fontSize: "0.78rem",
                background: "white",
                color: "#334155",
                border: "1px solid #cbd5e1",
                borderRadius: "9999px",
                padding: "0.1rem 0.55rem",
              }}
            >
              {n}
            </span>
          ))}
        </div>

        {reasons.length === 0 ? (
          <div
            style={{
              padding: "1rem",
              background: "#fef3c7",
              color: "#92400e",
              borderRadius: "0.4rem",
              fontSize: "0.9rem",
            }}
          >
            No active PBIS reasons are set up for this school yet. Ask an admin
            to add some in the PBIS list settings.
          </div>
        ) : (
          <>
            <div style={{ marginBottom: "1rem" }}>
              {reasonsByCategory.map(([cat, list]) => (
                <div key={cat} style={{ marginBottom: "0.6rem" }}>
                  <div
                    style={{
                      fontSize: "0.75rem",
                      fontWeight: 700,
                      color: "#94a3b8",
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                      marginBottom: "0.3rem",
                    }}
                  >
                    {cat}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: "0.35rem",
                    }}
                  >
                    {list.map((r) => {
                      const active = picks[r.id] !== undefined;
                      const isNeg = r.polarity === "negative";
                      return (
                        <button
                          key={r.id}
                          type="button"
                          onClick={() => togglePick(r)}
                          style={{
                            padding: "0.4rem 0.7rem",
                            borderRadius: "0.4rem",
                            border: active
                              ? `1.5px solid ${isNeg ? "#dc2626" : "#0e7490"}`
                              : "1px solid #cbd5e1",
                            background: active
                              ? isNeg
                                ? "#fef2f2"
                                : "#ecfeff"
                              : "white",
                            color: active
                              ? isNeg
                                ? "#991b1b"
                                : "#0e7490"
                              : "#334155",
                            fontSize: "0.85rem",
                            fontWeight: 500,
                            cursor: "pointer",
                          }}
                        >
                          {active ? "✓ " : ""}{r.name}{" "}
                          <span
                            style={{
                              opacity: 0.65,
                              marginLeft: "0.25rem",
                              fontSize: "0.75rem",
                            }}
                          >
                            {isNeg ? "−" : "+"}
                            {r.defaultPoints}
                          </span>
                          {r.ownerScope === "school" && (
                            <SchoolTag />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            <PicksEditor
              picks={pickEntries}
              onChangePoints={setPickPoints}
              onRemove={removePick}
              perStudent
            />

            <NoteSection
              note={note}
              setNote={setNote}
              templates={templates}
              onSaveTemplate={onSaveTemplate}
              noteOver={noteOver}
              placeholder="Why is the whole group earning these points? (Saved on each student's record.)"
            />

            {err && (
              <div
                style={{
                  marginBottom: "0.75rem",
                  padding: "0.5rem 0.75rem",
                  background: "#fee2e2",
                  color: "#991b1b",
                  borderRadius: "0.35rem",
                  fontSize: "0.85rem",
                }}
              >
                {err}
              </div>
            )}

            <div
              style={{
                display: "flex",
                gap: "0.5rem",
                justifyContent: "flex-end",
              }}
            >
              <button
                type="button"
                onClick={onClose}
                style={{
                  padding: "0.5rem 1rem",
                  background: "white",
                  border: "1px solid #cbd5e1",
                  borderRadius: "0.4rem",
                  color: "#475569",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={
                  !allValid ||
                  submitting ||
                  noteOver ||
                  studentIds.length === 0
                }
                onClick={async () => {
                  if (!allValid) return;
                  setSubmitting(true);
                  setErr(null);
                  try {
                    const valid = pickEntries
                      .filter((p): p is typeof p & { reason: Reason } =>
                        p.reason !== null,
                      )
                      .map((p) => ({ reason: p.reason, points: p.points }));
                    await onSubmit(valid, note.trim());
                  } catch (e) {
                    setErr(e instanceof Error ? e.message : "Failed");
                  } finally {
                    setSubmitting(false);
                  }
                }}
                style={{
                  padding: "0.5rem 1rem",
                  background: "#0e7490",
                  border: "1px solid #0e7490",
                  borderRadius: "0.4rem",
                  color: "white",
                  fontWeight: 600,
                  cursor: submitting ? "wait" : "pointer",
                  opacity:
                    !allValid || submitting || noteOver ? 0.6 : 1,
                }}
              >
                {submitting
                  ? "Awarding…"
                  : `Award ${studentIds.length} student${studentIds.length === 1 ? "" : "s"}${pickEntries.length > 1 ? ` × ${pickEntries.length}` : ""}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// NoteTemplatesSection — per-school library of reusable note text shown above
// the rubric in Settings. Any staff sees the picker; only PBIS admins edit.
// =============================================================================

export function NoteTemplatesSection({
  me,
  canEdit,
  templates,
  onTemplatesChanged,
  onError,
  scope,
}: {
  me: Me | null;
  canEdit: boolean;
  templates: NoteTemplate[];
  onTemplatesChanged: (next: NoteTemplate[]) => void;
  onError: (msg: string | null) => void;
  scope: "school" | "teacher";
}) {
  // Filter to the same scope the rubric is showing so a teacher in
  // "My classroom" view doesn't accidentally edit/delete a school-wide row.
  const visibleTemplates = useMemo(() => {
    if (scope === "school") {
      return templates.filter((t) => t.ownerScope === "school");
    }
    return templates.filter(
      (t) => t.ownerScope === "teacher" && (!me || t.ownerStaffId === me.id),
    );
  }, [templates, scope, me]);
  const [editing, setEditing] = useState<NoteTemplate | "new" | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [saving, setSaving] = useState(false);

  function openNew() {
    setDraftTitle("");
    setDraftBody("");
    setEditing("new");
  }
  function openEdit(t: NoteTemplate) {
    setDraftTitle(t.title);
    setDraftBody(t.body);
    setEditing(t);
  }
  function closeEditor() {
    setEditing(null);
    setDraftTitle("");
    setDraftBody("");
  }

  const titleOver = draftTitle.length > 80;
  const bodyOver = draftBody.length > 500;
  const canSave =
    !saving &&
    draftTitle.trim().length > 0 &&
    draftBody.trim().length > 0 &&
    !titleOver &&
    !bodyOver;

  async function save() {
    if (!editing || !canSave) return;
    setSaving(true);
    onError(null);
    try {
      if (editing === "new") {
        const res = await authFetch("/api/pbis-note-templates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: draftTitle.trim(),
            body: draftBody.trim(),
            scope,
          }),
        });
        if (!res.ok) throw new Error("Save failed");
        const created = (await res.json()) as NoteTemplate;
        onTemplatesChanged([...templates, created]);
      } else {
        const res = await authFetch(
          `/api/pbis-note-templates/${editing.id}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: draftTitle.trim(),
              body: draftBody.trim(),
            }),
          },
        );
        if (!res.ok) throw new Error("Save failed");
        const updated = (await res.json()) as NoteTemplate;
        onTemplatesChanged(
          templates.map((t) => (t.id === updated.id ? updated : t)),
        );
      }
      closeEditor();
    } catch {
      onError("Could not save note template. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function remove(t: NoteTemplate) {
    if (!window.confirm(`Delete the "${t.title}" template?`)) return;
    onError(null);
    try {
      const res = await authFetch(`/api/pbis-note-templates/${t.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Delete failed");
      onTemplatesChanged(templates.filter((x) => x.id !== t.id));
    } catch {
      onError("Could not delete that template. Try again.");
    }
  }

  return (
    <div
      style={{
        border: "1px solid #e2e8f0",
        borderRadius: "0.6rem",
        padding: "1rem",
        marginBottom: "1rem",
        background: "white",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "0.6rem",
        }}
      >
        <div>
          <div
            style={{ fontSize: "1.05rem", fontWeight: 700, color: "#0f172a" }}
          >
            Note templates
          </div>
          <div style={{ fontSize: "0.82rem", color: "#64748b" }}>
            Reusable note text teachers can pick from when awarding points to a
            group.
          </div>
        </div>
        {canEdit && (
          <button
            type="button"
            onClick={openNew}
            style={{
              background: "#0e7490",
              color: "white",
              border: "none",
              padding: "0.45rem 0.85rem",
              borderRadius: "0.4rem",
              fontWeight: 600,
              cursor: "pointer",
              fontSize: "0.85rem",
            }}
          >
            + New template
          </button>
        )}
      </div>

      {visibleTemplates.length === 0 ? (
        <div
          style={{
            padding: "1rem",
            textAlign: "center",
            color: "#64748b",
            border: "1px dashed #cbd5e1",
            borderRadius: "0.5rem",
            fontSize: "0.88rem",
          }}
        >
          No note templates yet.
          {canEdit ? " Add one to get started." : ""}
        </div>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {visibleTemplates.map((t) => (
            <li
              key={t.id}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: "0.75rem",
                padding: "0.55rem 0.5rem",
                borderTop: "1px solid #f1f5f9",
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, color: "#0f172a" }}>
                  {t.title}
                </div>
                <div
                  style={{
                    fontSize: "0.85rem",
                    color: "#475569",
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                  }}
                >
                  {t.body}
                </div>
              </div>
              {canEdit && (
                <div style={{ display: "flex", gap: "0.4rem" }}>
                  <button
                    type="button"
                    onClick={() => openEdit(t)}
                    style={{
                      background: "white",
                      border: "1px solid #cbd5e1",
                      borderRadius: "0.35rem",
                      padding: "0.3rem 0.65rem",
                      fontSize: "0.8rem",
                      cursor: "pointer",
                      color: "#0f172a",
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(t)}
                    style={{
                      background: "white",
                      border: "1px solid #fecaca",
                      borderRadius: "0.35rem",
                      padding: "0.3rem 0.65rem",
                      fontSize: "0.8rem",
                      cursor: "pointer",
                      color: "#991b1b",
                    }}
                  >
                    Delete
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <div
          onClick={closeEditor}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15,23,42,0.55)",
            zIndex: 50,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "1rem",
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={
              editing === "new" ? "New note template" : "Edit note template"
            }
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "white",
              borderRadius: "0.6rem",
              width: "100%",
              maxWidth: "32rem",
              padding: "1.25rem",
              boxShadow: "0 20px 40px rgba(15,23,42,0.25)",
            }}
          >
            <h3 style={{ marginTop: 0, fontSize: "1.1rem" }}>
              {editing === "new" ? "New note template" : "Edit note template"}
            </h3>
            <label style={{ display: "block", marginBottom: "0.85rem" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  marginBottom: "0.25rem",
                }}
              >
                <span style={{ fontSize: "0.88rem", color: "#475569" }}>
                  Title
                </span>
                <div style={{ flex: 1 }} />
                <span
                  style={{
                    fontSize: "0.75rem",
                    color: titleOver ? "#dc2626" : "#94a3b8",
                  }}
                >
                  {draftTitle.length}/80
                </span>
              </div>
              <input
                type="text"
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                placeholder="e.g. Great group effort"
                style={{
                  width: "100%",
                  padding: "0.45rem 0.6rem",
                  border: titleOver
                    ? "1px solid #dc2626"
                    : "1px solid #cbd5e1",
                  borderRadius: "0.35rem",
                  fontSize: "0.95rem",
                  boxSizing: "border-box",
                }}
              />
            </label>
            <label style={{ display: "block", marginBottom: "0.85rem" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  marginBottom: "0.25rem",
                }}
              >
                <span style={{ fontSize: "0.88rem", color: "#475569" }}>
                  Note text
                </span>
                <div style={{ flex: 1 }} />
                <span
                  style={{
                    fontSize: "0.75rem",
                    color: bodyOver ? "#dc2626" : "#94a3b8",
                  }}
                >
                  {draftBody.length}/500
                </span>
              </div>
              <textarea
                value={draftBody}
                onChange={(e) => setDraftBody(e.target.value)}
                rows={5}
                placeholder="The note that will be saved on each student's record."
                style={{
                  width: "100%",
                  padding: "0.5rem 0.6rem",
                  border: bodyOver
                    ? "1px solid #dc2626"
                    : "1px solid #cbd5e1",
                  borderRadius: "0.35rem",
                  fontSize: "0.9rem",
                  fontFamily: "inherit",
                  resize: "vertical",
                  boxSizing: "border-box",
                }}
              />
            </label>
            <div
              style={{
                display: "flex",
                gap: "0.5rem",
                justifyContent: "flex-end",
              }}
            >
              <button
                type="button"
                onClick={closeEditor}
                style={{
                  padding: "0.5rem 1rem",
                  background: "white",
                  border: "1px solid #cbd5e1",
                  borderRadius: "0.4rem",
                  color: "#475569",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!canSave}
                onClick={save}
                style={{
                  padding: "0.5rem 1rem",
                  background: canSave ? "#0e7490" : "#94a3b8",
                  color: "white",
                  border: "none",
                  borderRadius: "0.4rem",
                  fontWeight: 600,
                  cursor: canSave ? "pointer" : "not-allowed",
                }}
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// SettingsView — "Edit Behavior Rubric"
// Authorized staff (admin/PBIS coordinator/behavior specialist) can add, edit,
// reorder, archive, and toggle polarity of behaviors. Negative behaviors are
// always logged as red entries on a student's record; the school chooses
// whether they also subtract from the running point total.
// =============================================================================

export function SettingsView({
  me,
  reasons,
  onReasonsChanged,
  templates,
  onTemplatesChanged,
  lockedScope,
  initialFilter = "all",
  hideTemplates = false,
}: {
  me: Me | null;
  reasons: Reason[];
  onReasonsChanged: (next: Reason[]) => void;
  templates: NoteTemplate[];
  onTemplatesChanged: (next: NoteTemplate[]) => void;
  // When set, hides the Classroom|School-wide toggle and forces that scope.
  // Used by the BS Hub and MTSS Coordinator Hub to expose a school-wide-only
  // editor without bringing the entire teacher workflow with it.
  lockedScope?: "school" | "teacher";
  // Default polarity filter. The Manage Lists tab opens this editor pre-filtered
  // to "negative" so admins land directly on the negative-behavior list.
  initialFilter?: "all" | "positive" | "negative";
  // When true, the Note Templates section is omitted — used by Manage Lists,
  // which surfaces note templates as its own standalone sub-tab.
  hideTemplates?: boolean;
}) {
  const [viewScope, setViewScope] = useState<"school" | "teacher">(
    lockedScope ?? "teacher",
  );
  // Edit permission depends on which scope we're currently viewing:
  //   school view  → admin / behavior specialist / MTSS coordinator only
  //   teacher view → any signed-in staff (managing their own classroom rows)
  // PBIS coordinator is intentionally NOT in the school-edit allow-list.
  const canEdit =
    viewScope === "school"
      ? !!(
          me?.isSuperUser ||
          me?.isAdmin ||
          me?.isBehaviorSpecialist ||
          me?.isMtssCoordinator
        )
      : !!me; // any signed-in staff can manage their own teacher-scope rows

  // Local working copy so drag-reorders feel instant; we PATCH on drop.
  const [local, setLocal] = useState<Reason[]>(() =>
    [...reasons].sort(
      (a, b) =>
        a.category.localeCompare(b.category) || a.sortOrder - b.sortOrder,
    ),
  );
  useEffect(() => {
    setLocal(
      [...reasons].sort(
        (a, b) =>
          a.category.localeCompare(b.category) || a.sortOrder - b.sortOrder,
      ),
    );
  }, [reasons]);

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "positive" | "negative">(
    initialFilter,
  );
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<Reason | "new" | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // School setting toggle — fetched on mount, saved on change.
  const [settings, setSettings] = useState<SchoolSettings | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch("/api/school-settings");
        if (!res.ok) return;
        const json = (await res.json()) as SchoolSettings;
        if (!cancelled) setSettings(json);
      } catch {
        /* ignore — non-fatal for the editor */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggleNegativeAffectsTotal(next: boolean) {
    setSettings((s) => (s ? { ...s, pbisNegativeAffectsTotal: next } : s));
    try {
      const res = await authFetch("/api/school-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pbisNegativeAffectsTotal: next }),
      });
      if (!res.ok) throw new Error("Save failed");
      const json = (await res.json()) as SchoolSettings;
      setSettings(json);
    } catch {
      setSettings((s) =>
        s ? { ...s, pbisNegativeAffectsTotal: !next } : s,
      );
      setErr("Could not save setting. Try again.");
    }
  }

  // Draft value for the effectiveness-window input (kept separate so the user
  // can type freely; committed on blur / Enter). Synced when settings load.
  const [windowDraft, setWindowDraft] = useState<string>("");
  useEffect(() => {
    if (settings) setWindowDraft(String(settings.interventionEffectivenessDays));
  }, [settings?.interventionEffectivenessDays]);

  async function saveEffectivenessDays(raw: string) {
    if (!settings) return;
    const prev = settings.interventionEffectivenessDays;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 90) {
      setWindowDraft(String(prev));
      setErr("Effectiveness window must be a whole number of days (1–90).");
      return;
    }
    if (n === prev) return;
    setSettings((s) => (s ? { ...s, interventionEffectivenessDays: n } : s));
    try {
      const res = await authFetch("/api/school-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ interventionEffectivenessDays: n }),
      });
      if (!res.ok) throw new Error("Save failed");
      const json = (await res.json()) as SchoolSettings;
      setSettings(json);
      setErr(null);
    } catch {
      setSettings((s) =>
        s ? { ...s, interventionEffectivenessDays: prev } : s,
      );
      setWindowDraft(String(prev));
      setErr("Could not save setting. Try again.");
    }
  }

  // Apply scope + search + polarity + archive filter, group by category
  // preserving category order = first-seen order in the underlying list.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return local.filter((r) => {
      // Scope filter: in 'school' view only show school-wide rows; in
      // 'teacher' view only show rows the viewer owns.
      if (viewScope === "school") {
        if (r.ownerScope !== "school") return false;
      } else {
        if (r.ownerScope !== "teacher") return false;
        if (me && r.ownerStaffId !== me.id) return false;
      }
      if (!showArchived && !r.active) return false;
      if (filter !== "all" && r.polarity !== filter) return false;
      if (q && !r.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [local, search, filter, showArchived, viewScope, me]);

  const groups = useMemo(() => {
    const out: { category: string; items: Reason[] }[] = [];
    const idx = new Map<string, number>();
    for (const r of filtered) {
      let i = idx.get(r.category);
      if (i === undefined) {
        i = out.length;
        idx.set(r.category, i);
        out.push({ category: r.category, items: [] });
      }
      out[i].items.push(r);
    }
    return out;
  }, [filtered]);

  // ---- Drag & drop ----
  const dragRef = useRef<{ id: number; fromCategory: string } | null>(null);

  async function persistReorder(newLocal: Reason[]) {
    // Snapshot prior state so we can roll back the optimistic update if the
    // server rejects the reorder.
    const prevSnapshot = local;
    // Only reorder rows in the currently-visible scope. The local array can
    // hold rows from BOTH scopes (e.g. a teacher loads ?scope=all and sees
    // their own rows while school rows are filtered out of the UI). Including
    // hidden-scope rows in the reorder payload would (a) trigger 403s in
    // teacher scope because they can't write school rows, and (b) silently
    // renumber hidden rows in admin school-scope view. Filter strictly.
    const isInScope = (r: Reason) =>
      viewScope === "school"
        ? r.ownerScope === "school"
        : r.ownerScope === "teacher" && r.ownerStaffId === me?.id;
    // Recompute sortOrder per category from the new local order, but only for
    // rows in the visible scope.
    const byCat = new Map<string, Reason[]>();
    for (const r of newLocal) {
      if (!isInScope(r)) continue;
      const arr = byCat.get(r.category) ?? [];
      arr.push(r);
      byCat.set(r.category, arr);
    }
    const items: { id: number; sortOrder: number; category: string }[] = [];
    for (const [cat, arr] of byCat) {
      arr.forEach((r, i) => {
        items.push({ id: r.id, sortOrder: i, category: cat });
      });
    }
    // Update local with the canonical sortOrders. Hidden-scope rows are NOT
    // in `items` (we filtered them out above), so leave those rows unchanged
    // — using a non-null assertion here would crash when the visible list is
    // a strict subset of `local`.
    const itemsById = new Map(items.map((it) => [it.id, it]));
    const updated = newLocal.map((r) => {
      const m = itemsById.get(r.id);
      return m ? { ...r, sortOrder: m.sortOrder, category: m.category } : r;
    });
    setLocal(updated);
    onReasonsChanged(updated);
    try {
      const res = await authFetch("/api/pbis-reasons/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
      if (!res.ok) throw new Error("Reorder failed");
    } catch {
      // Roll back so the visible order matches what's actually stored.
      setLocal(prevSnapshot);
      onReasonsChanged(prevSnapshot);
      setErr("Reorder didn't save — your previous order has been restored.");
    }
  }

  function handleDragStart(r: Reason) {
    dragRef.current = { id: r.id, fromCategory: r.category };
  }
  function handleDragOver(e: React.DragEvent) {
    if (dragRef.current) e.preventDefault();
  }
  function handleDropOnTile(target: Reason) {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || drag.id === target.id) return;
    const next = [...local];
    const fromIdx = next.findIndex((r) => r.id === drag.id);
    if (fromIdx === -1) return;
    const [moved] = next.splice(fromIdx, 1);
    moved.category = target.category; // moving across categories is allowed
    const toIdx = next.findIndex((r) => r.id === target.id);
    next.splice(toIdx, 0, moved);
    persistReorder(next);
  }
  function handleDropOnCategory(cat: string) {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    const next = [...local];
    const fromIdx = next.findIndex((r) => r.id === drag.id);
    if (fromIdx === -1) return;
    const [moved] = next.splice(fromIdx, 1);
    moved.category = cat;
    // Place at the end of the destination category.
    let lastIdx = -1;
    next.forEach((r, i) => {
      if (r.category === cat) lastIdx = i;
    });
    next.splice(lastIdx + 1, 0, moved);
    persistReorder(next);
  }

  async function saveBehavior(payload: {
    id?: number;
    name: string;
    category: string;
    defaultPoints: number;
    polarity: "positive" | "negative";
    active?: boolean;
  }) {
    setSaving(true);
    setErr(null);
    try {
      const isNew = !payload.id;
      const url = isNew
        ? "/api/pbis-reasons"
        : `/api/pbis-reasons/${payload.id}`;
      const res = await authFetch(url, {
        method: isNew ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: payload.name,
          category: payload.category,
          defaultPoints: payload.defaultPoints,
          polarity: payload.polarity,
          ...(payload.active !== undefined ? { active: payload.active } : {}),
          // Only POST cares about scope; PATCH ignores it server-side.
          ...(isNew ? { scope: viewScope } : {}),
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || "Save failed");
      }
      const row = (await res.json()) as Reason;
      let next: Reason[];
      if (isNew) {
        next = [...local, row];
      } else {
        next = local.map((r) => (r.id === row.id ? row : r));
      }
      next.sort(
        (a, b) =>
          a.category.localeCompare(b.category) || a.sortOrder - b.sortOrder,
      );
      setLocal(next);
      onReasonsChanged(next);
      setEditing(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      {/* Scope toggle — hidden when locked from a parent (e.g. BS Hub) */}
      {!lockedScope && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.6rem",
            marginBottom: "0.85rem",
          }}
        >
          <Segmented
            value={viewScope}
            onChange={(v) => setViewScope(v as "school" | "teacher")}
            options={[
              { value: "teacher", label: "My classroom" },
              { value: "school", label: "School-wide" },
            ]}
          />
          <span style={{ fontSize: "0.78rem", color: "#64748b" }}>
            {viewScope === "school"
              ? "Used by every teacher in the school."
              : "Only you see and edit these."}
          </span>
        </div>
      )}

      {/* Header bar */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "0.6rem",
          marginBottom: "1rem",
        }}
      >
        <input
          type="search"
          placeholder="Search behaviors…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            flex: "1 1 16rem",
            padding: "0.55rem 0.8rem",
            border: "1px solid #cbd5e1",
            borderRadius: "0.4rem",
            fontSize: "0.95rem",
          }}
        />
        <Segmented
          value={filter}
          onChange={(v) => setFilter(v as typeof filter)}
          options={[
            { value: "all", label: "All" },
            { value: "positive", label: "Positive" },
            { value: "negative", label: "Negative" },
          ]}
        />
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.4rem",
            fontSize: "0.85rem",
            color: "#475569",
          }}
        >
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          Show archived
        </label>
        {canEdit && (
          <button
            type="button"
            onClick={() => setEditing("new")}
            style={{
              background: "#0e7490",
              color: "white",
              border: "none",
              padding: "0.55rem 1rem",
              borderRadius: "0.4rem",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            + New Behavior
          </button>
        )}
      </div>

      {/* Negative-points policy toggle */}
      {settings && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "1rem",
            padding: "0.85rem 1rem",
            background: "#fff7ed",
            border: "1px solid #fed7aa",
            borderRadius: "0.5rem",
            marginBottom: "1rem",
          }}
        >
          <div>
            <div style={{ fontWeight: 600, color: "#9a3412" }}>
              Negative behavior policy
            </div>
            <div style={{ fontSize: "0.85rem", color: "#9a3412" }}>
              {settings.pbisNegativeAffectsTotal
                ? "Awarding a negative behavior subtracts its points from the student's total."
                : "Negative behaviors are logged on the student's record only — no impact on their point total."}
            </div>
          </div>
          {canEdit && (
            <ToggleSwitch
              checked={settings.pbisNegativeAffectsTotal}
              onChange={toggleNegativeAffectsTotal}
              label="Subtract from total"
            />
          )}
        </div>
      )}

      {/* Intervention effectiveness window */}
      {settings && (
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: "1rem",
            padding: "0.85rem 1rem",
            background: "#eff6ff",
            border: "1px solid #bfdbfe",
            borderRadius: "0.5rem",
            marginBottom: "1rem",
          }}
        >
          <div style={{ maxWidth: "42rem" }}>
            <div style={{ fontWeight: 600, color: "#1e3a8a" }}>
              Intervention effectiveness window
            </div>
            <div
              style={{
                fontSize: "0.85rem",
                color: "#1e40af",
                marginTop: "0.2rem",
                lineHeight: 1.45,
              }}
            >
              When a teacher logs an intervention for a negative behavior,
              PulseEDU automatically grades whether it{" "}
              <strong>worked</strong>. If the same behavior does{" "}
              <strong>not</strong> happen again for that student within this many
              days, the intervention is marked <strong>Worked&nbsp;✓</strong>. If
              the behavior comes back inside the window, it is marked{" "}
              <strong>Recurred&nbsp;↻</strong>. While the window is still open it
              shows as <strong>Pending</strong>. Teachers never grade this by
              hand — these outcomes appear on the per-student Classroom
              Intervention Report and as the “what’s worked before” badges shown
              while logging.
              <br />
              <em>
                Shorter windows (e.g. 7 days) judge interventions faster but are
                stricter; longer windows (e.g. 21–30 days) give an intervention
                more time to prove it stuck. 14 days is the default.
              </em>
            </div>
          </div>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.4rem",
              whiteSpace: "nowrap",
              color: "#1e3a8a",
              fontWeight: 600,
              fontSize: "0.9rem",
            }}
          >
            <input
              type="number"
              min={1}
              max={90}
              step={1}
              value={windowDraft}
              disabled={!canEdit}
              onChange={(e) => setWindowDraft(e.target.value)}
              onBlur={(e) => saveEffectivenessDays(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  (e.target as HTMLInputElement).blur();
                }
              }}
              style={{
                width: "4.5rem",
                padding: "0.4rem 0.5rem",
                border: "1px solid #93c5fd",
                borderRadius: "0.4rem",
                fontSize: "0.95rem",
                textAlign: "center",
                background: canEdit ? "#fff" : "#f1f5f9",
              }}
            />
            days
          </label>
        </div>
      )}

      {err && (
        <div
          style={{
            padding: "0.6rem 0.8rem",
            background: "#fee2e2",
            color: "#991b1b",
            borderRadius: "0.4rem",
            marginBottom: "0.8rem",
            fontSize: "0.88rem",
          }}
        >
          {err}
        </div>
      )}

      {/* Category groups */}
      {groups.length === 0 ? (
        <div
          style={{
            padding: "2rem",
            textAlign: "center",
            color: "#64748b",
            border: "1px dashed #cbd5e1",
            borderRadius: "0.5rem",
          }}
        >
          No behaviors match your filters yet.
        </div>
      ) : (
        groups.map((g, gi) => (
          <div
            key={g.category}
            onDragOver={handleDragOver}
            onDrop={() => handleDropOnCategory(g.category)}
            style={{
              border: "1px solid #e2e8f0",
              borderRadius: "0.6rem",
              padding: "1rem",
              marginBottom: "0.85rem",
              background: "white",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: "0.7rem",
              }}
            >
              <div
                style={{
                  fontSize: "1.05rem",
                  fontWeight: 700,
                  color: "#0f172a",
                }}
              >
                {gi + 1}. {g.category}
              </div>
              <div
                style={{ fontSize: "0.8rem", color: "#94a3b8" }}
              >
                Drag tiles to reorder
              </div>
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
                gap: "0.6rem",
              }}
            >
              {g.items.map((r) => (
                <BehaviorTile
                  key={r.id}
                  reason={r}
                  canEdit={canEdit}
                  onEdit={() => setEditing(r)}
                  onDragStart={() => handleDragStart(r)}
                  onDrop={() => handleDropOnTile(r)}
                  onDragOver={handleDragOver}
                />
              ))}
            </div>
          </div>
        ))
      )}

      {!hideTemplates && (
        <>
          {/* Visual separator between behaviors and templates */}
          <hr
            style={{
              border: 0,
              borderTop: "1px solid #e2e8f0",
              margin: "1.5rem 0 1.25rem",
            }}
          />

          {/* Note Templates — share the same scope as the rubric above */}
          <NoteTemplatesSection
            me={me}
            canEdit={canEdit}
            templates={templates}
            onTemplatesChanged={onTemplatesChanged}
            onError={setErr}
            scope={viewScope}
          />
        </>
      )}

      {editing && canEdit && (
        <BehaviorEditModal
          reason={editing === "new" ? null : editing}
          existingCategories={Array.from(
            new Set(local.map((r) => r.category)),
          )}
          onClose={() => setEditing(null)}
          onSave={saveBehavior}
          saving={saving}
        />
      )}
    </div>
  );
}

// =============================================================================
// ManageListsView — admin-only tab grouping the three editable list surfaces:
// negative classroom behaviors, the intervention list, and pullout reasons.
// Each is rendered behind a sub-tab so the top tab bar stays tidy.
// =============================================================================
export function ManageListsView() {
  const [me, setMe] = useState<Me | null>(null);
  const [reasons, setReasons] = useState<Reason[]>([]);
  const [templates, setTemplates] = useState<NoteTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Non-fatal error channel for the Note Templates sub-tab. Kept separate from
  // errorMsg (which gates the whole tile into a blocking panel) so a failed
  // template save/delete shows inline and the tabs stay usable.
  const [templateErr, setTemplateErr] = useState<string | null>(null);
  const [subTab, setSubTab] = useState<
    "behaviors" | "templates" | "interventions" | "pullouts"
  >("behaviors");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErrorMsg(null);
      try {
        const [meRes, reasonsRes, tplRes] = await Promise.all([
          authFetch("/api/auth/me"),
          authFetch("/api/pbis-reasons?scope=school"),
          authFetch("/api/pbis-note-templates?scope=school"),
        ]);
        if (!meRes.ok) throw new Error("Failed to load your account");
        if (!reasonsRes.ok) throw new Error("Failed to load PBIS reasons");
        if (cancelled) return;
        setMe((await meRes.json()) as Me);
        setReasons((await reasonsRes.json()) as Reason[]);
        if (tplRes.ok) {
          setTemplates((await tplRes.json()) as NoteTemplate[]);
        }
      } catch (err) {
        if (!cancelled) {
          setErrorMsg(err instanceof Error ? err.message : "Failed to load");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const SUBTABS: {
    key: "behaviors" | "templates" | "interventions" | "pullouts";
    label: string;
  }[] = [
    { key: "behaviors", label: "Negative Behaviors" },
    { key: "templates", label: "Note Templates" },
    { key: "interventions", label: "Interventions" },
    { key: "pullouts", label: "Pullout Reasons" },
  ];

  // School-scope edit gate — mirrors SettingsView's school-view canEdit
  // (admin / BS / MTSS). Note templates here are always school-scoped.
  const canEditTemplates = !!(
    me?.isSuperUser ||
    me?.isAdmin ||
    me?.isBehaviorSpecialist ||
    me?.isMtssCoordinator
  );

  if (loading) {
    return (
      <div style={{ padding: "2rem", textAlign: "center", color: "#64748b" }}>
        Loading…
      </div>
    );
  }
  if (errorMsg) {
    return (
      <div
        style={{
          padding: "1rem",
          background: "#fee2e2",
          color: "#991b1b",
          borderRadius: "0.4rem",
        }}
      >
        {errorMsg}
      </div>
    );
  }

  return (
    <div>
      <div
        style={{
          display: "flex",
          gap: "0.4rem",
          flexWrap: "wrap",
          marginBottom: "1rem",
        }}
      >
        {SUBTABS.map(({ key, label }) => {
          const active = key === subTab;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setSubTab(key)}
              style={{
                padding: "0.45rem 0.9rem",
                borderRadius: "999px",
                border: active ? "1px solid #0e7490" : "1px solid #cbd5e1",
                background: active ? "#0e7490" : "white",
                color: active ? "white" : "#475569",
                fontSize: "0.9rem",
                fontWeight: active ? 600 : 500,
                cursor: "pointer",
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      {subTab === "behaviors" ? (
        <SettingsView
          me={me}
          reasons={reasons}
          onReasonsChanged={setReasons}
          templates={templates}
          onTemplatesChanged={setTemplates}
          lockedScope="school"
          initialFilter="negative"
          hideTemplates
        />
      ) : subTab === "templates" ? (
        <>
          {templateErr && (
            <div
              style={{
                padding: "0.7rem 0.9rem",
                marginBottom: "0.85rem",
                background: "#fee2e2",
                color: "#991b1b",
                borderRadius: "0.4rem",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "0.6rem",
              }}
            >
              <span>{templateErr}</span>
              <button
                type="button"
                onClick={() => setTemplateErr(null)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "#991b1b",
                  cursor: "pointer",
                  fontWeight: 700,
                  fontSize: "1rem",
                  lineHeight: 1,
                }}
                aria-label="Dismiss error"
              >
                ×
              </button>
            </div>
          )}
          <NoteTemplatesSection
            me={me}
            canEdit={canEditTemplates}
            templates={templates}
            onTemplatesChanged={setTemplates}
            onError={setTemplateErr}
            scope="school"
          />
        </>
      ) : subTab === "interventions" ? (
        <InterventionTypesAdmin />
      ) : (
        <PulloutReasonsAdmin />
      )}
    </div>
  );
}

function BehaviorTile({
  reason,
  canEdit,
  onEdit,
  onDragStart,
  onDrop,
  onDragOver,
}: {
  reason: Reason;
  canEdit: boolean;
  onEdit: () => void;
  onDragStart: () => void;
  onDrop: () => void;
  onDragOver: (e: React.DragEvent) => void;
}) {
  const isNeg = reason.polarity === "negative";
  const accent = isNeg ? "#dc2626" : "#16a34a";
  const tint = isNeg ? "#fef2f2" : "#f0fdf4";
  return (
    <div
      draggable={canEdit}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={(e) => {
        e.stopPropagation();
        onDrop();
      }}
      onClick={canEdit ? onEdit : undefined}
      style={{
        position: "relative",
        border: `1px solid ${isNeg ? "#fecaca" : "#bbf7d0"}`,
        background: tint,
        borderRadius: "0.5rem",
        padding: "0.7rem 0.7rem 0.6rem 0.7rem",
        cursor: canEdit ? "grab" : "default",
        opacity: reason.active ? 1 : 0.55,
        textAlign: "center",
        userSelect: "none",
      }}
      title={canEdit ? "Drag to reorder, click to edit" : reason.name}
    >
      <div
        style={{
          position: "absolute",
          top: "0.4rem",
          right: "0.5rem",
          width: "1.4rem",
          height: "1.4rem",
          borderRadius: "999px",
          background: accent,
          color: "white",
          fontWeight: 700,
          fontSize: "0.95rem",
          lineHeight: "1.4rem",
        }}
      >
        {isNeg ? "−" : "+"}
      </div>
      {reason.ownerScope === "school" && (
        <div
          style={{
            position: "absolute",
            top: "0.4rem",
            left: "0.45rem",
            background: "#1e3a8a",
            color: "white",
            fontSize: "0.6rem",
            fontWeight: 700,
            letterSpacing: "0.04em",
            padding: "1px 5px",
            borderRadius: "3px",
            textTransform: "uppercase",
          }}
        >
          School
        </div>
      )}
      <div
        style={{
          fontWeight: 600,
          color: "#0f172a",
          fontSize: "0.92rem",
          minHeight: "2.4rem",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "0 1.2rem",
        }}
      >
        {reason.name}
      </div>
      <div
        style={{
          marginTop: "0.4rem",
          fontSize: "0.8rem",
          color: accent,
          fontWeight: 600,
        }}
      >
        {reason.defaultPoints} {reason.defaultPoints === 1 ? "point" : "points"}
      </div>
      {!reason.active && (
        <div
          style={{
            marginTop: "0.2rem",
            fontSize: "0.7rem",
            color: "#64748b",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          Archived
        </div>
      )}
    </div>
  );
}

function Segmented({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        background: "#f1f5f9",
        borderRadius: "0.4rem",
        padding: "2px",
      }}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            style={{
              padding: "0.4rem 0.85rem",
              border: "none",
              background: active ? "white" : "transparent",
              color: active ? "#0f172a" : "#64748b",
              fontWeight: active ? 600 : 500,
              fontSize: "0.85rem",
              borderRadius: "0.3rem",
              cursor: "pointer",
              boxShadow: active ? "0 1px 2px rgba(15,23,42,0.08)" : "none",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function ToggleSwitch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}) {
  return (
    <label
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.5rem",
        cursor: "pointer",
        fontSize: "0.85rem",
        color: "#9a3412",
        fontWeight: 600,
      }}
    >
      <span>{label}</span>
      <span
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        style={{
          width: "2.4rem",
          height: "1.3rem",
          background: checked ? "#16a34a" : "#cbd5e1",
          borderRadius: "999px",
          position: "relative",
          transition: "background 0.15s",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: "2px",
            left: checked ? "calc(100% - 1.1rem - 2px)" : "2px",
            width: "1.1rem",
            height: "1.1rem",
            background: "white",
            borderRadius: "999px",
            transition: "left 0.15s",
            boxShadow: "0 1px 2px rgba(15,23,42,0.2)",
          }}
        />
      </span>
    </label>
  );
}

function BehaviorEditModal({
  reason,
  existingCategories,
  onClose,
  onSave,
  saving,
}: {
  reason: Reason | null;
  existingCategories: string[];
  onClose: () => void;
  onSave: (p: {
    id?: number;
    name: string;
    category: string;
    defaultPoints: number;
    polarity: "positive" | "negative";
    active?: boolean;
  }) => void;
  saving: boolean;
}) {
  const [name, setName] = useState(reason?.name ?? "");
  const [category, setCategory] = useState(
    reason?.category ?? existingCategories[0] ?? "General",
  );
  const [newCat, setNewCat] = useState("");
  const [points, setPoints] = useState<number>(reason?.defaultPoints ?? 1);
  const [polarity, setPolarity] = useState<"positive" | "negative">(
    reason?.polarity ?? "positive",
  );
  const [active, setActive] = useState<boolean>(reason?.active ?? true);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const finalCategory = newCat.trim() || category;
  const valid =
    name.trim().length > 0 && Number.isInteger(points) && points >= 1;

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 200,
        padding: "1rem",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "white",
          borderRadius: "0.6rem",
          padding: "1.25rem",
          maxWidth: "26rem",
          width: "100%",
          boxShadow: "0 25px 50px -12px rgba(0,0,0,0.25)",
        }}
      >
        <div
          style={{
            fontSize: "1.1rem",
            fontWeight: 700,
            color: "#0f172a",
            marginBottom: "0.9rem",
          }}
        >
          {reason ? "Edit Behavior" : "New Behavior"}
        </div>

        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            style={inputStyle}
          />
        </Field>

        <Field label="Category">
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            style={inputStyle}
          >
            {existingCategories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
            {existingCategories.length === 0 && (
              <option value="General">General</option>
            )}
          </select>
          <input
            value={newCat}
            onChange={(e) => setNewCat(e.target.value)}
            placeholder="…or type a new category"
            style={{ ...inputStyle, marginTop: "0.4rem" }}
          />
        </Field>

        <Field label="Points">
          <input
            type="number"
            min={1}
            step={1}
            value={points}
            onChange={(e) => setPoints(Math.floor(Number(e.target.value) || 0))}
            style={{
              ...inputStyle,
              borderColor: points >= 1 ? "#cbd5e1" : "#dc2626",
            }}
          />
        </Field>

        <Field label="Type">
          <Segmented
            value={polarity}
            onChange={(v) => setPolarity(v as typeof polarity)}
            options={[
              { value: "positive", label: "Positive (+)" },
              { value: "negative", label: "Negative (−)" },
            ]}
          />
        </Field>

        {reason && (
          <Field label="Status">
            <Segmented
              value={active ? "active" : "archived"}
              onChange={(v) => setActive(v === "active")}
              options={[
                { value: "active", label: "Active" },
                { value: "archived", label: "Archived" },
              ]}
            />
          </Field>
        )}

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "0.5rem",
            marginTop: "1rem",
          }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            style={{
              padding: "0.55rem 1rem",
              background: "white",
              border: "1px solid #cbd5e1",
              borderRadius: "0.4rem",
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!valid || saving}
            onClick={() =>
              onSave({
                id: reason?.id,
                name: name.trim(),
                category: finalCategory,
                defaultPoints: points,
                polarity,
                active: reason ? active : undefined,
              })
            }
            style={{
              padding: "0.55rem 1.1rem",
              background: !valid || saving ? "#94a3b8" : "#0e7490",
              color: "white",
              border: "none",
              borderRadius: "0.4rem",
              fontWeight: 600,
              cursor: !valid || saving ? "not-allowed" : "pointer",
            }}
          >
            {saving ? "Saving…" : reason ? "Save changes" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: "0.7rem" }}>
      <div
        style={{
          fontSize: "0.78rem",
          fontWeight: 600,
          color: "#475569",
          marginBottom: "0.25rem",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.55rem 0.7rem",
  border: "1px solid #cbd5e1",
  borderRadius: "0.4rem",
  fontSize: "0.95rem",
  boxSizing: "border-box",
};

// Small visual tag used in the merged award picker so a teacher can tell
// at a glance which behaviors come from the school-wide rubric vs. their own.
function SchoolTag() {
  return (
    <span
      style={{
        marginLeft: "0.4rem",
        background: "#1e3a8a",
        color: "white",
        fontSize: "0.6rem",
        fontWeight: 700,
        letterSpacing: "0.04em",
        padding: "1px 5px",
        borderRadius: "3px",
        textTransform: "uppercase",
        verticalAlign: "middle",
      }}
    >
      School
    </span>
  );
}

// =============================================================================
// SchoolWidePbisAdminView
// =============================================================================
// Standalone editor for the school-wide rubric and note templates. Used by
// the BS Hub and MTSS Coordinator Hub so those roles get the same editor
// without having to navigate into PBIS Points → Settings.
// =============================================================================
export function SchoolWidePbisAdminView() {
  const [me, setMe] = useState<Me | null>(null);
  const [reasons, setReasons] = useState<Reason[]>([]);
  const [templates, setTemplates] = useState<NoteTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErrorMsg(null);
      try {
        const [meRes, reasonsRes, tplRes] = await Promise.all([
          authFetch("/api/auth/me"),
          authFetch("/api/pbis-reasons?scope=school"),
          authFetch("/api/pbis-note-templates?scope=school"),
        ]);
        if (!meRes.ok) throw new Error("Failed to load your account");
        if (!reasonsRes.ok) throw new Error("Failed to load PBIS reasons");
        if (cancelled) return;
        setMe((await meRes.json()) as Me);
        setReasons((await reasonsRes.json()) as Reason[]);
        if (tplRes.ok) {
          setTemplates((await tplRes.json()) as NoteTemplate[]);
        }
      } catch (err) {
        if (!cancelled) {
          setErrorMsg(err instanceof Error ? err.message : "Failed to load");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="card">
      <div className="section-header-bar-teal" />
      <div className="section-header-band-hub">
        <h2
          style={{
            margin: 0,
            color: "white",
            fontSize: "1.5rem",
            fontWeight: 700,
          }}
        >
          School-wide PBIS
        </h2>
        <div
          style={{
            color: "rgba(255,255,255,0.85)",
            fontSize: "0.85rem",
            marginTop: "0.15rem",
          }}
        >
          Behaviors and note templates available to every teacher in the school.
        </div>
      </div>
      <div style={{ padding: "1rem" }}>
        {loading ? (
          <div style={{ padding: "2rem", textAlign: "center", color: "#64748b" }}>
            Loading…
          </div>
        ) : errorMsg ? (
          <div
            style={{
              padding: "1rem",
              background: "#fee2e2",
              color: "#991b1b",
              borderRadius: "0.4rem",
            }}
          >
            {errorMsg}
          </div>
        ) : (
          <SettingsView
            me={me}
            reasons={reasons}
            onReasonsChanged={setReasons}
            templates={templates}
            onTemplatesChanged={setTemplates}
            lockedScope="school"
          />
        )}
      </div>
    </section>
  );
}

// AuthImage — fetches a private object via authFetch (so it can attach the
// bearer token), then renders the bytes via a blob: object URL. Plain
// `<img src="/api/...">` won't work for our private endpoints because
// browsers can't attach Authorization headers to image requests.
function AuthImage({
  src,
  alt,
  style,
}: {
  src: string;
  alt: string;
  style?: React.CSSProperties;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | null = null;
    setFailed(false);
    setUrl(null);
    (async () => {
      try {
        const res = await authFetch(src);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (cancelled) return;
        createdUrl = URL.createObjectURL(blob);
        setUrl(createdUrl);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [src]);

  if (failed) {
    return (
      <span aria-hidden="true" style={{ fontSize: "2.5rem" }}>
        🎁
      </span>
    );
  }
  if (!url) {
    return (
      <span aria-hidden="true" style={{ fontSize: "1rem", color: "#94a3b8" }}>
        …
      </span>
    );
  }
  return <img src={url} alt={alt} style={style} />;
}

// =============================================================================
// StoreView — generic catalog UI shared by the per-teacher Classroom Store
// and the school-wide School Store. The two only differ in:
//   • API path (/api/classroom-store vs /api/school-store)
//   • Header label, icon, gradient
//   • Empty-state copy
//   • Whether the current user can add/edit/delete items
// Everything else (card layout, modal flow, image upload) is identical.
// =============================================================================

type StoreConfig = {
  apiPath: string; // e.g. "/api/classroom-store"
  headerIcon: string; // emoji
  headerTitle: string;
  headerSubtitle: string;
  headerGradient: string; // CSS gradient
  headerShadow: string; // CSS box-shadow color
  emptyTitle: string;
  emptyHint: string;
};

function StoreView({
  config,
  canEdit,
}: {
  config: StoreConfig;
  canEdit: boolean;
}) {
  const [items, setItems] = useState<StoreItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<StoreItem | "new" | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch(config.apiPath);
        if (!res.ok) throw new Error("Failed to load store");
        const data = (await res.json()) as StoreItem[];
        if (!cancelled) setItems(data);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : "Load failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config.apiPath]);

  async function handleDelete(item: StoreItem) {
    if (
      !confirm(
        `Delete "${item.name}"? Students will no longer be able to redeem this item.`,
      )
    ) {
      return;
    }
    try {
      const res = await authFetch(`${config.apiPath}/${item.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Delete failed");
      setItems((prev) => prev.filter((x) => x.id !== item.id));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
    }
  }

  return (
    <div>
      {/* Gradient header */}
      <div
        style={{
          background: config.headerGradient,
          color: "white",
          padding: "1.4rem 1.6rem",
          borderRadius: "0.7rem",
          marginBottom: "1.25rem",
          display: "flex",
          alignItems: "center",
          gap: "1rem",
          boxShadow: `0 4px 14px ${config.headerShadow}`,
        }}
      >
        <div style={{ fontSize: "2.1rem", lineHeight: 1 }}>
          {config.headerIcon}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: "1.55rem", fontWeight: 700 }}>
            {config.headerTitle}
          </div>
          <div style={{ fontSize: "0.92rem", opacity: 0.92, marginTop: 2 }}>
            {config.headerSubtitle}
          </div>
        </div>
        {canEdit && (
          <button
            type="button"
            onClick={() => setEditing("new")}
            style={{
              padding: "0.55rem 1rem",
              background: "white",
              color: "#0e7490",
              border: "none",
              borderRadius: "0.4rem",
              fontWeight: 700,
              cursor: "pointer",
              whiteSpace: "nowrap",
              boxShadow: "0 1px 3px rgba(0,0,0,0.15)",
            }}
          >
            + Add item
          </button>
        )}
      </div>

      {err && (
        <div
          style={{
            marginBottom: "1rem",
            padding: "0.6rem 0.8rem",
            background: "#fee2e2",
            color: "#991b1b",
            borderRadius: "0.4rem",
            fontSize: "0.9rem",
          }}
        >
          {err}
        </div>
      )}

      {loading ? (
        <div style={{ color: "#64748b", padding: "1.5rem 0" }}>
          Loading store…
        </div>
      ) : items.length === 0 ? (
        <div
          style={{
            padding: "2.5rem 1rem",
            textAlign: "center",
            background: "#f8fafc",
            border: "1px dashed #cbd5e1",
            borderRadius: "0.6rem",
            color: "#64748b",
          }}
        >
          <div style={{ fontSize: "2.5rem", marginBottom: "0.5rem" }}>
            {config.headerIcon}
          </div>
          <div
            style={{
              fontSize: "1.05rem",
              color: "#334155",
              fontWeight: 600,
              marginBottom: "0.25rem",
            }}
          >
            {config.emptyTitle}
          </div>
          <div style={{ fontSize: "0.9rem" }}>{config.emptyHint}</div>
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
            gap: "1rem",
          }}
        >
          {items.map((item) => (
            <StoreItemCard
              key={item.id}
              item={item}
              canEdit={canEdit}
              onEdit={() => setEditing(item)}
              onDelete={() => handleDelete(item)}
            />
          ))}
        </div>
      )}

      {editing && (
        <StoreItemModal
          apiPath={config.apiPath}
          existing={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(saved, mode) => {
            setItems((prev) => {
              if (mode === "create") return [...prev, saved];
              return prev.map((x) => (x.id === saved.id ? saved : x));
            });
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

// Per-teacher Classroom Store: each staffer manages their own catalog. Any
// signed-in staffer can add to their own list (server enforces ownership).
function ClassroomStoreView() {
  return (
    <StoreView
      config={{
        apiPath: "/api/classroom-store",
        headerIcon: "🎁",
        headerTitle: "Classroom Store",
        headerSubtitle:
          "Build a list of rewards your students can redeem with their PBIS points.",
        headerGradient:
          "var(--brand-header-bg)",
        headerShadow: "rgba(14, 116, 144, 0.18)",
        emptyTitle: "Your store is empty",
        emptyHint: 'Click "+ Add item" to add your first reward.',
      }}
      canEdit
    />
  );
}

// School-wide School Store: shared catalog visible to all staff in the
// school. Writes are gated to admin / Behavior Specialist / MTSS
// Coordinator / PBIS Coordinator (server enforces this too). Exported so
// it can be embedded in the BS hub, MTSS hub, and a top-level read-only
// sidebar entry — see App.tsx.
export function SchoolStoreView({ canEdit }: { canEdit: boolean }) {
  return (
    <StoreView
      config={{
        apiPath: "/api/school-store",
        headerIcon: "🏫",
        headerTitle: "School Store",
        headerSubtitle: canEdit
          ? "Set up rewards available school-wide that any student can redeem."
          : "Browse the school-wide rewards catalog. Only admins can edit items.",
        headerGradient:
          "var(--brand-header-bg)",
        headerShadow: "rgba(30, 58, 138, 0.22)",
        emptyTitle: canEdit
          ? "The school store is empty"
          : "No school-wide rewards yet",
        emptyHint: canEdit
          ? 'Click "+ Add item" to add the first school-wide reward.'
          : "Check back later — your admin hasn't added any items yet.",
      }}
      canEdit={canEdit}
    />
  );
}

function StoreItemCard({
  item,
  canEdit,
  onEdit,
  onDelete,
}: {
  item: StoreItem;
  canEdit: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      style={{
        border: "1px solid #e2e8f0",
        borderRadius: "0.55rem",
        background: "white",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        boxShadow: "0 1px 2px rgba(15, 23, 42, 0.04)",
      }}
    >
      <div
        style={{
          aspectRatio: "1 / 1",
          background:
            "linear-gradient(135deg, #ecfeff 0%, #ede9fe 50%, #fdf4ff 100%)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "3.5rem",
          color: "#0e7490",
        }}
      >
        {item.imageUrl ? (
          <AuthImage
            src={`/api/storage${item.imageUrl}`}
            alt={item.name}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              display: "block",
            }}
          />
        ) : (
          <span aria-hidden="true">🎁</span>
        )}
      </div>
      <div
        style={{
          padding: "0.7rem 0.85rem",
          display: "flex",
          flexDirection: "column",
          flex: 1,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "0.4rem",
          }}
        >
          <div
            style={{
              fontWeight: 600,
              color: "#0f172a",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={item.name}
          >
            {item.name}
          </div>
          <div
            style={{
              padding: "0.15rem 0.5rem",
              background: "#0e7490",
              color: "white",
              borderRadius: "9999px",
              fontSize: "0.78rem",
              fontWeight: 700,
              whiteSpace: "nowrap",
            }}
          >
            {item.pointsCost} pt{item.pointsCost === 1 ? "" : "s"}
          </div>
        </div>
        {item.description && (
          <div
            style={{
              fontSize: "0.83rem",
              color: "#475569",
              marginTop: "0.35rem",
              display: "-webkit-box",
              WebkitLineClamp: 3,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
            title={item.description}
          >
            {item.description}
          </div>
        )}
        {canEdit && (
          <div
            style={{
              display: "flex",
              gap: "0.4rem",
              marginTop: "auto",
              paddingTop: "0.65rem",
            }}
          >
            <button
              type="button"
              onClick={onEdit}
              style={{
                flex: 1,
                padding: "0.35rem 0.5rem",
                border: "1px solid #cbd5e1",
                background: "white",
                color: "#0e7490",
                borderRadius: "0.3rem",
                fontSize: "0.8rem",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Edit
            </button>
            <button
              type="button"
              onClick={onDelete}
              style={{
                padding: "0.35rem 0.55rem",
                border: "1px solid #fecaca",
                background: "white",
                color: "#dc2626",
                borderRadius: "0.3rem",
                fontSize: "0.8rem",
                fontWeight: 600,
                cursor: "pointer",
              }}
              aria-label={`Delete ${item.name}`}
            >
              Delete
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function StoreItemModal({
  apiPath,
  existing,
  onClose,
  onSaved,
}: {
  apiPath: string; // e.g. "/api/classroom-store" or "/api/school-store"
  existing: StoreItem | null;
  onClose: () => void;
  onSaved: (saved: StoreItem, mode: "create" | "update") => void;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [pointsCost, setPointsCost] = useState<number>(
    existing?.pointsCost ?? 5,
  );
  const [imageUrl, setImageUrl] = useState<string | null>(
    existing?.imageUrl ?? null,
  );
  // Local preview URL (a `blob:` URL) for the file the user just picked,
  // shown immediately while we upload to storage in the background. Avoids
  // a server round-trip (and any GCS eventual-consistency lag) for preview.
  const [localPreviewUrl, setLocalPreviewUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Revoke any blob URL when it's replaced or when the modal unmounts so we
  // don't leak browser memory.
  useEffect(() => {
    return () => {
      if (localPreviewUrl) URL.revokeObjectURL(localPreviewUrl);
    };
  }, [localPreviewUrl]);

  async function handleFile(file: File) {
    if (!file.type.startsWith("image/")) {
      setErr("Please choose an image file.");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setErr("Image must be under 8 MB.");
      return;
    }
    setErr(null);
    // Show the picked file immediately as a blob preview. The setter's
    // cleanup effect will revoke the previous URL automatically.
    setLocalPreviewUrl(URL.createObjectURL(file));
    setUploading(true);
    try {
      // Step 1: ask the server for a presigned PUT URL.
      const reqRes = await authFetch("/api/storage/uploads/request-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: file.name,
          size: file.size,
          contentType: file.type,
        }),
      });
      if (!reqRes.ok) throw new Error("Could not start upload");
      const { uploadURL, objectPath } = (await reqRes.json()) as {
        uploadURL: string;
        objectPath: string;
      };
      // Step 2: PUT the file bytes directly to GCS — bypass authFetch so we
      // don't accidentally attach the session cookie / auth header to a
      // third-party origin.
      const putRes = await fetch(uploadURL, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!putRes.ok) throw new Error("Upload failed");
      setImageUrl(objectPath);
    } catch (e) {
      // Upload failed — drop the local preview so we don't mislead the user.
      setLocalPreviewUrl(null);
      setErr(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function handleSave() {
    if (!name.trim()) {
      setErr("Name is required");
      return;
    }
    if (!Number.isInteger(pointsCost) || pointsCost < 0) {
      setErr("Point cost must be a whole number ≥ 0");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const body = {
        name: name.trim(),
        description: description.trim(),
        pointsCost,
        imageUrl: imageUrl ?? null,
      };
      const res = await authFetch(
        existing ? `${apiPath}/${existing.id}` : apiPath,
        {
          method: existing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        let msg = "Save failed";
        try {
          const j = (await res.json()) as { error?: string };
          if (j?.error) msg = j.error;
        } catch {
          // ignore
        }
        throw new Error(msg);
      }
      const saved = (await res.json()) as StoreItem;
      onSaved(saved, existing ? "update" : "create");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: "1rem",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "white",
          borderRadius: "0.7rem",
          width: "min(540px, 100%)",
          maxHeight: "92vh",
          overflowY: "auto",
          padding: "1.25rem 1.4rem",
          boxShadow: "0 14px 40px rgba(15, 23, 42, 0.25)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "1rem",
          }}
        >
          <h3 style={{ margin: 0, color: "#0f172a" }}>
            {existing ? "Edit item" : "Add item"}
          </h3>
          <button
            type="button"
            onClick={onClose}
            style={{
              border: "none",
              background: "transparent",
              fontSize: "1.4rem",
              color: "#64748b",
              cursor: "pointer",
              lineHeight: 1,
            }}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div
          style={{
            display: "flex",
            gap: "1rem",
            marginBottom: "1rem",
            flexWrap: "wrap",
          }}
        >
          <div
            style={{
              width: 130,
              height: 130,
              borderRadius: "0.5rem",
              border: "1px solid #e2e8f0",
              background:
                "linear-gradient(135deg, #ecfeff 0%, #ede9fe 50%, #fdf4ff 100%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "2.5rem",
              color: "#0e7490",
              overflow: "hidden",
              flexShrink: 0,
            }}
          >
            {localPreviewUrl ? (
              <img
                src={localPreviewUrl}
                alt=""
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                }}
              />
            ) : imageUrl ? (
              <AuthImage
                src={`/api/storage${imageUrl}`}
                alt=""
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                }}
              />
            ) : (
              <span aria-hidden="true">🎁</span>
            )}
          </div>
          <div
            style={{
              flex: 1,
              minWidth: 180,
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              gap: "0.4rem",
            }}
          >
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
              style={{
                padding: "0.4rem 0.7rem",
                border: "1px solid #0e7490",
                background: "white",
                color: "#0e7490",
                borderRadius: "0.35rem",
                fontWeight: 600,
                fontSize: "0.85rem",
                cursor: uploading ? "wait" : "pointer",
                opacity: uploading ? 0.6 : 1,
              }}
            >
              {uploading
                ? "Uploading…"
                : imageUrl
                  ? "Replace image"
                  : "Upload image"}
            </button>
            {imageUrl && (
              <button
                type="button"
                onClick={() => setImageUrl(null)}
                style={{
                  padding: "0.3rem 0.5rem",
                  border: "1px solid #cbd5e1",
                  background: "white",
                  color: "#475569",
                  borderRadius: "0.35rem",
                  fontSize: "0.78rem",
                  cursor: "pointer",
                }}
              >
                Remove image
              </button>
            )}
            <div
              style={{ fontSize: "0.72rem", color: "#94a3b8", marginTop: 2 }}
            >
              PNG, JPG, or GIF · up to 8 MB
            </div>
          </div>
        </div>

        <label style={{ display: "block", marginBottom: "0.85rem" }}>
          <div
            style={{
              fontSize: "0.85rem",
              color: "#475569",
              marginBottom: "0.25rem",
            }}
          >
            Name
          </div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            placeholder="e.g. Pizza party invite"
            style={{
              width: "100%",
              padding: "0.5rem 0.6rem",
              border: "1px solid #cbd5e1",
              borderRadius: "0.35rem",
              fontSize: "0.95rem",
              boxSizing: "border-box",
            }}
          />
        </label>

        <label style={{ display: "block", marginBottom: "0.85rem" }}>
          <div
            style={{
              fontSize: "0.85rem",
              color: "#475569",
              marginBottom: "0.25rem",
            }}
          >
            Point cost
          </div>
          <input
            type="number"
            min={0}
            step={1}
            value={pointsCost}
            onChange={(e) => setPointsCost(Number(e.target.value))}
            style={{
              width: 140,
              padding: "0.5rem 0.6rem",
              border: "1px solid #cbd5e1",
              borderRadius: "0.35rem",
              fontSize: "0.95rem",
              boxSizing: "border-box",
            }}
          />
        </label>

        <label style={{ display: "block", marginBottom: "1rem" }}>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              marginBottom: "0.25rem",
            }}
          >
            <span style={{ fontSize: "0.85rem", color: "#475569" }}>
              Description
            </span>
            <div style={{ flex: 1 }} />
            <span
              style={{
                fontSize: "0.72rem",
                color: description.length > 500 ? "#dc2626" : "#94a3b8",
              }}
            >
              {description.length}/500
            </span>
          </div>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="What does the student get?"
            style={{
              width: "100%",
              padding: "0.5rem 0.6rem",
              border:
                description.length > 500
                  ? "1px solid #dc2626"
                  : "1px solid #cbd5e1",
              borderRadius: "0.35rem",
              fontSize: "0.92rem",
              fontFamily: "inherit",
              resize: "vertical",
              boxSizing: "border-box",
            }}
          />
        </label>

        {err && (
          <div
            style={{
              marginBottom: "0.8rem",
              padding: "0.5rem 0.7rem",
              background: "#fee2e2",
              color: "#991b1b",
              borderRadius: "0.35rem",
              fontSize: "0.85rem",
            }}
          >
            {err}
          </div>
        )}

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "0.5rem",
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: "0.5rem 1rem",
              background: "white",
              border: "1px solid #cbd5e1",
              borderRadius: "0.4rem",
              color: "#475569",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={
              saving ||
              uploading ||
              !name.trim() ||
              description.length > 500 ||
              !Number.isInteger(pointsCost) ||
              pointsCost < 0
            }
            onClick={handleSave}
            style={{
              padding: "0.5rem 1.1rem",
              background: "#0e7490",
              border: "1px solid #0e7490",
              borderRadius: "0.4rem",
              color: "white",
              fontWeight: 700,
              cursor: saving ? "wait" : "pointer",
              opacity:
                saving ||
                uploading ||
                !name.trim() ||
                description.length > 500 ||
                !Number.isInteger(pointsCost) ||
                pointsCost < 0
                  ? 0.6
                  : 1,
            }}
          >
            {saving ? "Saving…" : existing ? "Save changes" : "Add item"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ComingSoon({ tab }: { tab: Tab }) {
  const labels: Record<Tab, { title: string; body: string }> = {
    classes: { title: "Classes", body: "" },
    rubric: {
      title: "School Store",
      body: "Build the point-awarding rubric your classroom uses — categories, point values, and color-coded buttons your team can tap fast.",
    },
    rewards: {
      title: "Classroom Store",
      body: "Set up your classroom store. Students spend earned points on rewards you define, and you'll track inventory and redemptions here.",
    },
    reports: {
      title: "Reports",
      body: "See trends in awarded points by student, class, period, or reason. Export for parent conferences and admin reviews.",
    },
    settings: {
      title: "Settings",
      body: "Configure how PBIS Points behaves in your classroom — per-class caps, default reasons, parent visibility.",
    },
  };
  const { title, body } = labels[tab];
  return (
    <div
      style={{
        padding: "2.5rem 1.5rem",
        textAlign: "center",
        background: "linear-gradient(180deg, #f8fafc 0%, #f1f5f9 100%)",
        border: "1px dashed #cbd5e1",
        borderRadius: "0.6rem",
        color: "#475569",
      }}
    >
      <div
        style={{
          fontSize: "1.1rem",
          fontWeight: 700,
          color: "#0f172a",
          marginBottom: "0.4rem",
        }}
      >
        {title} — coming soon
      </div>
      <div style={{ fontSize: "0.9rem", maxWidth: "32rem", margin: "0 auto" }}>
        {body}
      </div>
    </div>
  );
}
