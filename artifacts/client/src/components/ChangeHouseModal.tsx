// =============================================================================
// ChangeHouseModal — admin-only single-student house change with required
// reason. Opens from the StudentProfile header (house pill). Calls
// PATCH /api/students/:studentId/house, which writes the new house and
// appends an audit row visible in the HousesPanel "Recent changes" tab.
// =============================================================================
import React, { useEffect, useState } from "react";
import { authFetch } from "../lib/authToken";

type House = { id: number; name: string; color: string };

type Props = {
  studentId: string;
  studentName: string;
  currentHouseId: number | null;
  onClose: () => void;
  onSaved: (next: { id: number; name: string; color: string } | null) => void;
};

export default function ChangeHouseModal({
  studentId,
  studentName,
  currentHouseId,
  onClose,
  onSaved,
}: Props): React.ReactElement {
  const [houses, setHouses] = useState<House[] | null>(null);
  const [pickedId, setPickedId] = useState<number | "none">(
    currentHouseId ?? "none",
  );
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch("/api/houses");
        const body = (await res.json()) as {
          houses?: Array<{ id: number; name: string; color: string }>;
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok) {
          setErr(body.error ?? "Could not load houses");
          return;
        }
        setHouses(body.houses ?? []);
      } catch (e) {
        if (!cancelled)
          setErr(e instanceof Error ? e.message : "Could not load houses");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    setErr(null);
    if (reason.trim().length < 10) {
      setErr("Reason is required (at least 10 characters).");
      return;
    }
    const houseId = pickedId === "none" ? null : pickedId;
    if (houseId === currentHouseId) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      const res = await authFetch(
        `/api/students/${encodeURIComponent(studentId)}/house`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ houseId, reason: reason.trim() }),
        },
      );
      const body = (await res.json()) as {
        ok: boolean;
        houseId?: number | null;
        error?: string;
      };
      if (!res.ok) {
        setErr(body.error ?? `Save failed (${res.status})`);
        return;
      }
      const nextHouse =
        houseId === null
          ? null
          : (houses?.find((h) => h.id === houseId) ?? null);
      onSaved(nextHouse);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "white",
          borderRadius: 8,
          padding: "1.25rem",
          minWidth: 360,
          maxWidth: 480,
          boxShadow: "0 10px 30px rgba(15,23,42,0.25)",
        }}
      >
        <h3 style={{ marginTop: 0 }}>Change house — {studentName}</h3>
        <div style={{ marginBottom: "0.75rem" }}>
          <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>
            House
          </label>
          {houses === null ? (
            <div style={{ color: "#475569" }}>Loading houses…</div>
          ) : (
            <select
              value={pickedId}
              onChange={(e) =>
                setPickedId(
                  e.target.value === "none" ? "none" : Number(e.target.value),
                )
              }
              style={{ width: "100%", padding: "0.4rem" }}
            >
              <option value="none">— None —</option>
              {houses.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <div style={{ marginBottom: "0.75rem" }}>
          <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>
            Reason (required, min. 10 characters)
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            style={{ width: "100%", padding: "0.4rem" }}
            placeholder="e.g. Re-balancing after sibling transfer in."
          />
          <div style={{ color: "#94a3b8", fontSize: "0.78rem" }}>
            {reason.trim().length}/10
          </div>
        </div>
        {err && (
          <div
            style={{
              color: "#991b1b",
              background: "#fee2e2",
              border: "1px solid #fecaca",
              padding: "0.4rem 0.6rem",
              borderRadius: 6,
              marginBottom: "0.5rem",
            }}
          >
            {err}
          </div>
        )}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: "0.5rem",
          }}
        >
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy || houses === null}
            onClick={save}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
