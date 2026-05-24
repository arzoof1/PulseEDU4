// Algebra I Placement Review (Phase-1 Historical FAST work).
//
// Read-only roster of every current 7th grader at the school whose
// current-year Math PM3 is Level 3+ — the cohort Florida statute
// flags for automatic Algebra I placement. Counselors + admins can
// record a parent-opt-out override (required justification + parent
// conversation confirmation + optional opt-out PDF upload).
//
// Server contract: see artifacts/api-server/src/routes/algebraPlacement.ts.
// Multi-tenant via req.schoolId — no cross-school view exists.

import { useCallback, useEffect, useState, type ReactElement } from "react";
import { authFetch } from "../lib/authToken";

interface TrajectoryPoint {
  schoolYear: string;
  score: number | null;
  level: 1 | 2 | 3 | 4 | 5 | null;
  gradeAtTime: number;
  isHistorical: boolean;
}

interface PlacementRow {
  studentId: string;
  localSisId: string | null;
  firstName: string;
  lastName: string;
  grade: number;
  trajectory: TrajectoryPoint[];
  override: {
    id: number;
    decision: string;
    justification: string;
    optOutFileObjectKey: string | null;
    decidedByStaffId: number;
    decidedByName: string | null;
    decidedAt: string;
  } | null;
  proposedPlacement: string;
  nsoPct: number | null;
  arPct: number | null;
  currentLevel: 3 | 4 | 5;
}

interface PlacementResponse {
  schoolYear: string;
  windowVisible: number;
  rows: PlacementRow[];
  overrideCount: number;
  // Optional defensively: an older server (pre-deploy) won't return
  // this field. Component guards against undefined to avoid crashing
  // mid-deploy when the bundled client outruns the API.
  levelCounts?: { l5: number; l4: number; l3: number };
  canSaveOverride: boolean;
}

function strandCell(pct: number | null): ReactElement {
  if (pct == null) {
    return (
      <span style={{ color: "var(--text-subtle, #6b7280)" }}>—</span>
    );
  }
  const color =
    pct < 50 ? "#991b1b" : pct < 70 ? "#92400e" : "#166534";
  const bg =
    pct < 50 ? "#fee2e2" : pct < 70 ? "#fef3c7" : "#dcfce7";
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 6px",
        borderRadius: 4,
        background: bg,
        color,
        fontSize: 12,
        fontWeight: 600,
      }}
    >
      {pct}%
    </span>
  );
}

function levelChip(p: TrajectoryPoint): ReactElement {
  // Matches the app-wide FAST palette (see TeacherRosterPage LEVEL_BG/
  // BUCKET_FILL): L1 red, L2 orange, L3 green, L4 blue, L5 purple.
  const lvl = p.level;
  const bg =
    lvl == null
      ? "#f3f4f6"
      : lvl === 1
        ? "#fee2e2"
        : lvl === 2
          ? "#fef3c7"
          : lvl === 3
            ? "#dcfce7"
            : lvl === 4
              ? "#dbeafe"
              : "#ede9fe";
  const fg =
    lvl == null
      ? "#6b7280"
      : lvl === 1
        ? "#7f1d1d"
        : lvl === 2
          ? "#78350f"
          : lvl === 3
            ? "#14532d"
            : lvl === 4
              ? "#1e3a8a"
              : "#4c1d95";
  return (
    <span
      title={
        p.isHistorical
          ? `${p.schoolYear} PM3 (historical back-fill) · grade ${p.gradeAtTime} at time of test`
          : `${p.schoolYear} PM3 · grade ${p.gradeAtTime} at time of test`
      }
      style={{
        display: "inline-block",
        padding: "2px 6px",
        borderRadius: 4,
        background: bg,
        color: fg,
        fontSize: 11,
        fontWeight: 600,
        marginRight: 4,
        border: p.isHistorical ? "1px dashed #94a3b8" : "1px solid transparent",
      }}
    >
      {p.schoolYear} {lvl != null ? `L${lvl}` : "—"}
    </span>
  );
}

export default function AlgebraPlacementReview({
  onBack,
}: {
  onBack: () => void;
}) {
  const [data, setData] = useState<PlacementResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalStudent, setModalStudent] = useState<PlacementRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await authFetch("/api/algebra-placement");
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setError(j.error ?? `Load failed (HTTP ${r.status})`);
        return;
      }
      setData(await r.json());
    } catch (e) {
      setError(`Load failed: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const downloadExport = async (kind: "csv" | "pdf") => {
    const r = await authFetch(`/api/algebra-placement/${kind}`);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      alert(j.error ?? `Export failed (HTTP ${r.status})`);
      return;
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `algebra-placement-${data?.schoolYear ?? "current"}.${kind}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const deleteOverride = async (id: number) => {
    if (!window.confirm("Remove this opt-out override?")) return;
    const r = await authFetch(`/api/algebra-placement/overrides/${id}`, {
      method: "DELETE",
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      alert(j.error ?? `Delete failed (HTTP ${r.status})`);
      return;
    }
    await load();
  };

  return (
    <div style={{ padding: "1rem 1.25rem" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <button
          type="button"
          onClick={onBack}
          style={{
            padding: "4px 10px",
            background: "transparent",
            border: "1px solid var(--border, #cbd5e1)",
            borderRadius: 4,
            cursor: "pointer",
          }}
        >
          ← Back
        </button>
        <h2 style={{ margin: 0 }}>Algebra I Placement Review</h2>
        {data && (
          <span style={{ color: "var(--text-subtle, #6b7280)", fontSize: 13 }}>
            · {data.schoolYear} · {data.rows.length} student
            {data.rows.length === 1 ? "" : "s"}
            {data.levelCounts && (
              <>
                {" "}
                (L5 {data.levelCounts.l5} · L4 {data.levelCounts.l4} · L3{" "}
                {data.levelCounts.l3})
              </>
            )}{" "}
            · {data.overrideCount} opt-out
            {data.overrideCount === 1 ? "" : "s"}
          </span>
        )}
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button
            type="button"
            disabled={!data || data.rows.length === 0}
            onClick={() => downloadExport("csv")}
            style={{
              padding: "4px 10px",
              borderRadius: 4,
              border: "1px solid var(--border, #cbd5e1)",
              cursor: "pointer",
            }}
          >
            Download CSV
          </button>
          <button
            type="button"
            disabled={!data || data.rows.length === 0}
            onClick={() => downloadExport("pdf")}
            style={{
              padding: "4px 10px",
              borderRadius: 4,
              border: "1px solid var(--border, #cbd5e1)",
              cursor: "pointer",
            }}
          >
            Download PDF
          </button>
        </div>
      </div>

      <p style={{ fontSize: 13, color: "var(--text-subtle, #6b7280)" }}>
        Florida statute auto-places every 7th grader at FAST Math PM3 Level 3+
        into Algebra I the following year. This roster is the placement cohort
        for the current school year. Counselors and admins may record a
        parent-opt-out override below; the override carries a required
        justification and an optional opt-out form upload (kept school-local
        in object storage).
      </p>

      {loading && <p>Loading…</p>}
      {error && (
        <p style={{ color: "var(--danger, #b91c1c)" }}>Error: {error}</p>
      )}

      {data && data.rows.length === 0 && !loading && (
        <p>No current 7th graders at PM3 Level 3+ yet. Once the current-year FAST Math PM3 is loaded, the cohort will populate here.</p>
      )}

      {data && data.rows.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 13,
            }}
          >
            <thead>
              <tr style={{ textAlign: "left", background: "var(--surface-2, #f1f5f9)" }}>
                <th style={{ padding: 6 }}>SIS ID</th>
                <th style={{ padding: 6 }}>Student</th>
                <th style={{ padding: 6 }}>Trajectory (oldest → newest)</th>
                <th
                  style={{ padding: 6 }}
                  title="Number Sense & Operations — current-year PM3 strand mastery"
                >
                  NSO
                </th>
                <th
                  style={{ padding: 6 }}
                  title="Algebraic Reasoning — current-year PM3 strand mastery (sort key)"
                >
                  AR ↑
                </th>
                <th style={{ padding: 6 }}>Placement</th>
                <th style={{ padding: 6 }}>Override</th>
                {data.canSaveOverride && <th style={{ padding: 6 }}></th>}
              </tr>
            </thead>
            <tbody>
              {([5, 4, 3] as const).flatMap((lvl) => {
                const sectionRows = data.rows.filter(
                  (r) => r.currentLevel === lvl,
                );
                if (sectionRows.length === 0) return [];
                // FAST palette: L3 green, L4 blue, L5 purple
                // (matches TeacherRosterPage LEVEL_BG / BUCKET_FILL).
                const sectionBg =
                  lvl === 5 ? "#ede9fe" : lvl === 4 ? "#dbeafe" : "#dcfce7";
                const sectionFg =
                  lvl === 5 ? "#4c1d95" : lvl === 4 ? "#1e3a8a" : "#14532d";
                const colSpan = data.canSaveOverride ? 8 : 7;
                return [
                  <tr key={`hdr-${lvl}`}>
                    <td
                      colSpan={colSpan}
                      style={{
                        padding: "6px 8px",
                        background: sectionBg,
                        color: sectionFg,
                        fontWeight: 700,
                        fontSize: 12,
                        letterSpacing: 0.2,
                      }}
                    >
                      Level {lvl} — {sectionRows.length} student
                      {sectionRows.length === 1 ? "" : "s"} · sorted by AR
                      mastery, weakest first
                    </td>
                  </tr>,
                  ...sectionRows.map((r) => (
                    <tr
                      key={r.studentId}
                      style={{ borderTop: "1px solid var(--border, #e2e8f0)" }}
                    >
                      <td style={{ padding: 6, fontFamily: "monospace" }}>
                        {r.localSisId ?? "—"}
                      </td>
                      <td style={{ padding: 6 }}>
                        {r.lastName}, {r.firstName}
                      </td>
                      <td style={{ padding: 6 }}>
                        {[...r.trajectory].reverse().map((p, i) => (
                          <span key={i}>{levelChip(p)}</span>
                        ))}
                      </td>
                      <td style={{ padding: 6, whiteSpace: "nowrap" }}>
                        {strandCell(r.nsoPct)}
                      </td>
                      <td style={{ padding: 6, whiteSpace: "nowrap" }}>
                        {strandCell(r.arPct)}
                      </td>
                      <td style={{ padding: 6 }}>
                        {r.override ? (
                          <span style={{ color: "#92400e", fontWeight: 600 }}>
                            {r.proposedPlacement}
                          </span>
                        ) : (
                          <span>{r.proposedPlacement}</span>
                        )}
                      </td>
                      <td style={{ padding: 6, fontSize: 12 }}>
                        {r.override ? (
                          <div>
                            <div title={r.override.justification}>
                              {r.override.justification.length > 80
                                ? `${r.override.justification.slice(0, 80)}…`
                                : r.override.justification}
                            </div>
                            <div
                              style={{
                                color: "var(--text-subtle, #6b7280)",
                              }}
                            >
                              by {r.override.decidedByName ?? "—"} ·{" "}
                              {new Date(
                                r.override.decidedAt,
                              ).toLocaleDateString()}
                            </div>
                          </div>
                        ) : (
                          <span
                            style={{ color: "var(--text-subtle, #6b7280)" }}
                          >
                            —
                          </span>
                        )}
                      </td>
                      {data.canSaveOverride && (
                        <td style={{ padding: 6, whiteSpace: "nowrap" }}>
                          {r.override ? (
                            <button
                              type="button"
                              onClick={() =>
                                deleteOverride(r.override!.id)
                              }
                              style={{
                                padding: "2px 8px",
                                fontSize: 12,
                                borderRadius: 4,
                                border: "1px solid var(--border, #cbd5e1)",
                                cursor: "pointer",
                              }}
                            >
                              Remove
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setModalStudent(r)}
                              style={{
                                padding: "2px 8px",
                                fontSize: 12,
                                borderRadius: 4,
                                border: "1px solid #b45309",
                                background: "#fef3c7",
                                color: "#92400e",
                                cursor: "pointer",
                              }}
                            >
                              Opt out…
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  )),
                ];
              })}
            </tbody>
          </table>
        </div>
      )}

      {modalStudent && (
        <OverrideModal
          row={modalStudent}
          onClose={() => setModalStudent(null)}
          onSaved={async () => {
            setModalStudent(null);
            await load();
          }}
        />
      )}
    </div>
  );
}

function OverrideModal({
  row,
  onClose,
  onSaved,
}: {
  row: PlacementRow;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [justification, setJustification] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [optOutFileObjectKey, setOptOutFileObjectKey] = useState<string | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const uploadFile = async (file: File) => {
    setErr(null);
    try {
      // Storage contract is two-step (see routes/storage.ts):
      //   POST /api/storage/uploads/request-url → { uploadURL, objectPath }
      //   PUT  <uploadURL> ← file bytes (GCS-signed)
      //   persist objectPath as the canonical key; server later binds
      //   it to this school via bindObjectToSchool.
      const presign = await authFetch("/api/storage/uploads/request-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, contentType: file.type }),
      });
      if (!presign.ok) {
        throw new Error(`request-url HTTP ${presign.status}`);
      }
      const j = (await presign.json()) as {
        uploadURL: string;
        objectPath: string;
      };
      const put = await fetch(j.uploadURL, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!put.ok) throw new Error(`PUT HTTP ${put.status}`);
      setOptOutFileObjectKey(j.objectPath);
    } catch (e) {
      setErr(`Upload failed: ${(e as Error).message}`);
    }
  };

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const r = await authFetch("/api/algebra-placement/overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId: row.studentId,
          justification,
          parentOptOutConfirmed: confirmed,
          optOutFileObjectKey,
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setErr(j.error ?? `Save failed (HTTP ${r.status})`);
        return;
      }
      await onSaved();
    } catch (e) {
      setErr(`Save failed: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--surface, #fff)",
          color: "var(--text, #0f172a)",
          padding: 20,
          borderRadius: 8,
          width: "min(560px, 92vw)",
          boxShadow: "0 20px 50px rgba(0,0,0,0.35)",
        }}
      >
        <h3 style={{ marginTop: 0 }}>
          Opt out: {row.firstName} {row.lastName}
        </h3>
        <p style={{ fontSize: 13, color: "var(--text-subtle, #64748b)" }}>
          Records that the parent has opted this student out of automatic
          Algebra I placement. The student will be placed in Regular 8th
          Math next year instead. Audit-logged.
        </p>
        <label style={{ display: "block", fontSize: 13, marginTop: 12 }}>
          Justification (required, 10–2000 characters)
          <textarea
            value={justification}
            onChange={(e) => setJustification(e.target.value)}
            rows={4}
            maxLength={2000}
            style={{
              width: "100%",
              marginTop: 4,
              padding: 8,
              borderRadius: 4,
              border: "1px solid var(--border, #cbd5e1)",
              font: "inherit",
              background: "var(--surface, #fff)",
              color: "inherit",
            }}
          />
        </label>
        <label
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            marginTop: 10,
            fontSize: 13,
          }}
        >
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            style={{ marginTop: 3 }}
          />
          <span>
            I confirm the parent-opt-out conversation took place and the
            parent agreed to Regular 8th Math placement.
          </span>
        </label>
        <label
          style={{
            display: "block",
            fontSize: 13,
            marginTop: 10,
          }}
        >
          Optional: attach signed opt-out form (PDF)
          <input
            type="file"
            accept="application/pdf"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void uploadFile(f);
            }}
            style={{ display: "block", marginTop: 4 }}
          />
          {optOutFileObjectKey && (
            <span style={{ fontSize: 12, color: "#166534" }}>
              ✓ Attached
            </span>
          )}
        </label>
        {err && (
          <p style={{ color: "var(--danger, #b91c1c)", marginTop: 10, fontSize: 13 }}>
            {err}
          </p>
        )}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 16,
          }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            style={{
              padding: "6px 12px",
              border: "1px solid var(--border, #cbd5e1)",
              borderRadius: 4,
              background: "transparent",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={
              saving ||
              justification.trim().length < 10 ||
              !confirmed
            }
            style={{
              padding: "6px 12px",
              borderRadius: 4,
              border: "1px solid #b45309",
              background: "#f59e0b",
              color: "#fff",
              cursor: "pointer",
            }}
          >
            {saving ? "Saving…" : "Save override"}
          </button>
        </div>
      </div>
    </div>
  );
}
