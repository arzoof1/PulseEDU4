import { useEffect, useMemo, useRef, useState } from "react";

interface SchoolSettings {
  schoolName: string;
}

interface LocationRow {
  id: number;
  name: string;
  isOrigin: boolean;
  isDestination: boolean;
  studentVisible: boolean;
  active: boolean;
}

interface AllowedRow {
  id: number;
  originLocationId: number;
  destinationLocationId: number;
}

const TOKEN_KEY = "pulseed.kiosk.token";
const DEVICE_ID_KEY = "pulseed.kiosk.device_id";

function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
function setStoredToken(token: string) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // ignore
  }
}
function clearStoredToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
}

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
    // Cookies/localStorage disabled — best-effort, ephemeral id.
    return "ephemeral-" + Math.random().toString(36).slice(2);
  }
}

function getDeviceLabel(): string {
  // Best-effort human-readable label so an admin can tell devices apart in
  // the Active Kiosks list. Stays short and never includes anything secret.
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

type Phase =
  | { kind: "loading" }
  | { kind: "activate" }
  | { kind: "ready"; token: string; room: string; staffName: string | null };

type Mode = "out" | "back";

interface ActivePass {
  id: number;
  studentId: string;
  studentFirstName: string | null;
  destination: string;
  createdAt: string; // ISO
  maxDurationMinutes: number;
}

type Status =
  | { kind: "idle" }
  | { kind: "submitting" }
  | {
      kind: "success";
      mode: Mode;
      studentId: string;
      studentFirstName: string | null;
      destination: string;
    }
  | { kind: "error"; message: string };

export default function Kiosk() {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [showDeactivate, setShowDeactivate] = useState(false);

  useEffect(() => {
    const token = getStoredToken();
    if (!token) {
      setPhase({ kind: "activate" });
      return;
    }
    fetch(`/api/kiosk/activation/${encodeURIComponent(token)}`)
      .then(async (r) => {
        if (!r.ok) {
          clearStoredToken();
          setPhase({ kind: "activate" });
          return;
        }
        const data = await r.json();
        setPhase({
          kind: "ready",
          token,
          room: data.room,
          staffName: data.staffName ?? null,
        });
      })
      .catch(() => {
        // Network failure; keep token, fall back to activate screen so the
        // user isn't stuck staring at a spinner forever.
        setPhase({ kind: "activate" });
      });
  }, []);

  function handleActivated(token: string, room: string, staffName: string) {
    setStoredToken(token);
    setPhase({ kind: "ready", token, room, staffName });
  }

  function handleRevoked() {
    clearStoredToken();
    setPhase({ kind: "activate" });
    setShowDeactivate(false);
  }

  if (phase.kind === "loading") {
    return (
      <Shell>
        <div style={{ opacity: 0.6 }}>Loading…</div>
      </Shell>
    );
  }

  if (phase.kind === "activate") {
    return (
      <Shell>
        <ActivationScreen onActivated={handleActivated} />
      </Shell>
    );
  }

  return (
    <Shell>
      <GearButton onClick={() => setShowDeactivate(true)} />
      <KioskBody
        token={phase.token}
        room={phase.room}
        staffName={phase.staffName}
        onRevoked={handleRevoked}
      />
      {showDeactivate && (
        <DeactivateModal
          token={phase.token}
          onClose={() => setShowDeactivate(false)}
          onDeactivated={handleRevoked}
        />
      )}
    </Shell>
  );
}

/* ----------------------------- Activation screen ----------------------------- */

function ActivationScreen({
  onActivated,
}: {
  onActivated: (token: string, room: string, staffName: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [room, setRoom] = useState("");
  const [pickerLocations, setPickerLocations] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password) return;
    setBusy(true);
    setError("");
    try {
      const body: Record<string, string> = {
        email: email.trim(),
        password,
        deviceFingerprint: getOrCreateDeviceFingerprint(),
        deviceLabel: getDeviceLabel(),
      };
      if (room) body.room = room;
      const res = await fetch("/api/kiosk/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && data.needsRoom) {
        setPickerLocations(data.locations ?? []);
        setError(
          "You don't have a default room set yet. Pick the room this kiosk is in.",
        );
        return;
      }
      if (!res.ok) {
        setError(data.error ?? `Activation failed (${res.status})`);
        return;
      }
      onActivated(data.token, data.room, data.staffName);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      style={{
        background: "rgba(255,255,255,0.06)",
        border: "1px solid rgba(255,255,255,0.12)",
        borderRadius: 12,
        padding: "1.75rem",
        width: "min(440px, 92vw)",
        display: "flex",
        flexDirection: "column",
        gap: "1rem",
      }}
    >
      <div style={{ textAlign: "center", marginBottom: "0.25rem" }}>
        <div style={{ fontSize: "1.4rem", fontWeight: 700, letterSpacing: "0.02em" }}>
          Activate Kiosk
        </div>
        <div style={{ fontSize: "0.85rem", opacity: 0.7, marginTop: 4 }}>
          A teacher must sign in once to put this device in kiosk mode.
        </div>
      </div>

      <Field label="Teacher email">
        <input
          type="email"
          autoComplete="username"
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy}
          style={inputStyle}
        />
      </Field>

      <Field label="Password">
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
          style={inputStyle}
        />
      </Field>

      {pickerLocations && (
        <Field label="Room this kiosk is in">
          <select
            value={room}
            onChange={(e) => setRoom(e.target.value)}
            disabled={busy}
            style={inputStyle}
          >
            <option value="">Select a room…</option>
            {pickerLocations.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </Field>
      )}

      {error && <ErrorBox>{error}</ErrorBox>}

      <button
        type="submit"
        disabled={
          busy ||
          !email.trim() ||
          !password ||
          (pickerLocations !== null && !room)
        }
        style={primaryBtn(
          busy ||
            !email.trim() ||
            !password ||
            (pickerLocations !== null && !room),
        )}
      >
        {busy ? "Activating…" : "Activate this kiosk"}
      </button>
    </form>
  );
}

/* -------------------------------- Kiosk body -------------------------------- */

function KioskBody({
  token,
  room,
  staffName,
  onRevoked,
}: {
  token: string;
  room: string;
  staffName: string | null;
  onRevoked: () => void;
}) {
  const [school, setSchool] = useState<SchoolSettings | null>(null);
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [allowed, setAllowed] = useState<AllowedRow[]>([]);
  const [now, setNow] = useState(new Date());
  const [studentId, setStudentId] = useState("");
  const [destination, setDestination] = useState("");
  const [mode, setMode] = useState<Mode>("out");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [activePass, setActivePass] = useState<ActivePass | null>(null);
  const [returning, setReturning] = useState(false);
  const [returnError, setReturnError] = useState<string | null>(null);
  const studentIdInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    fetch("/api/school-settings")
      .then((r) => r.json())
      .then((d: SchoolSettings) => setSchool(d))
      .catch(() => setSchool(null));
    fetch("/api/locations")
      .then((r) => r.json())
      .then((d: LocationRow[]) => setLocations(d))
      .catch(() => setLocations([]));
    fetch("/api/location-allowed-destinations")
      .then((r) => r.json())
      .then((d: AllowedRow[]) => setAllowed(d))
      .catch(() => setAllowed([]));
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const originLocation = useMemo(
    () => locations.find((l) => l.name === room) ?? null,
    [locations, room],
  );

  const destinationOptions = useMemo(() => {
    if (!originLocation) return [];
    const allowedDestIds = new Set(
      allowed
        .filter((a) => a.originLocationId === originLocation.id)
        .map((a) => a.destinationLocationId),
    );
    return locations
      .filter(
        (l) =>
          l.active &&
          l.studentVisible &&
          l.isDestination &&
          allowedDestIds.has(l.id),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [locations, allowed, originLocation]);

  function resetForm() {
    setStudentId("");
    setDestination("");
    setMode("out");
    setStatus({ kind: "idle" });
  }

  useEffect(() => {
    if (status.kind !== "success") return;
    const id = setTimeout(resetForm, 8000);
    return () => clearTimeout(id);
  }, [status.kind]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!studentId.trim()) return;
    if (mode === "out" && !destination) return;
    setStatus({ kind: "submitting" });
    try {
      const url =
        mode === "out"
          ? "/api/kiosk/hall-passes"
          : "/api/kiosk/hall-passes/return";
      const body: Record<string, string> =
        mode === "out"
          ? { studentId: studentId.trim(), token, destination }
          : { studentId: studentId.trim(), token };
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 401) {
        const b = await res.json().catch(() => ({}));
        if (b.revoked) {
          onRevoked();
          return;
        }
      }
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setStatus({
          kind: "error",
          message: b.error ?? `Request failed (${res.status})`,
        });
        return;
      }
      const data = (await res.json().catch(() => ({}))) as {
        id?: number;
        destination?: string;
        createdAt?: string;
        maxDurationMinutes?: number;
        studentFirstName?: string | null;
      };
      if (mode === "out") {
        // Skip the brief success card and go straight to the giant
        // countdown screen so the teacher can see who's out from across
        // the room.
        if (
          typeof data.id === "number" &&
          typeof data.createdAt === "string" &&
          typeof data.maxDurationMinutes === "number"
        ) {
          setActivePass({
            id: data.id,
            studentId: studentId.trim(),
            studentFirstName: data.studentFirstName ?? null,
            destination,
            createdAt: data.createdAt,
            maxDurationMinutes: data.maxDurationMinutes,
          });
          setStudentId("");
          setDestination("");
          setStatus({ kind: "idle" });
        } else {
          setStatus({
            kind: "success",
            mode,
            studentId: studentId.trim(),
            studentFirstName: data.studentFirstName ?? null,
            destination,
          });
        }
      } else {
        setStatus({
          kind: "success",
          mode,
          studentId: studentId.trim(),
          studentFirstName: data.studentFirstName ?? null,
          destination: data.destination ?? "(unknown)",
        });
      }
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Network error",
      });
    }
  }

  return (
    <>
      <div
        style={{
          fontSize: "0.875rem",
          letterSpacing: "0.15em",
          opacity: 0.6,
          textTransform: "uppercase",
          marginBottom: "0.5rem",
        }}
      >
        {school?.schoolName ?? "PulseEDU"} · Hall Pass Kiosk
      </div>
      <h1
        style={{
          fontSize: "clamp(2rem, 5vw, 3.5rem)",
          margin: "0.25rem 0 0.25rem",
          fontWeight: 700,
        }}
      >
        {room}
      </h1>
      {staffName && (
        <div style={{ fontSize: "0.95rem", opacity: 0.55, marginBottom: "0.5rem" }}>
          Activated by {staffName}
        </div>
      )}
      <div style={{ fontSize: "1rem", opacity: 0.7, marginBottom: "2rem" }}>
        {now.toLocaleString([], {
          weekday: "long",
          month: "long",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })}
      </div>

      {activePass ? (
        <TimerScreen
          activePass={activePass}
          now={now}
          returning={returning}
          returnError={returnError}
          onReturn={async () => {
            setReturning(true);
            setReturnError(null);
            try {
              const res = await fetch("/api/kiosk/hall-passes/return", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  studentId: activePass.studentId,
                  token,
                }),
              });
              if (res.status === 401) {
                const b = await res.json().catch(() => ({}));
                if (b.revoked) {
                  onRevoked();
                  return;
                }
              }
              if (!res.ok && res.status !== 404) {
                const b = await res.json().catch(() => ({}));
                setReturnError(
                  b.error ?? `Request failed (${res.status})`,
                );
                return;
              }
              // 404 means the pass was already ended elsewhere; treat as
              // success and clear the screen.
              setActivePass(null);
            } catch (err) {
              setReturnError(
                err instanceof Error ? err.message : "Network error",
              );
            } finally {
              setReturning(false);
            }
          }}
        />
      ) : status.kind === "success" ? (
        <SuccessCard
          mode={status.mode}
          studentId={status.studentId}
          studentFirstName={status.studentFirstName}
          destination={status.destination}
          onReset={resetForm}
        />
      ) : (
        <form
          onSubmit={handleSubmit}
          style={{
            background: "rgba(255,255,255,0.06)",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 12,
            padding: "1.5rem",
            width: "min(480px, 92vw)",
            display: "flex",
            flexDirection: "column",
            gap: "1rem",
          }}
        >
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <ModeButton
              active={mode === "out"}
              onClick={() => {
                if (status.kind === "submitting") return;
                setMode("out");
                setStatus({ kind: "idle" });
                studentIdInputRef.current?.focus();
              }}
            >
              I'm leaving
            </ModeButton>
            <ModeButton
              active={mode === "back"}
              onClick={() => {
                if (status.kind === "submitting") return;
                setMode("back");
                setDestination("");
                setStatus({ kind: "idle" });
                studentIdInputRef.current?.focus();
              }}
            >
              I'm back
            </ModeButton>
          </div>

          <Field label="Student ID">
            <input
              ref={studentIdInputRef}
              type="text"
              inputMode="numeric"
              autoComplete="off"
              autoFocus
              value={studentId}
              onChange={(e) => setStudentId(e.target.value)}
              placeholder="e.g. 12345"
              style={inputStyle}
              disabled={status.kind === "submitting"}
            />
          </Field>

          {mode === "out" && (
            <Field label="Where are you going?">
              <select
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                style={inputStyle}
                disabled={status.kind === "submitting"}
              >
                <option value="">Select a destination…</option>
                {destinationOptions.map((d) => (
                  <option key={d.id} value={d.name}>
                    {d.name}
                  </option>
                ))}
              </select>
              {originLocation && destinationOptions.length === 0 && (
                <div style={{ fontSize: "0.85rem", opacity: 0.7, marginTop: 6 }}>
                  No student-visible destinations are configured for this room.
                </div>
              )}
              {!originLocation && locations.length > 0 && (
                <div style={{ fontSize: "0.85rem", color: "#fca5a5", marginTop: 6 }}>
                  "{room}" is not a known location. Ask an admin.
                </div>
              )}
            </Field>
          )}

          {status.kind === "error" && <ErrorBox>{status.message}</ErrorBox>}

          <button
            type="submit"
            disabled={
              status.kind === "submitting" ||
              !studentId.trim() ||
              (mode === "out" && !destination)
            }
            style={primaryBtn(
              status.kind === "submitting" ||
                !studentId.trim() ||
                (mode === "out" && !destination),
              { padding: "0.9rem 1rem", fontSize: "1.1rem" },
            )}
          >
            {status.kind === "submitting"
              ? mode === "out"
                ? "Creating pass…"
                : "Signing back in…"
              : mode === "out"
                ? "Get Pass"
                : "Sign Back In"}
          </button>
        </form>
      )}
    </>
  );
}

/* ----------------------------- Deactivate modal ----------------------------- */

function DeactivateModal({
  token,
  onClose,
  onDeactivated,
}: {
  token: string;
  onClose: () => void;
  onDeactivated: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password) return;
    setBusy(true);
    setError("");
    try {
      const loginRes = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      if (!loginRes.ok) {
        const b = await loginRes.json().catch(() => ({}));
        setError(b.error ?? "Sign-in failed");
        return;
      }
      const deactRes = await fetch("/api/kiosk/deactivate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      // Always log the staff out so we don't leave a teacher session sitting on
      // a shared classroom device.
      await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
      if (!deactRes.ok && deactRes.status !== 404) {
        const b = await deactRes.json().catch(() => ({}));
        setError(b.error ?? `Deactivation failed (${deactRes.status})`);
        return;
      }
      onDeactivated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
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
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#0f172a",
          border: "1px solid rgba(255,255,255,0.15)",
          borderRadius: 12,
          padding: "1.75rem",
          width: "min(420px, 92vw)",
          display: "flex",
          flexDirection: "column",
          gap: "1rem",
        }}
      >
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: "1.25rem", fontWeight: 700 }}>
            Deactivate Kiosk
          </div>
          <div style={{ fontSize: "0.85rem", opacity: 0.7, marginTop: 4 }}>
            Any signed-in staff member can deactivate. We log who did it.
          </div>
        </div>

        <Field label="Your email">
          <input
            type="email"
            autoComplete="username"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
            style={inputStyle}
          />
        </Field>

        <Field label="Password">
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            style={inputStyle}
          />
        </Field>

        {error && <ErrorBox>{error}</ErrorBox>}

        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            style={{
              flex: 1,
              background: "transparent",
              color: "#fff",
              border: "1px solid rgba(255,255,255,0.25)",
              borderRadius: 8,
              padding: "0.75rem 1rem",
              fontSize: "1rem",
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !email.trim() || !password}
            style={{
              ...primaryBtn(busy || !email.trim() || !password),
              flex: 1,
              background:
                busy || !email.trim() || !password ? "rgba(239,68,68,0.4)" : "#ef4444",
            }}
          >
            {busy ? "Working…" : "Deactivate"}
          </button>
        </div>
      </form>
    </div>
  );
}

/* ---------------------------------- bits ---------------------------------- */

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: 1,
        background: active ? "#3b82f6" : "rgba(255,255,255,0.06)",
        color: active ? "#fff" : "rgba(255,255,255,0.75)",
        border: active
          ? "1px solid #3b82f6"
          : "1px solid rgba(255,255,255,0.18)",
        borderRadius: 8,
        padding: "0.7rem 1rem",
        fontSize: "1rem",
        fontWeight: 600,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

function GearButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label="Kiosk settings"
      title="Kiosk settings"
      onClick={onClick}
      style={{
        position: "fixed",
        top: 12,
        right: 12,
        background: "rgba(255,255,255,0.06)",
        border: "1px solid rgba(255,255,255,0.15)",
        color: "rgba(255,255,255,0.55)",
        borderRadius: 999,
        width: 40,
        height: 40,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        zIndex: 10,
      }}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    </button>
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
        justifyContent: "center",
        background: "linear-gradient(180deg, #0f172a 0%, #1e293b 100%)",
        color: "#fff",
        fontFamily: "system-ui, sans-serif",
        padding: "2rem",
        textAlign: "center",
        position: "relative",
      }}
    >
      {children}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        textAlign: "left",
      }}
    >
      <span style={{ fontSize: "0.85rem", opacity: 0.8, fontWeight: 500 }}>
        {label}
      </span>
      {children}
    </label>
  );
}

function ErrorBox({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: "rgba(239,68,68,0.15)",
        border: "1px solid rgba(239,68,68,0.4)",
        color: "#fecaca",
        padding: "0.6rem 0.9rem",
        borderRadius: 8,
        fontSize: "0.9rem",
        textAlign: "left",
      }}
    >
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "rgba(15,23,42,0.6)",
  border: "1px solid rgba(255,255,255,0.2)",
  color: "#fff",
  borderRadius: 8,
  padding: "0.75rem 0.9rem",
  fontSize: "1.05rem",
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};

function primaryBtn(
  disabled: boolean,
  override: React.CSSProperties = {},
): React.CSSProperties {
  return {
    background: disabled ? "rgba(59,130,246,0.4)" : "#3b82f6",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "0.75rem 1rem",
    fontSize: "1rem",
    fontWeight: 600,
    cursor: disabled ? "not-allowed" : "pointer",
    ...override,
  };
}

function TimerScreen({
  activePass,
  now,
  returning,
  returnError,
  onReturn,
}: {
  activePass: ActivePass;
  now: Date;
  returning: boolean;
  returnError: string | null;
  onReturn: () => void;
}) {
  const elapsedMs = now.getTime() - new Date(activePass.createdAt).getTime();
  const totalMs = activePass.maxDurationMinutes * 60 * 1000;
  const remainingMs = totalMs - elapsedMs;
  const overdue = remainingMs <= 0;
  const absMs = Math.abs(remainingMs);
  const totalSeconds = Math.floor(absMs / 1000);
  const mm = Math.floor(totalSeconds / 60);
  const ss = totalSeconds % 60;
  const timeText = `${overdue ? "-" : ""}${mm}:${String(ss).padStart(2, "0")}`;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: overdue ? "#dc2626" : "#15803d",
        color: "#fff",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "2rem",
        zIndex: 5,
        textAlign: "center",
      }}
    >
      <div
        style={{
          fontSize: "clamp(1rem, 2.5vw, 1.5rem)",
          letterSpacing: "0.15em",
          textTransform: "uppercase",
          opacity: 0.85,
          marginBottom: "0.75rem",
        }}
      >
        {overdue ? "Overdue" : "Out on pass"}
      </div>
      <div
        style={{
          fontSize: "clamp(2.5rem, 7vw, 5rem)",
          fontWeight: 700,
          lineHeight: 1.1,
          marginBottom: "0.5rem",
        }}
      >
        {activePass.studentFirstName ?? activePass.studentId}
        <span style={{ opacity: 0.85, fontWeight: 500 }}> → </span>
        {activePass.destination}
      </div>
      <div
        aria-label={overdue ? "overdue countdown" : "time remaining"}
        style={{
          fontSize: "clamp(8rem, 28vw, 22rem)",
          fontWeight: 900,
          lineHeight: 1,
          fontVariantNumeric: "tabular-nums",
          letterSpacing: "0.02em",
          margin: "1rem 0 1.5rem",
          textShadow: "0 4px 24px rgba(0,0,0,0.25)",
        }}
      >
        {timeText}
      </div>
      <div
        style={{
          fontSize: "clamp(1rem, 2vw, 1.25rem)",
          opacity: 0.85,
          marginBottom: "2rem",
        }}
      >
        {overdue
          ? `Over the ${activePass.maxDurationMinutes}-minute limit`
          : `Limit: ${activePass.maxDurationMinutes} minutes`}
      </div>

      {returnError && (
        <div
          style={{
            background: "rgba(0,0,0,0.25)",
            border: "1px solid rgba(255,255,255,0.4)",
            color: "#fff",
            padding: "0.6rem 0.9rem",
            borderRadius: 8,
            fontSize: "1rem",
            marginBottom: "1rem",
            maxWidth: 480,
          }}
        >
          {returnError}
        </div>
      )}

      <button
        type="button"
        onClick={onReturn}
        disabled={returning}
        style={{
          background: "#fff",
          color: overdue ? "#dc2626" : "#15803d",
          border: "none",
          borderRadius: 12,
          padding: "1.1rem 2.5rem",
          fontSize: "clamp(1.25rem, 2.5vw, 1.6rem)",
          fontWeight: 700,
          cursor: returning ? "not-allowed" : "pointer",
          opacity: returning ? 0.7 : 1,
          boxShadow: "0 6px 18px rgba(0,0,0,0.25)",
        }}
      >
        {returning ? "Signing in…" : "I'm back"}
      </button>
    </div>
  );
}

function SuccessCard({
  mode,
  studentId,
  studentFirstName,
  destination,
  onReset,
}: {
  mode: Mode;
  studentId: string;
  studentFirstName: string | null;
  destination: string;
  onReset: () => void;
}) {
  const displayName = studentFirstName ?? studentId;
  return (
    <div
      style={{
        background: "rgba(34,197,94,0.12)",
        border: "1px solid rgba(34,197,94,0.5)",
        borderRadius: 12,
        padding: "2rem",
        width: "min(480px, 92vw)",
      }}
    >
      <div style={{ fontSize: "3rem", marginBottom: "0.5rem" }}>✓</div>
      <div
        style={{ fontSize: "1.5rem", fontWeight: 600, marginBottom: "0.5rem" }}
      >
        {mode === "out" ? "Pass created" : "Welcome back"}
      </div>
      <div style={{ opacity: 0.85, marginBottom: "1.5rem" }}>
        {mode === "out" ? (
          <>
            <strong>{displayName}</strong> → <strong>{destination}</strong>
          </>
        ) : (
          <>
            <strong>{displayName}</strong> signed back in from{" "}
            <strong>{destination}</strong>
          </>
        )}
      </div>
      <div
        style={{ fontSize: "0.85rem", opacity: 0.55, marginBottom: "1rem" }}
      >
        Resetting in a few seconds…
      </div>
      <button
        type="button"
        onClick={onReset}
        style={{
          background: "rgba(255,255,255,0.12)",
          color: "#fff",
          border: "1px solid rgba(255,255,255,0.2)",
          borderRadius: 8,
          padding: "0.75rem 1.5rem",
          fontSize: "1rem",
          cursor: "pointer",
        }}
      >
        Done
      </button>
    </div>
  );
}
