import React, { useCallback, useEffect, useState } from "react";
import { authFetch } from "../lib/authToken";

// Front-office "Contact Info Fixes" queue. Staff flag a bad family phone line
// from the Communication Log; this page lets office staff (capManageContactInfo)
// enter a corrected number — an audited override that WINS app-wide until
// overwritten (pickup manual-override pattern). A "SIS disagrees" banner fires
// when RosterOne now carries a different number than the active override.

type ContactFix = {
  id: number;
  studentId: string;
  studentName: string;
  localSisId: string | null;
  contactSlot: number;
  contactLabel: string | null;
  badPhone: string | null;
  sisPhone: string | null;
  reason: string;
  status: string;
  flaggedByName: string;
  flaggedAt: string;
  correctedPhone: string | null;
  resolvedByName: string | null;
  resolvedAt: string | null;
  note: string | null;
  sisDisagrees: boolean;
};

function fmt(ts: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function slotLabel(slot: number): string {
  return slot === 0 ? "Primary guardian" : `Emergency contact ${slot}`;
}

export default function ContactFixesPage() {
  const [fixes, setFixes] = useState<ContactFix[]>([]);
  const [loading, setLoading] = useState(true);
  const [showResolved, setShowResolved] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [correctedPhone, setCorrectedPhone] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    authFetch(
      `/api/communications/contact-fixes?status=${showResolved ? "all" : "open"}`,
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { fixes?: ContactFix[] } | null) => {
        setFixes(j?.fixes ?? []);
      })
      .catch(() => setFixes([]))
      .finally(() => setLoading(false));
  }, [showResolved]);

  useEffect(() => {
    load();
  }, [load]);

  async function resolve(id: number) {
    setSaving(true);
    try {
      const res = await authFetch(
        `/api/communications/contact-fixes/${id}/resolve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            correctedPhone: correctedPhone.trim() || null,
            note: note.trim() || null,
          }),
        },
      );
      if (res.ok) {
        setEditing(null);
        setCorrectedPhone("");
        setNote("");
        load();
      }
    } catch {
      /* non-fatal */
    } finally {
      setSaving(false);
    }
  }

  const openCount = fixes.filter((f) => f.status === "open").length;

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "0.5rem",
          marginBottom: "0.75rem",
        }}
      >
        <div>
          <h2 style={{ margin: 0 }}>Contact Info Fixes</h2>
          <div style={{ color: "#64748b", fontSize: "0.85rem" }}>
            Family phone lines flagged as bad. Enter a corrected number — it
            overrides the SIS value until updated.
          </div>
        </div>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.4rem",
            fontSize: "0.85rem",
            color: "#334155",
          }}
        >
          <input
            type="checkbox"
            checked={showResolved}
            onChange={(e) => setShowResolved(e.target.checked)}
          />
          Show resolved
        </label>
      </div>

      {!showResolved && (
        <div
          style={{
            marginBottom: "0.75rem",
            fontSize: "0.85rem",
            fontWeight: 600,
            color: openCount > 0 ? "#b91c1c" : "#16a34a",
          }}
        >
          {openCount > 0
            ? `${openCount} number${openCount === 1 ? "" : "s"} need attention`
            : "All caught up — no open fixes"}
        </div>
      )}

      {loading ? (
        <div style={{ color: "#94a3b8" }}>Loading…</div>
      ) : fixes.length === 0 ? (
        <div style={{ color: "#94a3b8" }}>
          {showResolved
            ? "No contact-info fixes on record."
            : "No bad numbers flagged. Nice."}
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", fontSize: "0.78rem", color: "#64748b" }}>
                <th style={{ padding: "0.4rem 0.5rem" }}>Student</th>
                <th style={{ padding: "0.4rem 0.5rem" }}>Contact</th>
                <th style={{ padding: "0.4rem 0.5rem" }}>Bad number</th>
                <th style={{ padding: "0.4rem 0.5rem" }}>Reason</th>
                <th style={{ padding: "0.4rem 0.5rem" }}>Flagged</th>
                <th style={{ padding: "0.4rem 0.5rem" }}>Status</th>
                <th style={{ padding: "0.4rem 0.5rem" }} />
              </tr>
            </thead>
            <tbody>
              {fixes.map((f) => (
                <React.Fragment key={f.id}>
                  <tr style={{ borderTop: "1px solid #e2e8f0", fontSize: "0.85rem" }}>
                    <td style={{ padding: "0.5rem" }}>
                      <div style={{ fontWeight: 700, color: "#0f172a" }}>
                        {f.studentName}
                      </div>
                      <div style={{ color: "#94a3b8", fontSize: "0.75rem" }}>
                        {f.localSisId ?? "—"}
                      </div>
                    </td>
                    <td style={{ padding: "0.5rem" }}>
                      <div>{f.contactLabel ?? slotLabel(f.contactSlot)}</div>
                      <div style={{ color: "#94a3b8", fontSize: "0.75rem" }}>
                        {slotLabel(f.contactSlot)}
                      </div>
                    </td>
                    <td style={{ padding: "0.5rem" }}>
                      <div
                        style={{
                          textDecoration: "line-through",
                          color: "#dc2626",
                        }}
                      >
                        {f.badPhone ?? "—"}
                      </div>
                      {f.correctedPhone && (
                        <div style={{ color: "#16a34a", fontWeight: 600 }}>
                          → {f.correctedPhone}
                        </div>
                      )}
                      {f.sisDisagrees && (
                        <div
                          style={{
                            marginTop: "0.2rem",
                            fontSize: "0.72rem",
                            fontWeight: 700,
                            color: "#b45309",
                          }}
                        >
                          ⚠ SIS now shows {f.sisPhone}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: "0.5rem" }}>{f.reason}</td>
                    <td style={{ padding: "0.5rem" }}>
                      <div>{fmt(f.flaggedAt)}</div>
                      <div style={{ color: "#94a3b8", fontSize: "0.75rem" }}>
                        by {f.flaggedByName}
                      </div>
                    </td>
                    <td style={{ padding: "0.5rem" }}>
                      {f.status === "open" ? (
                        <span style={{ color: "#b91c1c", fontWeight: 700 }}>
                          Open
                        </span>
                      ) : (
                        <span style={{ color: "#16a34a", fontWeight: 700 }}>
                          Resolved
                        </span>
                      )}
                    </td>
                    <td style={{ padding: "0.5rem", textAlign: "right" }}>
                      {f.status === "open" ? (
                        <button
                          type="button"
                          onClick={() => {
                            setEditing(editing === f.id ? null : f.id);
                            setCorrectedPhone("");
                            setNote("");
                          }}
                          style={{
                            padding: "0.3rem 0.6rem",
                            borderRadius: "0.4rem",
                            border: "1px solid #2563eb",
                            background: editing === f.id ? "#eff6ff" : "#2563eb",
                            color: editing === f.id ? "#2563eb" : "#fff",
                            cursor: "pointer",
                            fontSize: "0.78rem",
                            fontWeight: 600,
                          }}
                        >
                          {editing === f.id ? "Cancel" : "Fix"}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                  {editing === f.id && (
                    <tr style={{ background: "#f8fafc" }}>
                      <td colSpan={7} style={{ padding: "0.75rem" }}>
                        <div
                          style={{
                            display: "flex",
                            flexWrap: "wrap",
                            gap: "0.6rem",
                            alignItems: "flex-end",
                          }}
                        >
                          <label style={{ fontSize: "0.8rem", color: "#334155" }}>
                            <div style={{ marginBottom: "0.2rem" }}>
                              Corrected number
                            </div>
                            <input
                              type="tel"
                              value={correctedPhone}
                              onChange={(e) => setCorrectedPhone(e.target.value)}
                              placeholder="(000) 000-0000"
                              style={{
                                padding: "0.4rem 0.6rem",
                                borderRadius: "0.4rem",
                                border: "1px solid #cbd5e1",
                                minWidth: "180px",
                              }}
                            />
                          </label>
                          <label
                            style={{
                              fontSize: "0.8rem",
                              color: "#334155",
                              flex: 1,
                              minWidth: "200px",
                            }}
                          >
                            <div style={{ marginBottom: "0.2rem" }}>
                              Note (optional)
                            </div>
                            <input
                              type="text"
                              value={note}
                              onChange={(e) => setNote(e.target.value)}
                              placeholder="e.g. confirmed with mom 6/27"
                              style={{
                                padding: "0.4rem 0.6rem",
                                borderRadius: "0.4rem",
                                border: "1px solid #cbd5e1",
                                width: "100%",
                              }}
                            />
                          </label>
                          <button
                            type="button"
                            disabled={saving}
                            onClick={() => resolve(f.id)}
                            style={{
                              padding: "0.45rem 0.9rem",
                              borderRadius: "0.4rem",
                              border: "none",
                              background: "#16a34a",
                              color: "#fff",
                              cursor: "pointer",
                              fontWeight: 600,
                            }}
                          >
                            {saving ? "Saving…" : "Save correction"}
                          </button>
                          <button
                            type="button"
                            disabled={saving}
                            onClick={() => resolve(f.id)}
                            title="Close without entering a number"
                            style={{
                              padding: "0.45rem 0.9rem",
                              borderRadius: "0.4rem",
                              border: "1px solid #cbd5e1",
                              background: "#fff",
                              color: "#64748b",
                              cursor: "pointer",
                            }}
                          >
                            Dismiss
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
