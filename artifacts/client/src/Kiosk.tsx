import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  // Location kind discriminator (e.g. "restroom"). Used to keep restrooms out
  // of the "Go now" line-bypass picker.
  kind?: string | null;
}

// A destination as shown in the kiosk picker. Extends a location row with the
// teacher of record for that room (e.g. "Mr. Hayes"), resolved server-side
// from the /kiosk/destinations endpoint. Null when the room has no single
// unambiguous teacher (the picker then shows just the room name).
type DestinationOption = Pick<LocationRow, "id" | "name"> &
  Partial<LocationRow> & { teacherName: string | null };

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
      // Valid origin rooms for this school, so the confirm screen can
      // render the same searchable RoomPicker as the password path.
      locations: string[];
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
  // Consent-gated photo key, when the kiosk payload carries one. Usually null
  // for the pass-create response (a pass row has no photo field) — the avatar
  // then falls back to initials.
  photoObjectKey?: string | null;
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
      photoObjectKey?: string | null;
    }
  | { kind: "error"; message: string };

interface QueueEntry {
  id: number;
  studentId: string;
  // Human-facing Local SIS id — the value students scan/type. The internal
  // studentId stays for queue ops (skip) but is never shown or matched against.
  localSisId: string | null;
  firstName: string | null;
  lastName: string | null;
  destination: string;
  position: number;
  addedAt: string;
  // Consent-gated photo object key for the kiosk avatar. Null when the student
  // withholds consent / has no photo. Streamed via /api/kiosk/photo/:token.
  photoObjectKey?: string | null;
}

// A one-way hall pass surfaced on the kiosk queue poll. `inRouteFromHere` are
// students who LEFT this kiosk's room and haven't checked in yet; `arrivalsToHere`
// are students HEADED to this room (tap to check them in). Restroom (round-trip)
// passes are excluded server-side.
interface OneWayPass {
  id: number;
  studentId: string;
  localSisId: string | null;
  firstName: string | null;
  lastName: string | null;
  destination: string;
  originRoom: string;
  createdAt: string;
  photoObjectKey: string | null;
}

// How long the "Welcome [Name] — enter your ID" handoff prompt sits on the
// kiosk after the previous student taps "I'm back". If the queued student
// doesn't enter their ID in this window we forfeit their slot and return
// the kiosk to idle (the next student in line, if any, is NOT auto-shown
// — they have to either be re-queued or walk up cold).
const NEXT_UP_TIMEOUT_MS = 60_000;

// Extract a student id from a scanned barcode. Two forms supported:
//   1. raw id (hardware scanner or QR encoded as just "12345")
//   2. signin URL (badge QR points at /kiosk?signin=12345)
// Anything else is passed through verbatim — server-side validation
// will reject if it's bogus. Module-scoped so both the main kiosk form
// and the next-up handoff screen share identical decode logic.
function extractStudentIdFromScan(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/[?&]signin=([^&\s]+)/);
  if (match) return decodeURIComponent(match[1]);
  return trimmed;
}

// Grace window before the queue poll is allowed to clear this device's
// TimerScreen on the basis of "the pass id is no longer active server-side".
// Set comfortably above the 10s poll interval so a legitimately-active pass
// always gets at least one confirming poll before the grace can fire — the
// grace only matters when a pass is created AND ended remotely before any poll
// ever observed it active (otherwise the confirmation ref clears it promptly).
const ACTIVE_PASS_CLEAR_GRACE_MS = 12_000;

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
            locations: Array.isArray(data.locations) ? data.locations : [],
            ttlDays: data.ttlDays ?? 14,
            // For a room-taken failure, don't pre-fill the scary "already
            // has an active kiosk" banner — the confirm screen will pop a
            // clean "take over this room?" modal when the user clicks
            // activate. Surface other errors (e.g. bad room) as before.
            autoConfirmError:
              confirmRes.status === 409 && confirmData.roomTaken
                ? null
                : (confirmData.error ??
                  `Auto-activation failed (${confirmRes.status}). Pick a room and try again.`),
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
          locations: Array.isArray(data.locations) ? data.locations : [],
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
          locations={phase.locations}
          ttlDays={phase.ttlDays}
          initialError={phase.autoConfirmError ?? null}
          onCancel={() => setPhase({ kind: "activate" })}
          onConfirm={async (room, replaceExisting) => {
            const body: Record<string, unknown> = {
              deviceFingerprint: getOrCreateDeviceFingerprint(),
              deviceLabel: getDeviceLabel(),
              confirm: true,
              room,
            };
            if (replaceExisting) body.replaceExisting = true;
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
            // Room already hosts another active kiosk. Surface the
            // take-over prompt (replaceExisting) instead of looping on
            // the same "already has an active kiosk" error forever.
            if (res.status === 409 && data.roomTaken) {
              return {
                ok: false,
                roomTaken: true,
                room: data.room ?? room,
                existing: data.existing ?? null,
                error: data.error ?? "Room already has an active kiosk",
              };
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
  locations,
  ttlDays,
  initialError,
  onCancel,
  onConfirm,
}: {
  staffName: string;
  previewRoom: string | null;
  locations: string[];
  ttlDays: number;
  initialError?: string | null;
  onCancel: () => void;
  onConfirm: (
    room: string,
    replaceExisting?: boolean,
  ) => Promise<{
    ok: boolean;
    error?: string;
    roomTaken?: boolean;
    room?: string;
    existing?: {
      activatedByName: string | null;
      deviceLabel: string | null;
      activatedAt: string | null;
    } | null;
  }>;
}) {
  // Only pre-commit the server's preview room when it's actually one of the
  // activatable options. Otherwise start empty so the "Yes, activate for X"
  // button can never offer a room the server will reject (defense in depth —
  // the API already nulls an invalid preview, but a stale response or another
  // caller must not be able to resurrect the "not a valid kiosk room" loop).
  const [room, setRoom] = useState(
    previewRoom && locations.includes(previewRoom) ? previewRoom : "",
  );
  const sortedRooms = useMemo(
    () => [...locations].sort((a, b) => a.localeCompare(b)),
    [locations],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError ?? "");
  const [takeover, setTakeover] = useState<{
    room: string;
    activatedByName: string | null;
    deviceLabel: string | null;
    activatedAt: string | null;
  } | null>(null);
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
      if (result.roomTaken) {
        // Don't show the raw error + reactivate button (the loop the
        // user hit) — switch to an explicit "take over this room?" modal.
        setTakeover({
          room: result.room ?? room.trim(),
          activatedByName: result.existing?.activatedByName ?? null,
          deviceLabel: result.existing?.deviceLabel ?? null,
          activatedAt: result.existing?.activatedAt ?? null,
        });
        setBusy(false);
        return;
      }
      setError(result.error ?? "Activation failed");
      setBusy(false);
    }
    // On success the parent moves us to phase:'ready' — no need to
    // unset busy.
  }
  async function confirmTakeover() {
    if (!takeover) return;
    setBusy(true);
    setError("");
    const result = await onConfirm(takeover.room, true);
    if (!result.ok) {
      setError(result.error ?? "Activation failed");
      setTakeover(null);
      setBusy(false);
    }
    // On success the parent moves us to phase:'ready'.
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
        <RoomPicker
          value={room}
          options={sortedRooms}
          defaultRoom={previewRoom}
          onSelect={(r) => {
            setRoom(r);
            setError("");
          }}
          disabled={busy}
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
      {takeover && (
        <TakeoverConfirm
          info={takeover}
          busy={busy}
          onCancel={() => {
            setTakeover(null);
            setBusy(false);
          }}
          onConfirm={confirmTakeover}
        />
      )}
    </form>
  );
}

/* ----------------------------- Activation screen ----------------------------- */

// Searchable, click-to-select room picker for the kiosk activation screen.
// Replaces the old free-text <input list=datalist>, which let staff type a
// room name that didn't exactly match a real room (silent activation failure)
// and rendered an awkward native dropdown. A room is only ever set by picking
// it from the list — there is no free-text fallback — so typos can't slip
// through. Works with mouse, trackpad, and keyboard (arrow keys + Enter) for
// laptop kiosks.
function RoomPicker({
  value,
  options,
  defaultRoom,
  onSelect,
  disabled,
}: {
  value: string;
  options: string[];
  defaultRoom: string | null;
  onSelect: (room: string) => void;
  disabled?: boolean;
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

  const q = query.trim().toLowerCase();
  const filtered = q
    ? options.filter((o) => o.toLowerCase().includes(q))
    : options;

  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  function labelFor(r: string) {
    return r === defaultRoom ? `${r} (your room)` : r;
  }

  function choose(r: string) {
    onSelect(r);
    setOpen(false);
    setQuery("");
    inputRef.current?.blur();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open && (e.key === "ArrowDown" || e.key === "Enter")) {
      e.preventDefault();
      setOpen(true);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, Math.max(filtered.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = filtered[activeIdx];
      if (pick) choose(pick);
    } else if (e.key === "Escape") {
      setOpen(false);
      setQuery("");
    }
  }

  const displayValue = open ? query : value ? labelFor(value) : "";

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={open}
        autoComplete="off"
        disabled={disabled}
        value={displayValue}
        placeholder={
          defaultRoom ? `${defaultRoom} (your room)` : "Tap to pick a room…"
        }
        onFocus={() => {
          setOpen(true);
          setQuery("");
          setActiveIdx(0);
        }}
        onChange={(e) => {
          // Editing the query un-commits any current selection so the user
          // can never type a different room, skip clicking it, and still
          // activate the previously-picked (e.g. default) room by mistake.
          // The submit button stays disabled until a real option is chosen.
          if (value) onSelect("");
          setQuery(e.target.value);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
        style={inputStyle}
      />
      {open && (
        <ul
          role="listbox"
          style={{
            position: "absolute",
            zIndex: 60,
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            maxHeight: 260,
            overflowY: "auto",
            margin: 0,
            padding: "0.25rem 0",
            listStyle: "none",
            background: "#0f172a",
            border: "1px solid rgba(255,255,255,0.2)",
            borderRadius: 8,
            boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
          }}
        >
          {filtered.length === 0 ? (
            <li
              style={{
                padding: "0.65rem 0.9rem",
                color: "rgba(255,255,255,0.6)",
                fontSize: "0.95rem",
              }}
            >
              No matching rooms
            </li>
          ) : (
            filtered.map((r, idx) => {
              const active = idx === activeIdx;
              const isDefault = r === defaultRoom;
              return (
                <li
                  key={r}
                  role="option"
                  aria-selected={r === value}
                  onMouseEnter={() => setActiveIdx(idx)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(r);
                  }}
                  style={{
                    padding: "0.65rem 0.9rem",
                    cursor: "pointer",
                    fontSize: "1.05rem",
                    color: "#fff",
                    background: active
                      ? "rgba(59,130,246,0.35)"
                      : "transparent",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <span>{r}</span>
                  {isDefault && (
                    <span style={{ opacity: 0.6, fontSize: "0.8rem" }}>
                      your room
                    </span>
                  )}
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}

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
            <RoomPicker
              value={room}
              options={sortedRooms}
              defaultRoom={defaultRoom}
              onSelect={(r) => {
                setRoom(r);
                setError("");
              }}
              disabled={busy}
            />
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
    {
      id: number;
      name: string;
      kind?: string | null;
      teacherName?: string | null;
    }[] | null
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
  // One-way lifecycle surfaces (P4). `inRoute` = students who left THIS room
  // and haven't checked in; `arrivals` = students headed HERE (tap to receive).
  const [inRoute, setInRoute] = useState<OneWayPass[]>([]);
  const [arrivals, setArrivals] = useState<OneWayPass[]>([]);
  // Transient banner for arrival check-ins (kiosk has no toast system).
  const [arriveMessage, setArriveMessage] = useState<string | null>(null);
  // Self-check-in confirm: when a student taps their chip on the "Heading
  // here" rail, we don't check them in on the tap — they must confirm
  // identity by scanning/typing their badge first (mirrors "I'm back").
  // `arriveConfirm` holds the pass awaiting that scan; `arriveScannerOpen`
  // drives a dedicated camera modal so it never clobbers the main form scan.
  const [arriveConfirm, setArriveConfirm] = useState<OneWayPass | null>(null);
  const [arriveScannerOpen, setArriveScannerOpen] = useState(false);
  const [arriveError, setArriveError] = useState<string | null>(null);
  const [arriveBusy, setArriveBusy] = useState(false);
  const [getInLineOpen, setGetInLineOpen] = useState(false);
  // "Go now" line bypass — opens an overlay that creates an immediate pass for
  // a student summoned to the office/guidance/clinic (any non-restroom dest).
  const [goNowOpen, setGoNowOpen] = useState(false);
  // When the previous student taps "I'm back" and the server reports a
  // next-up entry, we render a dedicated handoff overlay until they enter
  // their ID (or NEXT_UP_TIMEOUT_MS elapses).
  const [nextUp, setNextUp] = useState<{
    entry: QueueEntry;
    expiresAt: number;
  } | null>(null);

  // The queue poll runs inside a stable (token-keyed) closure, so it can't
  // read live `activePass` / `nextUp` / `getInLineOpen` state directly without
  // capturing stale values. Mirror them into refs the poll can consult.
  const activePassRef = useRef<ActivePass | null>(activePass);
  const nextUpRef = useRef(nextUp);
  const getInLineOpenRef = useRef(getInLineOpen);
  // Flips true once a poll has SEEN the device's current pass listed as still
  // active. Only then will a later poll that finds it absent clear the timer —
  // this prevents a poll that races a fresh sign-out (its row not yet visible)
  // from wiping a pass we just created.
  const activePassConfirmedRef = useRef(false);
  // When the current pass was set locally — used to grace-window the
  // poll-driven clear so it can never deadlock waiting for a confirmation
  // that will never come (pass created AND ended before any poll saw it).
  const activePassSetAtRef = useRef(0);
  useEffect(() => {
    activePassRef.current = activePass;
  }, [activePass]);
  useEffect(() => {
    nextUpRef.current = nextUp;
  }, [nextUp]);
  useEffect(() => {
    getInLineOpenRef.current = getInLineOpen;
  }, [getInLineOpen]);
  useEffect(() => {
    activePassConfirmedRef.current = false;
    activePassSetAtRef.current = activePass ? Date.now() : 0;
  }, [activePass?.id]);

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
          nextUp?: {
            studentId: string;
            localSisId: string | null;
            firstName: string | null;
            lastName: string | null;
            destination: string;
            photoObjectKey?: string | null;
          } | null;
          activePassIds?: number[];
          inRouteFromHere?: OneWayPass[];
          arrivalsToHere?: OneWayPass[];
        };
        setQueue(data.entries ?? []);
        if (typeof data.capacity === "number") setQueueCap(data.capacity);
        // One-way lifecycle cards/strip. Setting from the poll means they
        // clear automatically the moment the server stops returning them
        // (i.e. the student arrived / the pass ended).
        setInRoute(
          Array.isArray(data.inRouteFromHere) ? data.inRouteFromHere : [],
        );
        setArrivals(
          Array.isArray(data.arrivalsToHere) ? data.arrivalsToHere : [],
        );

        // Remote-end detection. The TimerScreen on THIS device is driven by
        // local state and normally only clears when the student taps "I'm
        // back". If a teacher ends the pass from the staff app (or the system
        // ends it), drop the now-stale countdown so the freed slot can
        // advance. Guarded by activePassConfirmedRef against a sign-out race.
        const ap = activePassRef.current;
        let deviceBusy = !!ap;
        if (ap && Array.isArray(data.activePassIds)) {
          if (data.activePassIds.includes(ap.id)) {
            activePassConfirmedRef.current = true;
            deviceBusy = true;
          } else {
            // The pass id is absent from the room's active set. Clear the
            // stale timer if we previously saw it active (fast path) OR the
            // grace window since it was set has elapsed (deadlock guard for a
            // pass ended remotely before any poll ever observed it active).
            const graceExpired =
              Date.now() - activePassSetAtRef.current >
              ACTIVE_PASS_CLEAR_GRACE_MS;
            if (activePassConfirmedRef.current || graceExpired) {
              setActivePass(null);
              deviceBusy = false;
            } else {
              deviceBusy = true; // within grace, unconfirmed — assume still out
            }
          }
        }

        // Auto-promote. When the kiosk is idle (no out-timer on this device,
        // no handoff prompt already up, get-in-line sheet closed) and the
        // server reports an eligible front-of-line student, raise the
        // "Welcome [Name] — enter your ID" prompt automatically. This makes a
        // slot opening from ANY source advance the line with no re-scan. The
        // existing NEXT_UP_TIMEOUT_MS auto-skip still forfeits the slot if the
        // student isn't there, and the next poll promotes whoever is next.
        if (
          data.nextUp &&
          !deviceBusy &&
          !nextUpRef.current &&
          !getInLineOpenRef.current
        ) {
          setNextUp({
            entry: {
              id: -1,
              studentId: data.nextUp.studentId,
              localSisId: data.nextUp.localSisId,
              firstName: data.nextUp.firstName,
              lastName: data.nextUp.lastName,
              destination: data.nextUp.destination,
              position: 1,
              addedAt: new Date().toISOString(),
              photoObjectKey: data.nextUp.photoObjectKey ?? null,
            },
            expiresAt: Date.now() + NEXT_UP_TIMEOUT_MS,
          });
        }
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
    // These two are staff-session endpoints and 401 on a kiosk device (no
    // staff login). They're only a legacy fallback for destinationOptions —
    // the token-authed /api/kiosk/destinations below is the real source. We
    // MUST check r.ok and guard Array.isArray: without it, a 401 JSON error
    // body parses fine and gets stored as `locations`, then `locations.find`
    // throws and white-screens the kiosk. (Reproduced after a room take-over.)
    fetch("/api/locations")
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then((d: LocationRow[]) => setLocations(Array.isArray(d) ? d : []))
      .catch(() => setLocations([]));
    fetch("/api/location-allowed-destinations")
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then((d: AllowedRow[]) => setAllowed(Array.isArray(d) ? d : []))
      .catch(() => setAllowed([]));
    // Token-authed source of truth for "what destinations can students
    // pick at THIS kiosk". Unions the school-wide room-pair matrix with
    // the activating teacher's per-staff allowlist server-side so admin
    // edits in either tile light up here.
    fetch(`/api/kiosk/destinations/${encodeURIComponent(token)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then(
        (d: {
          destinations: {
            id: number;
            name: string;
            kind?: string | null;
            teacherName?: string | null;
          }[];
        }) => setTokenDestinations(d.destinations ?? []),
      )
      .catch(() => setTokenDestinations(null));
  }, [token]);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // Auto-dismiss the arrival check-in banner so it doesn't linger.
  useEffect(() => {
    if (!arriveMessage) return;
    const id = setTimeout(() => setArriveMessage(null), 4000);
    return () => clearTimeout(id);
  }, [arriveMessage]);

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
        .map((d): DestinationOption => {
          const base = byId.get(d.id) ?? ({ id: d.id, name: d.name } as LocationRow);
          return {
            ...base,
            // The token endpoint is the authoritative source for `kind` on a
            // kiosk device (the staff-only /api/locations 401s here, so the
            // `byId` fallback is usually empty).
            kind: d.kind ?? base.kind,
            teacherName: d.teacherName ?? null,
          };
        })
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
      .map((l): DestinationOption => ({ ...l, teacherName: null }))
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
        photoObjectKey?: string | null;
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
            photoObjectKey: data.photoObjectKey ?? null,
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
            photoObjectKey: data.photoObjectKey ?? null,
          });
        }
      } else {
        setStatus({
          kind: "success",
          mode,
          studentId: studentId.trim(),
          studentFirstName: data.studentFirstName ?? null,
          destination: data.destination ?? "(unknown)",
          photoObjectKey: data.photoObjectKey ?? null,
        });
      }
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Network error",
      });
    }
  }

  // Destination check-in. A staff member at the destination kiosk taps an
  // inbound student to RECEIVE them — this ends the pass + stamps arrival.
  // Idempotent: a friendly banner on alreadyReceived, then refetch so the
  // strip clears.
  // Self-check-in: `scannedId` is the Local SIS id the student just scanned /
  // typed to confirm identity. The server enforces it belongs to `pass`, so a
  // mis-tap on the wrong chip can never check in another student.
  async function handleArrive(pass: OneWayPass, scannedId: string) {
    const name = pass.firstName ?? pass.localSisId ?? "Student";
    setArriveBusy(true);
    setArriveError(null);
    try {
      const res = await fetch("/api/kiosk/hall-passes/arrive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, passId: pass.id, studentId: scannedId }),
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
        // Keep the confirm panel open so a wrong-badge scan can be retried.
        setArriveError(b.error ?? `Check-in failed (${res.status})`);
        return;
      }
      const b = (await res.json().catch(() => ({}))) as {
        alreadyReceived?: boolean;
      };
      // Success: drop the row and close the confirm panel.
      setArrivals((prev) => prev.filter((p) => p.id !== pass.id));
      setArriveConfirm(null);
      setArriveMessage(
        b.alreadyReceived
          ? `${name} was already checked in.`
          : `Checked in ${name}.`,
      );
    } catch (err) {
      setArriveError(err instanceof Error ? err.message : "Network error");
    } finally {
      setArriveBusy(false);
      await refetchQueue();
    }
  }

  return (
    <>
      {/* On-Time Attendance overlay. Self-polling; renders null (and the
          hall-pass UI below shows through) until the kiosk's class enters its
          passing window, then takes over the screen. */}
      <AttendanceMode
        token={token}
        schoolName={school?.schoolName ?? ""}
        room={room}
        onRevoked={onRevoked}
      />
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
          token={token}
          now={now}
          returning={returning}
          returnError={returnError}
          onReturn={async (scannedId: string) => {
            setReturning(true);
            setReturnError(null);
            try {
              const res = await fetch("/api/kiosk/hall-passes/return", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  // Identity comes from the badge the student just scanned /
                  // typed — NOT activePass — so tapping "I'm back" alone can
                  // never end another student's pass. The server only ends a
                  // pass that belongs to this student from this room.
                  studentId: scannedId,
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
              if (res.status === 404) {
                // Wrong badge: the scanned student has no active pass from
                // this room. A remotely-ended pass clears on its own via the
                // queue poll, so a 404 on an explicit scan means a mismatch —
                // surface it instead of silently dismissing the timer.
                setReturnError(
                  "That badge has no active pass from this room. Scan the badge of the student who is out.",
                );
                return;
              }
              if (!res.ok) {
                const b = await res.json().catch(() => ({}));
                setReturnError(
                  b.error ?? `Request failed (${res.status})`,
                );
                return;
              }
              const body = (await res
                .json()
                .catch(() => ({}))) as {
                nextInQueue?: {
                  studentId: string;
                  localSisId: string | null;
                  firstName: string | null;
                  lastName: string | null;
                  destination: string;
                  photoObjectKey?: string | null;
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
                    localSisId: body.nextInQueue.localSisId,
                    firstName: body.nextInQueue.firstName,
                    lastName: body.nextInQueue.lastName,
                    destination: body.nextInQueue.destination,
                    position: 1,
                    addedAt: new Date().toISOString(),
                    photoObjectKey: body.nextInQueue.photoObjectKey ?? null,
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
          token={token}
          photoObjectKey={status.photoObjectKey}
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
                    {d.teacherName ? `${d.teacherName} — ${d.name}` : d.name}
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

      {/* One-way IN ROUTE cards — students who left THIS room and haven't
          checked in at their destination yet. Clears automatically when the
          poll stops returning them (arrived / ended). */}
      {inRoute.length > 0 && (
        <div
          style={{
            width: "min(680px, 88vw)",
            marginTop: "1.5rem",
            marginRight: 96,
            display: "flex",
            flexDirection: "column",
            gap: "0.75rem",
          }}
        >
          <div
            style={{
              fontSize: "0.875rem",
              letterSpacing: "0.15em",
              textTransform: "uppercase",
              opacity: 0.6,
              textAlign: "left",
            }}
          >
            In route from here
          </div>
          {inRoute.map((p) => (
            <InRouteCard key={p.id} pass={p} token={token} now={now} />
          ))}
        </div>
      )}

      {/* Destination arrivals rail — students HEADED here. Fixed to the LEFT
          edge (mirrors the "Next up" rail on the right) with a z-index above
          the TimerScreen overlay, so a returning student can self-check-in
          even while a countdown is running. Tapping a chip opens a badge-scan
          confirm — it does NOT check in on the tap. */}
      {arrivals.length > 0 && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            bottom: 0,
            width: 240,
            background: "rgba(15,23,42,0.92)",
            color: "#fff",
            zIndex: 11,
            display: "flex",
            flexDirection: "column",
            gap: "0.75rem",
            padding: "0.9rem 0.75rem",
            overflowY: "auto",
            boxShadow: "4px 0 16px rgba(0,0,0,0.25)",
            borderRight: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          <div
            style={{
              fontSize: "0.7rem",
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              opacity: 0.7,
              textAlign: "center",
            }}
          >
            Heading here
          </div>
          <div
            style={{
              fontSize: "0.7rem",
              opacity: 0.55,
              textAlign: "center",
              marginTop: "-0.4rem",
            }}
          >
            Tap your name, then scan your badge
          </div>
          {arrivals.map((p) => (
            <ArrivalChip
              key={p.id}
              pass={p}
              token={token}
              onArrive={() => {
                setArriveError(null);
                setArriveConfirm(p);
              }}
            />
          ))}
        </div>
      )}

      {/* Badge-scan confirm for a tapped arrival chip. Rendered above the
          timer (z-index) so it works mid-countdown. */}
      {arriveConfirm && (
        <ArriveConfirmOverlay
          pass={arriveConfirm}
          token={token}
          busy={arriveBusy}
          error={arriveError}
          scannerOpen={arriveScannerOpen}
          onOpenScanner={() => setArriveScannerOpen(true)}
          onCloseScanner={() => setArriveScannerOpen(false)}
          onSubmit={(scannedId) => {
            setArriveScannerOpen(false);
            void handleArrive(arriveConfirm, scannedId);
          }}
          onCancel={() => {
            setArriveScannerOpen(false);
            setArriveError(null);
            setArriveConfirm(null);
          }}
        />
      )}

      {arriveMessage && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: "fixed",
            bottom: 16,
            left: "50%",
            transform: "translateX(-50%)",
            background: "rgba(34,197,94,0.18)",
            border: "1px solid rgba(34,197,94,0.55)",
            color: "#bbf7d0",
            padding: "0.6rem 1.1rem",
            borderRadius: 999,
            fontSize: "0.95rem",
            fontWeight: 600,
            zIndex: 40,
          }}
        >
          {arriveMessage}
        </div>
      )}

      {/* Persistent queue strip — sibling to TimerScreen so the timer's
          render path is never coupled to queue updates. Sits on the right
          edge with a higher z-index than the timer overlay. */}
      <QueueStrip
        entries={queue}
        token={token}
        cap={queueCap}
        onAdd={() => setGetInLineOpen(true)}
        onGoNow={() => setGoNowOpen(true)}
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

      {goNowOpen && (
        <GoNowOverlay
          token={token}
          destinationOptions={destinationOptions}
          onClose={() => setGoNowOpen(false)}
          onCreated={() => {
            setGoNowOpen(false);
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

/* ----------------------------- Student photo ----------------------------- */

// Token-scoped student avatar for kiosk surfaces. When `photoObjectKey` is set
// (and the student consented, which the server already gates), we render a plain
// <img> against /api/kiosk/photo/:token — the kiosk has no staff session, so
// this token-authed route is the only way to fetch the bytes. On any load
// error (404 / no consent / network) we fall back to the initials disc, so a
// missing photo never blocks the surface. Circular by default; pass `square`
// for a rounded-rect.
function KioskPhoto({
  token,
  photoObjectKey,
  firstName,
  lastName,
  size,
  square,
}: {
  token: string;
  photoObjectKey?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  size: number;
  square?: boolean;
}) {
  const [errored, setErrored] = useState(false);
  // Reset the error flag if the key changes (a recycled component instance).
  useEffect(() => {
    setErrored(false);
  }, [photoObjectKey]);
  const initials =
    ((firstName?.[0] ?? "") + (lastName?.[0] ?? "")).toUpperCase() || "?";
  const base: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: square ? Math.round(size * 0.18) : "50%",
    flexShrink: 0,
    background: "rgba(255,255,255,0.12)",
    border: "1px solid rgba(255,255,255,0.2)",
  };
  if (photoObjectKey && !errored) {
    return (
      <img
        src={`/api/kiosk/photo/${encodeURIComponent(token)}?key=${encodeURIComponent(photoObjectKey)}`}
        alt=""
        aria-hidden="true"
        onError={() => setErrored(true)}
        style={{ ...base, objectFit: "cover" }}
      />
    );
  }
  return (
    <div
      aria-hidden="true"
      style={{
        ...base,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#fff",
        fontWeight: 700,
        fontSize: Math.round(size * 0.4),
      }}
    >
      {initials}
    </div>
  );
}

/* ------------------------ One-way lifecycle surfaces ------------------------ */

// Big across-room card for a student who left THIS room on a one-way pass and
// hasn't checked in yet. Shows their photo, name, destination, and elapsed
// time since departure. Rendered by KioskBody from the queue poll's
// `inRouteFromHere`; it disappears on the poll after the student arrives.
function InRouteCard({
  pass,
  token,
  now,
}: {
  pass: OneWayPass;
  token: string;
  now: Date;
}) {
  const elapsedMs = now.getTime() - new Date(pass.createdAt).getTime();
  const totalSec = Math.max(0, Math.floor(elapsedMs / 1000));
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  const elapsed = `${mm}:${String(ss).padStart(2, "0")}`;
  const name =
    `${pass.firstName ?? pass.localSisId ?? "Student"}${pass.lastName ? ` ${pass.lastName}` : ""}`;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "1rem",
        background: "rgba(59,130,246,0.14)",
        border: "1px solid rgba(59,130,246,0.5)",
        borderRadius: 14,
        padding: "1rem 1.25rem",
        textAlign: "left",
      }}
    >
      <KioskPhoto
        token={token}
        photoObjectKey={pass.photoObjectKey}
        firstName={pass.firstName}
        lastName={pass.lastName}
        size={72}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: "clamp(1.4rem, 3vw, 2rem)",
            fontWeight: 800,
            lineHeight: 1.1,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {name}
        </div>
        <div
          style={{
            fontSize: "clamp(1rem, 2vw, 1.25rem)",
            opacity: 0.85,
            marginTop: 2,
          }}
        >
          → {pass.destination}
        </div>
      </div>
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        <div
          style={{
            fontSize: "0.7rem",
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            opacity: 0.6,
          }}
        >
          In route
        </div>
        <div
          style={{
            fontSize: "clamp(1.4rem, 3vw, 2rem)",
            fontWeight: 800,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {elapsed}
        </div>
      </div>
    </div>
  );
}

// Tappable chip for a student headed to THIS room. Tapping it receives /
// checks them in via KioskBody's handleArrive.
function ArrivalChip({
  pass,
  token,
  onArrive,
}: {
  pass: OneWayPass;
  token: string;
  onArrive: () => void;
}) {
  const name =
    `${pass.firstName ?? pass.localSisId ?? "Student"}${pass.lastName ? ` ${pass.lastName.charAt(0)}.` : ""}`;
  return (
    <button
      type="button"
      onClick={onArrive}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.75rem",
        background: "rgba(34,197,94,0.14)",
        border: "1px solid rgba(34,197,94,0.5)",
        borderRadius: 12,
        padding: "0.6rem 0.9rem",
        color: "#fff",
        cursor: "pointer",
        textAlign: "left",
      }}
    >
      <KioskPhoto
        token={token}
        photoObjectKey={pass.photoObjectKey}
        firstName={pass.firstName}
        lastName={pass.lastName}
        size={48}
      />
      <div>
        <div style={{ fontSize: "1.1rem", fontWeight: 700, lineHeight: 1.1 }}>
          {name}
        </div>
        <div style={{ fontSize: "0.8rem", opacity: 0.75, marginTop: 2 }}>
          from {pass.originRoom}
        </div>
      </div>
    </button>
  );
}

// Badge-scan confirm for a student self-checking-in from the "Heading here"
// rail. Identity must be confirmed by scanning/typing the Local SIS id before
// the pass is ended — tapping the chip alone is not enough. Rendered as a
// full-screen overlay above the TimerScreen so it works mid-countdown.
function ArriveConfirmOverlay({
  pass,
  token,
  busy,
  error,
  scannerOpen,
  onOpenScanner,
  onCloseScanner,
  onSubmit,
  onCancel,
}: {
  pass: OneWayPass;
  token: string;
  busy: boolean;
  error: string | null;
  scannerOpen: boolean;
  onOpenScanner: () => void;
  onCloseScanner: () => void;
  onSubmit: (scannedId: string) => void;
  onCancel: () => void;
}) {
  const [enteredId, setEnteredId] = useState("");
  const name = `${pass.firstName ?? pass.localSisId ?? "Student"}${
    pass.lastName ? ` ${pass.lastName.charAt(0)}.` : ""
  }`;
  const submit = (raw: string) => {
    const id = raw.trim();
    if (!id || busy) return;
    onSubmit(id);
  };
  if (scannerOpen) {
    return (
      <CameraScanner
        onScan={(text) => {
          onCloseScanner();
          const id = extractStudentIdFromScan(text);
          if (id) submit(id);
        }}
        onCancel={onCloseScanner}
      />
    );
  }
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(2,6,23,0.82)",
        zIndex: 60,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1.5rem",
      }}
    >
      <div
        style={{
          width: "min(440px, 92vw)",
          background: "#0f172a",
          color: "#fff",
          border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 18,
          padding: "1.5rem",
          boxShadow: "0 24px 64px rgba(0,0,0,0.45)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "1rem",
          textAlign: "center",
        }}
      >
        <KioskPhoto
          token={token}
          photoObjectKey={pass.photoObjectKey}
          firstName={pass.firstName}
          lastName={pass.lastName}
          size={72}
        />
        <div>
          <div style={{ fontSize: "1.35rem", fontWeight: 800 }}>{name}</div>
          <div style={{ fontSize: "0.9rem", opacity: 0.7, marginTop: 2 }}>
            Scan your badge to check in
          </div>
        </div>
        <button
          type="button"
          onClick={onOpenScanner}
          disabled={busy}
          style={{
            width: "100%",
            background: "#2563eb",
            border: "none",
            borderRadius: 12,
            color: "#fff",
            fontSize: "1.05rem",
            fontWeight: 700,
            padding: "0.85rem 1rem",
            cursor: busy ? "default" : "pointer",
          }}
        >
          📷 Scan badge
        </button>
        <div style={{ fontSize: "0.8rem", opacity: 0.5 }}>
          or type your Student ID
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit(enteredId);
          }}
          style={{ width: "100%", display: "flex", gap: "0.5rem" }}
        >
          <input
            value={enteredId}
            onChange={(e) => setEnteredId(e.target.value)}
            inputMode="numeric"
            autoComplete="off"
            placeholder="e.g. 12345"
            style={{
              flex: 1,
              background: "rgba(255,255,255,0.08)",
              border: "1px solid rgba(255,255,255,0.18)",
              borderRadius: 10,
              color: "#fff",
              fontSize: "1.05rem",
              padding: "0.7rem 0.8rem",
            }}
          />
          <button
            type="submit"
            disabled={busy || !enteredId.trim()}
            style={{
              background: "#16a34a",
              border: "none",
              borderRadius: 10,
              color: "#fff",
              fontSize: "1rem",
              fontWeight: 700,
              padding: "0.7rem 1.1rem",
              cursor: busy || !enteredId.trim() ? "default" : "pointer",
              opacity: busy || !enteredId.trim() ? 0.6 : 1,
            }}
          >
            {busy ? "…" : "Check in"}
          </button>
        </form>
        {error && (
          <div
            role="alert"
            style={{
              width: "100%",
              background: "rgba(220,38,38,0.18)",
              border: "1px solid rgba(248,113,113,0.55)",
              color: "#fecaca",
              borderRadius: 10,
              padding: "0.6rem 0.8rem",
              fontSize: "0.9rem",
            }}
          >
            {error}
          </div>
        )}
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          style={{
            background: "transparent",
            border: "none",
            color: "rgba(255,255,255,0.6)",
            fontSize: "0.9rem",
            cursor: busy ? "default" : "pointer",
            textDecoration: "underline",
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ----------------------------- Queue UI ----------------------------- */

function QueueStrip({
  entries,
  token,
  cap,
  onAdd,
  onGoNow,
  disabled,
}: {
  entries: QueueEntry[];
  token: string;
  cap: number;
  onAdd: () => void;
  onGoNow: () => void;
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
        width: 240,
        background: "rgba(15,23,42,0.92)",
        color: "#fff",
        zIndex: 10,
        display: "flex",
        flexDirection: "column",
        gap: "0.75rem",
        padding: "0.9rem 0.75rem",
        overflowY: "auto",
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
          textAlign: "center",
        }}
      >
        Next up
      </div>
      <div
        style={{
          fontSize: "0.7rem",
          opacity: 0.55,
          textAlign: "center",
          marginTop: "-0.4rem",
        }}
      >
        {entries.length}
        <span style={{ opacity: 0.8 }}>/{cap}</span> waiting
      </div>
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: "0.75rem",
        }}
      >
        {entries.length === 0 ? (
          <div
            style={{
              fontSize: "0.8rem",
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
                display: "flex",
                alignItems: "center",
                gap: "0.75rem",
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.14)",
                borderRadius: 12,
                padding: "0.6rem 0.9rem",
                color: "#fff",
                textAlign: "left",
              }}
            >
              <KioskPhoto
                token={token}
                photoObjectKey={e.photoObjectKey}
                firstName={e.firstName}
                lastName={e.lastName}
                size={48}
              />
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontSize: "1.1rem",
                    fontWeight: 700,
                    lineHeight: 1.1,
                  }}
                >
                  {e.firstName ?? e.localSisId ?? ""}
                  {e.lastName ? ` ${e.lastName.charAt(0)}.` : ""}
                </div>
                <div
                  style={{
                    fontSize: "0.8rem",
                    opacity: 0.75,
                    marginTop: 2,
                  }}
                >
                  to {e.destination}
                </div>
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
          borderRadius: 10,
          padding: "0.7rem 0.5rem",
          fontWeight: 700,
          fontSize: "0.95rem",
          lineHeight: 1.15,
          cursor: isFull || disabled ? "not-allowed" : "pointer",
        }}
      >
        {isFull ? "Line is full" : "Get in line"}
      </button>
      <button
        type="button"
        onClick={onGoNow}
        style={{
          marginTop: "0.4rem",
          background: "transparent",
          color: "#fbbf24",
          border: "1px solid rgba(251,191,36,0.55)",
          borderRadius: 10,
          padding: "0.65rem 0.5rem",
          fontWeight: 700,
          fontSize: "0.9rem",
          lineHeight: 1.15,
          cursor: "pointer",
        }}
      >
        Go now
      </button>
      <div
        style={{
          marginTop: 4,
          fontSize: "0.7rem",
          opacity: 0.55,
          textAlign: "center",
          lineHeight: 1.2,
        }}
      >
        Called to the office?
      </div>
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
  destinationOptions: DestinationOption[];
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
                    {d.teacherName ? `${d.teacherName} — ${d.name}` : d.name}
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

// "Go now" line-bypass overlay. Lets a student who was summoned to the
// office/guidance/clinic create a pass immediately instead of waiting in the
// queue. Restroom-kind destinations are excluded (the line meters bathroom
// traffic). A confirmation step ("Were you called down or teacher directed?")
// guards against students bypassing the line casually. On success the pass is
// created server-side (priorityBypass=true) but does NOT take over the device
// timer — the line/bathroom student keeps the big countdown.
function GoNowOverlay({
  token,
  destinationOptions,
  onClose,
  onCreated,
}: {
  token: string;
  destinationOptions: DestinationOption[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [studentId, setStudentId] = useState("");
  const [destination, setDestination] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);

  // Restrooms can never bypass the line; hide them from the picker. (The
  // server enforces this too, in case `kind` isn't available client-side.)
  const bypassDestinations = useMemo(
    () => destinationOptions.filter((d) => d.kind !== "restroom"),
    [destinationOptions],
  );

  // Auto-close after a brief confirmation so the kiosk returns to its normal
  // screen for the next student.
  useEffect(() => {
    if (!done) return;
    const id = setTimeout(onCreated, 2500);
    return () => clearTimeout(id);
  }, [done, onCreated]);

  async function confirmGoNow() {
    if (!studentId.trim() || !destination) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/kiosk/hall-passes`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token,
            studentId: studentId.trim(),
            destination,
            bypassQueue: true,
          }),
        },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? `Request failed (${res.status})`);
        setConfirming(false);
        return;
      }
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setConfirming(false);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      {scannerOpen && (
        <CameraScanner
          onScan={(text) => {
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
            border: "1px solid rgba(251,191,36,0.4)",
          }}
        >
          <div
            style={{
              fontSize: "0.75rem",
              letterSpacing: "0.15em",
              textTransform: "uppercase",
              color: "#fbbf24",
              marginBottom: "0.25rem",
            }}
          >
            Go now — skip the line
          </div>
          <h2 style={{ margin: "0 0 1rem", fontSize: "1.5rem" }}>
            Called down or teacher directed
          </h2>
          {done ? (
            <div
              style={{
                padding: "1rem",
                background: "rgba(34,197,94,0.15)",
                border: "1px solid #22c55e",
                borderRadius: 8,
                textAlign: "center",
              }}
            >
              <div style={{ fontSize: "2rem", marginBottom: "0.25rem" }}>
                ✓
              </div>
              <div style={{ fontSize: "1.1rem", fontWeight: 700 }}>
                You're all set — head to {destination}.
              </div>
              <div style={{ opacity: 0.85, marginTop: "0.5rem" }}>
                Come back and tap “I'm back” when you return.
              </div>
            </div>
          ) : confirming ? (
            <div
              style={{ display: "flex", flexDirection: "column", gap: "1rem" }}
            >
              <div
                style={{
                  padding: "1rem",
                  background: "rgba(251,191,36,0.12)",
                  border: "1px solid rgba(251,191,36,0.5)",
                  borderRadius: 8,
                  fontSize: "1.15rem",
                  fontWeight: 600,
                  textAlign: "center",
                  lineHeight: 1.4,
                }}
              >
                Were you called down or teacher directed?
              </div>
              {error && <ErrorBox>{error}</ErrorBox>}
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <button
                  type="button"
                  onClick={() => {
                    setConfirming(false);
                    setError(null);
                  }}
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
                  type="button"
                  onClick={confirmGoNow}
                  disabled={submitting}
                  style={{
                    flex: 1,
                    background: submitting ? "rgba(251,191,36,0.4)" : "#fbbf24",
                    color: "#0b1220",
                    border: "none",
                    borderRadius: 8,
                    padding: "0.85rem",
                    fontWeight: 800,
                    cursor: submitting ? "not-allowed" : "pointer",
                  }}
                >
                  {submitting ? "Creating…" : "YES, I'm leaving now"}
                </button>
              </div>
            </div>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (studentId.trim() && destination) setConfirming(true);
              }}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.85rem",
              }}
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
                  />
                  <button
                    type="button"
                    onClick={() => setScannerOpen(true)}
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
                >
                  <option value="">Select a destination…</option>
                  {bypassDestinations.map((d) => (
                    <option key={d.id} value={d.name}>
                      {d.teacherName ? `${d.teacherName} — ${d.name}` : d.name}
                    </option>
                  ))}
                </select>
              </Field>
              <div style={{ fontSize: "0.8rem", opacity: 0.65 }}>
                Restrooms can't skip the line — use “Get in line” for those.
              </div>
              {error && <ErrorBox>{error}</ErrorBox>}
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <button
                  type="button"
                  onClick={onClose}
                  style={{
                    flex: 1,
                    background: "transparent",
                    color: "#fff",
                    border: "1px solid rgba(255,255,255,0.25)",
                    borderRadius: 8,
                    padding: "0.85rem",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!studentId.trim() || !destination}
                  style={primaryBtn(!studentId.trim() || !destination, {
                    padding: "0.85rem",
                    flex: 1,
                  })}
                >
                  Continue
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
  // Camera-scanner modal — lets the queued student scan their badge instead
  // of typing. Lazy-loaded so kiosks without a camera never pay the cost.
  const [scannerOpen, setScannerOpen] = useState(false);
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const secondsLeft = Math.max(0, Math.ceil((expiresAt - tick) / 1000));

  // `idOverride` lets a successful scan submit immediately without waiting for
  // the `studentId` state to flush (avoids a stale-state auto-submit race).
  async function submit(e?: React.FormEvent, idOverride?: string) {
    e?.preventDefault();
    const trimmed = (idOverride ?? studentId).trim();
    if (!trimmed) return;
    if (trimmed !== (entry.localSisId ?? "")) {
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
        photoObjectKey?: string | null;
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
          // Pass-create has no photo field; fall back to the queue entry's key
          // so the timer avatar still resolves when consent allows.
          photoObjectKey: data.photoObjectKey ?? entry.photoObjectKey ?? null,
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
      <div style={{ marginBottom: "1rem" }}>
        <KioskPhoto
          token={token}
          photoObjectKey={entry.photoObjectKey}
          firstName={entry.firstName}
          lastName={entry.lastName}
          size={120}
        />
      </div>
      <div
        style={{
          fontSize: "clamp(2.5rem, 7vw, 5rem)",
          fontWeight: 800,
          lineHeight: 1.1,
          marginBottom: "0.25rem",
        }}
      >
        Welcome, {entry.firstName ?? entry.localSisId ?? ""}!
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
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="off"
            autoFocus
            value={studentId}
            onChange={(e) => setStudentId(e.target.value)}
            placeholder="e.g. 12345"
            style={{
              ...inputStyle,
              flex: 1,
              fontSize: "1.4rem",
              textAlign: "center",
            }}
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
              cursor: submitting ? "not-allowed" : "pointer",
              flexShrink: 0,
            }}
          >
            📷
          </button>
        </div>
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
      {scannerOpen && (
        <CameraScanner
          onScan={(text) => {
            const id = extractStudentIdFromScan(text);
            setScannerOpen(false);
            if (!id) return;
            setStudentId(id);
            // The whole point of this screen is to walk up and tap your
            // badge — auto-start the pass on a successful scan. The identity
            // check inside submit() still guards against a mismatched badge.
            void submit(undefined, id);
          }}
          onCancel={() => setScannerOpen(false)}
        />
      )}
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
      const deactRes = await fetch("/api/kiosk/deactivate", {
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
            placeholder="you@school.org"
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
            placeholder="Your password"
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
            // Explicit light color — overrides the global `label` rule that
            // would otherwise render this dark-on-dark in the kiosk modal.
            color: "rgba(255,255,255,0.85)",
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
        // Left of the gear, which itself sits left of the 240px queue sidebar.
        right: 304,
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
        zIndex: 20,
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
        // Sit to the LEFT of the 240px "Next up" queue sidebar (an opaque panel
        // at the same stacking level) so the gear never overlaps it / its text.
        right: 252,
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
        zIndex: 20,
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
      <span
        style={{
          fontSize: "0.85rem",
          // Explicit light color: the global `label { color: var(--text) }`
          // rule (light theme = dark text) would otherwise paint these
          // dark-on-dark and invisible inside the dark kiosk modal.
          color: "rgba(255,255,255,0.85)",
          fontWeight: 500,
        }}
      >
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
  token,
  now,
  returning,
  returnError,
  onReturn,
}: {
  activePass: ActivePass;
  token: string;
  now: Date;
  returning: boolean;
  returnError: string | null;
  onReturn: (studentId: string) => void;
}) {
  // Signing back in requires the student to confirm identity by scanning
  // (or typing) their badge first — tapping "I'm back" alone must never end
  // the pass. The entered id is what gets sent to the return endpoint, which
  // only ends a pass that actually belongs to that student from this room.
  const [confirming, setConfirming] = useState(false);
  const [enteredId, setEnteredId] = useState("");
  const [scannerOpen, setScannerOpen] = useState(false);
  const idInputRef = useRef<HTMLInputElement | null>(null);
  const submitReturn = (raw: string) => {
    const id = raw.trim();
    if (!id) return;
    onReturn(id);
  };
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
        // `safe center` keeps everything centered when it fits but falls
        // back to top-aligned (scrollable) instead of clipping the bottom
        // when the photo + giant timer overflow a short kiosk screen — so
        // the "I'm back" button can never be pushed out of reach.
        justifyContent: "safe center",
        overflowY: "auto",
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
          marginBottom: "0.5rem",
        }}
      >
        {overdue ? "Overdue" : "Out on pass"}
      </div>
      <div style={{ marginBottom: "0.5rem" }}>
        <KioskPhoto
          token={token}
          photoObjectKey={activePass.photoObjectKey}
          firstName={activePass.studentFirstName}
          size={88}
        />
      </div>
      <div
        style={{
          fontSize: "clamp(1.75rem, min(7vw, 7vh), 4.5rem)",
          fontWeight: 700,
          lineHeight: 1.1,
          marginBottom: "0.5rem",
        }}
      >
        {activePass.studentFirstName ?? "Student"}
        <span style={{ opacity: 0.85, fontWeight: 500 }}> → </span>
        {activePass.destination}
      </div>
      <div
        aria-label={overdue ? "overdue countdown" : "time remaining"}
        style={{
          fontSize: "clamp(4rem, min(28vw, 30vh), 22rem)",
          fontWeight: 900,
          lineHeight: 1,
          fontVariantNumeric: "tabular-nums",
          letterSpacing: "0.02em",
          margin: "0.5rem 0 0.75rem",
          textShadow: "0 4px 24px rgba(0,0,0,0.25)",
        }}
      >
        {timeText}
      </div>
      <div
        style={{
          fontSize: "clamp(1rem, 2vw, 1.25rem)",
          opacity: 0.85,
          marginBottom: "1.25rem",
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

      {!confirming ? (
        <button
          type="button"
          onClick={() => {
            setConfirming(true);
            // Focus on the next tick so a hardware scanner / typed id lands
            // in the field immediately after the panel mounts.
            setTimeout(() => idInputRef.current?.focus(), 0);
          }}
          style={{
            background: "#fff",
            color: overdue ? "#dc2626" : "#15803d",
            border: "none",
            borderRadius: 12,
            padding: "1.1rem 2.5rem",
            fontSize: "clamp(1.25rem, 2.5vw, 1.6rem)",
            fontWeight: 700,
            cursor: "pointer",
            boxShadow: "0 6px 18px rgba(0,0,0,0.25)",
          }}
        >
          I'm back
        </button>
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "0.85rem",
            width: "min(420px, 92vw)",
          }}
        >
          <div
            style={{
              fontSize: "clamp(1rem, 2.2vw, 1.35rem)",
              fontWeight: 600,
            }}
          >
            Scan or enter your badge to sign back in
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitReturn(enteredId);
            }}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "0.75rem",
              width: "100%",
            }}
          >
            <input
              ref={idInputRef}
              value={enteredId}
              onChange={(e) => setEnteredId(e.target.value)}
              inputMode="numeric"
              autoComplete="off"
              placeholder="Student ID"
              disabled={returning}
              style={{
                padding: "0.9rem 1rem",
                fontSize: "1.25rem",
                textAlign: "center",
                borderRadius: 10,
                border: "none",
                width: "100%",
                boxSizing: "border-box",
              }}
            />
            <div style={{ display: "flex", gap: "0.6rem" }}>
              <button
                type="button"
                onClick={() => setScannerOpen(true)}
                disabled={returning}
                style={{
                  flex: 1,
                  background: "rgba(255,255,255,0.16)",
                  color: "#fff",
                  border: "1px solid rgba(255,255,255,0.5)",
                  borderRadius: 10,
                  padding: "0.9rem",
                  fontSize: "1.05rem",
                  fontWeight: 600,
                  cursor: returning ? "not-allowed" : "pointer",
                }}
              >
                Scan badge
              </button>
              <button
                type="submit"
                disabled={returning || !enteredId.trim()}
                style={{
                  flex: 1,
                  background: "#fff",
                  color: overdue ? "#dc2626" : "#15803d",
                  border: "none",
                  borderRadius: 10,
                  padding: "0.9rem",
                  fontSize: "1.05rem",
                  fontWeight: 700,
                  cursor:
                    returning || !enteredId.trim()
                      ? "not-allowed"
                      : "pointer",
                  opacity: returning || !enteredId.trim() ? 0.7 : 1,
                }}
              >
                {returning ? "Signing in…" : "Sign back in"}
              </button>
            </div>
          </form>

          <button
            type="button"
            onClick={() => {
              setConfirming(false);
              setEnteredId("");
            }}
            disabled={returning}
            style={{
              background: "transparent",
              color: "#fff",
              border: "none",
              fontSize: "0.95rem",
              textDecoration: "underline",
              cursor: returning ? "not-allowed" : "pointer",
              opacity: 0.85,
            }}
          >
            Cancel
          </button>

          {scannerOpen && (
            <CameraScanner
              onScan={(text) => {
                const id = extractStudentIdFromScan(text);
                setScannerOpen(false);
                if (!id) return;
                setEnteredId(id);
                // Auto-submit on a successful scan — tapping the badge IS the
                // confirmation, no extra button press needed.
                submitReturn(id);
              }}
              onCancel={() => setScannerOpen(false)}
            />
          )}
        </div>
      )}
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
  token,
  photoObjectKey,
  onReset,
}: {
  mode: Mode;
  studentId: string;
  studentFirstName: string | null;
  destination: string;
  token: string;
  photoObjectKey?: string | null;
  onReset: () => void;
}) {
  const displayName = studentFirstName ?? "Student";
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
      <div style={{ marginBottom: "0.75rem" }}>
        <KioskPhoto
          token={token}
          photoObjectKey={photoObjectKey}
          firstName={studentFirstName}
          size={88}
        />
      </div>
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

// ===========================================================================
// On-Time Attendance mode. When an activated kiosk's class is in its passing
// window, /api/kiosk/attendance/state flips `mode` to "attendance" and this
// component takes over the screen as a full-bleed overlay. Students earn
// server-authoritative on-time points by presenting their Local SIS id via
// three live inputs at once: a focused field (USB scanner + on-screen
// keypad) and the camera. The card slides down with the result; the last few
// scans show beneath it. The teacher's "Done" button only appears at the bell.
// ===========================================================================

type AttState = {
  enabled: boolean;
  mode: "hallpass" | "attendance";
  phase?: "passing" | "post_bell" | "off";
  incomingPeriodNumber?: number | null;
  incomingPeriodName?: string | null;
  minutesRemaining?: number | null;
  periodKey?: string | null;
  showDone?: boolean;
  recent?: {
    firstName: string;
    lastName: string;
    points: number;
    postBell: boolean;
  }[];
};

type AttResult =
  | {
      kind: "ok" | "already";
      firstName: string;
      points: number;
      postBell: boolean;
      house: { id: number; name: string; color: string } | null;
    }
  | { kind: "rejected"; firstName: string; message: string }
  | { kind: "unknown" }
  | { kind: "closed" }
  | { kind: "error"; message: string };

function AttendanceMode({
  token,
  schoolName,
  room,
  onRevoked,
}: {
  token: string;
  schoolName: string;
  room: string;
  onRevoked: () => void;
}) {
  const [state, setState] = useState<AttState | null>(null);
  const [studentId, setStudentId] = useState("");
  const [result, setResult] = useState<AttResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraKey, setCameraKey] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const busyRef = useRef(false);
  // Per-id debounce so a camera that re-decodes the same badge many times a
  // second only submits it once per ~2s.
  const lastScanRef = useRef<{ id: string; at: number } | null>(null);
  // Web Audio chime + screen flash on each scan result. The AudioContext is
  // built lazily; the teacher's kiosk-activation tap satisfies the browser
  // autoplay gesture requirement so later camera scans can play sound.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const playChime = useCallback((kind: "success" | "error") => {
    try {
      let ctx = audioCtxRef.current;
      if (!ctx) {
        ctx = new AudioContext();
        audioCtxRef.current = ctx;
      }
      const audio = ctx;
      if (audio.state === "suspended") void audio.resume().catch(() => {});
      const now = audio.currentTime;
      // Success: a bright rising two-note ding. Error: a low two-note buzz.
      const notes = kind === "success" ? [659.25, 987.77] : [196, 146.83];
      notes.forEach((freq, i) => {
        const osc = audio.createOscillator();
        const gain = audio.createGain();
        osc.type = kind === "success" ? "sine" : "triangle";
        osc.frequency.value = freq;
        const start = now + i * 0.12;
        const dur = 0.18;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
        osc.connect(gain);
        gain.connect(audio.destination);
        osc.start(start);
        osc.stop(start + dur);
      });
    } catch {
      // Audio unavailable (no AudioContext / autoplay blocked) — non-fatal.
    }
  }, []);

  const active = state?.mode === "attendance";

  const refetchState = useMemo(
    () => async () => {
      try {
        const res = await fetch(
          `/api/kiosk/attendance/state?token=${encodeURIComponent(token)}`,
        );
        if (res.status === 401) {
          const b = await res.json().catch(() => ({}));
          if (b.revoked) {
            onRevoked();
            return;
          }
        }
        if (!res.ok) return;
        const data = (await res.json()) as AttState;
        setState(data);
      } catch {
        // ignore — next poll retries
      }
    },
    [token, onRevoked],
  );

  useEffect(() => {
    refetchState();
    const id = setInterval(refetchState, 3000);
    return () => clearInterval(id);
  }, [refetchState]);

  // Keep the field focused for the USB scanner / keypad whenever attendance is
  // active and no result card is up.
  useEffect(() => {
    if (active && !result) inputRef.current?.focus();
  }, [active, result]);

  // On each result: play the chime, flash the screen, and auto-dismiss the
  // card so the next student isn't blocked.
  useEffect(() => {
    if (!result) return;
    const isSuccess = result.kind === "ok" || result.kind === "already";
    playChime(isSuccess ? "success" : "error");
    setFlash(isSuccess ? "rgba(34,197,94,0.55)" : "rgba(239,68,68,0.5)");
    const flashId = window.setTimeout(() => setFlash(null), 320);
    const id = window.setTimeout(() => setResult(null), 4000);
    return () => {
      window.clearTimeout(flashId);
      window.clearTimeout(id);
    };
  }, [result, playChime]);

  // Release the AudioContext when the kiosk overlay unmounts.
  useEffect(() => {
    return () => {
      void audioCtxRef.current?.close().catch(() => {});
      audioCtxRef.current = null;
    };
  }, []);

  async function submit(rawId: string, source: "usb" | "keypad" | "camera") {
    const id = rawId.trim();
    if (!id || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await fetch("/api/kiosk/attendance/checkin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId: id, token, source }),
      });
      if (res.status === 401) {
        const b = await res.json().catch(() => ({}));
        if (b.revoked) {
          onRevoked();
          return;
        }
      }
      const b = await res.json().catch(() => ({}) as Record<string, unknown>);
      if (res.status === 409) {
        setResult({ kind: "closed" });
      } else if (res.status === 404) {
        setResult({ kind: "unknown" });
      } else if (res.ok && b.status === "rejected") {
        setResult({
          kind: "rejected",
          firstName: String(b.firstName ?? ""),
          message: String(b.message ?? "Wrong door — this isn't your class."),
        });
      } else if (res.ok) {
        setResult({
          kind: b.status === "already" ? "already" : "ok",
          firstName: String(b.firstName ?? ""),
          points: Number(b.points ?? 0),
          postBell: Boolean(b.postBell),
          house:
            b.house && typeof b.house === "object"
              ? (b.house as { id: number; name: string; color: string })
              : null,
        });
      } else {
        setResult({
          kind: "error",
          message: String(b.error ?? `Check-in failed (${res.status})`),
        });
      }
    } catch (err) {
      setResult({
        kind: "error",
        message: err instanceof Error ? err.message : "Network error",
      });
    } finally {
      setStudentId("");
      busyRef.current = false;
      setBusy(false);
      inputRef.current?.focus();
      // Refresh the recent-scan list.
      void refetchState();
    }
  }

  function onCameraScan(text: string) {
    const id = extractStudentIdFromScan(text);
    if (!id) return;
    const prev = lastScanRef.current;
    const nowMs = Date.now();
    if (prev && prev.id === id && nowMs - prev.at < 2000) return;
    lastScanRef.current = { id, at: nowMs };
    void submit(id, "camera");
    // Re-arm the scanner for the next student (CameraScanner fires once).
    setCameraKey((k) => k + 1);
  }

  async function markDone() {
    try {
      const res = await fetch("/api/kiosk/attendance/done", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (res.status === 401) {
        const b = await res.json().catch(() => ({}));
        if (b.revoked) onRevoked();
      }
    } catch {
      // ignore — the auto-revert safety net (and next poll) covers this
    } finally {
      void refetchState();
    }
  }

  if (!active) return null;

  const mins = state?.minutesRemaining ?? null;
  const postBell = state?.phase === "post_bell";
  const periodLabel =
    state?.incomingPeriodName ||
    (state?.incomingPeriodNumber != null
      ? `Period ${state.incomingPeriodNumber}`
      : "Next class");

  const keypadDigits = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

  // Hero "welcome" card above the list: shows the fresh scan result when one
  // is up, otherwise the most-recent checked-in student — so a big celebratory
  // name is always on screen. Keyed by name so it re-animates on each new scan.
  const newest = state?.recent?.[0];
  const resultCardSlot = (
    <div
      style={{ width: "100%", minHeight: result || newest ? undefined : 0 }}
    >
      {result ? (
        <AttendanceResultCard result={result} />
      ) : newest ? (
        <div
          key={`${newest.firstName}-${newest.lastName}`}
          style={{
            background: "rgba(34,197,94,0.15)",
            border: "1px solid rgba(34,197,94,0.5)",
            borderRadius: 18,
            padding: "1.5rem 1.75rem",
            textAlign: "center",
            animation: "attRowIn 360ms ease-out",
          }}
        >
          <div
            style={{
              fontSize: "0.8rem",
              textTransform: "uppercase",
              letterSpacing: "0.16em",
              opacity: 0.7,
            }}
          >
            🎉 Just scanned in
          </div>
          <div
            style={{
              fontSize: "clamp(2rem, 4.2vw, 3.4rem)",
              fontWeight: 800,
              lineHeight: 1.1,
              margin: "0.4rem 0 0.35rem",
            }}
          >
            {newest.firstName} {newest.lastName}
          </div>
          <div
            style={{ fontSize: "1.3rem", fontWeight: 700, color: "#86efac" }}
          >
            {newest.postBell
              ? "On time — you made it!"
              : `+${newest.points} point${newest.points === 1 ? "" : "s"}`}
          </div>
        </div>
      ) : null}
    </div>
  );

  // Live "just checked in" name list (newest on top, slides in).
  const nameFeed = (
    <div style={{ width: "100%" }}>
      <style>{`@keyframes attRowIn{from{opacity:0;transform:translateY(-16px) scale(0.97)}to{opacity:1;transform:translateY(0) scale(1)}}`}</style>
      <div
        style={{
          fontSize: "0.85rem",
          textTransform: "uppercase",
          letterSpacing: "0.14em",
          opacity: 0.65,
          marginBottom: "0.6rem",
          textAlign: "center",
        }}
      >
        ✅ Just checked in
      </div>
      {state?.recent && state.recent.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {state.recent.map((r, i) => (
            <div
              key={`${r.firstName}-${r.lastName}-${i}`}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                background:
                  i === 0
                    ? "rgba(134,239,172,0.16)"
                    : "rgba(255,255,255,0.06)",
                border: `1px solid ${
                  i === 0 ? "rgba(134,239,172,0.5)" : "rgba(255,255,255,0.1)"
                }`,
                borderRadius: 12,
                padding: "0.8rem 1.1rem",
                fontSize: "1.35rem",
                fontWeight: 700,
                animation: "attRowIn 320ms ease-out",
              }}
            >
              <span>
                {r.firstName} {r.lastName}
              </span>
              <span
                style={{
                  fontWeight: 800,
                  color: "#86efac",
                  fontSize: "1.1rem",
                }}
              >
                {r.postBell ? "On time" : `+${r.points}`}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div
          style={{
            textAlign: "center",
            opacity: 0.45,
            fontSize: "1rem",
            padding: "0.75rem 0",
          }}
        >
          Scan a badge to get on the board
        </div>
      )}
    </div>
  );

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        background:
          "radial-gradient(1200px 600px at 50% -10%, #15324f 0%, #0b1220 60%, #070b14 100%)",
        color: "#fff",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "2rem 1.25rem",
        overflowY: "auto",
      }}
    >
      {flash && (
        <div
          aria-hidden
          style={{
            position: "fixed",
            inset: 0,
            background: flash,
            zIndex: 70,
            pointerEvents: "none",
            animation: "attFlash 320ms ease-out forwards",
          }}
        />
      )}
      <style>{`@keyframes attFlash{from{opacity:1}to{opacity:0}}`}</style>
      <div
        style={{
          fontSize: "0.8rem",
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          opacity: 0.6,
        }}
      >
        {schoolName || "PulseEDU"} · On-Time Attendance
      </div>
      <h1
        style={{
          fontSize: "clamp(1.8rem, 4.5vw, 3rem)",
          margin: "0.35rem 0 0",
          fontWeight: 800,
        }}
      >
        {room}
      </h1>
      <div
        style={{
          fontSize: "1.05rem",
          opacity: 0.85,
          marginTop: "0.35rem",
          textAlign: "center",
        }}
      >
        Scan in for <strong>{periodLabel}</strong>
      </div>
      <div
        style={{
          marginTop: "0.5rem",
          fontSize: postBell ? "1.05rem" : "1.25rem",
          fontWeight: 700,
          color: postBell ? "#fca5a5" : "#86efac",
        }}
      >
        {postBell
          ? "Bell has rung — last call!"
          : mins != null
            ? `${mins} min until the bell`
            : "Open now"}
      </div>

      {/* Live board. Camera ON: camera viewer LEFT, names RIGHT (no keypad —
          the camera is the input). Camera OFF: two columns — result card +
          growing name list scroll on the LEFT, scan input + keypad stay
          anchored on the RIGHT so they never get pushed off-screen. */}
      {cameraOn ? (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "center",
            alignItems: "flex-start",
            gap: "2.75rem",
            width: "100%",
            maxWidth: 1180,
            marginTop: "1.25rem",
          }}
        >
          {/* LEFT — camera viewer */}
          <div style={{ flex: "0 0 auto", width: "min(480px, 94vw)" }}>
            <CameraScanner
              key={cameraKey}
              embedded
              onScan={onCameraScan}
              onCancel={() => setCameraOn(false)}
            />
          </div>
          {/* RIGHT — welcome card flowing into the live name list */}
          <div
            style={{
              flex: "1 1 360px",
              minWidth: 280,
              maxWidth: 560,
              display: "flex",
              flexDirection: "column",
              gap: "1rem",
            }}
          >
            {resultCardSlot}
            {nameFeed}
          </div>
        </div>
      ) : (
        /* Camera OFF — fixed two-column layout: growing name list on the LEFT
           (scrolls within its own column), scan input + keypad anchored on the
           RIGHT so the keypad is always reachable no matter how many students
           have checked in. */
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            gap: "2.75rem",
            width: "100%",
            maxWidth: 1180,
            marginTop: "1.25rem",
          }}
        >
          {/* LEFT — result card + growing name feed (scrolls in place). */}
          <div
            style={{
              flex: "1 1 0",
              minWidth: 0,
              maxWidth: 560,
              display: "flex",
              flexDirection: "column",
              gap: "1rem",
            }}
          >
            {resultCardSlot}
            <div style={{ maxHeight: "calc(100vh - 280px)", overflowY: "auto" }}>
              {nameFeed}
            </div>
          </div>

          {/* RIGHT — USB scan field + on-screen keypad, anchored so it never
              scrolls off screen as the left column grows. */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit(studentId, "usb");
            }}
            style={{
              flex: "0 0 auto",
              width: "min(400px, 94vw)",
              alignSelf: "flex-start",
              position: "sticky",
              top: 0,
              background: "rgba(255,255,255,0.06)",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 14,
              padding: "1.25rem",
              display: "flex",
              flexDirection: "column",
              gap: "0.9rem",
            }}
          >
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <input
                ref={inputRef}
                type="text"
                inputMode="numeric"
                autoComplete="off"
                autoFocus
                value={studentId}
                onChange={(e) => setStudentId(e.target.value)}
                placeholder="Scan badge or enter your ID"
                style={{ ...inputStyle, flex: 1, fontSize: "1.3rem", textAlign: "center" }}
                disabled={busy}
              />
              <button
                type="button"
                onClick={() => {
                  setCameraOn((v) => !v);
                  setCameraKey((k) => k + 1);
                }}
                aria-label="Toggle camera scanning"
                title="Toggle camera scanning"
                style={{
                  background: cameraOn ? "#3b82f6" : "rgba(255,255,255,0.1)",
                  border: "1px solid rgba(255,255,255,0.2)",
                  borderRadius: 10,
                  color: "#fff",
                  width: 64,
                  fontSize: "1.6rem",
                  cursor: "pointer",
                  flexShrink: 0,
                }}
              >
                📷
              </button>
            </div>

            {/* On-screen keypad (live alongside the USB field). */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: "0.5rem",
              }}
            >
              {keypadDigits.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setStudentId((s) => s + d)}
                  disabled={busy}
                  style={keypadBtnStyle}
                >
                  {d}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setStudentId((s) => s.slice(0, -1))}
                disabled={busy}
                style={keypadBtnStyle}
                aria-label="Delete last digit"
              >
                ⌫
              </button>
              <button
                type="button"
                onClick={() => setStudentId((s) => s + "0")}
                disabled={busy}
                style={keypadBtnStyle}
              >
                0
              </button>
              <button
                type="submit"
                disabled={busy || !studentId.trim()}
                style={{
                  ...keypadBtnStyle,
                  background:
                    busy || !studentId.trim() ? "rgba(34,197,94,0.4)" : "#22c55e",
                  border: "none",
                }}
                aria-label="Submit check-in"
              >
                ✓
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Teacher "Done" — only at the bell. One tap reverts to hall pass. */}
      {state?.showDone && (
        <button
          type="button"
          onClick={markDone}
          style={{
            marginTop: "1.5rem",
            background: "#ef4444",
            color: "#fff",
            border: "none",
            borderRadius: 12,
            padding: "1.1rem 2.5rem",
            fontSize: "1.3rem",
            fontWeight: 800,
            cursor: "pointer",
          }}
        >
          Done — close attendance
        </button>
      )}
    </div>
  );
}

const keypadBtnStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.1)",
  border: "1px solid rgba(255,255,255,0.2)",
  color: "#fff",
  borderRadius: 10,
  padding: "1rem 0",
  fontSize: "1.5rem",
  fontWeight: 700,
  cursor: "pointer",
};

function AttendanceResultCard({ result }: { result: AttResult }) {
  let bg = "rgba(34,197,94,0.15)";
  let border = "rgba(34,197,94,0.5)";
  let title = "";
  let subtitle = "";

  if (result.kind === "ok") {
    bg = result.house
      ? `${result.house.color}26`
      : "rgba(34,197,94,0.15)";
    border = result.house ? result.house.color : "rgba(34,197,94,0.6)";
    title = `Welcome, ${result.firstName}!`;
    subtitle = result.postBell
      ? "Checked in — you made it."
      : `+${result.points} point${result.points === 1 ? "" : "s"}${
          result.house ? ` for ${result.house.name}` : ""
        }`;
  } else if (result.kind === "already") {
    bg = "rgba(59,130,246,0.15)";
    border = "rgba(59,130,246,0.6)";
    title = `You're already in, ${result.firstName}!`;
    subtitle = "No need to scan twice.";
  } else if (result.kind === "rejected") {
    bg = "rgba(234,179,8,0.15)";
    border = "rgba(234,179,8,0.6)";
    title = result.firstName ? `Hi ${result.firstName}` : "Wrong door";
    subtitle = result.message;
  } else if (result.kind === "unknown") {
    bg = "rgba(234,179,8,0.15)";
    border = "rgba(234,179,8,0.6)";
    title = "ID not found";
    subtitle = "Check your ID and try again, or see the teacher.";
  } else if (result.kind === "closed") {
    bg = "rgba(148,163,184,0.15)";
    border = "rgba(148,163,184,0.6)";
    title = "Attendance is closed";
    subtitle = "This window has ended.";
  } else if (result.kind === "error") {
    bg = "rgba(239,68,68,0.15)";
    border = "rgba(239,68,68,0.6)";
    title = "Something went wrong";
    subtitle = result.message;
  }

  return (
    <div
      style={{
        background: bg,
        border: `2px solid ${border}`,
        borderRadius: 14,
        padding: "1.1rem 1.4rem",
        textAlign: "center",
        animation: "attCardIn 220ms ease-out",
      }}
    >
      <style>{`@keyframes attCardIn{from{opacity:0;transform:translateY(-10px)}to{opacity:1;transform:translateY(0)}}`}</style>
      <div style={{ fontSize: "1.6rem", fontWeight: 800 }}>{title}</div>
      <div style={{ fontSize: "1.1rem", opacity: 0.9, marginTop: "0.3rem" }}>
        {subtitle}
      </div>
    </div>
  );
}
