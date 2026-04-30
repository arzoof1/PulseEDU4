// Launcher that replaces the legacy "+ Log Intervention" CTA. The teacher
// (or Core Team member) types or picks a student; on selection the
// component reads the student's active MTSS plan and routes to the
// matching form:
//
//    plan.tier === 3   → Tier 3 weekly form
//    plan.tier === 2   → Tier 2 daily form
//    no plan / tier 1  → Tier 2 daily form is offered as a starter
//                          (Core Team likely needs to create a plan).
//
// The CheckInOutModal lives on as a "Quick Check-in" secondary link on
// this launcher so teachers can still use the legacy quick-tally flow
// without losing it.
import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/authToken";
import Tier2DailyForm from "./Tier2DailyForm";
import Tier3WeeklyForm from "./Tier3WeeklyForm";

export interface LauncherStudent {
  studentId: string;
  firstName: string;
  lastName: string;
  grade?: string | null;
}

interface PlanRow {
  id: number;
  studentId: string;
  tier: number;
  closedAt: string | null;
  interventionSubType: string | null;
}

interface Props {
  open: boolean;
  schoolId: number | null;
  isCoreTeam: boolean;
  students: LauncherStudent[];
  onClose: () => void;
  onLogged: () => void;
  onOpenQuickCheckin: () => void;
  // Optional pre-selected student to bypass the picker (used by the
  // "Log now" buttons on the My Interventions Today page).
  initialStudentId?: string | null;
  initialMode?: "tier2" | "tier3" | "auto";
  initialWeekStartDate?: string;
}

// Monday of the week containing `today` in local time.
function mondayOf(today: Date): string {
  const d = new Date(today);
  const dow = d.getDay();
  const shift = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + shift);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10);
}

export default function LogInterventionLauncher({
  open,
  isCoreTeam,
  students,
  onClose,
  onLogged,
  onOpenQuickCheckin,
  initialStudentId,
  initialMode,
  initialWeekStartDate,
}: Props) {
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<LauncherStudent | null>(null);
  const [mode, setMode] = useState<"tier2" | "tier3" | "loading" | "pick">(
    "pick",
  );
  const [planErr, setPlanErr] = useState<string | null>(null);

  // Reset on open / close.
  useEffect(() => {
    if (!open) return;
    setSearch("");
    setPlanErr(null);
    if (initialStudentId) {
      const s = students.find((s) => s.studentId === initialStudentId);
      if (s) {
        setPicked(s);
        if (initialMode && initialMode !== "auto") setMode(initialMode);
        else routeToForm(s);
        return;
      }
    }
    setPicked(null);
    setMode("pick");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialStudentId, initialMode]);

  async function routeToForm(s: LauncherStudent) {
    setMode("loading");
    setPlanErr(null);
    try {
      // Use the teacher-friendly probe endpoint (returns only
      // `{tier, interventionSubType, trackSchoolWideExpectations}`,
      // no notes / goal text). The full /api/mtss-plans list is
      // Core-Team gated; the probe is open to any signed-in staff
      // member in the same school so plain teachers can be routed to
      // the right form.
      const planRes = await authFetch(
        `/api/mtss-plans/probe/${encodeURIComponent(s.studentId)}`,
      );
      if (planRes.ok) {
        const data = (await planRes.json()) as {
          plan: { tier: number } | null;
        };
        if (data.plan?.tier === 3) {
          setMode("tier3");
          return;
        }
        if (data.plan?.tier === 2) {
          setMode("tier2");
          return;
        }
      } else {
        setPlanErr(await planRes.text());
      }
      setMode("tier2");
    } catch (err) {
      setPlanErr(err instanceof Error ? err.message : "Lookup failed");
      setMode("tier2");
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return students.slice(0, 25);
    return students
      .filter((s) => {
        const full = `${s.firstName} ${s.lastName}`.toLowerCase();
        return (
          full.includes(q) || s.studentId.toLowerCase().includes(q)
        );
      })
      .slice(0, 25);
  }, [students, search]);

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,0.55)",
        zIndex: 100,
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
        paddingTop: "5vh",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "white",
          padding: "1.25rem",
          borderRadius: 10,
          boxShadow: "0 12px 40px rgba(0,0,0,0.18)",
          width: "min(940px, 96vw)",
          maxHeight: "90vh",
          overflowY: "auto",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "0.75rem",
          }}
        >
          <h2 style={{ margin: 0 }}>Log Intervention</h2>
          <button type="button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {mode === "pick" && (
          <>
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name or student ID…"
              style={{
                width: "100%",
                padding: "0.5rem 0.7rem",
                borderRadius: 6,
                border: "1px solid #cbd5e1",
                marginBottom: "0.5rem",
              }}
            />
            <div
              style={{
                maxHeight: 360,
                overflowY: "auto",
                border: "1px solid #e2e8f0",
                borderRadius: 6,
              }}
            >
              {filtered.length === 0 && (
                <div style={{ padding: "0.6rem", color: "#64748b" }}>
                  No matches.
                </div>
              )}
              {filtered.map((s) => (
                <button
                  key={s.studentId}
                  type="button"
                  onClick={() => {
                    setPicked(s);
                    routeToForm(s);
                  }}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    padding: "0.5rem 0.7rem",
                    background: "white",
                    border: "none",
                    borderBottom: "1px solid #f1f5f9",
                    cursor: "pointer",
                  }}
                >
                  <div style={{ fontWeight: 600 }}>
                    {s.firstName} {s.lastName}
                  </div>
                  <div style={{ fontSize: "0.8rem", color: "#64748b" }}>
                    ID {s.studentId}
                    {s.grade ? ` · Grade ${s.grade}` : ""}
                  </div>
                </button>
              ))}
            </div>
            <div style={{ marginTop: "0.75rem", textAlign: "right" }}>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onOpenQuickCheckin();
                }}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "#2563eb",
                  cursor: "pointer",
                  fontSize: "0.85rem",
                }}
              >
                Use Quick Check-in (legacy)
              </button>
            </div>
          </>
        )}

        {mode === "loading" && (
          <div style={{ padding: "1rem", color: "#64748b" }}>Loading plan…</div>
        )}

        {mode === "tier2" && picked && (
          <Tier2DailyForm
            schoolId={null}
            studentId={picked.studentId}
            studentName={`${picked.firstName} ${picked.lastName}`}
            isCoreTeam={isCoreTeam}
            onSaved={() => {
              onLogged();
              onClose();
            }}
            onCancel={() => {
              if (initialStudentId) onClose();
              else setMode("pick");
            }}
          />
        )}

        {mode === "tier3" && picked && (
          <Tier3WeeklyForm
            studentId={picked.studentId}
            studentName={`${picked.firstName} ${picked.lastName}`}
            isCoreTeam={isCoreTeam}
            weekStartDate={initialWeekStartDate ?? mondayOf(new Date())}
            onSaved={() => {
              onLogged();
              onClose();
            }}
            onCancel={() => {
              if (initialStudentId) onClose();
              else setMode("pick");
            }}
          />
        )}

        {planErr && (
          <div
            style={{
              marginTop: "0.5rem",
              padding: "0.4rem 0.6rem",
              background: "#fef2f2",
              border: "1px solid #fecaca",
              color: "#b91c1c",
              borderRadius: 6,
              fontSize: "0.85rem",
            }}
          >
            {planErr}
          </div>
        )}
      </div>
    </div>
  );
}
