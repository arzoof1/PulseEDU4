import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { authFetch } from "../lib/authToken";
import AddDisciplineLogModal from "./AddDisciplineLogModal";
import IssLogDetailDrawer from "./IssLogDetailDrawer";
import { HowToUseHelp, HowToSection, RoleSection, howtoListStyle } from "./HowToUseHelp";

interface RecentRow {
  kind: "iss" | "oss";
  id: number;
  studentId: string;
  student: { firstName: string; lastName: string; grade: string | null } | null;
  reasonText: string | null;
  notes: string | null;
  createdByName: string | null;
  cancelledAt: string | null;
  createdAt: string;
  dayCount: number;
}

interface AckExpected {
  studentId: string;
  studentName: string;
  teacherId: number;
  teacherName: string;
  period: number;
  acknowledged: boolean;
  method: "canvas" | "hardcopy" | null;
}

interface AckResp {
  date: string;
  totalExpected: number;
  totalAcknowledged: number;
  students: AckExpected[];
}

interface ReconciliationStudent {
  id: number;
  studentId: string;
  firstName: string;
  lastName: string;
  grade: number | null;
  dismissalMode: string | null;
}

interface ReconciliationResp {
  asOf: string;
  // Server-derived from school_settings.pickup_cutoff_time. Older
  // server builds didn't return this field, so the client falls back
  // to the historical default below.
  cutoffTime?: string;
  byMode: Record<string, ReconciliationStudent[]>;
}

// Fallback cutoff used only when the server response predates the
// pickupCutoffTime field. The authoritative value is the school's
// Settings → Pick-Up cutoff (returned in `cutoffTime` above).
const RECONCILIATION_CUTOFF_FALLBACK_HHMM = "15:30";

const DISMISSAL_MODE_LABELS: Record<string, string> = {
  car_rider: "Car riders",
  walker: "Walkers",
  bus: "Bus riders",
  aftercare: "Aftercare",
  parent_pickup_only: "Parent pick-up only",
};

const card: CSSProperties = {
  padding: "1rem 1.1rem",
  border: "1px solid var(--border, #e5e7eb)",
  borderRadius: 10,
  background: "var(--surface, #fff)",
};

const bigBtn: CSSProperties = {
  flex: 1,
  padding: "1.4rem 1rem",
  borderRadius: 12,
  border: "1px solid transparent",
  fontSize: "1.05rem",
  fontWeight: 700,
  cursor: "pointer",
  color: "white",
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: "0.3rem",
  textAlign: "left",
};

function nowHHMM(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// Renders the "Still on campus" reconciliation tile. Hidden until the
// configured cutoff so it doesn't alarm admins mid-day, and hidden if
// the queue is empty (no signal). Grouped by dismissal mode so the
// front office can call the right list of parents.
function ReconciliationTile({ data }: { data: ReconciliationResp | null }) {
  if (!data) return null;
  const cutoff = data.cutoffTime || RECONCILIATION_CUTOFF_FALLBACK_HHMM;
  const beforeCutoff = nowHHMM() < cutoff;
  const modeKeys = Object.keys(data.byMode).sort();
  const total = modeKeys.reduce((n, k) => n + data.byMode[k]!.length, 0);
  if (beforeCutoff) return null;
  if (total === 0) {
    return (
      <div style={card}>
        <h3 style={{ marginTop: 0 }}>🚗 Still on campus</h3>
        <p style={{ color: "var(--text-subtle)", margin: 0 }}>
          All students have been released as of{" "}
          {new Date(data.asOf).toLocaleTimeString()}.
        </p>
      </div>
    );
  }
  return (
    <div
      style={{
        ...card,
        borderColor: "#fbbf24",
        background: "#fffbeb",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <h3 style={{ margin: 0 }}>🚗 Still on campus</h3>
        <span style={{ color: "var(--text-subtle)", fontSize: 13 }}>
          {total} student{total === 1 ? "" : "s"} not yet released · as of{" "}
          {new Date(data.asOf).toLocaleTimeString()}
        </span>
      </div>
      <p
        style={{
          margin: "6px 0 10px",
          color: "var(--text-subtle)",
          fontSize: 12,
        }}
      >
        Anyone with no release event today (in-car, walker-released, or
        auto-cleared). Grouped by the student's dismissal mode so the
        front office can call the right list of parents.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {modeKeys.map((mode) => {
          const students = data.byMode[mode]!;
          const label = DISMISSAL_MODE_LABELS[mode] ?? mode;
          return (
            <div key={mode}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  marginBottom: 4,
                  color: "#92400e",
                }}
              >
                {label} · {students.length}
              </div>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 6,
                }}
              >
                {students.map((s) => (
                  <span
                    key={s.id}
                    style={{
                      padding: "3px 8px",
                      background: "white",
                      border: "1px solid #fbbf24",
                      borderRadius: 999,
                      fontSize: 12,
                    }}
                  >
                    {s.firstName} {s.lastName}
                    {s.grade !== null && (
                      <span
                        style={{
                          marginLeft: 4,
                          color: "var(--text-subtle)",
                          fontSize: 11,
                        }}
                      >
                        Gr {s.grade}
                      </span>
                    )}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface PmReadinessResp {
  schoolYear: string;
  window: string;
  ready: boolean;
  subjects: { ela: boolean; math: boolean };
  dismissed: boolean;
}

// Post-PM nudge banner. Visible only when (a) the school has loaded
// ELA + Math PM3 for the current SY, AND (b) the admin hasn't already
// dismissed this window. Dismissal is per SY+window so the banner
// reappears automatically when a new PM cycle arrives. Wording is
// deliberately soft — "suggestions" — because Class Composer never
// writes to the roster; the school chooses whether to act.
function ClassComposerBanner({
  data,
  onLaunch,
  onDismiss,
}: {
  data: PmReadinessResp;
  onLaunch?: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      style={{
        ...card,
        borderColor: "#a7f3d0",
        background: "#ecfdf5",
        display: "flex",
        flexDirection: "column",
        gap: "0.6rem",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <h3 style={{ margin: 0 }}>📊 PM3 data complete — group suggestions ready</h3>
        <span style={{ color: "var(--text-subtle)", fontSize: 13 }}>
          {data.schoolYear} · ELA + Math
        </span>
      </div>
      <p style={{ margin: 0, fontSize: 14 }}>
        Class Composer can propose intensive groupings for next quarter from
        your latest FAST data. This is a <strong>read-only suggestion</strong>{" "}
        — nothing is written to your roster. You decide whether to reshuffle
        sections.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={() => onLaunch?.()}
          disabled={!onLaunch}
          style={{
            padding: "0.5rem 0.9rem",
            borderRadius: 8,
            border: "1px solid #059669",
            background: "#059669",
            color: "white",
            fontWeight: 600,
            cursor: onLaunch ? "pointer" : "not-allowed",
          }}
        >
          View suggested groupings
        </button>
        <button
          type="button"
          onClick={onDismiss}
          style={{
            padding: "0.5rem 0.9rem",
            borderRadius: 8,
            border: "1px solid var(--border, #cbd5e1)",
            background: "white",
            color: "var(--text, #334155)",
            cursor: "pointer",
          }}
        >
          Dismiss for this PM cycle
        </button>
      </div>
    </div>
  );
}

export default function AdminHubPage({
  onOpenAstQueue,
  onOpenCompQueue,
  onOpenClassComposer,
}: {
  // Optional deep-link to the AST admin queue. When provided, the AST
  // pending-count tile becomes clickable. Wired by App.tsx.
  onOpenAstQueue?: () => void;
  // Optional deep-link to the Comp Time admin queue. Same pattern as
  // AST — the tile is silent for non-approvers and shows the pending
  // count for approvers.
  onOpenCompQueue?: () => void;
  // Optional deep-link to Insights → Class Composer. When provided,
  // the post-PM nudge banner's "View suggested groupings" button
  // navigates there.
  onOpenClassComposer?: () => void;
} = {}) {
  const [recent, setRecent] = useState<RecentRow[] | null>(null);
  const [ack, setAck] = useState<AckResp | null>(null);
  const [reconciliation, setReconciliation] =
    useState<ReconciliationResp | null>(null);
  const [pmReadiness, setPmReadiness] = useState<PmReadinessResp | null>(null);
  const [skillclusterBanners, setSkillclusterBanners] = useState<Array<{
    pmWindow: string;
    token: string;
    title: string;
    description: string;
    subjects: string[];
  }>>([]);
  const [astPending, setAstPending] = useState<number | null>(null);
  const [compPending, setCompPending] = useState<number | null>(null);
  const [showModal, setShowModal] = useState<null | "iss" | "oss">(null);
  const [issDetail, setIssDetail] = useState<{
    id: number;
    studentName: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [r1, r2, r3, r4, r5, r6, r7] = await Promise.all([
        authFetch("/api/admin-hub/recent?limit=20"),
        authFetch("/api/admin-hub/acknowledgements"),
        authFetch("/api/pickup/reconciliation"),
        authFetch("/api/ast/admin-pending-count"),
        authFetch("/api/comp/admin-pending-count"),
        authFetch("/api/intensive-groups/pm-readiness"),
        authFetch("/api/intensive-groups/skillcluster-banners"),
      ]);
      if (!r1.ok) throw new Error(await r1.text());
      if (!r2.ok) throw new Error(await r2.text());
      const d1 = (await r1.json()) as { rows: RecentRow[] };
      const d2 = (await r2.json()) as AckResp;
      setRecent(d1.rows);
      setAck(d2);
      // AST count is best-effort. 403 (non-AST-approver staff who can
      // still use the Admin Hub for ISS/OSS) is silently ignored.
      if (r4.ok) {
        const d4 = (await r4.json()) as { total?: number };
        setAstPending(typeof d4.total === "number" ? d4.total : 0);
      } else {
        setAstPending(null);
      }
      // Comp Time pending count. Same best-effort treatment as AST
      // — the route returns { count: 0 } for non-approvers rather
      // than 403, so r5.ok should virtually always be true.
      if (r5.ok) {
        const d5 = (await r5.json()) as { count?: number };
        setCompPending(typeof d5.count === "number" ? d5.count : 0);
      } else {
        setCompPending(null);
      }
      // Reconciliation is best-effort; admins without curb access still
      // see the rest of the hub. (canRunCurb covers admin already, so a
      // 403 here would only happen on a misconfigured tenant.)
      if (r3.ok) {
        setReconciliation((await r3.json()) as ReconciliationResp);
      } else {
        setReconciliation(null);
      }
      // PM readiness is admin/Core-Team gated server-side; 403 just
      // means the signed-in staff can't manage groupings, so the
      // banner stays hidden for them. Any other error: silent.
      if (r6.ok) {
        setPmReadiness((await r6.json()) as PmReadinessResp);
      } else {
        setPmReadiness(null);
      }
      if (r7.ok) {
        const d7 = (await r7.json()) as {
          banners: Array<{
            pmWindow: string;
            token: string;
            title: string;
            description: string;
            subjects: string[];
          }>;
        };
        setSkillclusterBanners(d7.banners ?? []);
      } else {
        setSkillclusterBanners([]);
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load Admin Hub");
    }
  }, []);

  useEffect(() => {
    void reload();
    // Poll every 30s so the "Still on campus" tile shrinks in real
    // time as the front office runs the curb keypad. 30s matches the
    // hall-passes polling cadence elsewhere in the app — cheap and
    // good enough for a dismissal window that lasts ~20 minutes.
    const id = setInterval(() => {
      void reload();
    }, 30_000);
    return () => clearInterval(id);
  }, [reload]);

  const cancelLog = async (kind: "iss" | "oss", id: number) => {
    if (!confirm("Cancel this assignment? Future days will be removed."))
      return;
    const r = await authFetch(`/api/admin-hub/${kind}-logs/${id}/cancel`, {
      method: "POST",
    });
    if (!r.ok) {
      alert(`Cancel failed: ${await r.text()}`);
      return;
    }
    await reload();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <div>
        <h1 style={{ marginTop: 0 }}>Admin Hub</h1>
        <p style={{ color: "var(--text-subtle)", marginTop: 0 }}>
          Log ISS or OSS for one or more days. Teachers see soft reminders
          on their roster automatically. Parents see what your school has
          opted in to share.
        </p>
      </div>

      <HowToUseHelp title="How to use the Admin Hub">
        <HowToSection title="What this hub is">
          The single place administrators log out-of-class consequences
          (ISS, OSS) and confirm yesterday's assignments were served. The
          recent feed below is your audit log; the acknowledgement panel
          shows whether teachers marked the kid present this morning.
        </HowToSection>
        <HowToSection title="Logging an assignment">
          <ul style={howtoListStyle}>
            <li><strong>Add ISS log</strong> — pick the student, the date range (one or many days), the reason, and any notes. The system creates a per-day attendance row that the ISS room teacher will check off as the student shows up.</li>
            <li><strong>Add OSS log</strong> — same flow, but the kid is marked absent from school. Parents see this in the Parent Portal if your school has opted in.</li>
            <li><strong>Cancel</strong> — undoes a future-dated assignment. Past served days are immutable; cancellation only trims the tail.</li>
          </ul>
        </HowToSection>
        <RoleSection for={["admin", "coreTeam"]} title="Daily routine for admins">
          <ul style={howtoListStyle}>
            <li>Morning: scan the acknowledgement card. Yellow rows = teacher hasn't checked off the kid yet — call the room.</li>
            <li>Mid-day: log new assignments as they happen so the ISS teacher's roster stays accurate.</li>
            <li>End of day: review the recent feed. Anything wrong? Cancel future days; reason/notes stay editable on past assignments.</li>
          </ul>
        </RoleSection>
        <RoleSection for="teacher" title="What teachers see">
          You don't log here — instead you'll see soft reminders at the
          top of your roster ("Jamal is in ISS today, period 3 onward").
          Acknowledge by clicking the banner. That tells admin you saw it.
        </RoleSection>
      </HowToUseHelp>

      {error && (
        <div
          style={{
            ...card,
            borderColor: "#fca5a5",
            background: "#fef2f2",
            color: "#991b1b",
          }}
        >
          {error}
        </div>
      )}

      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
        <button
          type="button"
          style={{ ...bigBtn, background: "#ea580c" }}
          onClick={() => setShowModal("iss")}
        >
          <span style={{ fontSize: "1.4rem" }}>📘 Add ISS log</span>
          <span
            style={{ fontSize: "0.85rem", fontWeight: 400, opacity: 0.9 }}
          >
            In-school suspension. Multi-day calendar. Auto rollover for
            absences.
          </span>
        </button>
        <button
          type="button"
          style={{ ...bigBtn, background: "#dc2626" }}
          onClick={() => setShowModal("oss")}
        >
          <span style={{ fontSize: "1.4rem" }}>📕 Add OSS log</span>
          <span
            style={{ fontSize: "0.85rem", fontWeight: 400, opacity: 0.9 }}
          >
            Out-of-school suspension. Multi-day calendar. No rollover.
          </span>
        </button>
      </div>

      {ack && ack.totalExpected > 0 && (
        <div style={card}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <h3 style={{ margin: 0 }}>Today's ISS prep</h3>
            <span style={{ color: "var(--text-subtle)", fontSize: 13 }}>
              {ack.totalAcknowledged} of {ack.totalExpected} teachers
              acknowledged
            </span>
          </div>
          <div
            style={{
              marginTop: 8,
              maxHeight: 220,
              overflow: "auto",
              border: "1px solid var(--border, #e5e7eb)",
              borderRadius: 8,
            }}
          >
            <table className="pulse-table"
              style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}
            >
              <thead style={{ background: "#f8fafc", textAlign: "left" }}>
                <tr>
                  <th style={{ padding: "6px 10px" }}>Student</th>
                  <th style={{ padding: "6px 10px" }}>Teacher</th>
                  <th style={{ padding: "6px 10px" }}>Period</th>
                  <th style={{ padding: "6px 10px" }}>Acknowledged</th>
                </tr>
              </thead>
              <tbody>
                {ack.students.map((s) => (
                  <tr
                    key={`${s.studentId}-${s.teacherId}-${s.period}`}
                    style={{ borderTop: "1px solid #f1f5f9" }}
                  >
                    <td style={{ padding: "6px 10px" }}>{s.studentName}</td>
                    <td style={{ padding: "6px 10px" }}>{s.teacherName}</td>
                    <td style={{ padding: "6px 10px" }}>P{s.period}</td>
                    <td style={{ padding: "6px 10px" }}>
                      {s.acknowledged ? (
                        <span style={{ color: "#15803d" }}>
                          ✓ {s.method === "hardcopy" ? "Hard copy" : "Canvas"}
                        </span>
                      ) : (
                        <span style={{ color: "#b91c1c" }}>Not yet</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {pmReadiness && pmReadiness.ready && !pmReadiness.dismissed && (
        <ClassComposerBanner
          data={pmReadiness}
          onLaunch={onOpenClassComposer}
          onDismiss={async () => {
            // Optimistic dismiss — hide immediately; if the POST
            // fails the next 30s poll will restore the banner.
            setPmReadiness({ ...pmReadiness, dismissed: true });
            await authFetch("/api/intensive-groups/pm-readiness/dismiss", {
              method: "POST",
            });
          }}
        />
      )}

      {skillclusterBanners.map((b) => (
        <div
          key={b.token}
          style={{
            ...card,
            borderColor: b.pmWindow === "pm1" ? "#fcd34d" : "#a7f3d0",
            background: b.pmWindow === "pm1" ? "#fffbeb" : "#ecfdf5",
            display: "flex",
            flexDirection: "column",
            gap: "0.6rem",
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <h3 style={{ margin: 0 }}>
              {b.pmWindow === "pm1" ? "📋" : "🔄"} {b.title}
            </h3>
            <span style={{ color: "var(--text-subtle)", fontSize: 13 }}>
              {b.subjects.map((s) => s.toUpperCase()).join(" + ")}
            </span>
          </div>
          <p style={{ margin: 0, fontSize: 14 }}>{b.description}</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => onOpenClassComposer?.()}
              disabled={!onOpenClassComposer}
              style={{
                padding: "0.5rem 0.9rem",
                borderRadius: 8,
                border: "1px solid #4338ca",
                background: "#4338ca",
                color: "white",
                fontWeight: 600,
                cursor: onOpenClassComposer ? "pointer" : "not-allowed",
              }}
            >
              Open Class Composer
            </button>
            <button
              type="button"
              onClick={async () => {
                setSkillclusterBanners((prev) =>
                  prev.filter((x) => x.token !== b.token),
                );
                await authFetch(
                  "/api/intensive-groups/skillcluster-banners/dismiss",
                  {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ token: b.token }),
                  },
                );
              }}
              style={{
                padding: "0.5rem 0.9rem",
                borderRadius: 8,
                border: "1px solid var(--border, #cbd5e1)",
                background: "white",
                color: "var(--text, #334155)",
                cursor: "pointer",
              }}
            >
              Dismiss for this PM cycle
            </button>
          </div>
        </div>
      ))}

      <ReconciliationTile data={reconciliation} />

      {astPending !== null && (
        <button
          type="button"
          onClick={() => onOpenAstQueue?.()}
          disabled={!onOpenAstQueue}
          style={{
            ...card,
            textAlign: "left",
            cursor: onOpenAstQueue ? "pointer" : "default",
            background: astPending > 0 ? "#fff7ed" : "var(--surface, #fff)",
            borderColor: astPending > 0 ? "#fed7aa" : "var(--border, #e5e7eb)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div>
            <h3 style={{ margin: 0 }}>⏱ AST: {astPending}</h3>
            <div
              style={{
                color: "var(--text-subtle, #64748b)",
                fontSize: 13,
                marginTop: 2,
              }}
            >
              {astPending === 0
                ? "No pending Alternate Schedule Time approvals."
                : `${astPending} pending Alternate Schedule Time approval${astPending === 1 ? "" : "s"}. Click to review.`}
            </div>
          </div>
          {astPending > 0 && (
            <span
              style={{
                background: "#ea580c",
                color: "white",
                borderRadius: 999,
                padding: "4px 12px",
                fontWeight: 700,
                fontSize: 14,
              }}
            >
              {astPending}
            </span>
          )}
        </button>
      )}

      {compPending !== null && compPending >= 0 && (
        <button
          type="button"
          onClick={() => onOpenCompQueue?.()}
          disabled={!onOpenCompQueue}
          style={{
            ...card,
            textAlign: "left",
            cursor: onOpenCompQueue ? "pointer" : "default",
            background: compPending > 0 ? "#fff7ed" : "var(--surface, #fff)",
            borderColor: compPending > 0 ? "#fed7aa" : "var(--border, #e5e7eb)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div>
            <h3 style={{ margin: 0 }}>⏱ Comp Time: {compPending}</h3>
            <div
              style={{
                color: "var(--text-subtle, #64748b)",
                fontSize: 13,
                marginTop: 2,
              }}
            >
              {compPending === 0
                ? "No pending Comp Time approvals."
                : `${compPending} pending Comp Time approval${compPending === 1 ? "" : "s"}. Click to review.`}
            </div>
          </div>
          {compPending > 0 && (
            <span
              style={{
                background: "#ea580c",
                color: "white",
                borderRadius: 999,
                padding: "4px 12px",
                fontWeight: 700,
                fontSize: 14,
              }}
            >
              {compPending}
            </span>
          )}
        </button>
      )}

      <div style={card}>
        <h3 style={{ marginTop: 0 }}>Recent assignments</h3>
        {recent === null ? (
          <p style={{ color: "var(--text-subtle)" }}>Loading…</p>
        ) : recent.length === 0 ? (
          <p style={{ color: "var(--text-subtle)" }}>
            No discipline logs yet. Use the buttons above to start one.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {recent.map((r) => (
              <div
                key={`${r.kind}-${r.id}`}
                onClick={() => {
                  // Detail drawer is ISS-only for now (the audit-trail
                  // edit/delete flow only covers ISS assignments).
                  if (r.kind !== "iss") return;
                  const name = r.student
                    ? `${r.student.firstName} ${r.student.lastName}`
                    : r.studentId;
                  setIssDetail({ id: r.id, studentName: name });
                }}
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto 1fr auto auto",
                  gap: "0.75rem",
                  alignItems: "center",
                  padding: "0.55rem 0.75rem",
                  border: "1px solid #e5e7eb",
                  borderRadius: 8,
                  opacity: r.cancelledAt ? 0.55 : 1,
                  cursor: r.kind === "iss" ? "pointer" : "default",
                }}
              >
                <span
                  style={{
                    background: r.kind === "iss" ? "#ea580c" : "#dc2626",
                    color: "white",
                    padding: "2px 8px",
                    borderRadius: 6,
                    fontSize: 11,
                    fontWeight: 700,
                  }}
                >
                  {r.kind.toUpperCase()}
                </span>
                <div>
                  <div style={{ fontWeight: 600 }}>
                    {r.student
                      ? `${r.student.firstName} ${r.student.lastName}`
                      : r.studentId}
                    {r.student?.grade && (
                      <span
                        style={{
                          marginLeft: 6,
                          color: "var(--text-subtle)",
                          fontWeight: 400,
                          fontSize: 12,
                        }}
                      >
                        Gr {r.student.grade}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-subtle)" }}>
                    {r.reasonText ?? "(no reason)"} · by{" "}
                    {r.createdByName ?? "—"} ·{" "}
                    {new Date(r.createdAt).toLocaleDateString()}
                    {r.cancelledAt && " · cancelled"}
                  </div>
                </div>
                <span style={{ fontSize: 13, fontWeight: 600 }}>
                  {r.dayCount}d
                </span>
                {!r.cancelledAt && (
                  <button
                    type="button"
                    onClick={(e) => {
                      // Stop the row's click handler from also opening
                      // the detail drawer when the admin clicks Cancel.
                      e.stopPropagation();
                      void cancelLog(r.kind, r.id);
                    }}
                    style={{
                      padding: "3px 8px",
                      fontSize: 12,
                      border: "1px solid #cbd5e1",
                      borderRadius: 6,
                      background: "white",
                      cursor: "pointer",
                    }}
                  >
                    Cancel
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {showModal && (
        <AddDisciplineLogModal
          initialKind={showModal}
          onClose={() => setShowModal(null)}
          onSaved={async () => {
            setShowModal(null);
            await reload();
          }}
        />
      )}

      {issDetail && (
        <IssLogDetailDrawer
          logId={issDetail.id}
          studentName={issDetail.studentName}
          onClose={() => setIssDetail(null)}
          onChanged={(opts) => {
            void reload();
            if (opts?.deleted) setIssDetail(null);
          }}
        />
      )}
    </div>
  );
}
