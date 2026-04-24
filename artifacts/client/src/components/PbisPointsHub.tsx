import { useEffect, useMemo, useRef, useState } from "react";
import { authFetch } from "../lib/authToken";

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
};

type Reason = {
  id: number;
  name: string;
  category: string;
  defaultPoints: number;
  active: boolean;
  polarity: "positive" | "negative";
  sortOrder: number;
};

type SchoolSettings = {
  pbisNegativeAffectsTotal: boolean;
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
  isEseCoordinator?: boolean;
  isMtssCoordinator?: boolean;
  isBehaviorSpecialist?: boolean;
};

type Teacher = { id: number; name: string };

const TAB_LABELS: { key: Tab; label: string }[] = [
  { key: "classes", label: "Classes" },
  { key: "rubric", label: "Rubric" },
  { key: "rewards", label: "Rewards" },
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
  // studentId -> total active points (sum of non-voided entries)
  const [totals, setTotals] = useState<Map<string, number>>(new Map());

  const [selectedTeacherId, setSelectedTeacherId] = useState<number | null>(
    null,
  );
  const [activePeriod, setActivePeriod] = useState<number | "all">("all");
  const [awardingFor, setAwardingFor] = useState<Student | null>(null);
  // Bulk selection — set of studentIds checked across all sections.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);

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

        const adminScope = !!(meJson.isAdmin || meJson.isEseCoordinator);

        const [schedRes, studRes, reasonsRes, pbisRes] = await Promise.all([
          authFetch(adminScope ? "/api/schedule?all=1" : "/api/schedule"),
          authFetch("/api/students"),
          authFetch("/api/pbis-reasons"),
          authFetch("/api/pbis"),
        ]);
        if (!schedRes.ok) throw new Error("Failed to load class schedule");
        if (!studRes.ok) throw new Error("Failed to load students");
        if (!reasonsRes.ok) throw new Error("Failed to load PBIS reasons");
        if (!pbisRes.ok) throw new Error("Failed to load PBIS entries");

        const schedJson = (await schedRes.json()) as { sections: Section[] };
        const studJson = (await studRes.json()) as Student[];
        const reasonsJson = (await reasonsRes.json()) as Reason[];
        const pbisJson = (await pbisRes.json()) as PbisEntry[];

        if (cancelled) return;

        const filteredSections = (schedJson.sections ?? []).filter(
          (s) => !s.isPlanning,
        );
        setMe(meJson);
        setSections(filteredSections);
        setStudents(studJson);
        setReasons(reasonsJson.filter((r) => r.active));

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

  // Sections to display in the Classes tab — narrowed to the selected
  // teacher (or all of the viewer's own when not admin).
  const visibleSectionsForTeacher = useMemo(() => {
    if (selectedTeacherId == null) return sections;
    return sections.filter((s) => s.teacherStaffId === selectedTeacherId);
  }, [sections, selectedTeacherId]);

  // Reset the period filter when switching teachers so we don't leave the
  // user filtered to a period the new teacher doesn't have.
  useEffect(() => {
    setActivePeriod("all");
  }, [selectedTeacherId]);

  // ---- Award points (used by AwardModal)
  async function awardPoints(
    student: Student,
    reason: Reason,
    points: number,
  ): Promise<void> {
    const res = await authFetch("/api/pbis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        studentId: student.studentId,
        reason: reason.name,
        points,
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

      <TabBar tab={tab} onChange={setTab} />

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
        />
      ) : (
        <ComingSoon tab={tab} />
      )}

      {awardingFor && (
        <AwardModal
          student={awardingFor}
          reasons={reasons}
          onClose={() => setAwardingFor(null)}
          onSubmit={async (reason, points) => {
            await awardPoints(awardingFor, reason, points);
            setAwardingFor(null);
          }}
        />
      )}

      {bulkOpen && (
        <BulkAwardModal
          studentIds={Array.from(selectedIds)}
          students={students}
          reasons={reasons}
          onClose={() => setBulkOpen(false)}
          onSubmit={async (reason, points, note) => {
            await bulkAward(Array.from(selectedIds), reason, points, note);
            setBulkOpen(false);
            setSelectedIds(new Set());
          }}
        />
      )}
    </section>
  );
}

// -----------------------------------------------------------------------------
// Sub-components
// -----------------------------------------------------------------------------

function TabBar({
  tab,
  onChange,
}: {
  tab: Tab;
  onChange: (t: Tab) => void;
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
      {TAB_LABELS.map(({ key, label }) => {
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
            .sort((a, b) => a.firstName.localeCompare(b.firstName));
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
                {sectionStudents.length > 0 && (
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
      {selectedIds.size > 0 && (
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
}: {
  student: Student;
  total: number;
  onClick: () => void;
  selected: boolean;
  onToggleSelect: () => void;
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
  onClose,
  onSubmit,
}: {
  student: Student;
  reasons: Reason[];
  onClose: () => void;
  onSubmit: (reason: Reason, points: number) => Promise<void>;
}) {
  const [selectedReasonId, setSelectedReasonId] = useState<number | null>(
    reasons[0]?.id ?? null,
  );
  const [points, setPoints] = useState<number>(reasons[0]?.defaultPoints ?? 1);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const selected = reasons.find((r) => r.id === selectedReasonId) ?? null;
  // Award flow only supports awarding (not removing/deducting). Points must
  // be a positive integer to avoid bad data from typos like "-1" or "0".
  const pointsValid = Number.isInteger(points) && points >= 1;

  // When the selected reason changes, snap the points input to its default.
  useEffect(() => {
    if (selected) setPoints(selected.defaultPoints);
  }, [selectedReasonId]); // eslint-disable-line react-hooks/exhaustive-deps

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
                      const active = r.id === selectedReasonId;
                      return (
                        <button
                          key={r.id}
                          type="button"
                          onClick={() => setSelectedReasonId(r.id)}
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
                          {r.name}{" "}
                          <span
                            style={{
                              opacity: 0.65,
                              marginLeft: "0.25rem",
                              fontSize: "0.75rem",
                            }}
                          >
                            +{r.defaultPoints}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                marginBottom: "1rem",
              }}
            >
              <span style={{ fontSize: "0.9rem", color: "#475569" }}>
                Points:
              </span>
              <input
                type="number"
                min={1}
                step={1}
                value={points}
                onChange={(e) => setPoints(Number(e.target.value))}
                style={{
                  width: "5rem",
                  padding: "0.35rem 0.5rem",
                  border: pointsValid
                    ? "1px solid #cbd5e1"
                    : "1px solid #dc2626",
                  borderRadius: "0.35rem",
                  fontSize: "0.95rem",
                }}
              />
              {!pointsValid && (
                <span style={{ fontSize: "0.8rem", color: "#dc2626" }}>
                  Must be a whole number, 1 or more.
                </span>
              )}
            </label>

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
                disabled={!selected || submitting || !pointsValid}
                onClick={async () => {
                  if (!selected) return;
                  setSubmitting(true);
                  setErr(null);
                  try {
                    await onSubmit(selected, points);
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
                  opacity: !selected || submitting ? 0.6 : 1,
                }}
              >
                {submitting ? "Awarding…" : "Award Points"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// BulkAwardModal — same look as AwardModal but for many students + a note.
// -----------------------------------------------------------------------------
function BulkAwardModal({
  studentIds,
  students,
  reasons,
  onClose,
  onSubmit,
}: {
  studentIds: string[];
  students: Student[];
  reasons: Reason[];
  onClose: () => void;
  onSubmit: (reason: Reason, points: number, note: string) => Promise<void>;
}) {
  const [selectedReasonId, setSelectedReasonId] = useState<number | null>(
    reasons[0]?.id ?? null,
  );
  const [points, setPoints] = useState<number>(reasons[0]?.defaultPoints ?? 1);
  const [note, setNote] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const selected = reasons.find((r) => r.id === selectedReasonId) ?? null;
  const pointsValid = Number.isInteger(points) && points >= 1;
  // Cap the note client-side at the same 500-char limit the server enforces.
  const noteOver = note.length > 500;

  useEffect(() => {
    if (selected) setPoints(selected.defaultPoints);
  }, [selectedReasonId]); // eslint-disable-line react-hooks/exhaustive-deps

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
                      const active = r.id === selectedReasonId;
                      const isNeg = r.polarity === "negative";
                      return (
                        <button
                          key={r.id}
                          type="button"
                          onClick={() => setSelectedReasonId(r.id)}
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
                          {r.name}{" "}
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
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                marginBottom: "1rem",
              }}
            >
              <span style={{ fontSize: "0.9rem", color: "#475569" }}>
                Points each:
              </span>
              <input
                type="number"
                min={1}
                step={1}
                value={points}
                onChange={(e) => setPoints(Number(e.target.value))}
                style={{
                  width: "5rem",
                  padding: "0.35rem 0.5rem",
                  border: pointsValid
                    ? "1px solid #cbd5e1"
                    : "1px solid #dc2626",
                  borderRadius: "0.35rem",
                  fontSize: "0.95rem",
                }}
              />
              {!pointsValid && (
                <span style={{ fontSize: "0.8rem", color: "#dc2626" }}>
                  Must be a whole number, 1 or more.
                </span>
              )}
            </label>

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
                }}
              >
                <span style={{ fontSize: "0.9rem", color: "#475569" }}>
                  Note (optional)
                </span>
                <div style={{ flex: 1 }} />
                <span
                  style={{
                    fontSize: "0.75rem",
                    color: noteOver ? "#dc2626" : "#94a3b8",
                  }}
                >
                  {note.length}/500
                </span>
              </div>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                placeholder="Why is the whole group earning these points? (Saved on each student's record.)"
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
                  !selected ||
                  submitting ||
                  !pointsValid ||
                  noteOver ||
                  studentIds.length === 0
                }
                onClick={async () => {
                  if (!selected) return;
                  setSubmitting(true);
                  setErr(null);
                  try {
                    await onSubmit(selected, points, note.trim());
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
                    !selected || submitting || !pointsValid || noteOver
                      ? 0.6
                      : 1,
                }}
              >
                {submitting
                  ? "Awarding…"
                  : `Award ${studentIds.length} student${studentIds.length === 1 ? "" : "s"}`}
              </button>
            </div>
          </>
        )}
      </div>
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

function SettingsView({
  me,
  reasons,
  onReasonsChanged,
}: {
  me: Me | null;
  reasons: Reason[];
  onReasonsChanged: (next: Reason[]) => void;
}) {
  const canEdit = !!(
    me?.isAdmin ||
    (me as Me & { isPbisCoordinator?: boolean })?.isPbisCoordinator ||
    me?.isBehaviorSpecialist
  );

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
  const [filter, setFilter] = useState<"all" | "positive" | "negative">("all");
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

  // Apply search + polarity + archive filter, group by category preserving
  // category order = first-seen order in the underlying list.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return local.filter((r) => {
      if (!showArchived && !r.active) return false;
      if (filter !== "all" && r.polarity !== filter) return false;
      if (q && !r.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [local, search, filter, showArchived]);

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
    // Recompute sortOrder per category from the new local order.
    const byCat = new Map<string, Reason[]>();
    for (const r of newLocal) {
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
    // Update local with the canonical sortOrders.
    const updated = newLocal.map((r) => {
      const m = items.find((x) => x.id === r.id)!;
      return { ...r, sortOrder: m.sortOrder, category: m.category };
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

function ComingSoon({ tab }: { tab: Tab }) {
  const labels: Record<Tab, { title: string; body: string }> = {
    classes: { title: "Classes", body: "" },
    rubric: {
      title: "Rubric",
      body: "Build the point-awarding rubric your classroom uses — categories, point values, and color-coded buttons your team can tap fast.",
    },
    rewards: {
      title: "Rewards",
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
