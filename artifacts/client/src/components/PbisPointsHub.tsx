import { useEffect, useMemo, useState } from "react";
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
};

type PbisEntry = {
  id: number;
  studentId: string;
  points: number;
  voidedAt?: string | null;
};

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

  const [sections, setSections] = useState<Section[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [reasons, setReasons] = useState<Reason[]>([]);
  // studentId -> total active points (sum of non-voided entries)
  const [totals, setTotals] = useState<Map<string, number>>(new Map());

  const [activePeriod, setActivePeriod] = useState<number | "all">("all");
  const [awardingFor, setAwardingFor] = useState<Student | null>(null);

  // ---- Initial data load
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErrorMsg(null);
      try {
        const [schedRes, studRes, reasonsRes, pbisRes] = await Promise.all([
          authFetch("/api/schedule"),
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

        setSections(
          (schedJson.sections ?? []).filter((s) => !s.isPlanning),
        );
        setStudents(studJson);
        setReasons(reasonsJson.filter((r) => r.active));

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
    // Optimistically bump the local total so the card updates immediately.
    setTotals((prev) => {
      const next = new Map(prev);
      next.set(student.studentId, (next.get(student.studentId) ?? 0) + points);
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
          sections={sections}
          students={students}
          totals={totals}
          activePeriod={activePeriod}
          onChangePeriod={setActivePeriod}
          onSelectStudent={setAwardingFor}
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
}: {
  sections: Section[];
  students: Student[];
  totals: Map<string, number>;
  activePeriod: number | "all";
  onChangePeriod: (p: number | "all") => void;
  onSelectStudent: (s: Student) => void;
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

  if (sections.length === 0) {
    return (
      <div
        style={{
          padding: "2rem",
          textAlign: "center",
          color: "#64748b",
          background: "#f8fafc",
          borderRadius: "0.5rem",
        }}
      >
        You don't have any classes assigned yet.
        <br />
        Once your schedule is set up, your students will show up here.
      </div>
    );
  }

  return (
    <div>
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
          Tap a student to award points
        </span>
      </div>

      {/* Section list */}
      <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
        {visibleSections.map((sec) => {
          const sectionStudents = sec.studentIds
            .map((id) => studentById.get(id))
            .filter((s): s is Student => Boolean(s))
            .sort((a, b) => a.firstName.localeCompare(b.firstName));
          return (
            <div key={sec.id}>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: "0.5rem",
                  marginBottom: "0.5rem",
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
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
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
}: {
  student: Student;
  total: number;
  onClick: () => void;
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
    <button
      type="button"
      onClick={onClick}
      style={{
        position: "relative",
        textAlign: "left",
        padding: "0.6rem 0.7rem 0.7rem",
        background: "white",
        border: "1px solid #e2e8f0",
        borderTop: `3px solid ${accent}`,
        borderRadius: "0.5rem",
        cursor: "pointer",
        boxShadow: "0 1px 2px rgba(15,23,42,0.04)",
        transition: "transform 0.05s ease, box-shadow 0.1s ease",
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
