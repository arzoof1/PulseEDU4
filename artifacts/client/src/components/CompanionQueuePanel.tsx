import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";

// "Companion Queue Panel" — a small dashboard inside the staff app that
// surfaces every live kiosk waiting line the signed-in user is allowed
// to manage (admin/core team see every room; teachers see their default
// room or any room they personally activated). Reorder + remove flow
// through the staff endpoints; the kiosk in the front of the room
// repaints on its next poll without any handoff.
//
// "Show QR" mints a read-only viewer token and renders an SVG QR pointing
// at /kiosk-view/<token>, so anyone in the room can pull up the same
// list on their phone in view-only mode.

interface AuthUser {
  id: number;
  defaultRoom?: string | null;
  isAdmin?: boolean | null;
  isSuperUser?: boolean | null;
  isDistrictAdmin?: boolean | null;
  isBehaviorSpecialist?: boolean | null;
  isMtssCoordinator?: boolean | null;
  isSchoolPsychologist?: boolean | null;
}

interface QueueEntry {
  id: number;
  room: string;
  studentId: string;
  firstName: string | null;
  lastName: string | null;
  destination: string;
  position: number;
  addedAt: string;
  kioskActivationId: number;
}

function isCoreTeam(u: AuthUser | null | undefined): boolean {
  if (!u) return false;
  return Boolean(
    u.isSuperUser ||
      u.isDistrictAdmin ||
      u.isAdmin ||
      u.isBehaviorSpecialist ||
      u.isMtssCoordinator ||
      u.isSchoolPsychologist,
  );
}

// Mirrors the server's canManageRoomQueue. Used here just to filter the
// rooms a teacher sees in the panel — the server is the source of truth
// for write authorization.
function canSee(user: AuthUser, entry: QueueEntry): boolean {
  if (isCoreTeam(user)) return true;
  if (user.defaultRoom && user.defaultRoom === entry.room) return true;
  // Note: the staff endpoint doesn't return activation.staffId, so a
  // teacher who activated a "different room" kiosk for sub coverage will
  // see it via the QR / direct link flow but not the bulk panel. That's
  // an acceptable v1 trade-off — the activation owner already has the
  // "Kiosk active on this device" banner pointing at the actual kiosk.
  return false;
}

function formatWait(addedAt: string): string {
  const ms = Date.now() - new Date(addedAt).getTime();
  if (ms < 0) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h${m ? ` ${m}m` : ""}`;
}

function displayName(e: QueueEntry): string {
  const fn = (e.firstName ?? "").trim();
  const ln = (e.lastName ?? "").trim();
  if (!fn && !ln) return e.studentId;
  return [fn, ln].filter(Boolean).join(" ");
}

export function CompanionQueuePanel({ user }: { user: AuthUser | null }) {
  const [entries, setEntries] = useState<QueueEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [qrFor, setQrFor] = useState<string | null>(null);
  // Tick once a second so wait labels update.
  const [, setTick] = useState(0);

  const loadingRef = useRef(false);
  const load = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const res = await fetch("/api/hall-pass-queue", {
        credentials: "include",
      });
      if (!res.ok) {
        // Silent retry on every non-OK status. 401 = not signed in
        // (panel is irrelevant); 5xx/502 = api restart blip and the
        // next poll will succeed. Surfacing an error banner here was
        // confusing — users read "Couldn't load queue (502)" as
        // "there's no kiosk for my room", which it is not.
        if (res.status === 401) {
          setEntries([]);
        }
        return;
      }
      const body = (await res.json()) as { entries: QueueEntry[] };
      setEntries(body.entries ?? []);
      setError(null);
    } catch {
      // Network blip — let the next interval try again silently.
    } finally {
      loadingRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    load();
    const id = setInterval(load, 5_000);
    const tick = setInterval(() => setTick((t) => t + 1), 1_000);
    return () => {
      clearInterval(id);
      clearInterval(tick);
    };
  }, [user, load]);

  const visibleByRoom = useMemo(() => {
    if (!user) return new Map<string, QueueEntry[]>();
    const grouped = new Map<string, QueueEntry[]>();
    for (const e of entries) {
      if (!canSee(user, e)) continue;
      const list = grouped.get(e.room) ?? [];
      list.push(e);
      grouped.set(e.room, list);
    }
    for (const list of grouped.values()) {
      list.sort((a, b) => a.position - b.position || a.id - b.id);
    }
    return grouped;
  }, [entries, user]);

  async function move(entryId: number, direction: -1 | 1) {
    const target = entries.find((e) => e.id === entryId);
    if (!target) return;
    const roomList = entries
      .filter((e) => e.kioskActivationId === target.kioskActivationId)
      .sort((a, b) => a.position - b.position || a.id - b.id);
    const idx = roomList.findIndex((e) => e.id === entryId);
    const swap = idx + direction;
    if (idx < 0 || swap < 0 || swap >= roomList.length) return;
    const orderedIds = roomList.map((e) => e.id);
    [orderedIds[idx], orderedIds[swap]] = [orderedIds[swap]!, orderedIds[idx]!];
    setBusy(entryId);
    try {
      const res = await fetch("/api/hall-pass-queue/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          kioskActivationId: target.kioskActivationId,
          orderedIds,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `Reorder failed (${res.status})`);
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(null);
    }
  }

  async function remove(entryId: number) {
    setBusy(entryId);
    try {
      const res = await fetch(`/api/hall-pass-queue/${entryId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `Remove failed (${res.status})`);
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(null);
    }
  }

  if (!user) return null;
  if (visibleByRoom.size === 0 && !error) return null;

  return (
    <div
      className="card"
      style={{
        marginTop: "1rem",
        padding: "1rem 1.1rem",
        display: "flex",
        flexDirection: "column",
        gap: "0.85rem",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.5rem",
          flexWrap: "wrap",
        }}
      >
        <div>
          <div style={{ fontWeight: 700, fontSize: "1rem" }}>
            🖥️ Live Hall Pass Kiosks
          </div>
          <div style={{ fontSize: "0.8rem", opacity: 0.65 }}>
            Reorder or remove from here — the kiosk in the room updates
            on its own.
          </div>
        </div>
      </div>

      {error && (
        <div
          style={{
            background: "#fee2e2",
            border: "1px solid #fca5a5",
            color: "#991b1b",
            padding: "0.4rem 0.75rem",
            borderRadius: 6,
            fontSize: "0.85rem",
          }}
        >
          {error}
        </div>
      )}

      {Array.from(visibleByRoom.entries()).map(([room, list]) => (
        <RoomBlock
          key={room}
          room={room}
          entries={list}
          busyId={busy}
          onMove={move}
          onRemove={remove}
          onShowQr={() => setQrFor(room)}
        />
      ))}

      {qrFor && (
        <ViewerQrModal room={qrFor} onClose={() => setQrFor(null)} />
      )}
    </div>
  );
}

function RoomBlock({
  room,
  entries,
  busyId,
  onMove,
  onRemove,
  onShowQr,
}: {
  room: string;
  entries: QueueEntry[];
  busyId: number | null;
  onMove: (id: number, dir: -1 | 1) => void;
  onRemove: (id: number) => void;
  onShowQr: () => void;
}) {
  return (
    <div
      style={{
        border: "1px solid #e2e8f0",
        borderRadius: 8,
        padding: "0.7rem 0.85rem",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "0.5rem",
          marginBottom: "0.5rem",
        }}
      >
        <div style={{ fontWeight: 600 }}>
          {room}{" "}
          <span style={{ fontWeight: 400, opacity: 0.6, fontSize: "0.85rem" }}>
            · {entries.length} waiting
          </span>
        </div>
        <button
          type="button"
          onClick={onShowQr}
          style={{
            background: "#fff",
            border: "1px solid #cbd5e1",
            borderRadius: 6,
            padding: "0.25rem 0.6rem",
            fontSize: "0.8rem",
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}
          title="Share a read-only QR code for phones in the room"
        >
          📱 Show QR
        </button>
      </div>

      {entries.length === 0 ? (
        <div style={{ fontSize: "0.85rem", opacity: 0.6 }}>
          Line is empty.
        </div>
      ) : (
        <ol
          style={{
            listStyle: "none",
            padding: 0,
            margin: 0,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          {entries.map((e, i) => (
            <li
              key={e.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "0.4rem 0.5rem",
                background: "#f8fafc",
                borderRadius: 6,
                fontSize: "0.9rem",
              }}
            >
              <span
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 11,
                  background: "#e0e7ff",
                  color: "#3730a3",
                  fontWeight: 700,
                  fontSize: "0.75rem",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                {i + 1}
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span
                  style={{
                    fontWeight: 600,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {displayName(e)}
                </span>{" "}
                <span style={{ opacity: 0.6, fontSize: "0.8rem" }}>
                  · {e.destination} · {formatWait(e.addedAt)}
                </span>
              </span>
              <button
                type="button"
                onClick={() => onMove(e.id, -1)}
                disabled={busyId === e.id || i === 0}
                title="Move up"
                style={iconBtn(busyId === e.id || i === 0)}
              >
                ▲
              </button>
              <button
                type="button"
                onClick={() => onMove(e.id, 1)}
                disabled={busyId === e.id || i === entries.length - 1}
                title="Move down"
                style={iconBtn(
                  busyId === e.id || i === entries.length - 1,
                )}
              >
                ▼
              </button>
              <button
                type="button"
                onClick={() => onRemove(e.id)}
                disabled={busyId === e.id}
                title="Remove from line"
                style={{
                  ...iconBtn(busyId === e.id),
                  color: "#dc2626",
                  borderColor: "#fecaca",
                }}
              >
                ✕
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function iconBtn(disabled: boolean): React.CSSProperties {
  return {
    background: "#fff",
    border: "1px solid #cbd5e1",
    borderRadius: 6,
    padding: "0.15rem 0.45rem",
    fontSize: "0.75rem",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.4 : 1,
  };
}

function ViewerQrModal({
  room,
  onClose,
}: {
  room: string;
  onClose: () => void;
}) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ok"; url: string; svg: string; expiresAt: string }
    | { kind: "error"; message: string }
  >({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/kiosk/viewer-token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ room }),
        });
        if (cancelled) return;
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          setState({
            kind: "error",
            message: body.error ?? `Could not generate link (${res.status})`,
          });
          return;
        }
        // Render the QR as an inline SVG string so we don't need a React
        // wrapper component — keeps the dependency footprint small.
        const svg = await QRCode.toString(body.url, {
          type: "svg",
          margin: 1,
          errorCorrectionLevel: "M",
          width: 240,
        });
        if (cancelled) return;
        setState({
          kind: "ok",
          url: body.url,
          svg,
          expiresAt: body.expiresAt,
        });
      } catch (err) {
        if (cancelled) return;
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : "Network error",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [room]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1rem",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#fff",
          borderRadius: 12,
          padding: "1.25rem",
          width: "min(360px, 95vw)",
          display: "flex",
          flexDirection: "column",
          gap: "0.85rem",
          textAlign: "center",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
          }}
        >
          <h3 style={{ margin: 0 }}>Phone view · {room}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "transparent",
              border: "none",
              fontSize: "1.4rem",
              cursor: "pointer",
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>
        {state.kind === "loading" && (
          <div style={{ padding: "2rem 0", opacity: 0.6 }}>
            Generating QR…
          </div>
        )}
        {state.kind === "error" && (
          <div
            style={{
              background: "#fee2e2",
              border: "1px solid #fca5a5",
              color: "#991b1b",
              padding: "0.6rem 0.75rem",
              borderRadius: 6,
              fontSize: "0.85rem",
            }}
          >
            {state.message}
          </div>
        )}
        {state.kind === "ok" && (
          <>
            <div
              // eslint-disable-next-line react/no-danger
              dangerouslySetInnerHTML={{ __html: state.svg }}
              style={{ display: "flex", justifyContent: "center" }}
            />
            <div style={{ fontSize: "0.85rem", opacity: 0.75 }}>
              Scan with a phone in the room. Read-only — no add, no
              reorder, no remove.
            </div>
            <div
              style={{
                fontSize: "0.7rem",
                opacity: 0.55,
                wordBreak: "break-all",
              }}
            >
              {state.url}
            </div>
            <div style={{ fontSize: "0.7rem", opacity: 0.55 }}>
              Goes dark when the kiosk ends or another device takes over.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
