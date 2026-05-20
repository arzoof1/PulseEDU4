import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { authFetch } from "../lib/authToken";

// "Companion Queue Panel" — a small dashboard inside the staff app that
// surfaces every live hall-pass kiosk the signed-in user is allowed to
// manage. The server returns ONLY rooms the user can manage (admin/core
// team see every room; teachers see their default room or any room they
// personally activated), so this component just renders what the API
// hands back without redoing authz client-side.
//
// Per room we show:
//  · who is currently OUT on a pass from that room
//  · the waiting line, with reorder and remove
//  · a "Show QR" button that mints a read-only viewer token and renders
//    /kiosk-view/<token> so phones in the room can mirror the line.

interface AuthUser {
  id: number;
}

interface QueueEntry {
  id: number;
  room: string;
  studentId: string;
  localSisId?: string | null;
  firstName: string | null;
  lastName: string | null;
  destination: string;
  position: number;
  addedAt: string;
  kioskActivationId: number;
  blocked?: boolean;
  blockedReason?: string | null;
}

interface ActivePass {
  kioskActivationId: number | null;
  room: string;
  studentId: string;
  localSisId?: string | null;
  firstName: string | null;
  lastName: string | null;
  destination: string;
  createdAt: string;
  maxDurationMinutes: number;
}

interface KioskRef {
  kioskActivationId: number;
  room: string;
}

interface PanelData {
  entries: QueueEntry[];
  activePasses: ActivePass[];
  kiosks: KioskRef[];
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

function formatPassAge(createdAt: string, maxMinutes: number): string {
  const start = new Date(createdAt).getTime();
  if (!Number.isFinite(start)) return "";
  const mins = Math.max(0, Math.floor((Date.now() - start) / 60_000));
  const over = mins > maxMinutes;
  const label = mins < 1 ? "<1m" : `${mins}m`;
  return over ? `${label} · over by ${mins - maxMinutes}m` : label;
}

function studentName(
  fn: string | null,
  ln: string | null,
  fallback: string,
): string {
  const f = (fn ?? "").trim();
  const l = (ln ?? "").trim();
  if (!f && !l) return fallback;
  return [f, l].filter(Boolean).join(" ");
}

export function CompanionQueuePanel({ user }: { user: AuthUser | null }) {
  const [data, setData] = useState<PanelData>({
    entries: [],
    activePasses: [],
    kiosks: [],
  });
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
      const res = await authFetch("/api/hall-pass-queue");
      if (!res.ok) {
        // Silent on transient errors. 401 = signed out; 5xx = api blip.
        if (res.status === 401) {
          setData({ entries: [], activePasses: [], kiosks: [] });
        }
        return;
      }
      const body = (await res.json()) as Partial<PanelData>;
      setData({
        entries: body.entries ?? [],
        activePasses: body.activePasses ?? [],
        kiosks: body.kiosks ?? [],
      });
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

  // Group queue entries by activationId, then attach active passes by
  // matching room. Rooms with no queue but a live kiosk still appear
  // (server includes them in `kiosks`) so a teacher with a kiosk up
  // and one student out always sees the room block.
  const rooms = useMemo(() => {
    const byKiosk = new Map<
      number,
      { kioskActivationId: number; room: string; queue: QueueEntry[] }
    >();
    for (const k of data.kiosks) {
      byKiosk.set(k.kioskActivationId, {
        kioskActivationId: k.kioskActivationId,
        room: k.room,
        queue: [],
      });
    }
    for (const e of data.entries) {
      let bucket = byKiosk.get(e.kioskActivationId);
      if (!bucket) {
        bucket = {
          kioskActivationId: e.kioskActivationId,
          room: e.room,
          queue: [],
        };
        byKiosk.set(e.kioskActivationId, bucket);
      }
      bucket.queue.push(e);
    }
    for (const b of byKiosk.values()) {
      b.queue.sort((a, b2) => a.position - b2.position || a.id - b2.id);
    }
    const passesByRoom = new Map<string, ActivePass[]>();
    for (const p of data.activePasses) {
      const list = passesByRoom.get(p.room) ?? [];
      list.push(p);
      passesByRoom.set(p.room, list);
    }
    return Array.from(byKiosk.values())
      .map((b) => ({ ...b, activePasses: passesByRoom.get(b.room) ?? [] }))
      .sort((a, b) => a.room.localeCompare(b.room));
  }, [data]);

  async function move(entryId: number, direction: -1 | 1) {
    const target = data.entries.find((e) => e.id === entryId);
    if (!target) return;
    const roomList = data.entries
      .filter((e) => e.kioskActivationId === target.kioskActivationId)
      .sort((a, b) => a.position - b.position || a.id - b.id);
    const idx = roomList.findIndex((e) => e.id === entryId);
    const swap = idx + direction;
    if (idx < 0 || swap < 0 || swap >= roomList.length) return;
    const orderedIds = roomList.map((e) => e.id);
    [orderedIds[idx], orderedIds[swap]] = [orderedIds[swap]!, orderedIds[idx]!];
    setBusy(entryId);
    try {
      const res = await authFetch("/api/hall-pass-queue/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
      const res = await authFetch(`/api/hall-pass-queue/${entryId}`, {
        method: "DELETE",
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
  if (rooms.length === 0 && !error) return null;

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
      <div>
        <div style={{ fontWeight: 700, fontSize: "1rem" }}>
          🖥️ Live Hall Pass Kiosks
        </div>
        <div style={{ fontSize: "0.8rem", opacity: 0.65 }}>
          See who's out and who's waiting. Reorder or remove from here —
          the kiosk in the room updates on its own.
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

      {rooms.map((r) => (
        <RoomBlock
          key={r.kioskActivationId}
          room={r.room}
          queue={r.queue}
          activePasses={r.activePasses}
          busyId={busy}
          onMove={move}
          onRemove={remove}
          onShowQr={() => setQrFor(r.room)}
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
  queue,
  activePasses,
  busyId,
  onMove,
  onRemove,
  onShowQr,
}: {
  room: string;
  queue: QueueEntry[];
  activePasses: ActivePass[];
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
            · {activePasses.length} out · {queue.length} waiting
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

      {/* Currently OUT — students with an active pass from this room. */}
      <div style={{ marginBottom: queue.length > 0 ? "0.6rem" : 0 }}>
        <div
          style={{
            fontSize: "0.7rem",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            opacity: 0.55,
            margin: "0.1rem 0 0.3rem",
          }}
        >
          Currently out
        </div>
        {activePasses.length === 0 ? (
          <div style={{ fontSize: "0.82rem", opacity: 0.55 }}>
            Nobody is out from this room right now.
          </div>
        ) : (
          <ul
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            {activePasses.map((p) => (
              <li
                key={`${p.studentId}-${p.createdAt}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "0.35rem 0.5rem",
                  background: "#fff7ed",
                  border: "1px solid #fed7aa",
                  borderRadius: 6,
                  fontSize: "0.88rem",
                }}
              >
                <span aria-hidden>🚶</span>
                <span style={{ flex: 1, minWidth: 0, fontWeight: 600 }}>
                  {studentName(p.firstName, p.lastName, p.localSisId ?? p.studentId)}
                </span>
                <span style={{ opacity: 0.65, fontSize: "0.78rem" }}>
                  → {p.destination} ·{" "}
                  {formatPassAge(p.createdAt, p.maxDurationMinutes)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Waiting line */}
      <div
        style={{
          fontSize: "0.7rem",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          opacity: 0.55,
          margin: "0.1rem 0 0.3rem",
        }}
      >
        Waiting line
      </div>
      {queue.length === 0 ? (
        <div style={{ fontSize: "0.82rem", opacity: 0.55 }}>
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
          {queue.map((e, i) => (
            <li
              key={e.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "0.4rem 0.5rem",
                background: e.blocked ? "#fef2f2" : "#f8fafc",
                border: e.blocked ? "1px solid #fecaca" : "1px solid transparent",
                borderRadius: 6,
                fontSize: "0.9rem",
              }}
            >
              <span
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 11,
                  background: e.blocked ? "#fee2e2" : "#e0e7ff",
                  color: e.blocked ? "#991b1b" : "#3730a3",
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
                <span style={{ fontWeight: 600 }}>
                  {studentName(e.firstName, e.lastName, e.localSisId ?? e.studentId)}
                </span>{" "}
                <span style={{ opacity: 0.6, fontSize: "0.8rem" }}>
                  · {e.destination} · {formatWait(e.addedAt)}
                </span>
                {e.blocked && (
                  <span
                    title="Keep-apart hold — waiting until the rule clears"
                    style={{
                      marginLeft: 6,
                      display: "inline-block",
                      padding: "1px 6px",
                      background: "#dc2626",
                      color: "#fff",
                      borderRadius: 4,
                      fontSize: "0.65rem",
                      fontWeight: 700,
                      letterSpacing: "0.04em",
                      textTransform: "uppercase",
                      verticalAlign: "1px",
                    }}
                  >
                    On hold
                  </span>
                )}
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
                disabled={busyId === e.id || i === queue.length - 1}
                title="Move down"
                style={iconBtn(busyId === e.id || i === queue.length - 1)}
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
        const res = await authFetch("/api/kiosk/viewer-token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
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
