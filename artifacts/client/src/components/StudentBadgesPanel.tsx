import { useState } from "react";
import { authFetch } from "../lib/authToken";

// Admin tool — print Student ID badges (PDF, one per Letter page,
// QR + house ribbon + barcode). Backed by
// POST /api/students/id-badges.pdf which is admin-gated and
// school-scoped on the server side.
//
// Two modes:
//   - "Print all" — every student in the school
//   - "Print a specific list" — paste a comma-separated student
//     student_id list (the visible one printed on the badge), we
//     resolve internal ids server-side
type BadgeSize = "lanyard" | "cr80";

export function StudentBadgesPanel() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [idList, setIdList] = useState("");
  // Default to lanyard — most schools issue these on lanyards. CR80
  // is the standard credit-card / hard-plastic-ID size for printers
  // that take blank CR80 cards.
  const [size, setSize] = useState<BadgeSize>("lanyard");

  async function download(payload: { all: true } | { studentIds: number[] }) {
    setBusy(true);
    setError("");
    try {
      const res = await authFetch("/api/students/id-badges.pdf", {
        method: "POST",
        body: JSON.stringify({ ...payload, size }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error ?? `PDF failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `student-id-badges-${new Date().toISOString().slice(0, 10)}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function printSelection() {
    // Server accepts numeric internal ids; the visible student_id
    // (e.g. "12345") doesn't map 1:1. We expose two simple paths
    // here — "all", or an internal-id list pasted by an admin who
    // pulled it from the importer / SIS extract. This keeps the
    // panel useful without dragging in a full student picker UI.
    const ids = idList
      .split(/[\s,]+/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
    if (ids.length === 0) {
      setError("Paste one or more numeric student record ids (comma-separated).");
      return;
    }
    await download({ studentIds: ids });
  }

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <h2 style={{ marginTop: 0 }}>Student ID Badges</h2>
      <p style={{ color: "var(--text-subtle)", marginTop: 0 }}>
        Printable badges with the student's name, grade, school, house
        ribbon, and a QR + Code 128 of their student ID. Students scan
        these at the kiosk to sign in to class or create a hall pass.
      </p>

      <fieldset
        style={{
          border: "1px solid var(--border, rgba(0,0,0,0.15))",
          borderRadius: 6,
          padding: "0.5rem 0.75rem",
          margin: "0 0 0.75rem 0",
        }}
      >
        <legend style={{ fontSize: "0.85rem", padding: "0 0.35rem" }}>
          Badge size
        </legend>
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            marginRight: "1rem",
            cursor: "pointer",
          }}
        >
          <input
            type="radio"
            name="badge-size"
            value="lanyard"
            checked={size === "lanyard"}
            onChange={() => setSize("lanyard")}
            disabled={busy}
          />
          <span>
            Lanyard <span style={{ opacity: 0.65 }}>(3⅜″ × 4¼″, portrait)</span>
          </span>
        </label>
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            cursor: "pointer",
          }}
        >
          <input
            type="radio"
            name="badge-size"
            value="cr80"
            checked={size === "cr80"}
            onChange={() => setSize("cr80")}
            disabled={busy}
          />
          <span>
            CR80 card <span style={{ opacity: 0.65 }}>(3⅜″ × 2⅛″, landscape)</span>
          </span>
        </label>
      </fieldset>

      {error && (
        <div
          style={{
            color: "#b91c1c",
            background: "rgba(220,38,38,0.08)",
            border: "1px solid rgba(220,38,38,0.3)",
            padding: "0.5rem 0.75rem",
            borderRadius: 6,
            marginBottom: "0.75rem",
            fontSize: "0.9rem",
          }}
        >
          {error}
        </div>
      )}

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "0.75rem",
          alignItems: "flex-end",
        }}
      >
        <button
          type="button"
          disabled={busy}
          onClick={() => download({ all: true })}
          style={{
            background: "#2563eb",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            padding: "0.7rem 1.25rem",
            fontWeight: 600,
            cursor: busy ? "not-allowed" : "pointer",
            opacity: busy ? 0.7 : 1,
          }}
        >
          {busy ? "Generating…" : "Print all student badges"}
        </button>
      </div>

      <details style={{ marginTop: "1rem" }}>
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>
          Print a specific list (advanced)
        </summary>
        <div style={{ marginTop: "0.5rem" }}>
          <label
            style={{
              display: "block",
              fontSize: "0.9rem",
              marginBottom: 4,
              opacity: 0.8,
            }}
          >
            Internal student record ids (comma-separated)
          </label>
          <textarea
            value={idList}
            onChange={(e) => setIdList(e.target.value)}
            rows={3}
            placeholder="e.g. 102, 103, 215"
            style={{
              width: "100%",
              padding: "0.5rem",
              borderRadius: 6,
              border: "1px solid var(--border, rgba(0,0,0,0.15))",
              fontFamily: "inherit",
              boxSizing: "border-box",
            }}
          />
          <button
            type="button"
            disabled={busy}
            onClick={printSelection}
            style={{
              marginTop: "0.5rem",
              background: "#0f766e",
              color: "#fff",
              border: "none",
              borderRadius: 6,
              padding: "0.55rem 1rem",
              fontWeight: 600,
              cursor: busy ? "not-allowed" : "pointer",
              opacity: busy ? 0.7 : 1,
            }}
          >
            Print selected
          </button>
        </div>
      </details>
    </div>
  );
}

export default StudentBadgesPanel;
