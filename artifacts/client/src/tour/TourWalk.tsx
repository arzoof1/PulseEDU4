import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// =============================================================================
// TourWalk — the guide-facing, offline-first LIVE TOUR CAPTURE screen.
//
// Path-dispatched from TourApp at /tour/walk/<token>. UNAUTHENTICATED-by-design:
// the guide opens this by scanning the QR on the printed roadmap (or the
// on-screen lead view) while walking the building with a phone — there is no
// session. The opaque per-walk token is the only gate (mirrors the post-tour
// survey + kiosk enrollment pattern).
//
// Flow:
//   1. Confirm who is guiding (defaults to the lead owner, editable) → Start.
//   2. Tap each checkpoint ONCE as it is completed (client-timestamped).
//   3. Optionally jot a per-stop note (staff-only — meant to catch a family
//      follow-up question for the post-tour call; never family-facing).
//   4. End the tour.
//
// Offline-first: every change is written to a localStorage buffer keyed by the
// token and optimistically reflected in the UI immediately. A debounced flush
// POSTs the FULL buffer to /api/tours/walk/<token>/sync (idempotent upserts), and
// a retry fires on the `online` event + a slow interval. A pill shows
// synced / saving / offline-pending so the guide always knows their taps are safe.
// =============================================================================

type WalkStop = {
  checkpointKey: string;
  label: string;
  location: string;
  talkingPoints: string;
  plannedMinutes: number;
  order: number;
  familyRequested: boolean;
  schoolHighlight: boolean;
  completedAt: string | null;
  note: string;
};

type WalkState = {
  schoolName: string;
  familyName: string;
  children: { name: string; grade: string }[];
  leadStatus: string | null;
  tourScheduledAt: string | null;
  walk: {
    token: string;
    status: "pending" | "in_progress" | "completed" | "abandoned";
    startedAt: string | null;
    endedAt: string | null;
    guideStaffId: number | null;
    guideName: string | null;
  };
  stops: WalkStop[];
  assignableStaff: { id: number; name: string }[];
};

// The locally-buffered, editable session. This is the source of truth for what
// the guide sees; the server state seeds it and reconciles display scaffolding
// (stop list, guide options) but never clobbers un-synced local edits.
type Buffer = {
  guideStaffId: number | null;
  startedAt: string | null;
  endedAt: string | null;
  status: "pending" | "in_progress" | "completed" | "abandoned";
  steps: Record<string, { completedAt: string; note: string }>;
};

const accent = "#0ea5a4";

const bufKey = (token: string) => `pulseedu.tourwalk.${token}`;

function loadBuffer(token: string): Buffer | null {
  try {
    const raw = localStorage.getItem(bufKey(token));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Buffer;
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.steps || typeof parsed.steps !== "object") parsed.steps = {};
    return parsed;
  } catch {
    return null;
  }
}

function saveBuffer(token: string, buf: Buffer) {
  try {
    localStorage.setItem(bufKey(token), JSON.stringify(buf));
  } catch {
    /* private mode / quota — the in-memory state still works for this session */
  }
}

function bufferFromServer(state: WalkState): Buffer {
  const steps: Buffer["steps"] = {};
  for (const s of state.stops) {
    if (s.completedAt) steps[s.checkpointKey] = { completedAt: s.completedAt, note: s.note || "" };
    else if (s.note) steps[s.checkpointKey] = { completedAt: "", note: s.note };
  }
  return {
    guideStaffId: state.walk.guideStaffId,
    startedAt: state.walk.startedAt,
    endedAt: state.walk.endedAt,
    status: state.walk.status,
    steps,
  };
}

function fmtClock(ms: number): string {
  if (ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

const page: React.CSSProperties = {
  minHeight: "100vh",
  background: "#f6f8fb",
  color: "#1f2937",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
};
const wrap: React.CSSProperties = { maxWidth: 620, margin: "0 auto", padding: "0 16px 80px" };
const card: React.CSSProperties = {
  background: "#fff",
  borderRadius: 16,
  boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
  padding: 20,
  marginTop: 16,
};

export default function TourWalk({ token }: { token: string }) {
  const [state, setState] = useState<WalkState | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "missing">("loading");
  const [buf, setBuf] = useState<Buffer | null>(null);
  const [sync, setSync] = useState<"synced" | "saving" | "pending">("synced");
  const [online, setOnline] = useState<boolean>(
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const [now, setNow] = useState(Date.now());

  const bufRef = useRef<Buffer | null>(null);
  const dirtyRef = useRef(false);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncingRef = useRef(false);

  // --- initial load: server state seeds (or reconciles with) the local buffer
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/tours/walk/${encodeURIComponent(token)}`);
        if (!res.ok) throw new Error("missing");
        const json = (await res.json()) as WalkState;
        if (cancelled) return;
        setState(json);
        const local = loadBuffer(token);
        const seeded = local ?? bufferFromServer(json);
        bufRef.current = seeded;
        setBuf(seeded);
        saveBuffer(token, seeded);
        setStatus("ok");
        // If we restored a local buffer that may have un-synced edits, push it.
        if (local) {
          dirtyRef.current = true;
          setSync("pending");
          void flushNow();
        }
      } catch {
        if (!cancelled) setStatus("missing");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // --- ticking clock while a tour is in progress
  useEffect(() => {
    if (buf?.status !== "in_progress") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [buf?.status]);

  // --- online/offline awareness + retry on reconnect
  useEffect(() => {
    const goOnline = () => {
      setOnline(true);
      if (dirtyRef.current) void flushNow();
    };
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    // slow safety-net retry for any stuck pending changes
    const id = setInterval(() => {
      if (dirtyRef.current) void flushNow();
    }, 20000);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flushNow = useCallback(async () => {
    const current = bufRef.current;
    if (!current || !dirtyRef.current || syncingRef.current) return;
    syncingRef.current = true;
    setSync("saving");
    // Snapshot exactly what we send. If the guide edits the buffer while this
    // request is in flight, bufRef will no longer equal `current`, and we must
    // NOT clear the dirty flag (those newer edits still need a sync) — otherwise
    // the retry loops skip them and the taps are silently lost.
    const sent = current;
    const steps = Object.entries(current.steps)
      .filter(([, v]) => !!v.completedAt)
      .map(([checkpointKey, v]) => ({
        checkpointKey,
        completedAt: v.completedAt,
        note: v.note || "",
      }));
    try {
      const res = await fetch(`/api/tours/walk/${encodeURIComponent(token)}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          guideStaffId: current.guideStaffId,
          startedAt: current.startedAt,
          endedAt: current.endedAt,
          status: current.status,
          steps,
        }),
      });
      if (!res.ok) throw new Error("sync failed");
      const fresh = (await res.json()) as WalkState;
      const stillCurrent = bufRef.current === sent;
      if (stillCurrent) {
        dirtyRef.current = false;
        setSync("synced");
      }
      // Reconcile display scaffolding (guide name, stop list) without clobbering
      // the local buffer the guide is actively editing.
      setState((prev) => (prev ? { ...prev, ...fresh } : fresh));
    } catch {
      setSync("pending");
    } finally {
      syncingRef.current = false;
      // Newer edits arrived mid-flight (or a retry was requested) — flush again.
      if (dirtyRef.current) {
        if (flushTimer.current) clearTimeout(flushTimer.current);
        flushTimer.current = setTimeout(() => void flushNow(), 400);
      }
    }
  }, [token]);

  // Apply a mutation to the buffer: persist, mark dirty, debounce a flush.
  const mutate = useCallback(
    (fn: (b: Buffer) => Buffer, immediate = false) => {
      const base = bufRef.current;
      if (!base) return;
      const next = fn({ ...base, steps: { ...base.steps } });
      bufRef.current = next;
      setBuf(next);
      saveBuffer(token, next);
      dirtyRef.current = true;
      setSync("pending");
      if (flushTimer.current) clearTimeout(flushTimer.current);
      if (immediate) {
        void flushNow();
      } else {
        flushTimer.current = setTimeout(() => void flushNow(), 1200);
      }
    },
    [token, flushNow],
  );

  const setGuide = (id: number | null) =>
    mutate((b) => ({ ...b, guideStaffId: id }), true);

  const startTour = () =>
    mutate(
      (b) => ({
        ...b,
        startedAt: b.startedAt ?? new Date().toISOString(),
        status: "in_progress",
      }),
      true,
    );

  const toggleStop = (key: string) =>
    mutate((b) => {
      const existing = b.steps[key];
      if (existing?.completedAt) return b; // one tap — already completed, locked
      return {
        ...b,
        steps: {
          ...b.steps,
          [key]: { completedAt: new Date().toISOString(), note: existing?.note ?? "" },
        },
      };
    });

  const setNote = (key: string, note: string) =>
    mutate((b) => {
      const existing = b.steps[key];
      return {
        ...b,
        steps: {
          ...b.steps,
          [key]: {
            // Noting a stop you haven't tapped yet implies you're there now.
            completedAt: existing?.completedAt || new Date().toISOString(),
            note,
          },
        },
      };
    });

  const endTour = () =>
    mutate(
      (b) => ({ ...b, endedAt: new Date().toISOString(), status: "completed" }),
      true,
    );

  const completedCount = useMemo(
    () =>
      buf ? Object.values(buf.steps).filter((s) => !!s.completedAt).length : 0,
    [buf],
  );

  if (status === "loading") {
    return (
      <div style={{ ...page, display: "grid", placeItems: "center" }}>
        <div style={{ color: "#64748b" }}>Loading…</div>
      </div>
    );
  }
  if (status === "missing" || !state || !buf) {
    return (
      <div style={{ ...page, display: "grid", placeItems: "center", padding: 24 }}>
        <div style={{ color: "#64748b", textAlign: "center" }}>
          This tour link isn’t valid. Ask the front office for a fresh roadmap.
        </div>
      </div>
    );
  }

  const childLine = state.children.length
    ? state.children.map((c) => `${c.name} (Gr ${c.grade})`).join(" · ")
    : "";
  const started = buf.status === "in_progress" || buf.status === "completed";
  const ended = buf.status === "completed";
  const elapsedMs = buf.startedAt
    ? (buf.endedAt ? new Date(buf.endedAt).getTime() : now) -
      new Date(buf.startedAt).getTime()
    : 0;

  const syncPill = (() => {
    if (!online)
      return { text: `Offline — ${dirtyRef.current ? "changes saved on this device" : "all saved"}`, bg: "#fef3c7", fg: "#92400e" };
    if (sync === "saving") return { text: "Saving…", bg: "#e0f2fe", fg: "#075985" };
    if (sync === "pending") return { text: "Saving…", bg: "#e0f2fe", fg: "#075985" };
    return { text: "All changes saved", bg: "#dcfce7", fg: "#166534" };
  })();

  return (
    <div style={page}>
      {/* header */}
      <div
        style={{
          background: `linear-gradient(135deg, ${accent} 0%, #1e293b 140%)`,
          color: "#fff",
          padding: "20px 16px",
        }}
      >
        <div style={{ maxWidth: 620, margin: "0 auto" }}>
          <div style={{ fontSize: 12, opacity: 0.85, letterSpacing: 1 }}>
            LIVE TOUR · {state.schoolName}
          </div>
          <div style={{ fontSize: 22, fontWeight: 800, marginTop: 4 }}>
            {state.familyName}
          </div>
          {childLine && (
            <div style={{ fontSize: 13, opacity: 0.9, marginTop: 2 }}>{childLine}</div>
          )}
        </div>
      </div>

      <div style={wrap}>
        {/* sync status */}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
          <span
            style={{
              fontSize: 12,
              fontWeight: 700,
              padding: "5px 10px",
              borderRadius: 999,
              background: syncPill.bg,
              color: syncPill.fg,
            }}
          >
            {syncPill.text}
          </span>
        </div>

        {/* guide picker */}
        <div style={card}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#475569" }}>
            Who’s guiding this tour?
          </div>
          <select
            value={buf.guideStaffId ?? ""}
            onChange={(e) =>
              setGuide(e.target.value === "" ? null : Number(e.target.value))
            }
            style={{
              width: "100%",
              marginTop: 8,
              padding: "11px 13px",
              borderRadius: 10,
              border: "1px solid #cbd5e1",
              fontSize: 15,
              background: "#fff",
              color: "#1f2937",
              boxSizing: "border-box",
            }}
          >
            <option value="">Unassigned</option>
            {state.assignableStaff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 6 }}>
            Defaults to the lead owner — change it if someone else is walking the family today.
          </div>
        </div>

        {/* clock / start */}
        <div style={{ ...card, textAlign: "center" }}>
          {!started ? (
            <>
              <div style={{ color: "#64748b", marginBottom: 12 }}>
                Ready when you are. Tap start as you greet the family.
              </div>
              <button
                type="button"
                onClick={startTour}
                style={{
                  width: "100%",
                  padding: 16,
                  borderRadius: 12,
                  border: "none",
                  background: accent,
                  color: "#fff",
                  fontWeight: 800,
                  fontSize: 18,
                  cursor: "pointer",
                }}
              >
                Start tour
              </button>
            </>
          ) : (
            <>
              <div style={{ fontSize: 13, color: "#64748b" }}>
                {ended ? "Tour length" : "Elapsed"}
              </div>
              <div
                style={{
                  fontSize: 40,
                  fontWeight: 800,
                  color: ended ? "#166534" : accent,
                  fontVariantNumeric: "tabular-nums",
                  margin: "2px 0 6px",
                }}
              >
                {fmtClock(elapsedMs)}
              </div>
              <div style={{ fontSize: 13, color: "#64748b" }}>
                {completedCount} of {state.stops.length} stops · started{" "}
                {fmtTime(buf.startedAt)}
              </div>
            </>
          )}
        </div>

        {/* stops */}
        {started && (
          <div style={{ marginTop: 8 }}>
            {state.stops.length === 0 && (
              <div style={{ ...card, color: "#64748b", textAlign: "center" }}>
                No specific stops were selected for this family. Walk the spaces they
                mentioned and add notes below.
              </div>
            )}
            {state.stops.map((stop, i) => {
              const step = buf.steps[stop.checkpointKey];
              const done = !!step?.completedAt;
              return (
                <div
                  key={stop.checkpointKey}
                  style={{
                    ...card,
                    marginTop: 12,
                    border: done ? `1.5px solid ${accent}` : "1.5px solid transparent",
                    opacity: ended && !done ? 0.6 : 1,
                  }}
                >
                  <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                    <button
                      type="button"
                      onClick={() => !ended && toggleStop(stop.checkpointKey)}
                      disabled={done || ended}
                      aria-label={done ? "Completed" : "Mark complete"}
                      style={{
                        flexShrink: 0,
                        width: 34,
                        height: 34,
                        borderRadius: 9,
                        border: done ? "none" : `2px solid ${accent}`,
                        background: done ? accent : "#fff",
                        color: "#fff",
                        fontSize: 18,
                        fontWeight: 800,
                        cursor: done || ended ? "default" : "pointer",
                        lineHeight: 1,
                      }}
                    >
                      {done ? "✓" : ""}
                    </button>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 16 }}>
                        {i + 1}. {stop.label}
                        {stop.plannedMinutes > 0 && (
                          <span style={{ color: "#94a3b8", fontWeight: 500, fontSize: 13 }}>
                            {"  ·  ~"}
                            {stop.plannedMinutes} min
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 12, marginTop: 2 }}>
                        <span
                          style={{
                            color: stop.familyRequested ? accent : "#94a3b8",
                            fontWeight: 700,
                          }}
                        >
                          {stop.familyRequested
                            ? stop.schoolHighlight
                              ? "★ Family requested · School highlight"
                              : "★ Family requested"
                            : "School highlight"}
                        </span>
                      </div>
                      {stop.location && (
                        <div style={{ fontSize: 13, color: "#64748b", marginTop: 3 }}>
                          {stop.location}
                        </div>
                      )}
                      {done && (
                        <div style={{ fontSize: 12, color: accent, marginTop: 4 }}>
                          Completed {fmtTime(step!.completedAt)}
                        </div>
                      )}
                      {/* per-stop note (staff-only) */}
                      <textarea
                        value={step?.note ?? ""}
                        onChange={(e) => setNote(stop.checkpointKey, e.target.value)}
                        placeholder="Add a note — e.g. a question to follow up on (staff only)"
                        rows={step?.note ? 2 : 1}
                        style={{
                          width: "100%",
                          marginTop: 8,
                          padding: "8px 10px",
                          borderRadius: 8,
                          border: "1px solid #e2e8f0",
                          fontSize: 13,
                          resize: "vertical",
                          boxSizing: "border-box",
                          background: "#f8fafc",
                          color: "#1f2937",
                          fontFamily: "inherit",
                        }}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* end tour */}
        {started && !ended && (
          <button
            type="button"
            onClick={endTour}
            style={{
              width: "100%",
              marginTop: 20,
              padding: 16,
              borderRadius: 12,
              border: `2px solid ${accent}`,
              background: "#fff",
              color: accent,
              fontWeight: 800,
              fontSize: 17,
              cursor: "pointer",
            }}
          >
            End tour
          </button>
        )}

        {ended && (
          <div style={{ ...card, textAlign: "center", marginTop: 16 }}>
            <div style={{ fontSize: 40 }}>✅</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: "#166534", marginTop: 4 }}>
              Tour complete
            </div>
            <div style={{ fontSize: 13, color: "#64748b", marginTop: 6 }}>
              {completedCount} of {state.stops.length} stops in {fmtClock(elapsedMs)}.
              Your timings and notes are on the family’s lead for the follow-up call.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
