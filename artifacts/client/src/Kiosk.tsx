import { useEffect, useMemo, useRef, useState } from "react";
import { CameraScanner } from "./components/CameraScanner";
import { useSchoolBranding } from "./lib/branding";

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
  | {
      // First-scan confirmation. Server returned `requiresConfirm:true`
      // for an activate-by-enrollment / activate-by-pin call. The kiosk
      // shows a big "Activate kiosk for X in Y?" modal — once confirmed
      // we call back with `confirm:true`.
      kind: "enrollConfirm";
      method: "enroll" | "pin";
      credential: string; // raw token OR pin
      staffId: number;
      staffName: string;
      previewRoom: string | null;
      ttlDays: number;
      // Set when we tried to auto-confirm with the previewRoom and it
      // failed (e.g., the default room is no longer a valid origin).
      // Surfaced as a banner in EnrollConfirmScreen so the user knows
      // why they landed on the manual form.
      autoConfirmError?: string | null;
    }
  | {
      kind: "ready";
      token: string;
      room: string;
      staffName: string | null;
      expiresAt?: string | null;
    };

type Mode = "out" | "back" | "signin";

interface SigninSuccess {
  firstName: string;
  lastName: string;
  grade: number | string | null;
  house: { id: number; name: string; color: string } | null;
  welcomeMessage: string;
}

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

interface QueueEntry {
  id: number;
  studentId: string;
  firstName: string | null;
  lastName: string | null;
  destination: string;
  position: number;
  addedAt: string;
}

// How long the "Welcome [Name] — enter your ID" handoff prompt sits on the
// kiosk after the previous student taps "I'm back". If the queued student
// doesn't enter their ID in this window we forfeit their slot and return
// the kiosk to idle (the next student in line, if any, is NOT auto-shown
// — they have to either be re-queued or walk up cold).
const NEXT_UP_TIMEOUT_MS = 60_000;

export default function Kiosk() {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  // Phase 3: `?signin=<studentId>` parsed from URL on first load,
  // handed to KioskBody once a token is in place. Null after consumption.
  const [pendingSignin, setPendingSignin] = useState<string | null>(null);
  const [showDeactivate, setShowDeactivate] = useState(false);

  // Apply per-school branding once we have an activation token. The hook
  // re-fetches automatically when the token (and therefore the school)
  // changes, so reactivating to a different school retints the masthead.
  const kioskToken = phase.kind === "ready" ? phase.token : null;
  useSchoolBranding({ mode: "kiosk", token: kioskToken });

  useEffect(() => {
    // First check for an ?enroll=<token> in the URL. A teacher who
    // scanned their card with the device's camera lands on
    // `/kiosk?enroll=<...>`. We try to activate-by-enrollment, which
    // returns either `requiresConfirm:true` (first scan on this device)
    // or a live activation immediately if the kiosk was already in
    // place. Either way we strip the token from the URL so a refresh
    // doesn't re-trigger the flow.
    const params = new URLSearchParams(window.location.search);
    const enrollFromUrl = params.get("enroll");
    if (enrollFromUrl) {
      params.delete("enroll");
      const qs = params.toString();
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${qs ? "?" + qs : ""}`,
      );
      void beginEnrollActivation(enrollFromUrl);
      return;
    }

    // Phase 3: a student badge QR encodes `/kiosk?signin=<studentId>`.
    // If the device has an existing kiosk activation in localStorage,
    // we hand the ID to KioskBody via `pendingSignin` so it auto-fills
    // and submits the sign-in flow. We strip it from the URL either
    // way so a refresh is a no-op.
    const signinFromUrl = params.get("signin");
    if (signinFromUrl) {
      params.delete("signin");
      const qs = params.toString();
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${qs ? "?" + qs : ""}`,
      );
      setPendingSignin(signinFromUrl);
    }

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
          expiresAt: data.expiresAt ?? null,
        });
      })
      .catch(() => {
        // Network failure; keep token, fall back to activate screen so the
        // user isn't stuck staring at a spinner forever.
        setPhase({ kind: "activate" });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Used by both the ?enroll= URL path AND the in-app "Enter 6-digit
  // code" path. `method:'enroll'` sends `{enrollToken}`; `'pin'` sends
  // `{pin}`. On `requiresConfirm:true` we hop to the enrollConfirm
  // phase. Otherwise treat it as a normal activation success/failure.
  async function beginEnrollActivation(
    credential: string,
    method: "enroll" | "pin" = "enroll",
    room?: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const path =
      method === "enroll"
        ? "/api/kiosk/activate-by-enrollment"
        : "/api/kiosk/activate-by-pin";
    const body: Record<string, unknown> = {
      deviceFingerprint: getOrCreateDeviceFingerprint(),
      deviceLabel: getDeviceLabel(),
      confirm: false,
    };
    if (method === "enroll") body.enrollToken = credential;
    else body.pin = credential;
    if (room) body.room = room;
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.requiresConfirm) {
        // If the server already knows this teacher's default room
        // (staff_defaults.default_location_name is set), skip the
        // confirm screen and auto-activate. The teacher typed her
        // own PIN/QR — she shouldn't have to also pick the room she
        // sits in every day. Core Team sub-coverage uses a different
        // endpoint (/api/kiosk/activate-proxy) where the actor types
        // the room explicitly, so they're unaffected by this branch.
        const presetRoom =
          typeof data.previewRoom === "string" && data.previewRoom.trim()
            ? data.previewRoom.trim()
            : null;
        if (presetRoom) {
          const confirmBody: Record<string, unknown> = {
            deviceFingerprint: getOrCreateDeviceFingerprint(),
            deviceLabel: getDeviceLabel(),
            confirm: true,
            room: presetRoom,
          };
          if (method === "enroll") confirmBody.enrollToken = credential;
          else confirmBody.pin = credential;
          const confirmRes = await fetch(path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(confirmBody),
          });
          const confirmData = await confirmRes.json().catch(() => ({}));
          if (confirmRes.ok && confirmData.token) {
            handleActivated(
              confirmData.token,
              confirmData.room,
              confirmData.staffName,
              confirmData.expiresAt ?? null,
            );
            return { ok: true };
          }
          // Fall through to the confirm screen on failure so the user
          // can see the error and try a different room name.
          setPhase({
            kind: "enrollConfirm",
            method,
            credential,
            staffId: data.staffId,
            staffName: data.staffName,
            previewRoom: data.previewRoom ?? null,
            ttlDays: data.ttlDays ?? 14,
            autoConfirmError:
              confirmData.error ??
              `Auto-activation failed (${confirmRes.status}). Pick a room and try again.`,
          });
          return { ok: true };
        }
        setPhase({
          kind: "enrollConfirm",
          method,
          credential,
          staffId: data.staffId,
          staffName: data.staffName,
          previewRoom: data.previewRoom ?? null,
          ttlDays: data.ttlDays ?? 14,
        });
        return { ok: true };
      }
      if (res.ok && data.token) {
        handleActivated(
          data.token,
          data.room,
          data.staffName,
          data.expiresAt ?? null,
        );
        return { ok: true };
      }
      setPhase({ kind: "activate" });
      return { ok: false, error: data.error ?? `Activation failed (${res.status})` };
    } catch (err) {
      setPhase({ kind: "activate" });
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Network error",
      };
    }
  }

  function handleActivated(
    token: string,
    room: string,
    staffName: string,
    expiresAt: string | null = null,
  ) {
    setStoredToken(token);
    setPhase({ kind: "ready", token, room, staffName, expiresAt });
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
        <ActivationEntry
          onActivated={handleActivated}
          onBeginEnroll={beginEnrollActivation}
        />
      </Shell>
    );
  }

  if (phase.kind === "enrollConfirm") {
    return (
      <Shell>
        <EnrollConfirmScreen
          staffName={phase.staffName}
          previewRoom={phase.previewRoom}
          ttlDays={phase.ttlDays}
          initialError={phase.autoConfirmError ?? null}
          onCancel={() => setPhase({ kind: "activate" })}
          onConfirm={async (room) => {
            const body: Record<string, unknown> = {
              deviceFingerprint: getOrCreateDeviceFingerprint(),
              deviceLabel: getDeviceLabel(),
              confirm: true,
              room,
            };
            if (phase.method === "enroll")
              body.enrollToken = phase.credential;
            else body.pin = phase.credential;
            const path =
              phase.method === "enroll"
                ? "/api/kiosk/activate-by-enrollment"
                : "/api/kiosk/activate-by-pin";
            const res = await fetch(path, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.token) {
              handleActivated(
                data.token,
                data.room,
                data.staffName,
                data.expiresAt ?? null,
              );
              return { ok: true };
            }
            return {
              ok: false,
              error: data.error ?? `Activation failed (${res.status})`,
            };
          }}
        />
      </Shell>
    );
  }

  return (
    <Shell>
      <GearButton onClick={() => setShowDeactivate(true)} />
      {phase.expiresAt && <ExpiryNudge expiresAt={phase.expiresAt} />}
      {/* "Step out" — opens the staff app in a new tab so a teacher can
          log attendance, write a support note, etc. without losing the
          waiting line. The kiosk keeps polling the queue server-side
          (token in localStorage), so they can flip back any time. */}
      <StepOutButton />
      <KioskBody
        token={phase.token}
        room={phase.room}
        staffName={phase.staffName}
        onRevoked={handleRevoked}
        pendingSignin={pendingSignin}
        onPendingSigninConsumed={() => setPendingSignin(null)}
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

// Day-12 nudge: surfaces a small amber banner when the activation has
// fewer than 2 days left. Encourages the teacher to re-scan their card
// before the kiosk dies mid-period. Hidden once expiry is past
// (deactivation handler will catch that).
function ExpiryNudge({ expiresAt }: { expiresAt: string }) {
  const ts = Date.parse(expiresAt);
  if (!Number.isFinite(ts)) return null;
  const msLeft = ts - Date.now();
  const NUDGE_MS = 2 * 24 * 60 * 60 * 1000;
  if (msLeft > NUDGE_MS || msLeft <= 0) return null;
  const daysLeft = Math.max(1, Math.ceil(msLeft / (24 * 60 * 60 * 1000)));
  return (
    <div
      role="status"
      style={{
        position: "fixed",
        top: 12,
        left: "50%",
        transform: "translateX(-50%)",
        background: "rgba(245, 158, 11, 0.18)",
        border: "1px solid rgba(245, 158, 11, 0.55)",
        color: "#fbbf24",
        padding: "0.5rem 1rem",
        borderRadius: 999,
        fontSize: "0.85rem",
        fontWeight: 600,
        zIndex: 30,
        pointerEvents: "none",
      }}
    >
      This kiosk expires in {daysLeft} day{daysLeft === 1 ? "" : "s"} —
      scan your card to renew.
    </div>
  );
}

/* ----------------------------- Activation entry ----------------------------- */

// Three-tab entry point. Scan tab is the default: a teacher who already
// scanned their card with the device camera never lands here (they hit
// the ?enroll= path in the top-level useEffect). The Scan tab is just
// the instruction sheet for what to do. PIN tab accepts the 6-digit
// code printed on the card. Password tab is the original email +
// password flow, kept as a fallback for teachers who lost their card.
function ActivationEntry({
  onActivated,
  onBeginEnroll,
}: {
  onActivated: (
    token: string,
    room: string,
    staffName: string,
    expiresAt?: string | null,
  ) => void;
  onBeginEnroll: (
    credential: string,
    method: "enroll" | "pin",
    room?: string,
  ) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [tab, setTab] = useState<"camera" | "scan" | "pin" | "password">(
    "camera",
  );
  return (
    <div
      style={{
        background: "rgba(255,255,255,0.06)",
        border: "1px solid rgba(255,255,255,0.12)",
        borderRadius: 12,
        padding: "1.75rem",
        width: "min(520px, 92vw)",
        display: "flex",
        flexDirection: "column",
        gap: "1rem",
      }}
    >
      <div style={{ textAlign: "center" }}>
        <div
          style={{
            fontSize: "1.4rem",
            fontWeight: 700,
            letterSpacing: "0.02em",
          }}
        >
          Activate Kiosk
        </div>
        <div style={{ fontSize: "0.85rem", opacity: 0.7, marginTop: 4 }}>
          Scan your activation card, enter your 6-digit code, or sign in
          with your email and password.
        </div>
      </div>

      <div
        role="tablist"
        style={{
          display: "flex",
          gap: 4,
          background: "rgba(0,0,0,0.25)",
          padding: 4,
          borderRadius: 8,
        }}
      >
        {(["camera", "scan", "pin", "password"] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            type="button"
            onClick={() => setTab(t)}
            style={{
              flex: 1,
              background:
                tab === t ? "rgba(255,255,255,0.12)" : "transparent",
              border: "none",
              color: "white",
              padding: "0.5rem 0.5rem",
              borderRadius: 6,
              fontSize: "0.85rem",
              fontWeight: tab === t ? 700 : 500,
              cursor: "pointer",
            }}
          >
            {t === "camera"
              ? "Use this camera"
              : t === "scan"
              ? "Phone scan"
              : t === "pin"
              ? "6-digit code"
              : "Password"}
          </button>
        ))}
      </div>

      {tab === "camera" && <CameraScan onBeginEnroll={onBeginEnroll} />}
      {tab === "scan" && <ScanInstructions />}
      {tab === "pin" && <PinEntry onBeginEnroll={onBeginEnroll} />}
      {tab === "password" && <ActivationScreen onActivated={onActivated} />}
    </div>
  );
}

// Front-facing camera scan for laptop/desktop kiosks. The activation
// card QR encodes a URL like `/kiosk?enroll=<token>`. We extract the
// token and feed it into the same activate-by-enrollment flow used
// when a teacher scans on their phone.
function CameraScan({
  onBeginEnroll,
}: {
  onBeginEnroll: (
    credential: string,
    method: "enroll" | "pin",
    room?: string,
  ) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function extractToken(raw: string): string | null {
    // Accept either a full URL with ?enroll=<token> or a bare token.
    try {
      const u = new URL(raw, window.location.origin);
      const t = u.searchParams.get("enroll");
      if (t && t.length >= 16) return t;
    } catch {
      // not a URL — fall through
    }
    const trimmed = raw.trim();
    if (/^[A-Za-z0-9_-]{16,}$/.test(trimmed)) return trimmed;
    return null;
  }

  async function handleScan(text: string) {
    setOpen(false);
    const token = extractToken(text);
    if (!token) {
      setError(
        "That QR code isn't an activation card. Point at the QR on the card itself.",
      );
      return;
    }
    setBusy(true);
    setError("");
    const result = await onBeginEnroll(token, "enroll");
    if (!result.ok) {
      setError(result.error ?? "Activation failed");
    }
    setBusy(false);
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.85rem",
        padding: "0.5rem 0.25rem",
        fontSize: "0.95rem",
        lineHeight: 1.5,
      }}
    >
      <div style={{ opacity: 0.9 }}>
        Hold your activation card up to this device's webcam. We'll
        read the QR code and activate the kiosk automatically.
      </div>
      <button
        type="button"
        onClick={() => {
          setError("");
          setOpen(true);
        }}
        disabled={busy}
        style={primaryBtn(busy)}
      >
        {busy ? "Activating…" : "Open camera"}
      </button>
      {error && <ErrorBox>{error}</ErrorBox>}
      <div
        style={{
          fontSize: "0.8rem",
          opacity: 0.65,
          borderTop: "1px solid rgba(255,255,255,0.08)",
          paddingTop: "0.6rem",
        }}
      >
        No camera permission? Use <b>6-digit code</b> or <b>Password</b>
        {" "}instead. The browser will remember the choice next time.
      </div>
      {open && (
        <CameraScanner
          facingMode="user"
          label="Hold the activation card's QR up to the camera"
          onScan={handleScan}
          onCancel={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function ScanInstructions() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.75rem",
        padding: "0.5rem 0.25rem",
        fontSize: "0.95rem",
        lineHeight: 1.5,
      }}
    >
      <ol style={{ margin: 0, paddingLeft: "1.25rem", opacity: 0.9 }}>
        <li>Open your camera app.</li>
        <li>
          Point it at the QR code on your activation card. A link will
          pop up at the top of the screen.
        </li>
        <li>Tap the link — this kiosk will activate for 14 days.</li>
      </ol>
      <div
        style={{
          fontSize: "0.85rem",
          opacity: 0.65,
          borderTop: "1px solid rgba(255,255,255,0.08)",
          paddingTop: "0.75rem",
        }}
      >
        No card?  Use the <b>6-digit code</b> tab if you remember your
        PIN, or sign in with your <b>password</b>. Cards are issued by
        an admin from <em>Hall Pass Kiosks → Cards</em>.
      </div>
    </div>
  );
}

function PinEntry({
  onBeginEnroll,
}: {
  onBeginEnroll: (
    credential: string,
    method: "enroll" | "pin",
    room?: string,
  ) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!/^\d{6}$/.test(pin)) {
      setError("PIN must be 6 digits");
      return;
    }
    setBusy(true);
    setError("");
    const result = await onBeginEnroll(pin, "pin");
    if (!result.ok) setError(result.error ?? "Activation failed");
    setBusy(false);
  }
  return (
    <form
      onSubmit={submit}
      style={{ display: "flex", flexDirection: "column", gap: "1rem" }}
    >
      <Field label="6-digit code from your activation card">
        <input
          type="text"
          inputMode="numeric"
          pattern="\d{6}"
          maxLength={6}
          autoFocus
          value={pin}
          onChange={(e) =>
            setPin(e.target.value.replace(/\D/g, "").slice(0, 6))
          }
          disabled={busy}
          style={{
            ...inputStyle,
            fontSize: "1.6rem",
            letterSpacing: "0.5em",
            textAlign: "center",
            fontFamily: "ui-monospace, SFMono-Regular, monospace",
          }}
        />
      </Field>
      {error && <ErrorBox>{error}</ErrorBox>}
      <button
        type="submit"
        disabled={busy || pin.length !== 6}
        style={primaryBtn(busy || pin.length !== 6)}
      >
        {busy ? "Checking…" : "Activate this kiosk"}
      </button>
    </form>
  );
}

function EnrollConfirmScreen({
  staffName,
  previewRoom,
  ttlDays,
  initialError,
  onCancel,
  onConfirm,
}: {
  staffName: string;
  previewRoom: string | null;
  ttlDays: number;
  initialError?: string | null;
  onCancel: () => void;
  onConfirm: (room: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [room, setRoom] = useState(previewRoom ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError ?? "");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!room.trim()) {
      setError("Pick a room name for this kiosk");
      return;
    }
    setBusy(true);
    setError("");
    const result = await onConfirm(room.trim());
    if (!result.ok) {
      setError(result.error ?? "Activation failed");
      setBusy(false);
    }
    // On success the parent moves us to phase:'ready' — no need to
    // unset busy.
  }
  return (
    <form
      onSubmit={submit}
      style={{
        background: "rgba(255,255,255,0.06)",
        border: "1px solid rgba(255,255,255,0.12)",
        borderRadius: 12,
        padding: "1.75rem",
        width: "min(480px, 92vw)",
        display: "flex",
        flexDirection: "column",
        gap: "1rem",
      }}
    >
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: "1.4rem", fontWeight: 700 }}>
          Activate kiosk for {staffName}?
        </div>
        <div
          style={{ fontSize: "0.85rem", opacity: 0.7, marginTop: 6 }}
        >
          This device will be signed in for {ttlDays} days. You can
          sign out from the gear menu any time.
        </div>
      </div>
      <Field label="Room this kiosk is in">
        <input
          type="text"
          autoFocus
          value={room}
          onChange={(e) => setRoom(e.target.value)}
          disabled={busy}
          placeholder={previewRoom ? `${previewRoom} (your room)` : "Room name…"}
          style={inputStyle}
        />
      </Field>
      {error && <ErrorBox>{error}</ErrorBox>}
      <button
        type="submit"
        disabled={busy || !room.trim()}
        style={primaryBtn(busy || !room.trim())}
      >
        {busy ? "Activating…" : `Yes, activate for ${room.trim() || "…"}`}
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        style={{
          background: "transparent",
          border: "none",
          color: "rgba(255,255,255,0.7)",
          fontSize: "0.9rem",
          textDecoration: "underline",
          cursor: "pointer",
          padding: "0.25rem",
        }}
      >
        Cancel
      </button>
    </form>
  );
}

/* ----------------------------- Activation screen ----------------------------- */

// The activation screen has three "modes" baked into one form:
//
//  - default mode: email + password → use the staff's default room (one tap)
//  - picker mode:  email + password + searchable room dropdown
//                  (entered when staff clicks "Activate to a different room"
//                   OR when the server tells us they have no default)
//  - confirm-takeover: room is already hosting an active kiosk; the user
//                      must explicitly choose to replace it
//
// All of these submit to the same POST /api/kiosk/activate; the client
// just toggles `dryRun` (to fetch the room list without committing) and
// `replaceExisting` (to take over).
function ActivationScreen({
  onActivated,
}: {
  onActivated: (token: string, room: string, staffName: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [room, setRoom] = useState("");
  const [defaultRoom, setDefaultRoom] = useState<string | null>(null);
  const [pickerLocations, setPickerLocations] = useState<string[] | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [takeover, setTakeover] = useState<{
    room: string;
    activatedByName: string | null;
    deviceLabel: string | null;
    activatedAt: string | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function call(extra: {
    room?: string;
    dryRun?: boolean;
    replaceExisting?: boolean;
  }) {
    const body: Record<string, unknown> = {
      email: email.trim(),
      password,
      deviceFingerprint: getOrCreateDeviceFingerprint(),
      deviceLabel: getDeviceLabel(),
      ...extra,
    };
    const res = await fetch("/api/kiosk/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }

  async function submitDefault(e?: React.FormEvent) {
    e?.preventDefault();
    if (!email.trim() || !password) return;
    setBusy(true);
    setError("");
    try {
      const { res, data } = await call({});
      if (res.status === 409 && data.needsRoom) {
        // No default → force the picker
        setPickerLocations(data.locations ?? []);
        setDefaultRoom(null);
        setPickerOpen(true);
        setError(
          "You don't have a default room set. Pick the room this kiosk is in.",
        );
        return;
      }
      if (res.status === 409 && data.roomTaken) {
        setTakeover({
          room: data.room,
          activatedByName: data.existing?.activatedByName ?? null,
          deviceLabel: data.existing?.deviceLabel ?? null,
          activatedAt: data.existing?.activatedAt ?? null,
        });
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

  // Click "Activate to a different room" — fetch room list with dryRun
  // (no activation row created) and switch to picker mode.
  async function openPicker() {
    if (!email.trim() || !password) {
      setError("Enter your email and password first.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const { res, data } = await call({ dryRun: true });
      if (!res.ok) {
        setError(data.error ?? `Couldn't load room list (${res.status})`);
        return;
      }
      setPickerLocations(data.locations ?? []);
      setDefaultRoom(data.defaultRoom ?? null);
      setRoom(data.defaultRoom ?? "");
      setPickerOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  async function submitWithRoom(e?: React.FormEvent) {
    e?.preventDefault();
    if (!email.trim() || !password || !room) return;
    setBusy(true);
    setError("");
    try {
      const { res, data } = await call({ room });
      if (res.status === 409 && data.roomTaken) {
        setTakeover({
          room: data.room,
          activatedByName: data.existing?.activatedByName ?? null,
          deviceLabel: data.existing?.deviceLabel ?? null,
          activatedAt: data.existing?.activatedAt ?? null,
        });
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

  async function confirmTakeover() {
    if (!takeover) return;
    setBusy(true);
    setError("");
    try {
      const { res, data } = await call({
        room: takeover.room,
        replaceExisting: true,
      });
      if (!res.ok) {
        setError(data.error ?? `Activation failed (${res.status})`);
        return;
      }
      setTakeover(null);
      onActivated(data.token, data.room, data.staffName);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  // Sort the picker so the user's own classroom is at the top, then the
  // rest alphabetically. Important for big high schools (100+ rooms).
  const sortedRooms = (() => {
    if (!pickerLocations) return [];
    const rest = pickerLocations
      .filter((r) => r !== defaultRoom)
      .sort((a, b) => a.localeCompare(b));
    return defaultRoom ? [defaultRoom, ...rest] : rest;
  })();

  return (
    <form
      onSubmit={pickerOpen ? submitWithRoom : submitDefault}
      style={{
        background: "rgba(255,255,255,0.06)",
        border: "1px solid rgba(255,255,255,0.12)",
        borderRadius: 12,
        padding: "1.75rem",
        width: "min(460px, 92vw)",
        display: "flex",
        flexDirection: "column",
        gap: "1rem",
      }}
    >
      <div style={{ textAlign: "center", marginBottom: "0.25rem" }}>
        <div
          style={{
            fontSize: "1.4rem",
            fontWeight: 700,
            letterSpacing: "0.02em",
          }}
        >
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

      {pickerOpen && pickerLocations && (
        <>
          <Field
            label={
              defaultRoom
                ? "Room this kiosk is in (start typing to search)"
                : "Pick the room this kiosk is in"
            }
          >
            <input
              type="text"
              list="kiosk-room-list"
              value={room}
              onChange={(e) => setRoom(e.target.value)}
              disabled={busy}
              placeholder={
                defaultRoom
                  ? `${defaultRoom} (your room)`
                  : "Type or pick a room…"
              }
              style={inputStyle}
            />
            <datalist id="kiosk-room-list">
              {sortedRooms.map((r) => (
                <option key={r} value={r}>
                  {r === defaultRoom ? `${r} (your room)` : r}
                </option>
              ))}
            </datalist>
          </Field>
          {defaultRoom && (
            <button
              type="button"
              onClick={() => {
                setPickerOpen(false);
                setRoom("");
                setError("");
              }}
              style={{
                background: "transparent",
                border: "none",
                color: "rgba(255,255,255,0.7)",
                fontSize: "0.85rem",
                textDecoration: "underline",
                cursor: "pointer",
                alignSelf: "flex-start",
                padding: 0,
              }}
              disabled={busy}
            >
              ← Back to "use my room ({defaultRoom})"
            </button>
          )}
        </>
      )}

      {error && <ErrorBox>{error}</ErrorBox>}

      {pickerOpen ? (
        <button
          type="submit"
          disabled={busy || !email.trim() || !password || !room}
          style={primaryBtn(busy || !email.trim() || !password || !room)}
        >
          {busy ? "Activating…" : `Activate kiosk for ${room || "…"}`}
        </button>
      ) : (
        <>
          <button
            type="submit"
            disabled={busy || !email.trim() || !password}
            style={primaryBtn(busy || !email.trim() || !password)}
          >
            {busy ? "Activating…" : "Activate this kiosk"}
          </button>
          <button
            type="button"
            onClick={openPicker}
            disabled={busy || !email.trim() || !password}
            style={{
              background: "transparent",
              border: "none",
              color: "rgba(255,255,255,0.75)",
              fontSize: "0.9rem",
              textDecoration: "underline",
              cursor: "pointer",
              padding: "0.25rem",
            }}
          >
            Activate to a different room (sub / floating staff)
          </button>
        </>
      )}

      {takeover && (
        <TakeoverConfirm
          info={takeover}
          busy={busy}
          onCancel={() => setTakeover(null)}
          onConfirm={confirmTakeover}
        />
      )}
    </form>
  );
}

function TakeoverConfirm({
  info,
  busy,
  onConfirm,
  onCancel,
}: {
  info: {
    room: string;
    activatedByName: string | null;
    deviceLabel: string | null;
    activatedAt: string | null;
  };
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const when = info.activatedAt
    ? new Date(info.activatedAt).toLocaleString()
    : null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.65)",
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1rem",
      }}
    >
      <div
        style={{
          background: "#0f172a",
          border: "1px solid rgba(255,255,255,0.15)",
          color: "#fff",
          borderRadius: 12,
          padding: "1.5rem",
          width: "min(440px, 92vw)",
          display: "flex",
          flexDirection: "column",
          gap: "0.75rem",
          textAlign: "left",
        }}
      >
        <div style={{ fontSize: "1.15rem", fontWeight: 700 }}>
          Room "{info.room}" already has an active kiosk
        </div>
        <div style={{ fontSize: "0.9rem", opacity: 0.85, lineHeight: 1.5 }}>
          {info.activatedByName ? (
            <>
              Last activated by <strong>{info.activatedByName}</strong>
              {info.deviceLabel ? ` on ${info.deviceLabel}` : ""}
              {when ? ` at ${when}` : ""}.
            </>
          ) : (
            <>Another device is already running a kiosk for this room.</>
          )}
          <br />
          <br />
          Taking over will deactivate that device and clear its waiting line.
          The other device will need to log in again to come back.
        </div>
        <div
          style={{
            display: "flex",
            gap: "0.5rem",
            marginTop: "0.5rem",
            flexWrap: "wrap",
          }}
        >
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            style={{
              ...primaryBtn(busy),
              background: busy ? "rgba(239,68,68,0.4)" : "#ef4444",
              flex: 1,
            }}
          >
            {busy ? "Taking over…" : "Take over this room"}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            style={{
              background: "transparent",
              color: "#fff",
              border: "1px solid rgba(255,255,255,0.3)",
              borderRadius: 8,
              padding: "0.65rem 1rem",
              cursor: busy ? "not-allowed" : "pointer",
              fontSize: "1rem",
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------- Kiosk body -------------------------------- */

function KioskBody({
  token,
  room,
  staffName,
  onRevoked,
  pendingSignin,
  onPendingSigninConsumed,
}: {
  token: string;
  room: string;
  staffName: string | null;
  onRevoked: () => void;
  pendingSignin: string | null;
  onPendingSigninConsumed: () => void;
}) {
  const [school, setSchool] = useState<SchoolSettings | null>(null);
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [allowed, setAllowed] = useState<AllowedRow[]>([]);
  // Token-authed destination list for this kiosk. Returned by
  // /api/kiosk/destinations/:token which unions room-pair allowlist with
  // the activating teacher's per-staff allowlist. Preferred over the old
  // locations × allowed intersection so per-teacher admin edits show up.
  const [tokenDestinations, setTokenDestinations] = useState<
    { id: number; name: string }[] | null
  >(null);
  const [now, setNow] = useState(new Date());
  const [studentId, setStudentId] = useState("");
  const [destination, setDestination] = useState("");
  const [mode, setMode] = useState<Mode>("out");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [activePass, setActivePass] = useState<ActivePass | null>(null);
  const [returning, setReturning] = useState(false);
  const [returnError, setReturnError] = useState<string | null>(null);
  const studentIdInputRef = useRef<HTMLInputElement | null>(null);
  // Phase 3: full-screen welcome overlay after a successful class
  // sign-in. Auto-dismisses; setting back to null returns the kiosk
  // to its idle form.
  const [welcome, setWelcome] = useState<SigninSuccess | null>(null);
  // Camera-scanner modal. Opened from the student-id field via the
  // 📷 button; on a successful decode we populate the student-id
  // input. Lazy-loaded so phones/tablets without the scanner never
  // pay the @zxing/browser cost.
  const [scannerOpen, setScannerOpen] = useState(false);

  // ---- Hall Pass Queue state ---------------------------------------------
  // Polled from /api/kiosk/queue/:token; auto-clears at period boundary on
  // the server side. The strip on the right edge of the kiosk shows this
  // list; "Get in line" opens an overlay to add yourself.
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [queueCap, setQueueCap] = useState(5);
  const [getInLineOpen, setGetInLineOpen] = useState(false);
  // When the previous student taps "I'm back" and the server reports a
  // next-up entry, we render a dedicated handoff overlay until they enter
  // their ID (or NEXT_UP_TIMEOUT_MS elapses).
  const [nextUp, setNextUp] = useState<{
    entry: QueueEntry;
    expiresAt: number;
  } | null>(null);

  const refetchQueue = useMemo(
    () => async () => {
      try {
        const res = await fetch(
          `/api/kiosk/queue/${encodeURIComponent(token)}`,
        );
        if (!res.ok) return;
        const data = (await res.json()) as {
          capacity?: number;
          entries?: QueueEntry[];
        };
        setQueue(data.entries ?? []);
        if (typeof data.capacity === "number") setQueueCap(data.capacity);
      } catch {
        // ignore — next poll will retry
      }
    },
    [token],
  );

  useEffect(() => {
    refetchQueue();
    const id = setInterval(refetchQueue, 10_000);
    return () => clearInterval(id);
  }, [refetchQueue]);

  // Auto-expire the next-up handoff prompt after NEXT_UP_TIMEOUT_MS so a
  // queued student who walked off doesn't park the kiosk indefinitely.
  useEffect(() => {
    if (!nextUp) return;
    const remaining = nextUp.expiresAt - Date.now();
    if (remaining <= 0) {
      // already expired; skip immediately
      void (async () => {
        await fetch(
          `/api/kiosk/queue/${encodeURIComponent(token)}/skip`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ studentId: nextUp.entry.studentId }),
          },
        ).catch(() => {});
        setNextUp(null);
        await refetchQueue();
      })();
      return;
    }
    const id = setTimeout(async () => {
      await fetch(
        `/api/kiosk/queue/${encodeURIComponent(token)}/skip`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ studentId: nextUp.entry.studentId }),
        },
      ).catch(() => {});
      setNextUp(null);
      await refetchQueue();
    }, remaining);
    return () => clearTimeout(id);
  }, [nextUp, token, refetchQueue]);

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
    // Token-authed source of truth for "what destinations can students
    // pick at THIS kiosk". Unions the school-wide room-pair matrix with
    // the activating teacher's per-staff allowlist server-side so admin
    // edits in either tile light up here.
    fetch(`/api/kiosk/destinations/${encodeURIComponent(token)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then(
        (d: { destinations: { id: number; name: string }[] }) =>
          setTokenDestinations(d.destinations ?? []),
      )
      .catch(() => setTokenDestinations(null));
  }, [token]);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const originLocation = useMemo(
    () => locations.find((l) => l.name === room) ?? null,
    [locations, room],
  );

  const destinationOptions = useMemo(() => {
    // Prefer the token-authed kiosk-destinations endpoint (unions the
    // school-wide room-pair matrix with the activating teacher's
    // allowlist). Fall back to the old client-side intersection only if
    // the new endpoint failed (network/old server) so the kiosk still
    // works during a partial rollout.
    if (tokenDestinations !== null) {
      const byId = new Map(locations.map((l) => [l.id, l]));
      return tokenDestinations
        .map((d) => byId.get(d.id) ?? { id: d.id, name: d.name } as LocationRow)
        .sort((a, b) => a.name.localeCompare(b.name));
    }
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
  }, [locations, allowed, originLocation, tokenDestinations]);

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

  // Welcome overlay auto-dismiss. Five seconds is long enough to read
  // the greeting + see the house color, short enough that the next
  // student isn't blocked.
  useEffect(() => {
    if (!welcome) return;
    const id = setTimeout(() => setWelcome(null), 5000);
    return () => clearTimeout(id);
  }, [welcome]);

  // Extract a student id from a scanned barcode. Two forms supported:
  //   1. raw id (hardware scanner or QR encoded as just "12345")
  //   2. signin URL (badge QR points at /kiosk?signin=12345)
  // Anything else is passed through verbatim — server-side validation
  // will reject if it's bogus.
  function extractStudentIdFromScan(text: string): string {
    const trimmed = text.trim();
    const match = trimmed.match(/[?&]signin=([^&\s]+)/);
    if (match) return decodeURIComponent(match[1]);
    return trimmed;
  }

  async function handleSignin(rawStudentId: string) {
    const id = rawStudentId.trim();
    if (!id) return;
    setStatus({ kind: "submitting" });
    try {
      const res = await fetch("/api/kiosk/class-signin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId: id, token }),
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
          message: b.error ?? `Sign-in failed (${res.status})`,
        });
        return;
      }
      const data = (await res.json()) as SigninSuccess;
      setWelcome(data);
      setStudentId("");
      setStatus({ kind: "idle" });
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Network error",
      });
    }
  }

  // Consume `?signin=<studentId>` once: drop into sign-in mode,
  // fire the request, then tell the parent so a re-render doesn't
  // re-trigger. Guarded by a ref so React 18 strict double-invoke
  // can't double-submit.
  const pendingSigninConsumed = useRef(false);
  useEffect(() => {
    if (!pendingSignin) return;
    if (pendingSigninConsumed.current) return;
    pendingSigninConsumed.current = true;
    setMode("signin");
    setStudentId(pendingSignin);
    void handleSignin(pendingSignin);
    onPendingSigninConsumed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSignin]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!studentId.trim()) return;
    if (mode === "signin") {
      await handleSignin(studentId);
      return;
    }
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
        queued?: boolean;
        position?: number | null;
        message?: string;
      };
      if (mode === "out") {
        // Keep-apart hold: server enqueued the student silently and told
        // us to show a generic "on hold" message — never the partner's
        // name. Surface as a non-error status so it doesn't look angry.
        if (data.queued === true) {
          const positionLabel =
            typeof data.position === "number" && data.position > 0
              ? ` You're #${data.position} in line.`
              : "";
          setStatus({
            kind: "error",
            message:
              (data.message ?? "You're on hold — please wait.") +
              positionLabel,
          });
          setStudentId("");
          setDestination("");
          return;
        }
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
      {welcome && (
        <WelcomeOverlay
          welcome={welcome}
          onDismiss={() => setWelcome(null)}
        />
      )}
      {scannerOpen && (
        <CameraScanner
          onScan={(text) => {
            const id = extractStudentIdFromScan(text);
            setScannerOpen(false);
            if (!id) return;
            setStudentId(id);
            // For sign-in mode, auto-submit on a successful scan —
            // the whole point is to walk up and tap the badge.
            // Pass / return modes still require a destination
            // selection so we just populate the field.
            if (mode === "signin") {
              void handleSignin(id);
            } else {
              studentIdInputRef.current?.focus();
            }
          }}
          onCancel={() => setScannerOpen(false)}
        />
      )}
      <div
        style={{
          fontSize: "0.875rem",
          letterSpacing: "0.15em",
          opacity: 0.6,
          textTransform: "uppercase",
          marginBottom: "0.5rem",
        }}
      >
        {school?.schoolName ?? "PulseED"} · Hall Pass Kiosk
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
              const body = (await res
                .json()
                .catch(() => ({}))) as {
                nextInQueue?: {
                  studentId: string;
                  firstName: string | null;
                  lastName: string | null;
                  destination: string;
                } | null;
              };
              setActivePass(null);
              // If someone is queued, surface the next-up handoff prompt.
              // Refresh the canonical queue list so the strip + prompt
              // agree, then arm the timeout.
              await refetchQueue();
              if (body.nextInQueue) {
                setNextUp({
                  entry: {
                    id: -1,
                    studentId: body.nextInQueue.studentId,
                    firstName: body.nextInQueue.firstName,
                    lastName: body.nextInQueue.lastName,
                    destination: body.nextInQueue.destination,
                    position: 1,
                    addedAt: new Date().toISOString(),
                  },
                  expiresAt: Date.now() + NEXT_UP_TIMEOUT_MS,
                });
              }
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
            <ModeButton
              active={mode === "signin"}
              onClick={() => {
                if (status.kind === "submitting") return;
                setMode("signin");
                setDestination("");
                setStatus({ kind: "idle" });
                studentIdInputRef.current?.focus();
              }}
            >
              Sign in to class
            </ModeButton>
          </div>

          <Field label={mode === "signin" ? "Scan or enter your ID" : "Student ID"}>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <input
                ref={studentIdInputRef}
                type="text"
                inputMode="numeric"
                autoComplete="off"
                autoFocus
                value={studentId}
                onChange={(e) => setStudentId(e.target.value)}
                placeholder="e.g. 12345"
                style={{ ...inputStyle, flex: 1 }}
                disabled={status.kind === "submitting"}
              />
              <button
                type="button"
                onClick={() => setScannerOpen(true)}
                disabled={status.kind === "submitting"}
                aria-label="Scan badge with camera"
                title="Scan badge with camera"
                style={{
                  background: "rgba(255,255,255,0.1)",
                  border: "1px solid rgba(255,255,255,0.2)",
                  borderRadius: 8,
                  color: "#fff",
                  width: 56,
                  fontSize: "1.5rem",
                  cursor: "pointer",
                  flexShrink: 0,
                }}
              >
                📷
              </button>
            </div>
          </Field>

          {mode === "out" && (
            <>
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
            </>
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
            aria-label={mode === "signin" ? "Sign in to class" : undefined}
          >
            {status.kind === "submitting"
              ? mode === "out"
                ? "Creating pass…"
                : mode === "back"
                  ? "Signing back in…"
                  : "Signing in…"
              : mode === "out"
                ? "Get Pass"
                : mode === "back"
                  ? "Sign Back In"
                  : "Sign in to class"}
          </button>
        </form>
      )}

      {/* Persistent queue strip — sibling to TimerScreen so the timer's
          render path is never coupled to queue updates. Sits on the right
          edge with a higher z-index than the timer overlay. */}
      <QueueStrip
        entries={queue}
        cap={queueCap}
        onAdd={() => setGetInLineOpen(true)}
        disabled={!!nextUp}
      />

      {getInLineOpen && (
        <GetInLineOverlay
          token={token}
          destinationOptions={destinationOptions}
          onClose={() => setGetInLineOpen(false)}
          onAdded={() => {
            setGetInLineOpen(false);
            void refetchQueue();
          }}
        />
      )}

      {nextUp && (
        <NextUpScreen
          entry={nextUp.entry}
          expiresAt={nextUp.expiresAt}
          token={token}
          onSkip={async () => {
            await fetch(
              `/api/kiosk/queue/${encodeURIComponent(token)}/skip`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  studentId: nextUp.entry.studentId,
                }),
              },
            ).catch(() => {});
            setNextUp(null);
            void refetchQueue();
          }}
          onRevoked={onRevoked}
          onPassStarted={(pass) => {
            setActivePass(pass);
            setNextUp(null);
            void refetchQueue();
          }}
        />
      )}
    </>
  );
}

/* ----------------------------- Queue UI ----------------------------- */

function QueueStrip({
  entries,
  cap,
  onAdd,
  disabled,
}: {
  entries: QueueEntry[];
  cap: number;
  onAdd: () => void;
  disabled: boolean;
}) {
  const isFull = entries.length >= cap;
  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 0,
        width: 96,
        background: "rgba(15,23,42,0.92)",
        color: "#fff",
        zIndex: 10,
        display: "flex",
        flexDirection: "column",
        padding: "0.75rem 0.5rem",
        boxShadow: "-4px 0 16px rgba(0,0,0,0.25)",
        borderLeft: "1px solid rgba(255,255,255,0.08)",
      }}
    >
      <div
        style={{
          fontSize: "0.7rem",
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          opacity: 0.7,
          marginBottom: "0.5rem",
          textAlign: "center",
        }}
      >
        Next up
      </div>
      <div
        style={{
          fontSize: "1.6rem",
          fontWeight: 800,
          lineHeight: 1,
          textAlign: "center",
          marginBottom: "0.75rem",
        }}
      >
        {entries.length}
        <span style={{ opacity: 0.5, fontSize: "0.85rem", fontWeight: 600 }}>
          /{cap}
        </span>
      </div>
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: "0.4rem",
        }}
      >
        {entries.length === 0 ? (
          <div
            style={{
              fontSize: "0.75rem",
              opacity: 0.55,
              textAlign: "center",
              padding: "0.5rem 0.25rem",
              lineHeight: 1.3,
            }}
          >
            No one waiting
          </div>
        ) : (
          entries.map((e) => (
            <div
              key={e.id}
              style={{
                background: "rgba(255,255,255,0.08)",
                borderRadius: 8,
                padding: "0.4rem 0.35rem",
                fontSize: "0.8rem",
                lineHeight: 1.15,
                textAlign: "center",
                fontWeight: 600,
              }}
            >
              <div>
                {e.firstName ?? e.studentId}
                {e.lastName ? ` ${e.lastName.charAt(0)}.` : ""}
              </div>
              <div
                style={{
                  fontSize: "0.65rem",
                  opacity: 0.6,
                  fontWeight: 400,
                  marginTop: 2,
                }}
              >
                {e.destination}
              </div>
            </div>
          ))
        )}
      </div>
      <button
        type="button"
        onClick={onAdd}
        disabled={isFull || disabled}
        style={{
          marginTop: "0.5rem",
          background: isFull || disabled ? "rgba(255,255,255,0.1)" : "#22c55e",
          color: isFull || disabled ? "rgba(255,255,255,0.5)" : "#0b1220",
          border: "none",
          borderRadius: 8,
          padding: "0.6rem 0.3rem",
          fontWeight: 700,
          fontSize: "0.75rem",
          lineHeight: 1.15,
          cursor: isFull || disabled ? "not-allowed" : "pointer",
        }}
      >
        {isFull ? "Line is full" : "Get in line"}
      </button>
    </div>
  );
}

function GetInLineOverlay({
  token,
  destinationOptions,
  onClose,
  onAdded,
}: {
  token: string;
  destinationOptions: LocationRow[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const [studentId, setStudentId] = useState("");
  const [destination, setDestination] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState<number | null>(null);
  // Mirror the main pass-creation form: students should be able to
  // scan their badge to populate the ID field here too.
  const [scannerOpen, setScannerOpen] = useState(false);

  // Auto-close after a brief confirmation so the next person can use the
  // overlay without a stale message lingering.
  useEffect(() => {
    if (position == null) return;
    const id = setTimeout(onAdded, 2500);
    return () => clearTimeout(id);
  }, [position, onAdded]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!studentId.trim() || !destination) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/kiosk/queue/${encodeURIComponent(token)}/add`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            studentId: studentId.trim(),
            destination,
          }),
        },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? `Request failed (${res.status})`);
        return;
      }
      setPosition(body.position ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      {scannerOpen && (
        <CameraScanner
          onScan={(text) => {
            // Same extraction the main pass form uses: badge QRs encode
            // /kiosk?signin=<id>; hardware scanners emit the raw id.
            const trimmed = text.trim();
            const m = trimmed.match(/[?&]signin=([^&\s]+)/);
            const id = m ? decodeURIComponent(m[1]) : trimmed;
            setScannerOpen(false);
            if (id) setStudentId(id);
          }}
          onCancel={() => setScannerOpen(false)}
        />
      )}
      <div
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.7)",
          zIndex: 20,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "2rem",
        }}
        onClick={onClose}
      >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#0f172a",
          color: "#fff",
          borderRadius: 16,
          padding: "1.5rem",
          width: "min(440px, 92vw)",
          border: "1px solid rgba(255,255,255,0.12)",
        }}
      >
        <div
          style={{
            fontSize: "0.75rem",
            letterSpacing: "0.15em",
            textTransform: "uppercase",
            opacity: 0.7,
            marginBottom: "0.25rem",
          }}
        >
          Get in line
        </div>
        <h2 style={{ margin: "0 0 1rem", fontSize: "1.5rem" }}>
          Add yourself to the queue
        </h2>
        {position != null ? (
          <div
            style={{
              padding: "1rem",
              background: "rgba(34,197,94,0.15)",
              border: "1px solid #22c55e",
              borderRadius: 8,
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: "1rem", marginBottom: "0.25rem" }}>
              You are
            </div>
            <div style={{ fontSize: "2.5rem", fontWeight: 800 }}>
              #{position}
            </div>
            <div style={{ opacity: 0.85, marginTop: "0.5rem" }}>
              We'll call your name on the screen.
            </div>
          </div>
        ) : (
          <form
            onSubmit={submit}
            style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}
          >
            <Field label="Scan or enter your ID">
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  autoFocus
                  value={studentId}
                  onChange={(e) => setStudentId(e.target.value)}
                  placeholder="e.g. 12345"
                  style={{ ...inputStyle, flex: 1 }}
                  disabled={submitting}
                />
                <button
                  type="button"
                  onClick={() => setScannerOpen(true)}
                  disabled={submitting}
                  aria-label="Scan badge with camera"
                  title="Scan badge with camera"
                  style={{
                    background: "rgba(255,255,255,0.1)",
                    border: "1px solid rgba(255,255,255,0.2)",
                    borderRadius: 8,
                    color: "#fff",
                    width: 56,
                    fontSize: "1.5rem",
                    cursor: "pointer",
                    flexShrink: 0,
                  }}
                >
                  📷
                </button>
              </div>
            </Field>
            <Field label="Where are you going?">
              <select
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                style={inputStyle}
                disabled={submitting}
              >
                <option value="">Select a destination…</option>
                {destinationOptions.map((d) => (
                  <option key={d.id} value={d.name}>
                    {d.name}
                  </option>
                ))}
              </select>
            </Field>
            {error && <ErrorBox>{error}</ErrorBox>}
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                style={{
                  flex: 1,
                  background: "transparent",
                  color: "#fff",
                  border: "1px solid rgba(255,255,255,0.25)",
                  borderRadius: 8,
                  padding: "0.85rem",
                  fontWeight: 600,
                  cursor: submitting ? "not-allowed" : "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={
                  submitting || !studentId.trim() || !destination
                }
                style={primaryBtn(
                  submitting || !studentId.trim() || !destination,
                  { padding: "0.85rem", flex: 1 },
                )}
              >
                {submitting ? "Adding…" : "Get in line"}
              </button>
            </div>
          </form>
        )}
      </div>
      </div>
    </>
  );
}

function NextUpScreen({
  entry,
  expiresAt,
  token,
  onSkip,
  onRevoked,
  onPassStarted,
}: {
  entry: QueueEntry;
  expiresAt: number;
  token: string;
  onSkip: () => void;
  onRevoked: () => void;
  onPassStarted: (pass: ActivePass) => void;
}) {
  const [studentId, setStudentId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const secondsLeft = Math.max(0, Math.ceil((expiresAt - tick) / 1000));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = studentId.trim();
    if (!trimmed) return;
    if (trimmed.toUpperCase() !== entry.studentId.toUpperCase()) {
      setError(
        `That ID doesn't match ${entry.firstName ?? "the student"}. Try again or tap Skip.`,
      );
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/kiosk/hall-passes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId: trimmed,
          token,
          destination: entry.destination,
        }),
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
        setError(b.error ?? `Request failed (${res.status})`);
        return;
      }
      const data = (await res.json()) as {
        id?: number;
        destination?: string;
        createdAt?: string;
        maxDurationMinutes?: number;
        studentFirstName?: string | null;
      };
      if (
        typeof data.id === "number" &&
        typeof data.createdAt === "string" &&
        typeof data.maxDurationMinutes === "number"
      ) {
        onPassStarted({
          id: data.id,
          studentId: trimmed,
          studentFirstName: data.studentFirstName ?? entry.firstName ?? null,
          destination: data.destination ?? entry.destination,
          createdAt: data.createdAt,
          maxDurationMinutes: data.maxDurationMinutes,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "#1d4ed8",
        color: "#fff",
        zIndex: 15,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "2rem",
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
        Your turn
      </div>
      <div
        style={{
          fontSize: "clamp(2.5rem, 7vw, 5rem)",
          fontWeight: 800,
          lineHeight: 1.1,
          marginBottom: "0.25rem",
        }}
      >
        Welcome, {entry.firstName ?? entry.studentId}!
      </div>
      <div
        style={{
          fontSize: "clamp(1.1rem, 2.5vw, 1.6rem)",
          opacity: 0.85,
          marginBottom: "2rem",
        }}
      >
        Heading to {entry.destination}
      </div>
      <form
        onSubmit={submit}
        style={{
          background: "rgba(0,0,0,0.18)",
          border: "1px solid rgba(255,255,255,0.25)",
          borderRadius: 12,
          padding: "1.25rem",
          width: "min(420px, 92vw)",
          display: "flex",
          flexDirection: "column",
          gap: "0.85rem",
        }}
      >
        <div
          style={{
            fontSize: "1rem",
            fontWeight: 600,
            opacity: 0.9,
            textAlign: "left",
          }}
        >
          Enter your Student ID to start your pass
        </div>
        <input
          type="text"
          inputMode="numeric"
          autoComplete="off"
          autoFocus
          value={studentId}
          onChange={(e) => setStudentId(e.target.value)}
          placeholder="e.g. 12345"
          style={{ ...inputStyle, fontSize: "1.4rem", textAlign: "center" }}
          disabled={submitting}
        />
        {error && <ErrorBox>{error}</ErrorBox>}
        <button
          type="submit"
          disabled={submitting || !studentId.trim()}
          style={primaryBtn(submitting || !studentId.trim(), {
            padding: "1rem",
            fontSize: "1.15rem",
          })}
        >
          {submitting ? "Starting pass…" : "Start my pass"}
        </button>
        <button
          type="button"
          onClick={onSkip}
          disabled={submitting}
          style={{
            background: "transparent",
            color: "#fff",
            border: "1px solid rgba(255,255,255,0.4)",
            borderRadius: 8,
            padding: "0.65rem",
            fontWeight: 600,
            cursor: submitting ? "not-allowed" : "pointer",
          }}
        >
          Skip / not here ({secondsLeft}s)
        </button>
      </form>
    </div>
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
  // "Also sign out every other kiosk I'm signed in on" — for the
  // lost-device case. We bundle this into the same email+password flow
  // so the teacher only has to authenticate once.
  const [revokeAll, setRevokeAll] = useState(false);

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
      const loginBody = (await loginRes.json().catch(() => null)) as {
        csrfToken?: string;
      } | null;
      const { setCsrfToken } = await import("./lib/csrf");
      if (loginBody?.csrfToken) setCsrfToken(loginBody.csrfToken);
      const { authFetch } = await import("./lib/authToken");
      const deactRes = await authFetch("/api/kiosk/deactivate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (revokeAll) {
        // Best-effort: if it fails the teacher is at least signed out
        // of THIS kiosk. They can hit revoke-all again from their
        // staff app whenever.
        await fetch("/api/kiosk/my-active/revoke-all", {
          method: "POST",
        }).catch(() => {});
      }
      // Always log the staff out so we don't leave a teacher session sitting on
      // a shared classroom device.
      await authFetch("/api/auth/logout", { method: "POST" }).catch(() => {});
      const { clearAuthToken } = await import("./lib/authToken");
      clearAuthToken();
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

        <label
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: "0.5rem",
            fontSize: "0.85rem",
            opacity: 0.85,
            cursor: "pointer",
            lineHeight: 1.4,
          }}
        >
          <input
            type="checkbox"
            checked={revokeAll}
            onChange={(e) => setRevokeAll(e.target.checked)}
            disabled={busy}
            style={{ marginTop: 2 }}
          />
          <span>
            Also sign me out of every other kiosk I&apos;m signed in on
            (use if your card or device was lost).
          </span>
        </label>

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

function StepOutButton() {
  return (
    <a
      href={`${import.meta.env.BASE_URL}`}
      target="_blank"
      rel="noreferrer"
      title="Open staff app in new tab — kiosk keeps running here"
      style={{
        position: "fixed",
        top: 12,
        right: 64,
        background: "rgba(255,255,255,0.06)",
        border: "1px solid rgba(255,255,255,0.15)",
        color: "rgba(255,255,255,0.7)",
        borderRadius: 999,
        padding: "0 0.85rem",
        height: 40,
        display: "flex",
        alignItems: "center",
        gap: 6,
        cursor: "pointer",
        zIndex: 10,
        fontSize: "0.85rem",
        textDecoration: "none",
      }}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M14 3h7v7" />
        <path d="M10 14L21 3" />
        <path d="M21 14v7H3V3h7" />
      </svg>
      Step out
    </a>
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
        background: "var(--brand-header-bg)",
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

// Full-screen welcome shown after a successful class sign-in.
// Auto-dismisses after 5s (managed by KioskBody). Background accent
// is the student's house color when available — a subtle radial wash
// so it doesn't overpower the greeting.
function WelcomeOverlay({
  welcome,
  onDismiss,
}: {
  welcome: SigninSuccess;
  onDismiss: () => void;
}) {
  const initials =
    (welcome.firstName?.[0] ?? "?") + (welcome.lastName?.[0] ?? "");
  const houseColor = welcome.house?.color ?? "#3b82f6";
  return (
    <div
      role="status"
      aria-live="polite"
      onClick={onDismiss}
      style={{
        position: "fixed",
        inset: 0,
        background: `radial-gradient(circle at top, ${houseColor}55 0%, #0b0f1a 60%)`,
        zIndex: 90,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        padding: "2rem",
      }}
    >
      <div
        aria-hidden="true"
        style={{
          width: 160,
          height: 160,
          borderRadius: "50%",
          background: houseColor,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#fff",
          fontSize: "3.5rem",
          fontWeight: 700,
          boxShadow: "0 12px 40px rgba(0,0,0,0.4)",
          marginBottom: "1.5rem",
          textTransform: "uppercase",
        }}
      >
        {initials}
      </div>
      <div
        style={{
          fontSize: "clamp(2rem, 6vw, 4rem)",
          fontWeight: 700,
          color: "#fff",
          textAlign: "center",
          maxWidth: "min(900px, 92vw)",
          lineHeight: 1.15,
        }}
      >
        {welcome.welcomeMessage}
      </div>
      {welcome.house && (
        <div
          style={{
            marginTop: "1.25rem",
            color: "#fff",
            opacity: 0.85,
            fontSize: "1.1rem",
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 16,
              height: 16,
              borderRadius: 4,
              background: houseColor,
              display: "inline-block",
              border: "1px solid rgba(255,255,255,0.5)",
            }}
          />
          {welcome.house.name}
          {welcome.grade !== null && welcome.grade !== ""
            ? ` · Grade ${welcome.grade}`
            : ""}
        </div>
      )}
      <div
        style={{
          marginTop: "2rem",
          color: "rgba(255,255,255,0.55)",
          fontSize: "0.9rem",
        }}
      >
        Tap anywhere to dismiss
      </div>
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
