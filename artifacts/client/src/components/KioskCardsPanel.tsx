import { useEffect, useRef, useState } from "react";
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
  originLocations = [],
  onRoomSaved,
}: {
  authUser: AuthUserLite | null;
  /** Active origin rooms, used to drive every room dropdown in this panel. */
  originLocations?: string[];
  /** Fired after a teacher's default room changes (inline edit or CSV import). */
  onRoomSaved?: () => void;
}) {
  const [rows, setRows] = useState<TokenRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  // Per-row "saving room" spinner keyed by staffId.
  const [savingRoom, setSavingRoom] = useState<number | null>(null);
  const [showImport, setShowImport] = useState(false);
  // After a regenerate, we show the raw token + PIN in a "print
  // immediately" modal — it's the only time this data is visible.
  const [reveal, setReveal] = useState<{
    staffId: number;
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

  // Inline-save a teacher's default room straight from the cards table, so
  // an admin sets the room and issues the card in one place.
  async function saveRoom(staffId: number, room: string) {
    setSavingRoom(staffId);
    setError("");
    try {
      const res = await authFetch("/api/staff-defaults", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ staffId, defaultLocationName: room }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error ?? `Save failed (${res.status})`);
      }
      setRows((prev) =>
        prev.map((r) =>
          r.staffId === staffId
            ? { ...r, defaultRoom: room.trim() ? room : null }
            : r,
        ),
      );
      onRoomSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingRoom(null);
    }
  }

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
        staffId: row.staffId,
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

  // Cards endpoint is POST. Three accepted payload shapes:
  //   - `{ all: true }`             — rotates every active teacher's token
  //   - `{ staffIds: [...] }`       — rotates the listed teachers' tokens
  //   - `{ presupplied: [...] }`    — uses already-live raw token/PIN
  //                                    values; NO rotation. Used by the
  //                                    "Reissue → Print" single-row flow
  //                                    so the printed PDF's PIN matches
  //                                    the one we just showed in the
  //                                    reveal modal.
  // Fetch the PDF as a blob, then trigger a download via an anchor.
  async function downloadCardsPdf(
    payload:
      | { all: true }
      | { staffIds: number[] }
      | {
          presupplied: Array<{
            staffId: number;
            enrollToken: string;
            pin: string;
          }>;
        },
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

  // Teacher ID badges share the kiosk activation secret (QR + barcode +
  // PIN) so one lanyard card both IDs the teacher and activates their
  // room kiosk. Same endpoint contract as cards.pdf (all/staffIds/
  // presupplied) — the "all"/"staffIds" modes ROTATE tokens.
  async function downloadBadgesPdf(
    payload:
      | { all: true }
      | { staffIds: number[] }
      | {
          presupplied: Array<{
            staffId: number;
            enrollToken: string;
            pin: string;
          }>;
        },
    filename: string,
  ) {
    setBusy(true);
    setError("");
    try {
      const res = await authFetch("/api/kiosk/teacher-badges.pdf", {
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

  function printBadgesAll() {
    if (
      !window.confirm(
        "Print ID badges for EVERY active teacher? Each badge carries that teacher's live kiosk QR, barcode, and PIN — generating this ROTATES every token, so any card or badge already handed out stops working. Only do this when you're ready to distribute the new badges.",
      )
    )
      return;
    void downloadBadgesPdf({ all: true }, `teacher-id-badges-all.pdf`);
  }

  function printBadgeOne(row: TokenRow) {
    // Reuse freshly-revealed raw values when available (no rotation) so
    // the printed badge PIN matches what's on screen.
    if (
      reveal &&
      reveal.staffId === row.staffId &&
      reveal.enrollToken &&
      reveal.pin
    ) {
      void downloadBadgesPdf(
        {
          presupplied: [
            {
              staffId: row.staffId,
              enrollToken: reveal.enrollToken,
              pin: reveal.pin,
            },
          ],
        },
        `teacher-id-badge-${row.staffId}.pdf`,
      );
      return;
    }
    if (
      !window.confirm(
        `Print an ID badge for ${row.displayName}? The badge carries their live kiosk QR, barcode, and PIN — this rotates their token, so their previous card or badge stops working.`,
      )
    )
      return;
    void downloadBadgesPdf(
      { staffIds: [row.staffId] },
      `teacher-id-badge-${row.staffId}.pdf`,
    );
  }

  function printOne(row: TokenRow) {
    // If we still have the freshly-revealed raw values for this row
    // (typically right after "Reissue"), print THOSE — no rotation, so
    // the on-screen PIN and the PDF PIN stay in sync.
    if (
      reveal &&
      reveal.staffId === row.staffId &&
      reveal.enrollToken &&
      reveal.pin
    ) {
      void downloadCardsPdf(
        {
          presupplied: [
            {
              staffId: row.staffId,
              enrollToken: reveal.enrollToken,
              pin: reveal.pin,
            },
          ],
        },
        `kiosk-card-${row.staffId}.pdf`,
      );
      return;
    }
    // Otherwise we have no raw values in hand and must rotate to
    // produce a printable PIN. Warn loudly because this invalidates
    // any card the teacher might already be carrying.
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

  // Build a ready-to-edit CSV template. When the roster has loaded we
  // pre-fill one row per teacher — teacher column uses their email when we
  // have it (an exact, unambiguous match), else their display name — with
  // their current room pre-filled so the admin only edits what changed. This
  // guarantees the teacher column matches on re-upload. A leading BOM keeps
  // Excel happy with accented names; the importer strips it back off.
  function downloadTemplate() {
    const header = "teacher,room";
    const body =
      rows.length > 0
        ? rows
            .map((r) =>
              [
                csvCell(r.email?.trim() || r.displayName),
                csvCell(r.defaultRoom ?? ""),
              ].join(","),
            )
            .join("\r\n")
        : ["teacher@yourschool.org,Room 101", "Jane Smith,Room 102"].join(
            "\r\n",
          );
    const csv = `\uFEFF${header}\r\n${body}\r\n`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "kiosk-teacher-rooms-template.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
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
            onClick={downloadTemplate}
            title="Download a ready-to-edit CSV (your teachers pre-filled) for the room import"
          >
            Download CSV template
          </button>
          <button
            type="button"
            onClick={() => setShowImport(true)}
            disabled={busy}
            title="Bulk-assign teacher rooms from a CSV file"
          >
            Import rooms (CSV)
          </button>
          <button
            type="button"
            onClick={printAll}
            disabled={busy || rows.length === 0}
          >
            Print all cards (PDF)
          </button>
          <button
            type="button"
            onClick={printBadgesAll}
            disabled={busy || rows.length === 0}
            title="Lanyard ID badges (teacher photo + name + house) that also activate the room kiosk"
          >
            Teacher ID badges (PDF)
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
                <td style={{ padding: "0.5rem" }}>
                  <RoomCombobox
                    value={r.defaultRoom ?? ""}
                    options={originLocations}
                    disabled={savingRoom === r.staffId || busy}
                    onSelect={(room) => void saveRoom(r.staffId, room)}
                    compact
                  />
                  {savingRoom === r.staffId && (
                    <span
                      style={{
                        marginLeft: 6,
                        fontSize: 11,
                        color: "var(--text-subtle)",
                      }}
                    >
                      Saving…
                    </span>
                  )}
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
                  {r.tokenId && (
                    <button
                      type="button"
                      onClick={() => printBadgeOne(r)}
                      disabled={busy}
                      style={{ marginRight: 4 }}
                      title="Lanyard ID badge (photo + name + house) that also activates the kiosk"
                    >
                      Badge
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
          busy={busy}
          onPrint={() => {
            void downloadCardsPdf(
              {
                presupplied: [
                  {
                    staffId: reveal.staffId,
                    enrollToken: reveal.enrollToken,
                    pin: reveal.pin,
                  },
                ],
              },
              `kiosk-card-${reveal.staffName.replace(/\s+/g, "-")}.pdf`,
            );
          }}
          onClose={() => setReveal(null)}
        />
      )}

      {subDraft && (
        <SubModal
          draft={subDraft}
          originLocations={originLocations}
          onChange={setSubDraft}
          onCancel={() => setSubDraft(null)}
          onSubmit={() => void submitProxy()}
          busy={busy}
        />
      )}

      {showImport && (
        <ImportRoomsModal
          originLocations={originLocations}
          onClose={() => setShowImport(false)}
          onCommitted={() => {
            setShowImport(false);
            void load();
            onRoomSaved?.();
          }}
        />
      )}
    </div>
  );
}

function RevealModal({
  staffName,
  enrollToken,
  pin,
  busy,
  onPrint,
  onClose,
}: {
  staffName: string;
  enrollToken: string;
  pin: string;
  busy: boolean;
  onPrint: () => void;
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
          <button type="button" onClick={onPrint} disabled={busy}>
            {busy ? "Preparing PDF…" : "Print this card"}
          </button>
          <button type="button" onClick={onClose}>
            I&apos;ve recorded this — close
          </button>
        </div>
      </div>
    </div>
  );
}

const ROAMING_LABEL = "(none — roaming)";

// Searchable room picker. Behaves like a constrained combobox: the admin can
// type to filter the origin-room list, but can only commit a value that is a
// real origin room, the existing (legacy) room, or blank (= roaming). We use a
// custom listbox instead of a native <datalist> to avoid the datalist
// onChange-matcher pitfalls and to keep selection strictly constrained.
function RoomCombobox({
  value,
  options,
  onSelect,
  disabled,
  compact,
}: {
  value: string;
  options: string[];
  onSelect: (room: string) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const legacy = value && !options.includes(value) ? value : null;
  const all: Array<{ label: string; val: string; hint?: string }> = [
    { label: ROAMING_LABEL, val: "" },
    ...(legacy ? [{ label: legacy, val: legacy, hint: "legacy" }] : []),
    ...options.map((o) => ({ label: o, val: o })),
  ];
  const q = query.trim().toLowerCase();
  const filtered = q
    ? all.filter((o) => o.label.toLowerCase().includes(q))
    : all;

  const displayLabel = value || ROAMING_LABEL;

  function choose(val: string) {
    onSelect(val);
    setOpen(false);
    setQuery("");
    inputRef.current?.blur();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open && (e.key === "ArrowDown" || e.key === "Enter")) {
      setOpen(true);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = filtered[activeIdx];
      if (pick) choose(pick.val);
    } else if (e.key === "Escape") {
      setOpen(false);
      setQuery("");
    }
  }

  return (
    <div
      ref={wrapRef}
      style={{ position: "relative", maxWidth: compact ? 220 : undefined }}
    >
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={open}
        autoComplete="off"
        disabled={disabled}
        value={open ? query : displayLabel}
        placeholder={open ? "Type to search rooms…" : undefined}
        onFocus={() => {
          setOpen(true);
          setQuery("");
          setActiveIdx(0);
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActiveIdx(0);
        }}
        onKeyDown={onKeyDown}
        style={{
          padding: compact ? "0.3rem 0.4rem" : "0.5rem",
          width: "100%",
          color: value ? undefined : "var(--text-subtle, #64748b)",
        }}
      />
      {open && (
        <ul
          role="listbox"
          style={{
            position: "absolute",
            zIndex: 60,
            top: "calc(100% + 2px)",
            left: 0,
            right: 0,
            minWidth: compact ? 180 : undefined,
            maxHeight: 240,
            overflowY: "auto",
            margin: 0,
            padding: "0.25rem 0",
            listStyle: "none",
            background: "var(--surface, #fff)",
            color: "var(--text, #111)",
            border: "1px solid var(--border, #d1d5db)",
            borderRadius: 6,
            boxShadow: "0 6px 20px rgba(0,0,0,0.18)",
          }}
        >
          {filtered.length === 0 && (
            <li
              style={{
                padding: "0.4rem 0.6rem",
                color: "var(--text-subtle, #64748b)",
                fontSize: "0.85rem",
              }}
            >
              No matching room
            </li>
          )}
          {filtered.map((o, idx) => {
            const selected = o.val === value;
            const active = idx === activeIdx;
            return (
              <li
                key={`${o.val}-${o.label}`}
                role="option"
                aria-selected={selected}
                onMouseEnter={() => setActiveIdx(idx)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(o.val);
                }}
                style={{
                  padding: "0.4rem 0.6rem",
                  cursor: "pointer",
                  fontSize: "0.9rem",
                  background: active
                    ? "var(--surface-subtle, rgba(0,0,0,0.06))"
                    : "transparent",
                  color: o.val
                    ? undefined
                    : "var(--text-subtle, #64748b)",
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 8,
                  fontWeight: selected ? 600 : 400,
                }}
              >
                <span>{o.label}</span>
                {o.hint && (
                  <span
                    style={{
                      fontSize: "0.75rem",
                      color: "var(--text-subtle, #64748b)",
                    }}
                  >
                    {o.hint}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function SubModal({
  draft,
  onChange,
  originLocations,
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
  originLocations: string[];
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
          <RoomCombobox
            value={draft.room}
            options={originLocations}
            disabled={busy}
            onSelect={(room) => onChange({ ...draft, room })}
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

// Minimal two-column CSV parser. Handles quoted fields with embedded
// commas/quotes and CRLF line endings. Returns string[][] (rows of cells).
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += c;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const TEACHER_HEADERS = ["teacher", "name", "staff", "email", "teacher_name"];
const ROOM_HEADERS = ["room", "location", "default_room", "homeroom", "home_room"];

// Quote a single CSV cell when it contains a comma, quote, or newline so the
// template round-trips cleanly back through parseCsv on re-upload.
function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// CSV bulk room-assignment. The admin uploads a file with a teacher column
// (name or email) and a room column. We parse client-side, send the rows to
// the bulk endpoint for a dry-run preview, then commit on confirm.
function ImportRoomsModal({
  originLocations,
  onClose,
  onCommitted,
}: {
  originLocations: string[];
  onClose: () => void;
  onCommitted: () => void;
}) {
  const [rows, setRows] = useState<Array<{ teacher: string; room: string }>>([]);
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{
    matched: Array<{ staffId: number; staffName: string; room: string | null }>;
    unmatchedTeachers: string[];
    invalidRooms: Array<{ teacher: string; room: string }>;
  } | null>(null);
  const [done, setDone] = useState<number | null>(null);

  function handleFile(file: File) {
    setError("");
    setPreview(null);
    setDone(null);
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        // Strip a UTF-8 BOM so the first header cell (often "teacher")
        // matches; Excel/Sheets exports frequently prepend one.
        const text = String(reader.result ?? "").replace(/^\uFEFF/, "");
        const grid = parseCsv(text);
        if (grid.length < 2) {
          throw new Error("CSV needs a header row and at least one data row.");
        }
        const header = grid[0].map((h) => h.trim().toLowerCase());
        const teacherIdx = header.findIndex((h) => TEACHER_HEADERS.includes(h));
        const roomIdx = header.findIndex((h) => ROOM_HEADERS.includes(h));
        if (teacherIdx < 0 || roomIdx < 0) {
          throw new Error(
            "Couldn't find a teacher column (name/email) and a room column. Header names like 'teacher' or 'email' and 'room' are required.",
          );
        }
        const parsed = grid
          .slice(1)
          .map((r) => ({
            teacher: (r[teacherIdx] ?? "").trim(),
            room: (r[roomIdx] ?? "").trim(),
          }))
          .filter((r) => r.teacher);
        if (parsed.length === 0) throw new Error("No teacher rows found.");
        setRows(parsed);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setRows([]);
      }
    };
    reader.onerror = () => setError("Could not read the file.");
    reader.readAsText(file);
  }

  async function runPreview() {
    if (rows.length === 0) return;
    setBusy(true);
    setError("");
    try {
      const res = await authFetch("/api/staff-defaults/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows, commit: false }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error ?? `Preview failed (${res.status})`);
      }
      const data = await res.json();
      setPreview({
        matched: data.matched ?? [],
        unmatchedTeachers: data.unmatchedTeachers ?? [],
        invalidRooms: data.invalidRooms ?? [],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!preview || preview.matched.length === 0) return;
    setBusy(true);
    setError("");
    try {
      const res = await authFetch("/api/staff-defaults/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows, commit: true }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error ?? `Import failed (${res.status})`);
      }
      const data = await res.json();
      setDone(data.applied ?? 0);
      setTimeout(onCommitted, 900);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

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
          width: "min(640px, 94vw)",
          maxHeight: "88vh",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: "1rem",
        }}
      >
        <div>
          <h3 style={{ margin: 0 }}>Import teacher rooms (CSV)</h3>
          <p style={{ color: "#555", fontSize: "0.85rem", marginTop: 4 }}>
            Upload a CSV with a <b>teacher</b> column (name or email) and a{" "}
            <b>room</b> column. Easiest path: use{" "}
            <b>Download CSV template</b> (top of the page) — it comes pre-filled
            with your teachers, so you only edit the room column. We match
            teachers to your staff list and to your origin rooms, show a
            preview, then save. Blank/“none” clears a teacher’s room (roaming).
          </p>
        </div>

        {error && (
          <div
            style={{
              background: "rgba(239,68,68,0.1)",
              border: "1px solid rgba(239,68,68,0.4)",
              color: "#b91c1c",
              padding: "0.5rem 0.75rem",
              borderRadius: 6,
            }}
          >
            {error}
          </div>
        )}

        {done != null ? (
          <div style={{ color: "#15803d", fontWeight: 600 }}>
            Saved {done} teacher {done === 1 ? "room" : "rooms"}. Refreshing…
          </div>
        ) : (
          <>
            <input
              type="file"
              accept=".csv,text/csv"
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
              }}
            />
            {fileName && rows.length > 0 && (
              <div style={{ fontSize: "0.85rem", color: "#555" }}>
                {fileName} — {rows.length} row{rows.length === 1 ? "" : "s"} read.
              </div>
            )}
            {originLocations.length === 0 && (
              <div style={{ fontSize: "0.85rem", color: "#b45309" }}>
                No origin rooms exist yet — add rooms first or every row will be
                flagged as an invalid room.
              </div>
            )}

            {preview && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ color: "#15803d", fontWeight: 600 }}>
                  {preview.matched.length} teacher
                  {preview.matched.length === 1 ? "" : "s"} ready to save
                </div>
                {preview.matched.length > 0 && (
                  <div
                    style={{
                      maxHeight: 180,
                      overflowY: "auto",
                      border: "1px solid #e5e5e5",
                      borderRadius: 6,
                      fontSize: "0.85rem",
                    }}
                  >
                    {preview.matched.map((m) => (
                      <div
                        key={m.staffId}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          padding: "0.3rem 0.6rem",
                          borderBottom: "1px solid #f0f0f0",
                        }}
                      >
                        <span>{m.staffName}</span>
                        <span style={{ color: m.room ? "#111" : "#999" }}>
                          {m.room ?? "(none — roaming)"}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {preview.unmatchedTeachers.length > 0 && (
                  <div style={{ fontSize: "0.85rem", color: "#b45309" }}>
                    <b>{preview.unmatchedTeachers.length} unmatched</b> (no staff
                    with that name/email):{" "}
                    {preview.unmatchedTeachers.slice(0, 8).join(", ")}
                    {preview.unmatchedTeachers.length > 8 ? "…" : ""}
                  </div>
                )}
                {preview.invalidRooms.length > 0 && (
                  <div style={{ fontSize: "0.85rem", color: "#b45309" }}>
                    <b>{preview.invalidRooms.length} invalid room
                    {preview.invalidRooms.length === 1 ? "" : "s"}</b> (not an
                    origin room):{" "}
                    {preview.invalidRooms
                      .slice(0, 8)
                      .map((r) => `${r.teacher}→${r.room}`)
                      .join(", ")}
                    {preview.invalidRooms.length > 8 ? "…" : ""}
                  </div>
                )}
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              {!preview ? (
                <button
                  type="button"
                  onClick={() => void runPreview()}
                  disabled={busy || rows.length === 0}
                >
                  {busy ? "Checking…" : "Preview matches"}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void commit()}
                  disabled={busy || preview.matched.length === 0}
                >
                  {busy
                    ? "Saving…"
                    : `Save ${preview.matched.length} room${preview.matched.length === 1 ? "" : "s"}`}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
