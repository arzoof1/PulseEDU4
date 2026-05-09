import { useEffect, useState } from "react";

// Same key Kiosk.tsx and KioskBanner.tsx use. Storing it from the staff
// app side is what makes "Open in new tab → already activated" work.
const TOKEN_KEY = "pulseed.kiosk.token";
const DEVICE_ID_KEY = "pulseed.kiosk.device_id";

function getOrCreateDeviceFingerprint(): string {
  try {
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing) return existing;
    const fresh =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem(DEVICE_ID_KEY, fresh);
    return fresh;
  } catch {
    return "ephemeral-" + Math.random().toString(36).slice(2);
  }
}

function getDeviceLabel(): string {
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData?.platform ||
    navigator.platform ||
    "Unknown device";
  const screenSize =
    typeof screen !== "undefined"
      ? `${screen.width}\u00d7${screen.height}`
      : "?";
  return `${platform} \u00b7 ${screenSize}`.slice(0, 200);
}

interface Takeover {
  room: string;
  activatedByName: string | null;
  deviceLabel: string | null;
  activatedAt: string | null;
}

// In-app "Open Kiosk Mode" flow, fronted by /api/kiosk/quick-activate
// (session-auth — no password retype). Modal handles the same three
// branches as the public activation screen:
//   - has default room → one click and we're done
//   - no default       → show searchable picker
//   - room conflict    → "take over?" confirm
// Fires onOpened with the token on success so the caller can decide what
// to do (we open /kiosk in a new tab below).
export function OpenKioskModal({ onClose }: { onClose: () => void }) {
  const [phase, setPhase] = useState<
    | { kind: "loading" }
    | { kind: "default-room"; room: string }
    | { kind: "picker"; locations: string[]; defaultRoom: string | null }
    | { kind: "confirm-takeover"; info: Takeover; chosenRoom: string }
    | { kind: "done" }
  >({ kind: "loading" });
  const [room, setRoom] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function call(extra: {
    room?: string;
    dryRun?: boolean;
    replaceExisting?: boolean;
  }) {
    const body = {
      deviceFingerprint: getOrCreateDeviceFingerprint(),
      deviceLabel: getDeviceLabel(),
      ...extra,
    };
    const res = await fetch("/api/kiosk/quick-activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }

  // Initial probe: dry-run to learn whether we have a default room and
  // load the picker list at the same time. Cheaper than two roundtrips.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { res, data } = await call({ dryRun: true });
        if (cancelled) return;
        if (!res.ok) {
          setError(data.error ?? `Couldn't load kiosk info (${res.status})`);
          setPhase({ kind: "picker", locations: [], defaultRoom: null });
          return;
        }
        const locs: string[] = data.locations ?? [];
        const def: string | null = data.defaultRoom ?? null;
        if (def) {
          setRoom(def);
          setPhase({ kind: "default-room", room: def });
        } else {
          setPhase({ kind: "picker", locations: locs, defaultRoom: null });
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Network error");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function finish(token: string) {
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {
      // ignore — kiosk tab will fall back to the activation screen
    }
    setPhase({ kind: "done" });
    // Pop the kiosk in a new tab so the staff app stays available behind it.
    window.open(`${import.meta.env.BASE_URL}kiosk`, "_blank", "noopener");
    onClose();
  }

  async function handleActivate(targetRoom: string, replace = false) {
    setBusy(true);
    setError("");
    try {
      const { res, data } = await call({
        room: targetRoom,
        replaceExisting: replace,
      });
      if (res.status === 409 && data.needsRoom) {
        setPhase({
          kind: "picker",
          locations: data.locations ?? [],
          defaultRoom: null,
        });
        setError("Pick the room this kiosk should run in.");
        return;
      }
      if (res.status === 409 && data.roomTaken) {
        setPhase({
          kind: "confirm-takeover",
          info: {
            room: data.room,
            activatedByName: data.existing?.activatedByName ?? null,
            deviceLabel: data.existing?.deviceLabel ?? null,
            activatedAt: data.existing?.activatedAt ?? null,
          },
          chosenRoom: data.room,
        });
        return;
      }
      if (!res.ok) {
        setError(data.error ?? `Activation failed (${res.status})`);
        return;
      }
      finish(data.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  // Need the picker even when the user has a default — they may want a
  // different room (sub day, hallway monitor coverage). Shown via the
  // "Use a different room" link below.
  function switchToPicker() {
    setPhase((p) => {
      if (p.kind === "default-room") {
        return {
          kind: "picker",
          locations: [],
          defaultRoom: p.room,
        };
      }
      return p;
    });
    // Re-fetch the location list now that the picker is showing.
    (async () => {
      const { res, data } = await call({ dryRun: true });
      if (!res.ok) return;
      setPhase({
        kind: "picker",
        locations: data.locations ?? [],
        defaultRoom: data.defaultRoom ?? null,
      });
      setRoom(data.defaultRoom ?? "");
    })();
  }

  const sortedRooms = (() => {
    if (phase.kind !== "picker") return [];
    const def = phase.defaultRoom;
    const rest = phase.locations
      .filter((r) => r !== def)
      .sort((a, b) => a.localeCompare(b));
    return def ? [def, ...rest] : rest;
  })();

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
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
          width: "min(480px, 95vw)",
          padding: "1.5rem",
          boxShadow: "0 20px 50px rgba(0,0,0,0.3)",
          display: "flex",
          flexDirection: "column",
          gap: "0.85rem",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
          }}
        >
          <h3 style={{ margin: 0 }}>Open Kiosk Mode</h3>
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

        {phase.kind === "loading" && (
          <div style={{ opacity: 0.6, padding: "1rem 0" }}>Loading…</div>
        )}

        {phase.kind === "default-room" && (
          <>
            <div style={{ fontSize: "0.92rem", lineHeight: 1.5 }}>
              Activate this device as a hall pass kiosk for{" "}
              <strong>{phase.room}</strong> (your room). Opens in a new tab so
              your staff app stays open here.
            </div>
            {error && (
              <div
                style={{
                  background: "#fee2e2",
                  border: "1px solid #fca5a5",
                  color: "#991b1b",
                  padding: "0.5rem 0.75rem",
                  borderRadius: 6,
                  fontSize: "0.85rem",
                }}
              >
                {error}
              </div>
            )}
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => handleActivate(phase.room)}
                disabled={busy}
                style={primaryBtnLight(busy)}
              >
                {busy ? "Activating…" : `Activate for ${phase.room}`}
              </button>
              <button
                type="button"
                onClick={switchToPicker}
                disabled={busy}
                style={ghostBtn(busy)}
              >
                Use a different room…
              </button>
            </div>
          </>
        )}

        {phase.kind === "picker" && (
          <>
            <div style={{ fontSize: "0.92rem", lineHeight: 1.5 }}>
              Choose the room this kiosk should run in. Start typing to
              search.
            </div>
            <input
              type="text"
              list="kiosk-quick-room-list"
              value={room}
              onChange={(e) => setRoom(e.target.value)}
              disabled={busy}
              autoFocus
              placeholder={
                phase.defaultRoom
                  ? `${phase.defaultRoom} (your room)`
                  : "Type or pick a room…"
              }
              style={{
                padding: "0.6rem 0.75rem",
                fontSize: "1rem",
                border: "1px solid #cbd5e1",
                borderRadius: 6,
              }}
            />
            <datalist id="kiosk-quick-room-list">
              {sortedRooms.map((r) => (
                <option key={r} value={r}>
                  {r === phase.defaultRoom ? `${r} (your room)` : r}
                </option>
              ))}
            </datalist>
            {error && (
              <div
                style={{
                  background: "#fef3c7",
                  border: "1px solid #fcd34d",
                  color: "#92400e",
                  padding: "0.5rem 0.75rem",
                  borderRadius: 6,
                  fontSize: "0.85rem",
                }}
              >
                {error}
              </div>
            )}
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button
                type="button"
                onClick={() => handleActivate(room.trim())}
                disabled={busy || !room.trim()}
                style={primaryBtnLight(busy || !room.trim())}
              >
                {busy ? "Activating…" : `Activate for ${room.trim() || "…"}`}
              </button>
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                style={ghostBtn(busy)}
              >
                Cancel
              </button>
            </div>
          </>
        )}

        {phase.kind === "confirm-takeover" && (
          <>
            <div style={{ fontSize: "0.92rem", lineHeight: 1.5 }}>
              <strong>{phase.info.room}</strong> already has an active kiosk
              {phase.info.activatedByName ? (
                <>
                  {" "}
                  (last activated by{" "}
                  <strong>{phase.info.activatedByName}</strong>
                  {phase.info.deviceLabel ? ` on ${phase.info.deviceLabel}` : ""}
                  ).
                </>
              ) : (
                "."
              )}{" "}
              Taking over deactivates that device and clears its waiting line.
            </div>
            {error && (
              <div
                style={{
                  background: "#fee2e2",
                  border: "1px solid #fca5a5",
                  color: "#991b1b",
                  padding: "0.5rem 0.75rem",
                  borderRadius: 6,
                  fontSize: "0.85rem",
                }}
              >
                {error}
              </div>
            )}
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button
                type="button"
                onClick={() => handleActivate(phase.chosenRoom, true)}
                disabled={busy}
                style={dangerBtn(busy)}
              >
                {busy ? "Taking over…" : "Take over this room"}
              </button>
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                style={ghostBtn(busy)}
              >
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function primaryBtnLight(disabled: boolean): React.CSSProperties {
  return {
    background: disabled ? "#93c5fd" : "#2563eb",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    padding: "0.55rem 0.95rem",
    fontWeight: 600,
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: "0.95rem",
    flex: 1,
  };
}

function dangerBtn(disabled: boolean): React.CSSProperties {
  return {
    background: disabled ? "#fca5a5" : "#dc2626",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    padding: "0.55rem 0.95rem",
    fontWeight: 600,
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: "0.95rem",
    flex: 1,
  };
}

function ghostBtn(disabled: boolean): React.CSSProperties {
  return {
    background: "transparent",
    color: "#475569",
    border: "1px solid #cbd5e1",
    borderRadius: 6,
    padding: "0.55rem 0.95rem",
    fontWeight: 600,
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: "0.95rem",
  };
}
