import { useEffect, useRef, useState } from "react";

// Public read-only mirror of a kiosk's waiting line. Loaded by anyone
// possessing the viewer token (no auth) — typically scanned on a phone
// from the QR code in the staff app's Companion Queue Panel.
//
// The route is /kiosk-view/<token>; main.tsx dispatches here based on
// the path. Nothing on this page can mutate the queue.

interface ViewerEntry {
  id: number;
  studentId: string;
  firstName: string | null;
  lastName: string | null;
  destination: string;
  position: number;
  addedAt: string;
}

interface ViewerPayload {
  room: string;
  schoolName: string | null;
  capacity: number;
  entries: ViewerEntry[];
  refreshedAt: string;
}

function getToken(): string | null {
  // Path looks like .../kiosk-view/<token>; tolerate trailing slash.
  const parts = window.location.pathname.split("/").filter(Boolean);
  const idx = parts.indexOf("kiosk-view");
  if (idx === -1 || idx === parts.length - 1) return null;
  return parts[idx + 1] ?? null;
}

function formatWait(addedAt: string): string {
  const ms = Date.now() - new Date(addedAt).getTime();
  if (ms < 0) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "<1 min";
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${m}m`;
}

function displayName(e: ViewerEntry): string {
  const fn = (e.firstName ?? "").trim();
  const ln = (e.lastName ?? "").trim();
  if (!fn && !ln) return e.studentId;
  return [fn, ln].filter(Boolean).join(" ");
}

export default function KioskViewer() {
  const token = getToken();
  const [data, setData] = useState<ViewerPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  // Tick once a second so the "5 min" wait labels update without
  // hammering the server.
  const [, setTick] = useState(0);
  const dataRef = useRef<ViewerPayload | null>(null);
  dataRef.current = data;

  useEffect(() => {
    if (!token) {
      setError("Missing viewer token in URL");
      return;
    }
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(
          `/api/kiosk/viewer/${encodeURIComponent(token!)}`,
        );
        if (cancelled) return;
        if (res.status === 410) {
          // Kiosk taken over or token expired — go dark, do not poll again.
          setGone(true);
          setError(null);
          return;
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(body.error ?? `Couldn't load (${res.status})`);
          return;
        }
        const body: ViewerPayload = await res.json();
        setData(body);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Network error");
      }
    }
    load();
    // 4s — slightly faster than the kiosk polls so the phone never feels
    // stale to someone watching the kiosk over the teacher's shoulder.
    const pollId = setInterval(() => {
      if (!gone) load();
    }, 4_000);
    const tickId = setInterval(() => setTick((t) => t + 1), 1_000);
    return () => {
      cancelled = true;
      clearInterval(pollId);
      clearInterval(tickId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, gone]);

  if (gone) {
    return (
      <Shell>
        <div style={{ fontSize: "1.4rem", fontWeight: 700 }}>
          This kiosk is no longer active
        </div>
        <div style={{ opacity: 0.7, marginTop: 12, maxWidth: 360 }}>
          The teacher ended the session or another device took over the
          room. Ask them for a new QR code if you still need to see the
          waiting line.
        </div>
      </Shell>
    );
  }

  if (error) {
    return (
      <Shell>
        <div style={{ fontSize: "1.2rem", fontWeight: 600 }}>
          Couldn't load the queue
        </div>
        <div style={{ opacity: 0.7, marginTop: 8 }}>{error}</div>
      </Shell>
    );
  }

  if (!data) {
    return (
      <Shell>
        <div style={{ opacity: 0.6 }}>Loading…</div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div style={{ width: "100%", maxWidth: 480 }}>
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: "0.85rem", opacity: 0.65 }}>
            {data.schoolName ?? "Hall Pass Queue"}
          </div>
          <div
            style={{
              fontSize: "1.6rem",
              fontWeight: 700,
              letterSpacing: "0.01em",
            }}
          >
            {data.room}
          </div>
          <div style={{ fontSize: "0.8rem", opacity: 0.6, marginTop: 4 }}>
            Read-only · {data.entries.length}/{data.capacity} waiting
          </div>
        </div>

        {data.entries.length === 0 ? (
          <div
            style={{
              border: "1px dashed rgba(255,255,255,0.2)",
              borderRadius: 10,
              padding: "1.5rem",
              textAlign: "center",
              opacity: 0.7,
            }}
          >
            No one is in line right now.
          </div>
        ) : (
          <ol
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            {data.entries.map((e) => (
              <li
                key={e.id}
                style={{
                  background: "rgba(255,255,255,0.06)",
                  border: "1px solid rgba(255,255,255,0.12)",
                  borderRadius: 10,
                  padding: "0.85rem 1rem",
                  display: "flex",
                  alignItems: "center",
                  gap: "0.85rem",
                }}
              >
                <div
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 18,
                    background: "rgba(59,130,246,0.25)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontWeight: 700,
                    flexShrink: 0,
                  }}
                >
                  {e.position}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontWeight: 600,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {displayName(e)}
                  </div>
                  <div style={{ fontSize: "0.8rem", opacity: 0.7 }}>
                    {e.destination} · waited {formatWait(e.addedAt)}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}

        <div
          style={{
            marginTop: 24,
            fontSize: "0.7rem",
            opacity: 0.4,
            textAlign: "center",
          }}
        >
          Updates every few seconds
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "flex-start",
        background: "var(--brand-header-bg, #0f172a)",
        color: "#fff",
        fontFamily: "system-ui, sans-serif",
        padding: "2rem 1rem",
        textAlign: "left",
      }}
    >
      {children}
    </div>
  );
}
