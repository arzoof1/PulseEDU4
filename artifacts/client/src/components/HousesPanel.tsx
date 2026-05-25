// =============================================================================
// HousesPanel — admin tooling for PBIS house placement.
//
// Two sub-tabs on top of the existing live "House Rankings" signage screen
// (mounted by the parent caller in App.tsx):
//   1. Bulk sort — preview / commit / 24h undo of an even house re-balance
//      across the school's roster. Keeps siblings together by default.
//   2. Recent changes — append-only audit log of who moved which student
//      to which house, when, and why (or the bulk sort job tag).
//
// All endpoints under /api/houses/sort/* and /api/houses/changes are
// admin/superuser-only on the server; this panel mirrors that with a
// soft-fail empty state so non-admins accidentally pointed here see a
// friendly message instead of a 403 toast.
// =============================================================================
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/authToken";

type House = { id: number; name: string; color: string };

type PreviewResp = {
  ok: boolean;
  includeAssigned: boolean;
  keepSiblings: boolean;
  houses: House[];
  currentCounts: Record<string, number>;
  proposedCounts: Record<string, number>;
  // Per-student proposed assignment list. Already returned by the
  // server; surfaced here so the admin can spot-check who is moving
  // where before they commit. `fromHouseId` is null for currently
  // unplaced students.
  moves: Array<{
    studentDbId: number;
    fromHouseId: number | null;
    toHouseId: number;
  }>;
  students?: Array<{
    id: number;
    studentId: string;
    firstName: string;
    lastName: string;
  }>;
  totalEligible: number;
  totalChanged: number;
  // Sibling-pin summary surfaced by the server so the admin can see
  // *why* a particular new student is heading to a specific house —
  // an already-placed sibling pins the rest of the family there.
  // Optional for forward-compat with older server builds.
  siblingPins?: {
    groupCount: number;
    studentCount: number;
    byHouse: Record<string, number>;
    sampleNames: string[];
    // Per-sample structured payload — same students as `sampleNames`,
    // same order. Carries the anchoring sibling ("elder") so the UI
    // can click through to that student's profile to sanity-check
    // the pin. `elder` is null only on degenerate data (the elder
    // row was deleted between compute and resolve); `studentId`
    // (text) is null only on the same degenerate path for the
    // pinned student itself. Optional for forward-compat with
    // older server builds that only returned `sampleNames`.
    samples?: Array<{
      studentDbId: number;
      studentId: string | null;
      name: string;
      elder: {
        studentDbId: number;
        studentId: string;
        name: string;
        houseId: number;
      } | null;
    }>;
    // Soft-warning payload computed by the server. When `lopsided`
    // is true, the UI surfaces a yellow inline notice naming the
    // heaviest and lightest pinned houses so the admin can decide
    // whether to keep "Keep siblings together" on. Optional for
    // forward-compat with older server builds.
    skew?: {
      lopsided: boolean;
      heaviestHouseId: number | null;
      heaviestCount: number;
      lightestHouseId: number | null;
      lightestCount: number;
      minPins: number;
      houseShare: number;
      ratio: number;
    };
  };
};

type ChangesResp = {
  rows: Array<{
    id: number;
    studentDbId: number;
    fromHouseId: number | null;
    // Nullable: the schema allows clearing a student's house, which
    // emits an audit row with toHouseId=null. The UI renders that as
    // "(none)" — see the lookups.house.get(r.toHouseId) ?? null path.
    toHouseId: number | null;
    reason: string;
    source: "manual" | "bulk_sort" | "undo";
    sortJobId: number | null;
    changedAt: string;
    changedByStaffId: number;
  }>;
  houses: House[];
  staff: Array<{ id: number; displayName: string }>;
  students: Array<{
    id: number;
    studentId: string;
    firstName: string;
    lastName: string;
  }>;
  undoable: {
    jobId: number;
    committedAt: string;
    affectedCount: number;
    expiresAt: string;
  } | null;
};

function pillStyle(color: string): React.CSSProperties {
  return {
    display: "inline-block",
    padding: "0.15rem 0.55rem",
    borderRadius: 999,
    background: color || "#e5e7eb",
    color: "#0f172a",
    fontSize: "0.78rem",
    fontWeight: 700,
    border: "1px solid rgba(15,23,42,0.12)",
  };
}

export default function HousesPanel({
  onOpenStudent,
}: {
  // Click-through from a pinned sibling name to the anchoring
  // sibling's profile. Optional so the panel still renders for
  // callers that haven't wired the host's student-profile router
  // yet — in that case names render as plain text.
  onOpenStudent?: (studentId: string) => void;
} = {}): React.ReactElement {
  const [tab, setTab] = useState<"sort" | "audit" | "appearance">("sort");
  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: "1rem" }}>
        <button
          type="button"
          className={tab === "sort" ? "btn primary" : "btn"}
          onClick={() => setTab("sort")}
        >
          Bulk sort
        </button>
        <button
          type="button"
          className={tab === "audit" ? "btn primary" : "btn"}
          onClick={() => setTab("audit")}
        >
          Recent changes
        </button>
        <button
          type="button"
          className={tab === "appearance" ? "btn primary" : "btn"}
          onClick={() => setTab("appearance")}
        >
          House logos
        </button>
      </div>
      {tab === "sort" ? (
        <SortTab
          onGoToAudit={() => setTab("audit")}
          onOpenStudent={onOpenStudent}
        />
      ) : tab === "audit" ? (
        <AuditTab />
      ) : (
        <AppearanceTab />
      )}
    </div>
  );
}

// =============================================================================
// AppearanceTab — admin uploads a custom logo (PNG/JPEG) per house. Logos
// appear on printed Student ID badges alongside the house color. Uses the
// shared /api/storage/uploads/request-url presigned-PUT pipeline; the
// bind step (POST /api/houses/:id/logo) attaches the object to the
// house's row and to the school's ACL.
// =============================================================================
type HouseAppearance = {
  id: number;
  name: string;
  color: string;
  iconKey: string | null;
  iconObjectKey: string | null;
  studentCount: number;
  staffCount: number;
};

function AppearanceTab(): React.ReactElement {
  const [houses, setHouses] = useState<HouseAppearance[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await authFetch("/api/houses/with-staff-counts");
      if (!res.ok) {
        setHouses([]);
        setErr(`Could not load houses (${res.status})`);
        return;
      }
      const body = (await res.json()) as { houses?: HouseAppearance[] };
      setHouses(Array.isArray(body.houses) ? body.houses : []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load houses");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function uploadLogo(houseId: number, file: File): Promise<void> {
    if (file.size > 2 * 1024 * 1024) {
      setErr("Logo must be 2 MB or smaller.");
      return;
    }
    const ok = ["image/png", "image/jpeg", "image/webp"].includes(file.type);
    if (!ok) {
      setErr("Logo must be a PNG, JPEG, or WebP image (SVG not supported on PDF badges).");
      return;
    }
    setBusyId(houseId);
    setErr(null);
    try {
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
      const putRes = await fetch(uploadURL, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!putRes.ok) throw new Error("Upload failed");
      const bindRes = await authFetch(`/api/houses/${houseId}/logo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ objectPath }),
      });
      const bindBody = (await bindRes.json()) as { error?: string };
      if (!bindRes.ok) {
        throw new Error(bindBody.error ?? `Could not save logo (${bindRes.status})`);
      }
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Logo upload failed");
    } finally {
      setBusyId(null);
    }
  }

  async function clearLogo(houseId: number): Promise<void> {
    if (!window.confirm("Remove the custom logo for this house? Badges will fall back to the colored initial.")) {
      return;
    }
    setBusyId(houseId);
    setErr(null);
    try {
      const res = await authFetch(`/api/houses/${houseId}/logo`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Could not remove logo (${res.status})`);
      }
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not remove logo");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>House logos for printed Student ID badges</h3>
      <p style={{ color: "#475569", marginTop: 0 }}>
        Upload a small PNG, JPEG, or WebP image (max 2 MB) for each house. The
        logo prints next to the house name on every student ID badge that's
        assigned to that house. Square images work best.
      </p>
      {err && (
        <div
          style={{
            margin: "0.5rem 0",
            color: "#991b1b",
            background: "#fee2e2",
            border: "1px solid #fecaca",
            padding: "0.5rem 0.75rem",
            borderRadius: 6,
          }}
        >
          {err}
        </div>
      )}
      {loading ? (
        <p style={{ color: "#94a3b8" }}>Loading houses…</p>
      ) : houses.length === 0 ? (
        <p style={{ color: "#475569" }}>
          No PBIS houses configured for this school yet.
        </p>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
            gap: "0.75rem",
          }}
        >
          {houses.map((h) => (
            <div
              key={h.id}
              style={{
                border: "1px solid #e2e8f0",
                borderRadius: 8,
                padding: "0.75rem",
                background: "#fff",
                display: "flex",
                flexDirection: "column",
                gap: "0.5rem",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={pillStyle(h.color)}>{h.name}</span>
                <span style={{ color: "#94a3b8", fontSize: "0.78rem" }}>
                  {h.studentCount} student{h.studentCount === 1 ? "" : "s"}
                </span>
              </div>
              <div
                style={{
                  height: 96,
                  borderRadius: 6,
                  background: h.color || "#e2e8f0",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  overflow: "hidden",
                }}
              >
                {h.iconObjectKey ? (
                  <img
                    src={`/api/storage${h.iconObjectKey}`}
                    alt={`${h.name} logo`}
                    style={{
                      maxHeight: 80,
                      maxWidth: "85%",
                      background: "#fff",
                      borderRadius: 4,
                      padding: 4,
                    }}
                  />
                ) : (
                  <span
                    style={{
                      color: "#fff",
                      fontWeight: 700,
                      fontSize: 36,
                      opacity: 0.85,
                    }}
                  >
                    {(h.name.charAt(0) || "H").toUpperCase()}
                  </span>
                )}
              </div>
              <label
                className="btn"
                style={{
                  display: "inline-block",
                  textAlign: "center",
                  cursor: busyId === h.id ? "not-allowed" : "pointer",
                  opacity: busyId === h.id ? 0.6 : 1,
                }}
              >
                {busyId === h.id
                  ? "Working…"
                  : h.iconObjectKey
                    ? "Replace logo"
                    : "Upload logo"}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  disabled={busyId === h.id}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) void uploadLogo(h.id, f);
                  }}
                  style={{ display: "none" }}
                />
              </label>
              {h.iconObjectKey && (
                <button
                  type="button"
                  className="btn"
                  disabled={busyId === h.id}
                  onClick={() => void clearLogo(h.id)}
                  style={{
                    color: "#991b1b",
                    borderColor: "#fecaca",
                  }}
                >
                  Remove logo
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SortTab({
  onGoToAudit,
  onOpenStudent,
}: {
  onGoToAudit: () => void;
  onOpenStudent?: (studentId: string) => void;
}): React.ReactElement {
  const [includeAssigned, setIncludeAssigned] = useState(false);
  const [keepSiblings, setKeepSiblings] = useState(true);
  // Required (≥10 chars) only when includeAssigned is on, mirroring
  // the server gate in routes/houses.ts. Persisted on every audit
  // row this commit produces so the move can be defended later.
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResp | null>(null);
  const [committing, setCommitting] = useState(false);
  const [lastCommit, setLastCommit] = useState<{
    affectedCount: number;
    jobId: number | null;
  } | null>(null);

  const runPreview = useCallback(async () => {
    setLoading(true);
    setErr(null);
    setLastCommit(null);
    try {
      const res = await authFetch("/api/houses/sort/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ includeAssigned, keepSiblings }),
      });
      const body = (await res.json()) as PreviewResp & { error?: string };
      if (!res.ok) {
        setErr(body.error ?? `Preview failed (${res.status})`);
        setPreview(null);
        return;
      }
      setPreview(body);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Preview failed");
    } finally {
      setLoading(false);
    }
  }, [includeAssigned, keepSiblings]);

  const runCommit = useCallback(async () => {
    if (!preview) return;
    if (
      !window.confirm(
        `Apply this sort? ${preview.totalChanged} student${
          preview.totalChanged === 1 ? "" : "s"
        } will be reassigned. You'll have 24 hours to undo.`,
      )
    )
      return;
    setCommitting(true);
    setErr(null);
    try {
      const res = await authFetch("/api/houses/sort/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          includeAssigned,
          keepSiblings,
          // Only send when required — keeps the API surface tidy
          // and matches the server-side conditional validation.
          ...(includeAssigned ? { reason: reason.trim() } : {}),
        }),
      });
      const body = (await res.json()) as {
        ok: boolean;
        affectedCount: number;
        jobId: number | null;
        error?: string;
      };
      if (!res.ok) {
        setErr(body.error ?? `Commit failed (${res.status})`);
        return;
      }
      setLastCommit({
        affectedCount: body.affectedCount,
        jobId: body.jobId,
      });
      setPreview(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Commit failed");
    } finally {
      setCommitting(false);
    }
  }, [preview, includeAssigned, keepSiblings, reason]);

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Bulk house placement</h3>
      <p style={{ color: "#475569", marginTop: 0 }}>
        Re-balance students across PBIS houses. Preview the proposed sort,
        then commit. You can undo any commit within 24 hours from the
        Recent changes tab.
      </p>
      <div
        style={{
          display: "flex",
          gap: "1.25rem",
          flexWrap: "wrap",
          margin: "0.75rem 0",
        }}
      >
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="checkbox"
            checked={includeAssigned}
            onChange={(e) => setIncludeAssigned(e.target.checked)}
          />
          Include students already assigned to a house
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="checkbox"
            checked={keepSiblings}
            onChange={(e) => setKeepSiblings(e.target.checked)}
          />
          Keep siblings together
        </label>
      </div>
      {includeAssigned && (
        <div style={{ margin: "0.5rem 0 0.75rem" }}>
          <label
            style={{
              display: "block",
              fontWeight: 600,
              marginBottom: 4,
              fontSize: "0.88rem",
            }}
          >
            Reason for re-sorting already-placed students (required, min.
            10 characters)
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            style={{ width: "100%", padding: "0.4rem", maxWidth: 520 }}
            placeholder="e.g. Rebalancing after Q2 enrollment surge."
          />
          <div style={{ color: "#94a3b8", fontSize: "0.78rem" }}>
            {reason.trim().length}/10
          </div>
        </div>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          className="btn primary"
          disabled={loading}
          onClick={runPreview}
        >
          {loading ? "Computing…" : "Preview sort"}
        </button>
        {preview && preview.totalChanged > 0 && (
          <button
            type="button"
            className="btn primary"
            disabled={
              committing ||
              (includeAssigned && reason.trim().length < 10)
            }
            onClick={runCommit}
            style={{ background: "#0f766e" }}
            title={
              includeAssigned && reason.trim().length < 10
                ? "Enter a reason (≥10 characters) to re-sort already-placed students."
                : ""
            }
          >
            {committing ? "Applying…" : `Commit (${preview.totalChanged})`}
          </button>
        )}
      </div>
      {err && (
        <div
          style={{
            marginTop: "0.75rem",
            color: "#991b1b",
            background: "#fee2e2",
            border: "1px solid #fecaca",
            padding: "0.5rem 0.75rem",
            borderRadius: 6,
          }}
        >
          {err}
        </div>
      )}
      {lastCommit && (
        <div
          style={{
            marginTop: "0.75rem",
            color: "#166534",
            background: "#dcfce7",
            border: "1px solid #bbf7d0",
            padding: "0.5rem 0.75rem",
            borderRadius: 6,
          }}
        >
          Reassigned {lastCommit.affectedCount} student
          {lastCommit.affectedCount === 1 ? "" : "s"}. Undo available for
          24 hours on the Recent changes tab.{" "}
          <button
            type="button"
            onClick={onGoToAudit}
            style={{
              background: "transparent",
              border: "none",
              color: "#166534",
              cursor: "pointer",
              padding: 0,
              textDecoration: "underline",
              fontWeight: 600,
            }}
          >
            Open Recent changes to undo →
          </button>
        </div>
      )}
      {preview && (
        <div style={{ marginTop: "1rem" }}>
          <h4 style={{ marginBottom: "0.5rem" }}>
            Proposed counts &middot; {preview.totalChanged} change
            {preview.totalChanged === 1 ? "" : "s"} out of{" "}
            {preview.totalEligible} eligible
          </h4>
          {preview.siblingPins?.skew?.lopsided && (() => {
            const sk = preview.siblingPins!.skew!;
            const houseLookup = new Map(preview.houses.map((h) => [h.id, h]));
            const heavy =
              sk.heaviestHouseId !== null
                ? houseLookup.get(sk.heaviestHouseId)
                : undefined;
            const light =
              sk.lightestHouseId !== null
                ? houseLookup.get(sk.lightestHouseId)
                : undefined;
            if (!heavy) return null;
            return (
              <div
                role="status"
                style={{
                  margin: "0.25rem 0 0.75rem",
                  background: "#fef9c3",
                  border: "1px solid #fde68a",
                  color: "#713f12",
                  borderRadius: 6,
                  padding: "0.5rem 0.75rem",
                  maxWidth: 520,
                  fontSize: "0.88rem",
                  lineHeight: 1.4,
                }}
              >
                Sibling pinning is sending {sk.heaviestCount} student
                {sk.heaviestCount === 1 ? "" : "s"} to{" "}
                <span style={pillStyle(heavy.color)}>{heavy.name}</span>
                {light && light.id !== heavy.id ? (
                  <>
                    {" "}vs.{" "}{sk.lightestCount}{" to "}
                    <span style={pillStyle(light.color)}>{light.name}</span>
                  </>
                ) : null}
                . Consider whether to keep "Keep siblings together" on for
                this sort.
              </div>
            );
          })()}
          {preview.siblingPins && preview.siblingPins.studentCount > 0 && (() => {
            const sp = preview.siblingPins!;
            const houseLookup = new Map(preview.houses.map((h) => [h.id, h]));
            const byHouseEntries = Object.entries(sp.byHouse)
              .map(([hid, n]) => ({
                house: houseLookup.get(Number(hid)),
                count: n,
              }))
              .filter((e) => e.house !== undefined)
              .sort((a, b) => b.count - a.count);
            return (
              <details
                style={{
                  margin: "0.25rem 0 0.75rem",
                  background: "#f1f5f9",
                  border: "1px solid #e2e8f0",
                  borderRadius: 6,
                  padding: "0.5rem 0.75rem",
                  maxWidth: 520,
                  fontSize: "0.88rem",
                }}
              >
                <summary
                  style={{ cursor: "pointer", color: "#334155" }}
                  title={
                    sp.sampleNames.length > 0
                      ? sp.sampleNames.join("\n")
                      : undefined
                  }
                >
                  {sp.studentCount} student
                  {sp.studentCount === 1 ? " is" : "s are"} pinned to a house
                  because of a sibling already there.
                </summary>
                <div style={{ marginTop: "0.5rem", color: "#475569" }}>
                  {byHouseEntries.length > 0 && (
                    <div style={{ marginBottom: "0.4rem" }}>
                      {byHouseEntries.map((e, i) => (
                        <span key={e.house!.id} style={{ marginRight: 8 }}>
                          <span style={pillStyle(e.house!.color)}>
                            {e.house!.name}
                          </span>{" "}
                          {e.count}
                          {i < byHouseEntries.length - 1 ? "" : ""}
                        </span>
                      ))}
                    </div>
                  )}
                  {sp.sampleNames.length > 0 && (
                    <div>
                      <span style={{ color: "#64748b" }}>
                        {sp.studentCount > sp.sampleNames.length
                          ? `First ${sp.sampleNames.length} of ${sp.studentCount}: `
                          : "Affected: "}
                      </span>
                      {sp.samples && sp.samples.length === sp.sampleNames.length ? (
                        // New structured payload — each pinned name
                        // links to the anchoring sibling's profile
                        // (the "elder" the server pinned the family
                        // to) so the admin can sanity-check the pin
                        // in one click instead of digging through
                        // the roster.
                        <span>
                          {sp.samples.map((sample, i) => {
                            const elder = sample.elder;
                            const elderHouse = elder
                              ? houseLookup.get(elder.houseId)
                              : undefined;
                            const canClick =
                              onOpenStudent && elder && elder.studentId;
                            return (
                              <span key={sample.studentDbId}>
                                {sample.name}
                                {elder && (
                                  <>
                                    {" → "}
                                    {canClick ? (
                                      <button
                                        type="button"
                                        onClick={() =>
                                          onOpenStudent!(elder.studentId)
                                        }
                                        title={`Open ${elder.name}'s profile`}
                                        style={{
                                          background: "transparent",
                                          border: "none",
                                          color: "#1d4ed8",
                                          cursor: "pointer",
                                          padding: 0,
                                          textDecoration: "underline",
                                          font: "inherit",
                                        }}
                                      >
                                        {elder.name}
                                      </button>
                                    ) : (
                                      <span>{elder.name}</span>
                                    )}
                                    {elderHouse && (
                                      <>
                                        {" "}
                                        <span
                                          style={{
                                            ...pillStyle(elderHouse.color),
                                            fontSize: "0.72rem",
                                            padding: "0.05rem 0.4rem",
                                          }}
                                        >
                                          {elderHouse.name}
                                        </span>
                                      </>
                                    )}
                                  </>
                                )}
                                {i < sp.samples!.length - 1 ? "; " : ""}
                              </span>
                            );
                          })}
                        </span>
                      ) : (
                        // Fallback for older server builds (or the
                        // degenerate case where samples and
                        // sampleNames drift apart) — preserve the
                        // original plain-text rendering.
                        sp.sampleNames.join("; ")
                      )}
                    </div>
                  )}
                </div>
              </details>
            );
          })()}
          {preview.houses.length === 0 ? (
            <p style={{ color: "#475569" }}>
              No PBIS houses configured for this school yet.
            </p>
          ) : (
            <table
              style={{
                borderCollapse: "collapse",
                width: "100%",
                maxWidth: 520,
              }}
            >
              <thead>
                <tr style={{ textAlign: "left", color: "#475569" }}>
                  <th style={{ padding: "4px 8px" }}>House</th>
                  <th style={{ padding: "4px 8px" }}>Current</th>
                  <th style={{ padding: "4px 8px" }}>Proposed</th>
                  <th style={{ padding: "4px 8px" }}>Δ</th>
                </tr>
              </thead>
              <tbody>
                {preview.houses.map((h) => {
                  const cur = preview.currentCounts[h.id] ?? 0;
                  const nxt = preview.proposedCounts[h.id] ?? 0;
                  const delta = nxt - cur;
                  return (
                    <tr key={h.id} style={{ borderTop: "1px solid #e5e7eb" }}>
                      <td style={{ padding: "6px 8px" }}>
                        <span style={pillStyle(h.color)}>{h.name}</span>
                      </td>
                      <td style={{ padding: "6px 8px" }}>{cur}</td>
                      <td style={{ padding: "6px 8px" }}>{nxt}</td>
                      <td
                        style={{
                          padding: "6px 8px",
                          color:
                            delta > 0
                              ? "#166534"
                              : delta < 0
                                ? "#991b1b"
                                : "#475569",
                          fontWeight: 600,
                        }}
                      >
                        {delta > 0 ? `+${delta}` : delta}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {/* Per-student proposed moves. Shown only for rows that
              actually change house — students whose target equals
              their current house are omitted to keep the list
              scannable. Capped at 200 rows; we surface a count if
              the plan is larger. */}
          {preview.moves.length > 0 && (() => {
            const studentLookup = new Map(
              (preview.students ?? []).map((s) => [s.id, s]),
            );
            const houseLookup = new Map(
              preview.houses.map((h) => [h.id, h]),
            );
            const changed = preview.moves.filter(
              (m) => m.fromHouseId !== m.toHouseId,
            );
            const shown = changed.slice(0, 200);
            return (
              <div style={{ marginTop: "1rem", maxWidth: 720 }}>
                <h4 style={{ marginBottom: "0.5rem" }}>
                  Proposed assignments
                  {changed.length > shown.length
                    ? ` (showing first ${shown.length} of ${changed.length})`
                    : ""}
                </h4>
                <div
                  style={{
                    maxHeight: 320,
                    overflowY: "auto",
                    border: "1px solid #e5e7eb",
                    borderRadius: 6,
                  }}
                >
                  <table style={{ borderCollapse: "collapse", width: "100%" }}>
                    <thead
                      style={{
                        position: "sticky",
                        top: 0,
                        background: "#f8fafc",
                      }}
                    >
                      <tr style={{ textAlign: "left", color: "#475569" }}>
                        <th style={{ padding: "4px 8px" }}>Student</th>
                        <th style={{ padding: "4px 8px" }}>From</th>
                        <th style={{ padding: "4px 8px" }}>To</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((m) => {
                        const stu = studentLookup.get(m.studentDbId);
                        const from =
                          m.fromHouseId == null
                            ? null
                            : (houseLookup.get(m.fromHouseId) ?? null);
                        const to = houseLookup.get(m.toHouseId) ?? null;
                        return (
                          <tr
                            key={m.studentDbId}
                            style={{ borderTop: "1px solid #e5e7eb" }}
                          >
                            <td style={{ padding: "4px 8px" }}>
                              {stu
                                ? `${stu.lastName}, ${stu.firstName} (${stu.studentId})`
                                : `#${m.studentDbId}`}
                            </td>
                            <td
                              style={{
                                padding: "4px 8px",
                                color: from ? "#0f172a" : "#94a3b8",
                              }}
                            >
                              {from ? from.name : "—"}
                            </td>
                            <td
                              style={{
                                padding: "4px 8px",
                                fontWeight: 600,
                                color: to?.color ?? "#0f172a",
                              }}
                            >
                              {to ? to.name : "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}

function AuditTab(): React.ReactElement {
  const [data, setData] = useState<ChangesResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [undoing, setUndoing] = useState(false);
  // Recent-changes filter: empty string = "All houses". Server-side
  // ?houseId=X narrows to bulk + manual moves that landed in that
  // house; "All" returns the unfiltered 200-row feed.
  const [houseFilter, setHouseFilter] = useState<string>("");
  // Snapshot of all houses for the filter dropdown. Loaded once
  // from /api/houses (separate from /houses/changes, which only
  // returns the houses referenced by the visible rows).
  const [houseOptions, setHouseOptions] = useState<House[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const url = houseFilter
        ? `/api/houses/changes?houseId=${encodeURIComponent(houseFilter)}`
        : "/api/houses/changes";
      const res = await authFetch(url);
      const body = (await res.json()) as ChangesResp & { error?: string };
      if (!res.ok) {
        setErr(body.error ?? `Load failed (${res.status})`);
        return;
      }
      setData(body);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, [houseFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  // Load the full house list once for the filter dropdown.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await authFetch("/api/houses");
        if (!res.ok) return;
        const body = (await res.json()) as { houses?: House[] };
        if (!cancelled && body.houses) setHouseOptions(body.houses);
      } catch {
        // non-fatal — filter just won't render
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const lookups = useMemo(() => {
    if (!data) {
      return {
        house: new Map<number, House>(),
        staff: new Map<number, string>(),
        student: new Map<
          number,
          { studentId: string; firstName: string; lastName: string }
        >(),
      };
    }
    return {
      house: new Map(data.houses.map((h) => [h.id, h])),
      staff: new Map(data.staff.map((s) => [s.id, s.displayName])),
      student: new Map(
        data.students.map((s) => [
          s.id,
          {
            studentId: s.studentId,
            firstName: s.firstName,
            lastName: s.lastName,
          },
        ]),
      ),
    };
  }, [data]);

  const undoLast = useCallback(async () => {
    if (!data?.undoable) return;
    const u = data.undoable;
    if (
      !window.confirm(
        `Undo the last bulk sort? ${u.affectedCount} student${
          u.affectedCount === 1 ? "" : "s"
        } will be restored to their previous house.`,
      )
    )
      return;
    setUndoing(true);
    setErr(null);
    try {
      const res = await authFetch(`/api/houses/sort/undo/${u.jobId}`, {
        method: "POST",
      });
      const body = (await res.json()) as {
        ok: boolean;
        restored: number;
        error?: string;
      };
      if (!res.ok) {
        setErr(body.error ?? `Undo failed (${res.status})`);
        return;
      }
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Undo failed");
    } finally {
      setUndoing(false);
    }
  }, [data, load]);

  if (loading) return <div className="card">Loading audit log…</div>;
  if (err)
    return (
      <div
        className="card"
        style={{ color: "#991b1b", background: "#fee2e2" }}
      >
        {err}
      </div>
    );
  if (!data) return <div className="card">No data.</div>;

  return (
    <div className="card">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          flexWrap: "wrap",
          gap: "1rem",
        }}
      >
        <div>
          <h3 style={{ marginTop: 0 }}>Recent house changes</h3>
          <p style={{ color: "#475569", marginTop: 0 }}>
            Most recent 200 entries. Manual changes show the reason
            entered by the editor; bulk sorts are tagged with the sort
            job they belong to.
          </p>
          {houseOptions.length > 0 && (
            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.5rem",
                fontSize: "0.875rem",
                color: "#475569",
              }}
            >
              Filter by house:
              <select
                value={houseFilter}
                onChange={(e) => setHouseFilter(e.target.value)}
                style={{
                  padding: "4px 8px",
                  border: "1px solid #cbd5e1",
                  borderRadius: 4,
                }}
              >
                <option value="">All houses</option>
                {houseOptions.map((h) => (
                  <option key={h.id} value={String(h.id)}>
                    {h.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {data.undoable && (
          <button
            type="button"
            className="btn"
            disabled={undoing}
            onClick={undoLast}
            style={{
              background: "#fef3c7",
              border: "1px solid #fcd34d",
              color: "#78350f",
              fontWeight: 600,
            }}
          >
            {undoing
              ? "Undoing…"
              : `Undo last sort (${data.undoable.affectedCount}, expires ${new Date(
                  data.undoable.expiresAt,
                ).toLocaleString()})`}
          </button>
        )}
      </div>
      {data.rows.length === 0 ? (
        <p style={{ color: "#475569" }}>No house changes recorded yet.</p>
      ) : (
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#475569" }}>
              <th style={{ padding: "6px 8px" }}>When</th>
              <th style={{ padding: "6px 8px" }}>Student</th>
              <th style={{ padding: "6px 8px" }}>From → To</th>
              <th style={{ padding: "6px 8px" }}>Reason</th>
              <th style={{ padding: "6px 8px" }}>By</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => {
              const stu = lookups.student.get(r.studentDbId);
              const from =
                r.fromHouseId == null
                  ? null
                  : (lookups.house.get(r.fromHouseId) ?? null);
              const to =
                r.toHouseId == null
                  ? null
                  : (lookups.house.get(r.toHouseId) ?? null);
              const by = lookups.staff.get(r.changedByStaffId) ?? "—";
              return (
                <tr key={r.id} style={{ borderTop: "1px solid #e5e7eb" }}>
                  <td
                    style={{
                      padding: "6px 8px",
                      whiteSpace: "nowrap",
                      color: "#475569",
                    }}
                  >
                    {new Date(r.changedAt).toLocaleString()}
                  </td>
                  <td style={{ padding: "6px 8px" }}>
                    {stu
                      ? `${stu.firstName} ${stu.lastName} (${stu.studentId})`
                      : `#${r.studentDbId}`}
                  </td>
                  <td style={{ padding: "6px 8px" }}>
                    {from ? (
                      <span style={pillStyle(from.color)}>{from.name}</span>
                    ) : (
                      <span style={{ color: "#94a3b8" }}>— none —</span>
                    )}
                    <span style={{ margin: "0 6px", color: "#94a3b8" }}>→</span>
                    {to ? (
                      <span style={pillStyle(to.color)}>{to.name}</span>
                    ) : (
                      <span style={{ color: "#94a3b8" }}>—</span>
                    )}
                  </td>
                  <td style={{ padding: "6px 8px" }}>
                    {r.reason}
                    {r.source === "bulk_sort" && r.sortJobId != null && (
                      <span style={{ color: "#94a3b8" }}>
                        {" "}
                        · job #{r.sortJobId}
                      </span>
                    )}
                    {r.source === "undo" && (
                      <span style={{ color: "#94a3b8" }}> · undo</span>
                    )}
                  </td>
                  <td style={{ padding: "6px 8px" }}>{by}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
