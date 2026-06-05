import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrowserQRCodeReader, type IScannerControls } from "@zxing/browser";
import { authFetch } from "../lib/authToken";

// =============================================================================
// ScannerApp — gate admission scanner for the Event Ticketing module.
//
// Two entry modes, dispatched off the URL:
//   /scan                — STAFF scanner. Requires a staff session (cookie or
//                          Bearer). The staffer picks a published event, then
//                          scans. Calls POST /api/ticketing/events/:id/scan.
//   /scan/<linkToken>    — NO-LOGIN volunteer scanner. The link is minted in
//                          the admin module and opened on a volunteer's own
//                          phone. Calls POST /api/ticketing/scan/:linkToken.
//
// Both modes share the same camera + result UI. A successful decode pauses the
// camera briefly so the gate volunteer can read the big result banner before
// the next person steps up. A manual-entry box is always available as a
// fallback (handheld USB/Bluetooth wedge scanners type into it; it also lets
// you key a short code when a screen is too dim to scan).
// =============================================================================

type ScanResult =
  | "admitted"
  | "already_used"
  | "invalid"
  | "void"
  | "wrong_event"
  | "outside_window";

type ScanResponse = {
  result: ScanResult;
  ticket?: {
    studentName: string;
    grade: number | null;
    seq: number;
    total: number;
  };
  usedAt?: string | null;
  usedGate?: string | null;
  usedVia?: string | null;
  usedByName?: string | null;
  eventDate?: string | null;
  admitted: number;
  total: number;
  capacity: number | null;
  capacityWarning: boolean;
  atCapacity: boolean;
  overCapacity?: boolean;
};

type EventInfo = {
  name: string;
  eventDate: string | null;
  startTime: string | null;
  location: string | null;
};

function logicalScanPath(): string {
  // The scanner is served from the client artifact (base "/"). The volunteer
  // link is built server-side as <origin>/scan/<token>, so the raw pathname is
  // authoritative here.
  return window.location.pathname;
}

function scannerLinkToken(): string | null {
  const m = logicalScanPath().match(/\/scan\/([^/?#]+)/);
  const tok = m?.[1]?.trim();
  if (!tok || tok === "staff") return null;
  return decodeURIComponent(tok);
}

export default function ScannerApp() {
  const linkToken = useMemo(scannerLinkToken, []);
  return linkToken ? (
    <VolunteerScanner linkToken={linkToken} />
  ) : (
    <StaffScanner />
  );
}

// ---------------------------------------------------------------------------
// Shared result banner + live count
// ---------------------------------------------------------------------------
const RESULT_META: Record<
  ScanResult,
  { bg: string; fg: string; label: string }
> = {
  admitted: { bg: "#16a34a", fg: "#fff", label: "ADMITTED" },
  already_used: { bg: "#dc2626", fg: "#fff", label: "ALREADY USED" },
  invalid: { bg: "#475569", fg: "#fff", label: "NOT A VALID CODE" },
  void: { bg: "#b45309", fg: "#fff", label: "VOIDED TICKET" },
  wrong_event: { bg: "#b45309", fg: "#fff", label: "WRONG EVENT" },
  outside_window: { bg: "#b45309", fg: "#fff", label: "NOT TODAY" },
};

function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function ResultBanner({ res }: { res: ScanResponse | null }) {
  if (!res) {
    return (
      <div style={{ ...bannerStyle, background: "#0f172a", color: "#cbd5e1" }}>
        Point the camera at a ticket QR code
      </div>
    );
  }
  const meta = RESULT_META[res.result];
  return (
    <div style={{ ...bannerStyle, background: meta.bg, color: meta.fg }}>
      <div style={{ fontSize: 34, fontWeight: 800, letterSpacing: 0.5 }}>
        {meta.label}
      </div>
      {res.ticket && (
        <div style={{ marginTop: 6, fontSize: 20, fontWeight: 600 }}>
          {res.ticket.studentName}
          {res.ticket.grade !== null ? ` · Gr ${res.ticket.grade}` : ""} · Ticket{" "}
          {res.ticket.seq} of {res.ticket.total}
        </div>
      )}
      {res.result === "already_used" && (
        <div style={{ marginTop: 6, fontSize: 15, opacity: 0.95 }}>
          Used {fmtWhen(res.usedAt)}
          {res.usedGate ? ` at ${res.usedGate}` : ""}
          {res.usedByName ? ` by ${res.usedByName}` : ""}
        </div>
      )}
      {res.result === "outside_window" && res.eventDate && (
        <div style={{ marginTop: 6, fontSize: 15, opacity: 0.95 }}>
          Valid only on {res.eventDate}
        </div>
      )}
    </div>
  );
}

function CountBar({ res }: { res: ScanResponse | null }) {
  if (!res) return null;
  const cap = res.capacity;
  const warn = res.overCapacity
    ? { txt: "OVER CAPACITY", bg: "#dc2626" }
    : res.atCapacity
      ? { txt: "AT CAPACITY", bg: "#dc2626" }
      : res.capacityWarning
        ? { txt: "NEARLY FULL", bg: "#b45309" }
        : null;
  return (
    <div style={countBarStyle}>
      <span style={{ fontWeight: 700, fontSize: 18 }}>
        {res.admitted}
        {cap !== null ? ` of ${cap}` : ` / ${res.total}`} admitted
      </span>
      {warn && (
        <span
          style={{
            marginLeft: 12,
            background: warn.bg,
            color: "#fff",
            borderRadius: 999,
            padding: "2px 10px",
            fontSize: 13,
            fontWeight: 700,
          }}
        >
          {warn.txt}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Camera hook (zxing). onDecode is called with the raw decoded text. Scanning
// pauses while `paused` is true so we don't fire the same code 30x/second.
// ---------------------------------------------------------------------------
function useCamera(
  enabled: boolean,
  paused: boolean,
  onDecode: (text: string) => void,
) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pausedRef = useRef(paused);
  const decodeRef = useRef(onDecode);
  pausedRef.current = paused;
  decodeRef.current = onDecode;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const reader = new BrowserQRCodeReader();
    (async () => {
      try {
        if (!videoRef.current) return;
        const controls = await reader.decodeFromVideoDevice(
          undefined,
          videoRef.current,
          (result) => {
            if (cancelled || pausedRef.current) return;
            if (result) decodeRef.current(result.getText());
          },
        );
        if (cancelled) {
          controls.stop();
          return;
        }
        controlsRef.current = controls;
      } catch (e) {
        if (!cancelled) {
          setError(
            e instanceof Error
              ? e.message
              : "Camera unavailable — use manual entry below.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
      controlsRef.current?.stop();
      controlsRef.current = null;
    };
  }, [enabled]);

  return { videoRef, error };
}

// ---------------------------------------------------------------------------
// Volunteer (no-login) scanner
// ---------------------------------------------------------------------------
function VolunteerScanner({ linkToken }: { linkToken: string }) {
  const [info, setInfo] = useState<EventInfo | null>(null);
  const [gateLabel, setGateLabel] = useState<string>("");
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const submit = useCallback(
    async (token: string): Promise<ScanResponse | null> => {
      const res = await fetch(
        `/api/ticketing/scan/${encodeURIComponent(linkToken)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        },
      );
      if (!res.ok) return null;
      return (await res.json()) as ScanResponse;
    },
    [linkToken],
  );

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(
          `/api/ticketing/scan/${encodeURIComponent(linkToken)}/info`,
        );
        if (!res.ok) {
          setLoadErr(
            res.status === 404
              ? "This scanner link is no longer active. Ask the office for a new one."
              : `Could not load scanner (${res.status})`,
          );
          return;
        }
        const data = (await res.json()) as {
          event: EventInfo;
          gateLabel: string;
        };
        setInfo(data.event);
        setGateLabel(data.gateLabel);
      } catch (e) {
        setLoadErr(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [linkToken]);

  if (loadErr) {
    return <FullMsg title="Scanner unavailable">{loadErr}</FullMsg>;
  }
  if (!info) {
    return <FullMsg title="Loading…">Connecting to the gate…</FullMsg>;
  }
  return (
    <ScanSurface
      title={info.name}
      subtitle={gateLabel ? `Gate: ${gateLabel}` : "Volunteer scanner"}
      submit={submit}
    />
  );
}

// ---------------------------------------------------------------------------
// Staff scanner (logged in) — pick an event, then scan
// ---------------------------------------------------------------------------
type StaffEvent = { id: number; name: string; status: string };

function StaffScanner() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [events, setEvents] = useState<StaffEvent[]>([]);
  const [eventId, setEventId] = useState<number | null>(null);
  const [gateLabel, setGateLabel] = useState("Main gate");

  useEffect(() => {
    (async () => {
      try {
        const me = await authFetch("/api/auth/me");
        if (!me.ok) {
          setAuthed(false);
          return;
        }
        setAuthed(true);
        const res = await authFetch("/api/ticketing/events");
        if (res.ok) {
          const data = (await res.json()) as {
            events: Array<{ id: number; name: string; status: string }>;
          };
          const published = data.events.filter(
            (e) => e.status === "published",
          );
          setEvents(published);
          if (published.length === 1) setEventId(published[0].id);
        }
      } catch {
        setAuthed(false);
      }
    })();
  }, []);

  const submit = useCallback(
    async (token: string): Promise<ScanResponse | null> => {
      if (eventId === null) return null;
      const res = await authFetch(`/api/ticketing/events/${eventId}/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, gateLabel }),
      });
      if (!res.ok) return null;
      return (await res.json()) as ScanResponse;
    },
    [eventId, gateLabel],
  );

  const lookup = useCallback(
    async (q: string) => {
      if (eventId === null) return [];
      const res = await authFetch(
        `/api/ticketing/events/${eventId}/lookup?q=${encodeURIComponent(q)}`,
      );
      if (!res.ok) return [];
      const data = (await res.json()) as { results: LookupRow[] };
      return data.results;
    },
    [eventId],
  );

  const admitTicket = useCallback(
    async (ticketId: number): Promise<ScanResponse | null> => {
      const res = await authFetch(`/api/ticketing/tickets/${ticketId}/admit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gateLabel }),
      });
      if (!res.ok) return null;
      return (await res.json()) as ScanResponse;
    },
    [gateLabel],
  );

  if (authed === null) {
    return <FullMsg title="Loading…">Checking your sign-in…</FullMsg>;
  }
  if (!authed) {
    return (
      <FullMsg title="Sign-in required">
        Open the main staff app to sign in, then return to this page.
        <div style={{ marginTop: 16 }}>
          <a href="/" style={linkBtn}>
            Go to staff app
          </a>
        </div>
      </FullMsg>
    );
  }
  if (events.length === 0) {
    return (
      <FullMsg title="No published events">
        Publish an event in Settings → Event Tickets before scanning.
      </FullMsg>
    );
  }
  if (eventId === null) {
    return (
      <FullMsg title="Pick the event">
        <div style={{ display: "grid", gap: 10, marginTop: 16 }}>
          {events.map((e) => (
            <button
              key={e.id}
              onClick={() => setEventId(e.id)}
              style={tileBtn}
            >
              {e.name}
            </button>
          ))}
        </div>
      </FullMsg>
    );
  }
  const ev = events.find((e) => e.id === eventId);
  return (
    <ScanSurface
      title={ev?.name ?? "Event"}
      subtitle="Staff scanner"
      submit={submit}
      gateControl={
        <input
          value={gateLabel}
          onChange={(e) => setGateLabel(e.target.value)}
          placeholder="Gate label"
          style={gateInput}
        />
      }
      lookup={lookup}
      admitTicket={admitTicket}
    />
  );
}

type LookupRow = {
  grantId: number;
  studentId: number;
  name: string;
  grade: number | null;
  tickets: Array<{ id: number; seq: number; status: string }>;
};

// ---------------------------------------------------------------------------
// The shared scanning surface (camera + manual entry + result + count)
// ---------------------------------------------------------------------------
function ScanSurface({
  title,
  subtitle,
  submit,
  gateControl,
  lookup,
  admitTicket,
}: {
  title: string;
  subtitle: string;
  submit: (token: string) => Promise<ScanResponse | null>;
  gateControl?: React.ReactNode;
  lookup?: (q: string) => Promise<LookupRow[]>;
  admitTicket?: (ticketId: number) => Promise<ScanResponse | null>;
}) {
  const [result, setResult] = useState<ScanResponse | null>(null);
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState("");
  const [showLookup, setShowLookup] = useState(false);
  const lastTokenRef = useRef<{ token: string; at: number } | null>(null);

  const handleToken = useCallback(
    async (token: string) => {
      const clean = token.trim();
      if (!clean || busy) return;
      // De-dupe the same code fired repeatedly by the camera within 3s.
      const now = Date.now();
      const last = lastTokenRef.current;
      if (last && last.token === clean && now - last.at < 3000) return;
      lastTokenRef.current = { token: clean, at: now };

      setBusy(true);
      setPaused(true);
      try {
        const res = await submit(clean);
        if (res) setResult(res);
      } finally {
        setBusy(false);
      }
      // Resume the camera after a beat so the volunteer can read the banner.
      window.setTimeout(() => setPaused(false), 2200);
    },
    [busy, submit],
  );

  const { videoRef, error: camError } = useCamera(true, paused, handleToken);

  return (
    <div style={surfaceStyle}>
      <div style={headerStyle}>
        <div style={{ fontWeight: 700, fontSize: 18 }}>{title}</div>
        <div style={{ color: "#94a3b8", fontSize: 13 }}>{subtitle}</div>
      </div>

      <div style={videoWrap}>
        <video ref={videoRef} style={videoStyle} muted playsInline />
        <div style={reticle} />
      </div>

      <CountBar res={result} />
      <ResultBanner res={result} />

      {result && (
        <button
          onClick={() => {
            setResult(null);
            setPaused(false);
            lastTokenRef.current = null;
          }}
          style={clearBtn}
        >
          Clear · ready for next
        </button>
      )}

      {gateControl && <div style={{ marginTop: 12 }}>{gateControl}</div>}

      <div style={{ marginTop: 12 }}>
        <div style={{ color: "#94a3b8", fontSize: 13, marginBottom: 6 }}>
          {camError
            ? "Camera unavailable — type or scan a code below."
            : "Or enter a code manually (handheld scanners type here too):"}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const v = manual;
            setManual("");
            void handleToken(v);
          }}
          style={{ display: "flex", gap: 8 }}
        >
          <input
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="Paste or scan ticket code"
            style={manualInput}
            autoFocus
          />
          <button type="submit" disabled={busy || !manual.trim()} style={goBtn}>
            {busy ? "…" : "Check"}
          </button>
        </form>
      </div>

      {lookup && admitTicket && (
        <div style={{ marginTop: 16 }}>
          <button
            onClick={() => setShowLookup((s) => !s)}
            style={linkLike}
          >
            {showLookup ? "Hide name lookup" : "Can't scan? Look up by name"}
          </button>
          {showLookup && (
            <NameLookup lookup={lookup} onAdmit={async (id) => {
              setBusy(true);
              try {
                const res = await admitTicket(id);
                if (res) setResult(res);
              } finally {
                setBusy(false);
              }
            }} />
          )}
        </div>
      )}
    </div>
  );
}

function NameLookup({
  lookup,
  onAdmit,
}: {
  lookup: (q: string) => Promise<LookupRow[]>;
  onAdmit: (ticketId: number) => Promise<void>;
}) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<LookupRow[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (q.trim().length < 2) {
      setRows([]);
      return;
    }
    let active = true;
    setSearching(true);
    const t = window.setTimeout(async () => {
      const r = await lookup(q.trim());
      if (active) {
        setRows(r);
        setSearching(false);
      }
    }, 300);
    return () => {
      active = false;
      window.clearTimeout(t);
    };
  }, [q, lookup]);

  return (
    <div style={{ marginTop: 10 }}>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Student name"
        style={manualInput}
      />
      {searching && (
        <div style={{ color: "#94a3b8", fontSize: 13, marginTop: 6 }}>
          Searching…
        </div>
      )}
      <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
        {rows.map((r) => (
          <div key={r.grantId} style={lookupCard}>
            <div style={{ fontWeight: 600 }}>
              {r.name}
              {r.grade !== null ? ` · Gr ${r.grade}` : ""}
            </div>
            <div
              style={{
                display: "flex",
                gap: 6,
                flexWrap: "wrap",
                marginTop: 6,
              }}
            >
              {r.tickets.map((t) => (
                <button
                  key={t.id}
                  disabled={t.status !== "valid"}
                  onClick={() => onAdmit(t.id)}
                  style={{
                    ...ticketChip,
                    opacity: t.status === "valid" ? 1 : 0.5,
                    cursor: t.status === "valid" ? "pointer" : "default",
                    background:
                      t.status === "valid" ? "#16a34a" : "#475569",
                  }}
                  title={
                    t.status === "valid"
                      ? "Admit this ticket"
                      : `Already ${t.status}`
                  }
                >
                  #{t.seq} {t.status === "valid" ? "Admit" : t.status}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function FullMsg({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div style={fullMsgStyle}>
      <div style={{ maxWidth: 420, textAlign: "center" }}>
        <h2 style={{ margin: "0 0 12px", fontSize: 24 }}>{title}</h2>
        <div style={{ color: "#cbd5e1", lineHeight: 1.5 }}>{children}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles (dark, full-screen, phone-first)
// ---------------------------------------------------------------------------
const surfaceStyle: React.CSSProperties = {
  minHeight: "100vh",
  background: "#020617",
  color: "#e2e8f0",
  padding: 16,
  maxWidth: 560,
  margin: "0 auto",
  fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
};
const headerStyle: React.CSSProperties = { marginBottom: 12 };
const videoWrap: React.CSSProperties = {
  position: "relative",
  width: "100%",
  aspectRatio: "1 / 1",
  background: "#000",
  borderRadius: 16,
  overflow: "hidden",
};
const videoStyle: React.CSSProperties = {
  width: "100%",
  height: "100%",
  objectFit: "cover",
};
const reticle: React.CSSProperties = {
  position: "absolute",
  inset: "18%",
  border: "3px solid rgba(255,255,255,0.7)",
  borderRadius: 16,
  pointerEvents: "none",
};
const bannerStyle: React.CSSProperties = {
  marginTop: 12,
  borderRadius: 16,
  padding: "20px 16px",
  textAlign: "center",
};
const countBarStyle: React.CSSProperties = {
  marginTop: 12,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "#0f172a",
  borderRadius: 12,
  padding: "10px 14px",
};
const manualInput: React.CSSProperties = {
  flex: 1,
  width: "100%",
  padding: "12px 14px",
  borderRadius: 10,
  border: "1px solid #334155",
  background: "#0f172a",
  color: "#e2e8f0",
  fontSize: 16,
};
const gateInput: React.CSSProperties = { ...manualInput, width: "100%" };
const goBtn: React.CSSProperties = {
  padding: "12px 18px",
  borderRadius: 10,
  border: "none",
  background: "#2563eb",
  color: "#fff",
  fontWeight: 700,
  fontSize: 16,
  cursor: "pointer",
};
const clearBtn: React.CSSProperties = {
  marginTop: 10,
  width: "100%",
  padding: "12px 18px",
  borderRadius: 10,
  border: "1px solid #334155",
  background: "#1e293b",
  color: "#e2e8f0",
  fontWeight: 700,
  fontSize: 16,
  cursor: "pointer",
};
const linkLike: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#60a5fa",
  cursor: "pointer",
  fontSize: 14,
  padding: 0,
  textDecoration: "underline",
};
const lookupCard: React.CSSProperties = {
  background: "#0f172a",
  borderRadius: 12,
  padding: 12,
  border: "1px solid #1e293b",
};
const ticketChip: React.CSSProperties = {
  border: "none",
  color: "#fff",
  borderRadius: 999,
  padding: "6px 12px",
  fontSize: 13,
  fontWeight: 700,
};
const fullMsgStyle: React.CSSProperties = {
  minHeight: "100vh",
  background: "#020617",
  color: "#e2e8f0",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 24,
  fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
};
const linkBtn: React.CSSProperties = {
  display: "inline-block",
  padding: "10px 18px",
  borderRadius: 10,
  background: "#2563eb",
  color: "#fff",
  textDecoration: "none",
  fontWeight: 600,
};
const tileBtn: React.CSSProperties = {
  padding: "16px 18px",
  borderRadius: 12,
  border: "1px solid #334155",
  background: "#0f172a",
  color: "#e2e8f0",
  fontSize: 17,
  fontWeight: 600,
  cursor: "pointer",
};
