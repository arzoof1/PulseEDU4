import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { authFetch } from "../lib/authToken";
import AddDisciplineLogModal from "./AddDisciplineLogModal";

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

export default function AdminHubPage() {
  const [recent, setRecent] = useState<RecentRow[] | null>(null);
  const [ack, setAck] = useState<AckResp | null>(null);
  const [showModal, setShowModal] = useState<null | "iss" | "oss">(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [r1, r2] = await Promise.all([
        authFetch("/api/admin-hub/recent?limit=20"),
        authFetch("/api/admin-hub/acknowledgements"),
      ]);
      if (!r1.ok) throw new Error(await r1.text());
      if (!r2.ok) throw new Error(await r2.text());
      const d1 = (await r1.json()) as { rows: RecentRow[] };
      const d2 = (await r2.json()) as AckResp;
      setRecent(d1.rows);
      setAck(d2);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load Admin Hub");
    }
  }, []);

  useEffect(() => {
    void reload();
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
            <table
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
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto 1fr auto auto",
                  gap: "0.75rem",
                  alignItems: "center",
                  padding: "0.55rem 0.75rem",
                  border: "1px solid #e5e7eb",
                  borderRadius: 8,
                  opacity: r.cancelledAt ? 0.55 : 1,
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
                    onClick={() => cancelLog(r.kind, r.id)}
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
    </div>
  );
}
