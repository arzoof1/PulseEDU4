import { useEffect, useState } from "react";
import { authFetch } from "../lib/authToken";

// Per-school admin panel for managing teacher kiosk activation cards.
//
// What admins can do here:
//   - See every active teacher and whether they have a live enrollment
//     token (a "card").
//   - "Generate cards for all active teachers" — one-click bulk seed.
//   - Regenerate a single teacher's card (revokes their old token,
//     prints a fresh one — useful when the previous card was lost).
//   - "Print all cards (PDF)" — downloads a multi-page printable PDF
//     with one card per teacher.  ⚠️ This ROTATES every selected
//     token. We warn loudly before downloading.
//   - "Activate sub for…" (Core Team only) — pick a teacher, pick a
//     room, pick today-vs-14d, opens the kiosk pre-activated in a new
//     tab.

interface TokenRow {
  staffId: number;
  displayName: string;
  email: string | null;
  isAdmin: boolean;
  defaultRoom: string | null;
  tokenId: number | null;
  tokenCreatedAt: string | null;
  tokenLastUsedAt: string | null;
}

interface AuthUserLite {
  id?: number;
  isAdmin?: boolean;
  isSuperUser?: boolean;
  isBehaviorSpecialist?: boolean;
  isMtssCoordinator?: boolean;
  isSchoolPsychologist?: boolean;
  isDistrictAdmin?: boolean;
}

export function KioskCardsPanel({
  authUser,
}: {
  authUser: AuthUserLite | null;
}) {
  const [rows, setRows] = useState<TokenRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  // After a regenerate, we show the raw token + PIN in a "print
  // immediately" modal — it's the only time this data is visible.
  const [reveal, setReveal] = useState<{
    staffName: string;
    enrollToken: string;
    pin: string;
  } | null>(null);
  const [subDraft, setSubDraft] = useState<{
    forStaffId: number;
    forStaffName: string;
    room: string;
    durationKind: "today" | "14d";
  } | null>(null);

  const isCoreTeam = Boolean(
    authUser?.isSuperUser ||
      authUser?.isDistrictAdmin ||
      authUser?.isAdmin ||
      authUser?.isBehaviorSpecialist ||
      authUser?.isMtssCoordinator ||
      authUser?.isSchoolPsychologist,
  );

  async function load() {
    setLoading(true);
    setError("");
    try {
      const res = await authFetch("/api/kiosk/enroll-tokens");
      if (!res.ok) throw new Error(`Load failed (${res.status})`);
      const data: TokenRow[] = await res.json();
      setRows(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function bulkGenerate() {
    if (
      !window.confirm(
        "Generate a kiosk card for every active teacher who doesn't already have one? Existing cards are not changed.",
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      const res = await authFetch("/api/kiosk/enroll-tokens/bulk-generate", {
        method: "POST",
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error ?? `Bulk-generate failed (${res.status})`);
      }
      const data = await res.json();
      window.alert(
        `Created ${data.created} new cards. ${data.alreadyHad} teachers already had one. Use "Print all cards" to print everything (this will rotate every token).`,
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function regenerateOne(row: TokenRow) {
    if (
      !window.confirm(
        `Generate a new kiosk card for ${row.displayName}? Their previous card (if any) will stop working immediately.`,
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      const res = await authFetch(
        `/api/kiosk/enroll-tokens/regenerate/${row.staffId}`,
        { method: "POST" },
      );
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error ?? `Regenerate failed (${res.status})`);
      }
      const data = await res.json();
      setReveal({
        staffName: data.staffName,
        enrollToken: data.enrollToken,
        pin: data.pin,
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Cards endpoint is POST (it rotates tokens — we don't want GET
  // navigation/CSRF triggering silent invalidation). Fetch the PDF as
  // a blob, then trigger a download via an anchor element.
  async function downloadCardsPdf(
    payload: { all: true } | { staffIds: number[] },
    filename: string,
  ) {
    setBusy(true);
    setError("");
    try {
      const res = await authFetch("/api/kiosk/cards.pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error ?? `PDF generation failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function printAll() {
    if (
      !window.confirm(
        "Print cards for EVERY active teacher? This ROTATES every existing token — old cards will stop working as soon as the PDF is generated. Only do this if you're about to hand out the new cards.",
      )
    )
      return;
    void downloadCardsPdf({ all: true }, `kiosk-cards-all.pdf`);
  }

  function printOne(row: TokenRow) {
    if (
      !window.confirm(
        `Print a single card for ${row.displayName}? This rotates their token — their previous card will stop working.`,
      )
    )
      return;
    void downloadCardsPdf(
      { staffIds: [row.staffId] },
      `kiosk-card-${row.staffId}.pdf`,
    );
  }

  async function submitProxy() {
    if (!subDraft) return;
    if (!subDraft.room.trim()) {
      setError("Pick a room for the sub kiosk");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await authFetch("/api/kiosk/activate-proxy", {
        method: "POST",
        body: JSON.stringify({
          forStaffId: subDraft.forStaffId,
          room: subDraft.room.trim(),
          durationKind: subDraft.durationKind,
        }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error ?? `Proxy activation failed (${res.status})`);
      }
      const data = await res.json();
      // The activation row is now live server-side. Hand the kiosk
      // token off via the URL so the new tab can pick it up. (Reuses
      // the same activation/token flow as a normal sign-in.)
      const kioskUrl = `${window.location.origin}${import.meta.env.BASE_URL}kiosk?token=${encodeURIComponent(data.token)}`;
      window.open(kioskUrl, "_blank", "noopener,noreferrer");
      setSubDraft(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const filtered = rows.filter((r) =>
    filter.trim()
      ? r.displayName.toLowerCase().includes(filter.trim().toLowerCase())
      : true,
  );
  const haveCards = rows.filter((r) => r.tokenId != null).length;

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.5rem",
          flexWrap: "wrap",
        }}
      >
        <h2 style={{ margin: 0 }}>
          Kiosk Cards{" "}
          <span style={{ color: "var(--text-subtle)", fontWeight: 400 }}>
            ({haveCards} of {rows.length} teachers have cards)
          </span>
        </h2>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <button type="button" onClick={() => void load()} disabled={busy}>
            Refresh
          </button>
          <button
            type="button"
            onClick={() => void bulkGenerate()}
            disabled={busy}
          >
            Generate missing cards
          </button>
          <button
            type="button"
            onClick={printAll}
            disabled={busy || rows.length === 0}
          >
            Print all cards (PDF)
          </button>
        </div>
      </div>

      <p style={{ color: "var(--text-subtle)", marginTop: "0.5rem" }}>
        Each card has a QR code, a Code 128 barcode, and a 6-digit PIN.
        Teachers scan or type to activate a classroom kiosk for 14
        days. Reprinting a card rotates the token — the old printout
        immediately stops working.
      </p>

      {error && (
        <div
          style={{
            background: "rgba(239,68,68,0.1)",
            border: "1px solid rgba(239,68,68,0.4)",
            color: "#b91c1c",
            padding: "0.5rem 0.75rem",
            borderRadius: 6,
            marginBottom: "0.75rem",
          }}
        >
          {error}
        </div>
      )}

      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.75rem" }}>
        <input
          type="text"
          value={filter}
          placeholder="Filter teachers…"
          onChange={(e) => setFilter(e.target.value)}
          style={{ flex: 1, padding: "0.4rem 0.6rem" }}
        />
      </div>

      {loading ? (
        <p style={{ color: "var(--text-subtle)" }}>Loading…</p>
      ) : filtered.length === 0 ? (
        <p style={{ color: "var(--text-subtle)" }}>No teachers match.</p>
      ) : (
        <table
          className="pulse-table"
          style={{ width: "100%", borderCollapse: "collapse" }}
        >
          <thead>
            <tr>
              <th style={{ textAlign: "left", padding: "0.5rem" }}>Teacher</th>
              <th style={{ textAlign: "left", padding: "0.5rem" }}>Room</th>
              <th style={{ textAlign: "left", padding: "0.5rem" }}>Card</th>
              <th style={{ textAlign: "left", padding: "0.5rem" }}>
                Last used
              </th>
              <th style={{ padding: "0.5rem" }}></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.staffId} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "0.5rem" }}>{r.displayName}</td>
                <td
                  style={{
                    padding: "0.5rem",
                    color: r.defaultRoom ? undefined : "var(--text-subtle)",
                  }}
                >
                  {r.defaultRoom ?? "—"}
                </td>
                <td style={{ padding: "0.5rem" }}>
                  {r.tokenId ? (
                    <span style={{ color: "#15803d" }}>
                      Issued{" "}
                      {r.tokenCreatedAt
                        ? new Date(r.tokenCreatedAt).toLocaleDateString()
                        : ""}
                    </span>
                  ) : (
                    <span style={{ color: "var(--text-subtle)" }}>No card</span>
                  )}
                </td>
                <td
                  style={{
                    padding: "0.5rem",
                    color: "var(--text-subtle)",
                    fontSize: "0.85rem",
                  }}
                >
                  {r.tokenLastUsedAt
                    ? new Date(r.tokenLastUsedAt).toLocaleString([], {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })
                    : "—"}
                </td>
                <td
                  style={{
                    padding: "0.5rem",
                    whiteSpace: "nowrap",
                    textAlign: "right",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => void regenerateOne(r)}
                    disabled={busy}
                    style={{ marginRight: 4 }}
                  >
                    {r.tokenId ? "Reissue" : "Issue"}
                  </button>
                  {r.tokenId && (
                    <button
                      type="button"
                      onClick={() => printOne(r)}
                      disabled={busy}
                      style={{ marginRight: 4 }}
                    >
                      Print card
                    </button>
                  )}
                  {isCoreTeam && (
                    <button
                      type="button"
                      onClick={() =>
                        setSubDraft({
                          forStaffId: r.staffId,
                          forStaffName: r.displayName,
                          room: r.defaultRoom ?? "",
                          durationKind: "today",
                        })
                      }
                      disabled={busy}
                    >
                      Activate sub
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {reveal && (
        <RevealModal
          {...reveal}
          onClose={() => setReveal(null)}
        />
      )}

      {subDraft && (
        <SubModal
          draft={subDraft}
          onChange={setSubDraft}
          onCancel={() => setSubDraft(null)}
          onSubmit={() => void submitProxy()}
          busy={busy}
        />
      )}
    </div>
  );
}

function RevealModal({
  staffName,
  enrollToken,
  pin,
  onClose,
}: {
  staffName: string;
  enrollToken: string;
  pin: string;
  onClose: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.65)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1.5rem",
        zIndex: 50,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "white",
          color: "#111",
          borderRadius: 12,
          padding: "1.5rem",
          width: "min(520px, 92vw)",
          display: "flex",
          flexDirection: "column",
          gap: "1rem",
        }}
      >
        <div>
          <h3 style={{ margin: 0 }}>Card issued for {staffName}</h3>
          <p style={{ color: "#555", fontSize: "0.85rem", marginTop: 4 }}>
            This is the only time we&apos;ll show this token + PIN. Use
            &quot;Print card&quot; if you want a printable layout instead.
          </p>
        </div>
        <div>
          <div style={{ fontSize: "0.75rem", color: "#666" }}>
            6-digit PIN
          </div>
          <div
            style={{
              fontFamily: "ui-monospace, SFMono-Regular, monospace",
              fontSize: "2rem",
              letterSpacing: "0.4em",
              fontWeight: 700,
            }}
          >
            {pin}
          </div>
        </div>
        <div>
          <div style={{ fontSize: "0.75rem", color: "#666" }}>
            Enrollment token (encoded in QR + barcode)
          </div>
          <code
            style={{
              display: "block",
              background: "#f5f5f5",
              padding: "0.5rem",
              borderRadius: 6,
              wordBreak: "break-all",
              fontSize: "0.8rem",
            }}
          >
            {enrollToken}
          </code>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" onClick={onClose}>
            I&apos;ve recorded this — close
          </button>
        </div>
      </div>
    </div>
  );
}

function SubModal({
  draft,
  onChange,
  onCancel,
  onSubmit,
  busy,
}: {
  draft: {
    forStaffId: number;
    forStaffName: string;
    room: string;
    durationKind: "today" | "14d";
  };
  onChange: (
    next: {
      forStaffId: number;
      forStaffName: string;
      room: string;
      durationKind: "today" | "14d";
    } | null,
  ) => void;
  onCancel: () => void;
  onSubmit: () => void;
  busy: boolean;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.65)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1.5rem",
        zIndex: 50,
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "white",
          color: "#111",
          borderRadius: 12,
          padding: "1.5rem",
          width: "min(480px, 92vw)",
          display: "flex",
          flexDirection: "column",
          gap: "1rem",
        }}
      >
        <div>
          <h3 style={{ margin: 0 }}>Activate sub kiosk</h3>
          <p style={{ color: "#555", fontSize: "0.85rem", marginTop: 4 }}>
            Opens a kiosk pre-activated as <b>{draft.forStaffName}</b>.
            The kiosk shows their name to students; the audit log
            records you as the activator.
          </p>
        </div>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: "0.85rem", color: "#555" }}>Room</span>
          <input
            type="text"
            value={draft.room}
            onChange={(e) => onChange({ ...draft, room: e.target.value })}
            disabled={busy}
            style={{ padding: "0.5rem" }}
            autoFocus
          />
        </label>
        <fieldset
          style={{
            border: "1px solid #e5e5e5",
            borderRadius: 6,
            padding: "0.5rem 0.75rem",
            display: "flex",
            flexDirection: "column",
            gap: "0.25rem",
          }}
        >
          <legend style={{ fontSize: "0.85rem", color: "#555" }}>
            Duration
          </legend>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="radio"
              checked={draft.durationKind === "today"}
              onChange={() => onChange({ ...draft, durationKind: "today" })}
              disabled={busy}
            />
            <span>Today only (recommended for single-day subs)</span>
          </label>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="radio"
              checked={draft.durationKind === "14d"}
              onChange={() => onChange({ ...draft, durationKind: "14d" })}
              disabled={busy}
            />
            <span>14 days (long-term sub block)</span>
          </label>
        </fieldset>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={busy || !draft.room.trim()}
          >
            {busy ? "Activating…" : "Activate & open kiosk"}
          </button>
        </div>
      </div>
    </div>
  );
}
