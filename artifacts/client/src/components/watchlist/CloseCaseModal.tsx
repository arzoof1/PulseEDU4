import { useEffect, useState } from "react";
import { authFetch } from "../../lib/authToken";

// Required-outcome modal for closing a case. There is intentionally no
// skip path — the close button is disabled until the user picks an
// outcome from the per-school catalog. The "other" outcome additionally
// requires a 5+ char note explaining what the catalog couldn't capture.

interface OutcomeRow {
  id: number;
  code: string;
  label: string;
  description: string;
}

interface Props {
  caseId: number;
  caseTitle: string;
  open: boolean;
  onClose: () => void;
  onClosed: () => void;
}

export default function CloseCaseModal({
  caseId,
  caseTitle,
  open,
  onClose,
  onClosed,
}: Props) {
  const [outcomes, setOutcomes] = useState<OutcomeRow[]>([]);
  const [code, setCode] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCode("");
    setNote("");
    setErr(null);
    void (async () => {
      const r = await authFetch("/api/watchlist/case-outcomes");
      const j = (await r.json()) as { outcomes: OutcomeRow[] };
      setOutcomes(j.outcomes ?? []);
    })();
  }, [open]);

  if (!open) return null;

  const isOther = code === "other";
  const noteOk = !isOther || note.trim().length >= 5;
  const canSubmit = !!code && noteOk && !busy;

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await authFetch(`/api/watchlist/cases/${caseId}/close`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcomeCode: code, outcomeNote: note }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setErr(j.error ?? "Failed to close case");
        return;
      }
      onClosed();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--card-bg, #fff)",
          color: "var(--ink, #111)",
          padding: "1.5rem",
          borderRadius: 10,
          minWidth: 460,
          maxWidth: 560,
        }}
      >
        <h2 style={{ marginTop: 0 }}>Close case</h2>
        <p style={{ color: "var(--ink-soft)" }}>
          <strong>{caseTitle}</strong>
        </p>
        <label style={{ display: "block", marginTop: "0.75rem" }}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>
            Outcome <span style={{ color: "#A1390B" }}>*</span>
          </div>
          <select
            value={code}
            onChange={(e) => setCode(e.target.value)}
            style={{ width: "100%", padding: "0.4rem", marginTop: 4 }}
          >
            <option value="">Pick an outcome…</option>
            {outcomes.map((o) => (
              <option key={o.code} value={o.code}>
                {o.label}
              </option>
            ))}
          </select>
          {code &&
            outcomes.find((o) => o.code === code)?.description && (
              <div
                style={{
                  fontSize: 11,
                  color: "var(--ink-soft)",
                  marginTop: 4,
                }}
              >
                {outcomes.find((o) => o.code === code)?.description}
              </div>
            )}
        </label>

        <label style={{ display: "block", marginTop: "0.75rem" }}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>
            Note {isOther ? <span style={{ color: "#A1390B" }}>*</span> : <span style={{ color: "var(--ink-soft)" }}>(optional)</span>}
          </div>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder={
              isOther
                ? "Required for 'Other' — what was the actual outcome?"
                : "Add detail visible in the audit trail."
            }
            style={{ width: "100%", marginTop: 4, padding: "0.4rem" }}
          />
        </label>

        {err && (
          <div
            style={{
              marginTop: "0.5rem",
              padding: "0.5rem",
              background: "#FFE4E1",
              color: "#7A1F1F",
              borderRadius: 6,
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
            marginTop: "1rem",
          }}
        >
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSubmit}
            style={{
              background: "#9F1D1D",
              color: "#fff",
              padding: "0.4rem 0.9rem",
              borderRadius: 6,
              opacity: canSubmit ? 1 : 0.5,
            }}
          >
            Close case
          </button>
        </div>
      </div>
    </div>
  );
}
