import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { authFetch } from "../lib/authToken";
import StudentPhoto from "../components/StudentPhoto";

// Safe alphabet for adult letters — no look/sound-alike glyphs (no I, O, etc.)
// so a code read off a tag and typed at the curb can't be confused. Mirrors
// SAFE_LETTERS on the server (routes/pickup.ts). A–H covers the soft cap of
// 8 authorized adults per student.
const SAFE_LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H"];

// =============================================================================
// PickupApp — standalone mini-app for the Parent Pick-Up Module
//
// Three internal routes (path-dispatched, not react-router so this stays a
// thin file):
//   /pickup/curb     — phone-first keypad for the car-rider line
//   /pickup/walkers  — walker dismissal gate
//   /pickup/admin    — authorizations CRUD + dismissal-mode editor
//
// All three rely on the staff session cookie (same as App.tsx). If the
// session is missing the API returns 401 and the page shows a sign-in prompt
// pointing back at the main app — front office staff log into the staff
// app on their station, then bookmark /pickup/curb on the dismissal tablet.
// =============================================================================

type Me = {
  staffId: number | null;
  displayName: string | null;
  isAdmin: boolean;
  isSuperUser: boolean;
  isDistrictAdmin: boolean;
  isBehaviorSpecialist: boolean;
  isMtssCoordinator: boolean;
  isSchoolPsychologist: boolean;
  isCounselor: boolean;
  isGuidanceCounselor: boolean;
  capCarRiderMonitor: boolean;
  capManageDismissal: boolean;
  canApproveAst: boolean;
};

function useMe(): { me: Me | null; loading: boolean; error: string | null } {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch("/api/auth/me");
        if (!res.ok) throw new Error("Not signed in");
        // /api/auth/me spreads the staff fields at the TOP level
        // (see publicStaff() in routes/auth.ts) — there is no `.staff`
        // wrapper. Reading data.staff.* silently coerced every role
        // flag to false, locking even SuperUsers out of the kiosk
        // gates with "Access denied."
        const s = (await res.json()) as Partial<Me> & {
          id?: number;
          staffId?: number;
        };
        if (cancelled) return;
        setMe({
          staffId: s.id ?? s.staffId ?? null,
          displayName: s.displayName ?? null,
          isAdmin: Boolean(s.isAdmin),
          isSuperUser: Boolean(s.isSuperUser),
          isDistrictAdmin: Boolean(s.isDistrictAdmin),
          isBehaviorSpecialist: Boolean(s.isBehaviorSpecialist),
          isMtssCoordinator: Boolean(s.isMtssCoordinator),
          isSchoolPsychologist: Boolean(s.isSchoolPsychologist),
          isCounselor: Boolean(s.isCounselor),
          isGuidanceCounselor: Boolean(s.isGuidanceCounselor),
          capCarRiderMonitor: Boolean(s.capCarRiderMonitor),
          capManageDismissal: Boolean(s.capManageDismissal),
          canApproveAst: Boolean(s.canApproveAst),
        });
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return { me, loading, error };
}

function canRunCurb(me: Me | null): boolean {
  if (!me) return false;
  return Boolean(
    me.isAdmin ||
      me.isSuperUser ||
      me.isDistrictAdmin ||
      me.capCarRiderMonitor,
  );
}

function isAdmin(me: Me | null): boolean {
  if (!me) return false;
  return Boolean(me.isAdmin || me.isSuperUser || me.isDistrictAdmin);
}

// Pickup-tag management gate — keep in sync with server-side
// canManagePickup() in artifacts/api-server/src/lib/coreTeam.ts.
// Admin / Core Team / counselor (either flavor) / front-office
// (capManageDismissal) / confidential secretary (canApproveAst).
// Teachers intentionally excluded.
function canManagePickup(me: Me | null): boolean {
  if (!me) return false;
  return Boolean(
    me.isAdmin ||
      me.isSuperUser ||
      me.isDistrictAdmin ||
      me.isBehaviorSpecialist ||
      me.isMtssCoordinator ||
      me.isSchoolPsychologist ||
      me.isCounselor ||
      me.isGuidanceCounselor ||
      me.capManageDismissal ||
      me.canApproveAst,
  );
}

// ---------------------------------------------------------------------------
// Top-level dispatch
// ---------------------------------------------------------------------------
export default function PickupApp() {
  const path = window.location.pathname;
  const { me, loading, error } = useMe();

  if (loading) {
    return <FullPageMsg>Loading…</FullPageMsg>;
  }
  if (error || !me) {
    return (
      <FullPageMsg>
        <strong>Sign-in required.</strong>
        <br />
        Open the main staff app to sign in, then return to this page.
        <div style={{ marginTop: 16 }}>
          <a href="/" style={linkStyle}>
            Go to staff app
          </a>
        </div>
      </FullPageMsg>
    );
  }

  if (path.includes("/pickup/curb")) {
    if (!canRunCurb(me)) return <NoAccess role="curb monitor" />;
    return <CurbKeypadPage me={me} />;
  }
  if (path.includes("/pickup/walkers")) {
    if (!canRunCurb(me)) return <NoAccess role="walker gate" />;
    return <WalkerGatePage me={me} />;
  }
  if (path.includes("/pickup/admin")) {
    if (!canManagePickup(me)) return <NoAccess role="pickup-tag manager" />;
    return <AuthorizationsAdminPage />;
  }
  if (path.includes("/pickup/teacher")) {
    // Any signed-in staff can use the teacher view. Server-side scope
    // enforcement (own_roster vs all_students) protects the release
    // event itself, so there's no role gate here.
    return <TeacherQueuePage me={me} />;
  }

  // /pickup → simple landing page that links to the three sub-routes.
  return (
    <FullPageMsg>
      <h2 style={{ margin: 0, fontSize: 28 }}>Parent Pick-Up</h2>
      <div style={{ marginTop: 24, display: "grid", gap: 12 }}>
        {canRunCurb(me) && (
          <a href="/pickup/curb" style={tileLinkStyle}>
            Curb keypad
          </a>
        )}
        {canRunCurb(me) && (
          <a href="/pickup/walkers" style={tileLinkStyle}>
            Walker gate
          </a>
        )}
        {isAdmin(me) && (
          <a href="/pickup/admin" style={tileLinkStyle}>
            Manage pickup numbers
          </a>
        )}
        <a href="/pickup/teacher" style={tileLinkStyle}>
          Teacher view
        </a>
        {!canRunCurb(me) && !isAdmin(me) && (
          <div style={{ color: "#6b7280" }}>
            You do not have access to the pickup module. Ask an admin to grant
            you the "Car-rider monitor" role.
          </div>
        )}
      </div>
    </FullPageMsg>
  );
}

// ---------------------------------------------------------------------------
// CURB KEYPAD
// ---------------------------------------------------------------------------
type LookupHit = {
  authorization: {
    id: number;
    pickupNumber: string;
    guardianLabel: string;
    restricted: boolean;
    parentId: number | null;
  };
  primary: {
    authorizationId: number;
    studentDbId: number;
    studentId: string;
    localSisId: string | null;
    firstName: string;
    lastName: string;
    grade: number;
    dismissalMode: string;
    restricted: boolean;
    // Photo verification — server-supplied. Renders via
    // <StudentPhoto/>, which falls back to initials when null or when
    // photoConsent === false.
    photoObjectKey: string | null;
    photoConsent: boolean;
  } | null;
  siblings: Array<{
    authorizationId: number;
    studentDbId: number;
    studentId: string;
    localSisId: string | null;
    firstName: string;
    lastName: string;
    grade: number;
    dismissalMode?: string;
    restricted: boolean;
    photoObjectKey: string | null;
    photoConsent: boolean;
  }>;
};

type QueueEntry = {
  position: number;
  studentId: string;
  localSisId: string | null;
  studentDbId: number;
  firstName: string;
  lastName: string;
  grade: number | null;
  addedAt: string;
  status: "in_queue" | "walking_out";
  pickupAuthorizationId: number | null;
};

function CurbKeypadPage({ me }: { me: Me }) {
  const [pad, setPad] = useState("");
  const [hit, setHit] = useState<LookupHit | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [overrideText, setOverrideText] = useState("");
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  // Which authorized kids to send out. Auto-selected (all non-restricted)
  // when a code resolves; for a single kid this means a one-tap confirm, and
  // for 2+ the office can untick a sibling who isn't in the car. Restricted
  // kids start UNticked (greyed) and only an admin override can add them.
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const refreshQueue = useCallback(async () => {
    try {
      const res = await authFetch("/api/pickup/queue");
      if (!res.ok) return;
      const data = (await res.json()) as { queue: QueueEntry[] };
      setQueue(data.queue);
    } catch {
      // best-effort
    }
  }, []);

  useEffect(() => {
    refreshQueue();
    const t = setInterval(refreshQueue, 15000);
    return () => clearInterval(t);
  }, [refreshQueue]);

  const tap = (s: string) => {
    setHit(null);
    setErrorMsg(null);
    setOverrideText("");
    if (s === "DEL") {
      setPad((v) => v.slice(0, -1));
      return;
    }
    if (s === "CLR") {
      setPad("");
      return;
    }
    if (pad.length >= 6) return;
    setPad((v) => v + s);
  };

  const lookup = async () => {
    if (!pad) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const res = await authFetch("/api/pickup/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pickupNumber: pad }),
      });
      const data = (await res.json()) as LookupHit & { error?: string };
      if (!res.ok) {
        setErrorMsg(data.error ?? `Lookup failed (${res.status})`);
        return;
      }
      setHit(data);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const allCandidates = useMemo(() => {
    if (!hit?.primary) return [];
    return [hit.primary, ...hit.siblings];
  }, [hit]);

  // When a code resolves, auto-tick the non-restricted kids. Single kid →
  // already confirmed; 2+ → office can untick whoever isn't in the car.
  useEffect(() => {
    setSelected(
      new Set(
        allCandidates.filter((c) => !c.restricted).map((c) => c.authorizationId),
      ),
    );
  }, [allCandidates]);

  const toggleSelected = (authId: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(authId)) next.delete(authId);
      else next.add(authId);
      return next;
    });
  };

  const selectedCandidates = allCandidates.filter((c) =>
    selected.has(c.authorizationId),
  );
  const multi = allCandidates.length > 1;
  // Override is only needed when a RESTRICTED kid is actually ticked.
  const hasRestricted = selectedCandidates.some((c) => c.restricted);

  const addToLine = async () => {
    if (!hit || selectedCandidates.length === 0) return;
    const ids = selectedCandidates.map((c) => c.authorizationId);
    setBusy(true);
    setErrorMsg(null);
    try {
      const res = await authFetch("/api/pickup/queue/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          authorizationIds: ids,
          overrideJustification: hasRestricted ? overrideText : undefined,
        }),
      });
      const data = (await res.json()) as { error?: string; added?: number };
      if (!res.ok) {
        setErrorMsg(data.error ?? `Add failed (${res.status})`);
        return;
      }
      // Reset for the next car.
      setPad("");
      setHit(null);
      setOverrideText("");
      await refreshQueue();
    } finally {
      setBusy(false);
    }
  };

  const markInCar = async (studentDbId: number) => {
    await authFetch("/api/pickup/queue/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ studentDbId, action: "in_car" }),
    });
    await refreshQueue();
  };

  return (
    <div style={pageStyle}>
      <Header title="Curb Keypad" subtitle={me.displayName ?? "Staff"} />
      <div style={twoCol}>
        <div style={col}>
          <div style={padDisplay}>{pad || "—"}</div>
          <div style={keypadGrid}>
            {["1", "2", "3", "4", "5", "6", "7", "8", "9", "CLR", "0", "DEL"].map(
              (k) => (
                <button
                  key={k}
                  onClick={() => tap(k)}
                  style={k === "DEL" || k === "CLR" ? keyAlt : keyMain}
                >
                  {k}
                </button>
              ),
            )}
          </div>
          {/* Adult letter row. A family reads the FULL code off their tag
              (e.g. 1001C); the letter picks which authorized adult is at the
              curb, then the lookup pulls that adult's whole car of kids. */}
          <div style={letterRow}>
            {SAFE_LETTERS.map((L) => (
              <button key={L} onClick={() => tap(L)} style={keyLetter}>
                {L}
              </button>
            ))}
          </div>
          <button
            onClick={lookup}
            disabled={!pad || busy}
            style={primaryBtn}
          >
            {busy ? "Looking up…" : "Look up"}
          </button>
          <button
            disabled
            style={{ ...secondaryBtn, marginTop: 8, opacity: 0.5 }}
            title="QR scan ships in the next release"
          >
            Scan QR (coming soon)
          </button>
          {errorMsg && <div style={errBox}>{errorMsg}</div>}
        </div>
        <div style={col}>
          {hit ? (
            <div>
              <div style={cardTitle}>
                #{hit.authorization.pickupNumber} ·{" "}
                {hit.authorization.guardianLabel}
              </div>
              {multi && (
                <div
                  style={{
                    fontSize: 13,
                    color: "#6b7280",
                    margin: "0 0 8px",
                  }}
                >
                  Tap to pick which kids are in the car.
                </div>
              )}
              {allCandidates.map((c) => {
                const isSel = selected.has(c.authorizationId);
                return (
                  <div
                    key={c.authorizationId}
                    onClick={() => toggleSelected(c.authorizationId)}
                    style={{
                      ...studentCard,
                      cursor: "pointer",
                      borderColor: c.restricted
                        ? "#dc2626"
                        : isSel
                          ? "#2563eb"
                          : "#e5e7eb",
                      borderWidth: isSel ? 2 : 1,
                      background: c.restricted
                        ? "#fef2f2"
                        : isSel
                          ? "#eff6ff"
                          : "#fff",
                      // Greyed when not selected (e.g. a restricted kid the
                      // office hasn't overridden, or a sibling not in the car).
                      opacity: isSel ? 1 : 0.55,
                    }}
                  >
                    {/* Photo verification — the staffer at the curb
                        visually matches the face on screen to the
                        student walking out. Sized big (72px) on this
                        card because it's THE moment-of-truth check;
                        no other place in the app needs the photo
                        this prominent. */}
                    <div
                      style={{
                        display: "flex",
                        gap: 14,
                        alignItems: "center",
                      }}
                    >
                      <div
                        style={{
                          width: 24,
                          height: 24,
                          borderRadius: 6,
                          border: `2px solid ${isSel ? "#2563eb" : "#cbd5e1"}`,
                          background: isSel ? "#2563eb" : "#fff",
                          color: "#fff",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: 16,
                          flexShrink: 0,
                        }}
                        aria-hidden
                      >
                        {isSel ? "✓" : ""}
                      </div>
                      <StudentPhoto
                        firstName={c.firstName}
                        lastName={c.lastName}
                        photoObjectKey={c.photoObjectKey}
                        photoConsent={c.photoConsent}
                        size={72}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600 }}>
                          {c.firstName} {c.lastName}
                        </div>
                        <div style={{ color: "#6b7280", fontSize: 13 }}>
                          Grade {c.grade} · ID {c.localSisId ?? "—"}
                        </div>
                        {c.restricted && (
                          <div
                            style={{
                              color: "#dc2626",
                              marginTop: 6,
                              fontWeight: 600,
                            }}
                          >
                            RESTRICTED — guardian not authorized for this
                            student
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
              {hasRestricted && (
                <div style={overrideBox}>
                  <div style={{ fontWeight: 600, color: "#7f1d1d" }}>
                    Admin override required
                  </div>
                  <div style={{ fontSize: 13, marginTop: 4, color: "#7f1d1d" }}>
                    Type a justification (5+ chars). This is recorded in the
                    audit log.
                  </div>
                  <textarea
                    value={overrideText}
                    onChange={(e) => setOverrideText(e.target.value)}
                    rows={2}
                    style={textareaStyle}
                    placeholder="e.g. front office confirmed parent identity by phone"
                  />
                </div>
              )}
              <button
                onClick={addToLine}
                disabled={
                  busy ||
                  selectedCandidates.length === 0 ||
                  (hasRestricted && overrideText.trim().length < 5) ||
                  (hasRestricted && !isAdmin(me))
                }
                style={{ ...primaryBtn, marginTop: 12 }}
              >
                {selectedCandidates.length === 0
                  ? "Pick at least one student"
                  : hasRestricted
                    ? `Override + add ${selectedCandidates.length} to line`
                    : `Add ${selectedCandidates.length} to line`}
              </button>
            </div>
          ) : (
            <div style={{ color: "#6b7280" }}>
              Type a pickup code (number + adult letter) and tap Look up. The
              car's authorized siblings will be added together.
            </div>
          )}
        </div>
      </div>

      <div style={{ marginTop: 32 }}>
        <h3 style={{ margin: "0 0 8px" }}>
          Live queue ({queue.length})
        </h3>
        {queue.length === 0 ? (
          <div style={{ color: "#6b7280" }}>Queue is empty.</div>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>#</th>
                <th style={th}>Student</th>
                <th style={th}>Grade</th>
                <th style={th}>Added</th>
                <th style={th}>Status</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {[...queue]
                .sort(
                  (a, b) =>
                    new Date(b.addedAt).getTime() -
                      new Date(a.addedAt).getTime() ||
                    b.position - a.position,
                )
                .map((q) => (
                <tr key={q.studentDbId}>
                  <td style={td}>{q.position}</td>
                  <td style={td}>
                    {q.firstName} {q.lastName}
                  </td>
                  <td style={td}>{q.grade ?? "—"}</td>
                  <td style={td}>
                    {new Date(q.addedAt).toLocaleTimeString([], {
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </td>
                  <td style={td}>
                    {q.status === "walking_out" ? (
                      <span style={chipGreen}>walking out</span>
                    ) : (
                      <span style={chipBlue}>in queue</span>
                    )}
                  </td>
                  <td style={td}>
                    <button
                      onClick={() => markInCar(q.studentDbId)}
                      style={smallBtn}
                    >
                      In car
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// WALKER GATE
// ---------------------------------------------------------------------------
type WalkerRow = {
  studentDbId: number;
  studentId: string;
  localSisId: string | null;
  firstName: string;
  lastName: string;
  grade: number;
  photoObjectKey: string | null;
  photoConsent: boolean;
  released: { releasedAt: string; releasedBy: string } | null;
  siblingWalkers: Array<{
    studentDbId: number;
    firstName: string;
    lastName: string;
    grade: number;
    releasedToday: boolean;
  }>;
};

function WalkerGatePage({ me }: { me: Me }) {
  const [rows, setRows] = useState<WalkerRow[]>([]);
  const [windowOpen, setWindowOpen] = useState(true);
  const [windowOpensAt, setWindowOpensAt] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  // Keypad lookup state — mirrors CurbKeypadPage so a guardian at the
  // walker gate can type their pickup number and release every walker
  // attached to that authorization in one tap (no scrolling a 600-row
  // roster on a tablet).
  const [pad, setPad] = useState("");
  const [hit, setHit] = useState<LookupHit | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await authFetch("/api/pickup/walkers");
    if (!res.ok) return;
    const data = (await res.json()) as {
      walkers: WalkerRow[];
      windowOpen: boolean;
      windowOpensAt: string | null;
    };
    setRows(data.walkers);
    setWindowOpen(data.windowOpen);
    setWindowOpensAt(data.windowOpensAt);
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15000);
    return () => clearInterval(t);
  }, [refresh]);

  const releasedTodayIds = useMemo(
    () => new Set(rows.filter((r) => r.released).map((r) => r.studentDbId)),
    [rows],
  );

  const release = async (
    studentDbId: number,
    opts?: {
      pickupAuthorizationId?: number;
      overrideJustification?: string;
    },
  ): Promise<{ ok: boolean; error?: string }> => {
    const body: Record<string, unknown> = { studentDbId };
    if (opts?.pickupAuthorizationId !== undefined) {
      body.pickupAuthorizationId = opts.pickupAuthorizationId;
    }
    if (opts?.overrideJustification) {
      body.overrideJustification = opts.overrideJustification;
    }
    const res = await authFetch("/api/pickup/walkers/release", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: data.error ?? `Release failed (${res.status})` };
    }
    return { ok: true };
  };

  const tap = (s: string) => {
    setHit(null);
    setErrorMsg(null);
    setOkMsg(null);
    if (s === "DEL") {
      setPad((v) => v.slice(0, -1));
      return;
    }
    if (s === "CLR") {
      setPad("");
      return;
    }
    if (pad.length >= 6) return;
    setPad((v) => v + s);
  };

  const lookup = async () => {
    if (!pad) return;
    setBusy(true);
    setErrorMsg(null);
    setOkMsg(null);
    try {
      const res = await authFetch("/api/pickup/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pickupNumber: pad }),
      });
      const data = (await res.json()) as LookupHit & { error?: string };
      if (!res.ok) {
        setErrorMsg(data.error ?? `Lookup failed (${res.status})`);
        return;
      }
      setHit(data);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Of everyone on the typed authorization, which ones are walkers we
  // can release here? Non-walker siblings (car-rider, bus, aftercare)
  // are shown but disabled — the guardian needs to go to the curb line
  // for those, which mirrors how the curb keypad treats walkers.
  const lookupCandidates = useMemo(() => {
    if (!hit?.primary) return [];
    return [hit.primary, ...hit.siblings];
  }, [hit]);
  const walkerCandidates = lookupCandidates.filter(
    (c) => c.dismissalMode === "walker",
  );
  const nonWalkerCandidates = lookupCandidates.filter(
    (c) => c.dismissalMode !== "walker",
  );
  const releasableWalkers = walkerCandidates.filter(
    (c) => !releasedTodayIds.has(c.studentDbId),
  );
  // Restricted-pickup gate: same rule as the curb keypad. If ANY walker
  // we're about to release is on a restricted authorization, we require
  // an admin user + a >=5-char justification (recorded in the audit row
  // server-side). Without this, a restricted guardian could just walk
  // up to the walker gate to bypass the curb-side prompt.
  const [overrideText, setOverrideText] = useState("");
  const hasRestricted = releasableWalkers.some((c) => c.restricted);
  const overrideOk =
    !hasRestricted ||
    (isAdmin(me) && overrideText.trim().length >= 5);

  const releaseFromLookup = async () => {
    if (releasableWalkers.length === 0) return;
    if (hasRestricted && !overrideOk) return;
    setBusy(true);
    setErrorMsg(null);
    setOkMsg(null);
    try {
      const released: string[] = [];
      const failures: string[] = [];
      for (const c of releasableWalkers) {
        const result = await release(c.studentDbId, {
          pickupAuthorizationId: c.authorizationId,
          overrideJustification: c.restricted ? overrideText : undefined,
        });
        const label = `${c.firstName} ${c.lastName.charAt(0)}.`;
        if (result.ok) released.push(label);
        else failures.push(`${label} (${result.error ?? "failed"})`);
      }
      await refresh();
      if (released.length > 0) {
        setOkMsg(
          `Released ${released.length} walker${released.length === 1 ? "" : "s"}: ${released.join(", ")}`,
        );
      }
      if (failures.length > 0) {
        setErrorMsg(`Could not release: ${failures.join("; ")}`);
      }
      if (failures.length === 0) {
        setPad("");
        setHit(null);
        setOverrideText("");
      }
    } finally {
      setBusy(false);
    }
  };

  const visible = rows.filter((r) => {
    if (!filter.trim()) return true;
    const f = filter.toLowerCase();
    return (
      r.firstName.toLowerCase().includes(f) ||
      r.lastName.toLowerCase().includes(f) ||
      r.studentId.toLowerCase().includes(f)
    );
  });

  return (
    <div style={pageStyle}>
      <Header title="Walker Gate" subtitle={me.displayName ?? "Staff"} />
      {!windowOpen && (
        <div style={warnBox}>
          Walker release is closed.
          {windowOpensAt && <> Opens at {windowOpensAt}.</>}
        </div>
      )}

      {/* Keypad lookup — fast path for guardians who know their pickup
          number. Mirrors the curb keypad layout so staff trained on
          one station can run the other without retraining. */}
      <div style={twoCol}>
        <div style={col}>
          <div style={padDisplay}>{pad || "—"}</div>
          <div style={keypadGrid}>
            {[
              "1",
              "2",
              "3",
              "4",
              "5",
              "6",
              "7",
              "8",
              "9",
              "CLR",
              "0",
              "DEL",
            ].map((k) => (
              <button
                key={k}
                onClick={() => tap(k)}
                style={k === "DEL" || k === "CLR" ? keyAlt : keyMain}
              >
                {k}
              </button>
            ))}
          </div>
          <button
            onClick={lookup}
            disabled={!pad || busy}
            style={primaryBtn}
          >
            {busy ? "Looking up…" : "Look up"}
          </button>
          {errorMsg && <div style={errBox}>{errorMsg}</div>}
          {okMsg && (
            <div
              style={{
                ...errBox,
                background: "#ecfdf5",
                color: "#065f46",
                border: "1px solid #86efac",
              }}
            >
              {okMsg}
            </div>
          )}
        </div>
        <div style={col}>
          {hit ? (
            <div>
              <div style={cardTitle}>
                #{hit.authorization.pickupNumber} ·{" "}
                {hit.authorization.guardianLabel}
              </div>
              {walkerCandidates.length === 0 && (
                <div style={{ ...errBox, marginTop: 0 }}>
                  No walkers on this authorization. Use the curb keypad
                  for car-rider siblings.
                </div>
              )}
              {walkerCandidates.map((c) => {
                const alreadyOut = releasedTodayIds.has(c.studentDbId);
                const borderColor = c.restricted
                  ? "#dc2626"
                  : alreadyOut
                    ? "#86efac"
                    : "#e5e7eb";
                const bg = c.restricted
                  ? "#fef2f2"
                  : alreadyOut
                    ? "#ecfdf5"
                    : "#fff";
                return (
                  <div
                    key={c.authorizationId}
                    style={{ ...studentCard, borderColor, background: bg }}
                  >
                    <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                      <StudentPhoto
                        firstName={c.firstName}
                        lastName={c.lastName}
                        photoObjectKey={c.photoObjectKey}
                        photoConsent={c.photoConsent}
                        size={48}
                      />
                      <div>
                        <div style={{ fontWeight: 600 }}>
                          {c.firstName} {c.lastName}
                        </div>
                        <div style={{ color: "#6b7280", fontSize: 13 }}>
                          Grade {c.grade} · ID {c.localSisId ?? "—"} · walker
                        </div>
                      </div>
                    </div>
                    {c.restricted && (
                      <div
                        style={{
                          color: "#dc2626",
                          marginTop: 6,
                          fontWeight: 600,
                        }}
                      >
                        RESTRICTED — guardian not authorized for this student
                      </div>
                    )}
                    {alreadyOut && (
                      <div
                        style={{
                          color: "#15803d",
                          marginTop: 6,
                          fontWeight: 600,
                          fontSize: 13,
                        }}
                      >
                        Already released today
                      </div>
                    )}
                  </div>
                );
              })}
              {hasRestricted && (
                <div style={overrideBox}>
                  <div style={{ fontWeight: 600, color: "#7f1d1d" }}>
                    Admin override required
                  </div>
                  <div style={{ fontSize: 13, marginTop: 4, color: "#7f1d1d" }}>
                    {isAdmin(me)
                      ? "Type a justification (5+ chars). This is recorded in the audit log."
                      : "Only an admin can release a restricted authorization. Get an admin to type their justification here."}
                  </div>
                  <textarea
                    value={overrideText}
                    onChange={(e) => setOverrideText(e.target.value)}
                    rows={2}
                    style={textareaStyle}
                    placeholder="e.g. front office confirmed parent identity by phone"
                    disabled={!isAdmin(me)}
                  />
                </div>
              )}
              {nonWalkerCandidates.length > 0 && (
                <div
                  style={{
                    marginTop: 8,
                    padding: 10,
                    background: "#fef3c7",
                    border: "1px solid #fde68a",
                    borderRadius: 8,
                    fontSize: 13,
                    color: "#78350f",
                  }}
                >
                  <strong>Not walkers (send to curb):</strong>{" "}
                  {nonWalkerCandidates
                    .map(
                      (c) =>
                        `${c.firstName} ${c.lastName.charAt(0)}. (${c.dismissalMode ?? "—"})`,
                    )
                    .join(", ")}
                </div>
              )}
              <button
                onClick={releaseFromLookup}
                disabled={
                  busy ||
                  !windowOpen ||
                  releasableWalkers.length === 0 ||
                  !overrideOk
                }
                style={{
                  ...primaryBtn,
                  marginTop: 12,
                  background: "#16a34a",
                }}
              >
                {releasableWalkers.length === 0
                  ? walkerCandidates.length > 0
                    ? "All walkers already released"
                    : "Nothing to release"
                  : hasRestricted
                    ? `Override + release ${releasableWalkers.length} walker${releasableWalkers.length === 1 ? "" : "s"}`
                    : `Release ${releasableWalkers.length} walker${releasableWalkers.length === 1 ? "" : "s"}`}
              </button>
            </div>
          ) : (
            <div style={{ color: "#6b7280" }}>
              Type a pickup number and tap Look up. The family's
              walker-mode siblings will be released together; car-rider
              siblings get sent to the curb line instead.
            </div>
          )}
        </div>
      </div>

      <h3 style={{ margin: "28px 0 8px" }}>Walker roster</h3>
      <input
        type="search"
        placeholder="Filter by name or ID…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        style={inputStyle}
      />
      <div style={{ marginTop: 12, color: "#6b7280", fontSize: 13 }}>
        {visible.length} walker{visible.length === 1 ? "" : "s"} ·{" "}
        {visible.filter((r) => r.released).length} released
      </div>
      <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
        {visible.map((r) => (
          <div
            key={r.studentDbId}
            style={{
              ...walkerRow,
              opacity: r.released ? 0.6 : 1,
            }}
          >
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <StudentPhoto
                firstName={r.firstName}
                lastName={r.lastName}
                photoObjectKey={r.photoObjectKey}
                photoConsent={r.photoConsent}
                size={48}
              />
              <div>
                <div style={{ fontWeight: 600, fontSize: 18 }}>
                  {r.firstName} {r.lastName}
                </div>
                <div style={{ color: "#6b7280", fontSize: 13 }}>
                  Grade {r.grade} · ID {r.localSisId ?? "—"}
                </div>
              {r.released && (
                <div style={{ color: "#15803d", fontSize: 13, marginTop: 4 }}>
                  Released{" "}
                  {new Date(r.released.releasedAt).toLocaleTimeString([], {
                    hour: "numeric",
                    minute: "2-digit",
                  })}{" "}
                  by {r.released.releasedBy}
                </div>
              )}
              {(() => {
                // Soft sibling flag — informational only, no hard block.
                // Shows OTHER walker siblings on this family and whether
                // they're already out the door, so gate staff can choose
                // to hold this kid until a younger sibling arrives.
                // Defensive default: if a stale client hits an older
                // server build (or vice versa during a deploy window)
                // siblingWalkers may be undefined — treat that as "no
                // sibling info" rather than crashing the gate UI.
                const sibs = r.siblingWalkers ?? [];
                if (sibs.length === 0) return null;
                const stillIn = sibs.filter((s) => !s.releasedToday);
                if (r.released) return null;
                if (stillIn.length === 0) {
                  return (
                    <div
                      style={{
                        color: "#15803d",
                        fontSize: 13,
                        marginTop: 4,
                        fontWeight: 600,
                      }}
                    >
                      ✓ All {r.siblingWalkers.length} walker sibling
                      {r.siblingWalkers.length === 1 ? "" : "s"} already out
                    </div>
                  );
                }
                return (
                  <div
                    style={{
                      color: "#b45309",
                      fontSize: 13,
                      marginTop: 4,
                      fontWeight: 600,
                    }}
                  >
                    👥 Sibling{stillIn.length === 1 ? "" : "s"} still on
                    campus:{" "}
                    {stillIn
                      .map(
                        (s) =>
                          `${s.firstName} ${s.lastName.charAt(0)}. (G${s.grade})`,
                      )
                      .join(", ")}
                  </div>
                );
              })()}
              </div>
            </div>
            <button
              onClick={async () => {
                const result = await release(r.studentDbId);
                if (result.ok) await refresh();
                else alert(result.error ?? "Release failed");
              }}
              disabled={Boolean(r.released) || !windowOpen}
              style={{
                ...primaryBtn,
                width: 160,
                background: r.released ? "#9ca3af" : "#16a34a",
              }}
            >
              {r.released ? "Released" : "Release"}
            </button>
          </div>
        ))}
        {visible.length === 0 && (
          <div style={{ color: "#6b7280", padding: 24, textAlign: "center" }}>
            No walkers match your filter.
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AUTHORIZATIONS ADMIN
// Small back-office page so an admin can issue numbers and flip
// dismissal_mode without dropping into SQL.
// ---------------------------------------------------------------------------
type AuthRow = {
  id: number;
  studentId: number;
  parentId: number | null;
  guardianLabel: string;
  pickupNumber: string;
  restrictedFrom: boolean;
  active: boolean;
  parentDisplayName: string | null;
};

function AuthorizationsAdminPage() {
  const [studentDbIdInput, setStudentDbIdInput] = useState("");
  const [studentDbId, setStudentDbId] = useState<number | null>(null);
  const [auths, setAuths] = useState<AuthRow[]>([]);
  const [guardianLabel, setGuardianLabel] = useState("");
  const [parentIdInput, setParentIdInput] = useState("");
  const [restricted, setRestricted] = useState(false);
  const [pickupNumberInput, setPickupNumberInput] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [dismissalMode, setDismissalMode] = useState("car_rider");

  const refresh = useCallback(async (sid: number) => {
    const res = await authFetch(
      `/api/pickup/authorizations?studentDbId=${sid}`,
    );
    if (!res.ok) return;
    const data = (await res.json()) as { authorizations: AuthRow[] };
    setAuths(data.authorizations);
  }, []);

  const loadStudent = async () => {
    const n = Number(studentDbIdInput);
    if (!Number.isInteger(n) || n <= 0) {
      setMsg("Enter a numeric student database id");
      return;
    }
    setStudentDbId(n);
    setMsg(null);
    await refresh(n);
  };

  const create = async () => {
    if (!studentDbId) return;
    setMsg(null);
    const body: Record<string, unknown> = {
      studentDbId,
      guardianLabel,
      restrictedFrom: restricted,
    };
    const pid = parentIdInput.trim();
    if (pid) body.parentId = Number(pid);
    if (pickupNumberInput.trim()) body.pickupNumber = pickupNumberInput.trim();
    const res = await authFetch("/api/pickup/authorizations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { error?: string };
    if (!res.ok) {
      setMsg(data.error ?? `Create failed (${res.status})`);
      return;
    }
    setGuardianLabel("");
    setParentIdInput("");
    setPickupNumberInput("");
    setRestricted(false);
    await refresh(studentDbId);
  };

  const toggle = async (id: number, patch: Partial<AuthRow>) => {
    if (!studentDbId) return;
    const res = await authFetch(`/api/pickup/authorizations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setMsg(data.error ?? `Update failed (${res.status})`);
      return;
    }
    await refresh(studentDbId);
  };

  const setMode = async () => {
    if (!studentDbId) return;
    const res = await authFetch(
      `/api/pickup/students/${studentDbId}/dismissal-mode`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dismissalMode }),
      },
    );
    const data = (await res.json()) as { error?: string };
    setMsg(res.ok ? "Dismissal mode updated" : (data.error ?? "Failed"));
  };

  // Stream a tag PDF response to the browser as a download. Uses
  // authFetch so the school-scoped session cookie rides along —
  // window.open() would skip it inside the Replit iframe and 401.
  const downloadPdf = async (url: string, filename: string) => {
    setMsg(null);
    try {
      const res = await authFetch(url);
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setMsg(b.error ?? `PDF failed (${res.status})`);
        return;
      }
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const printOne = (a: AuthRow) =>
    downloadPdf(
      `/api/pickup/authorizations/${a.id}/tag.pdf`,
      `pickup-tag-${a.pickupNumber}.pdf`,
    );

  const printActiveForStudent = () => {
    const ids = auths.filter((a) => a.active).map((a) => a.id);
    if (ids.length === 0) {
      setMsg("No active authorizations to print for this student.");
      return;
    }
    return downloadPdf(
      `/api/pickup/tags.pdf?ids=${ids.join(",")}`,
      `pickup-tags-student-${studentDbId}.pdf`,
    );
  };

  const printAllActive = () =>
    downloadPdf(
      `/api/pickup/tags.pdf`,
      `pickup-tags-all-${new Date().toISOString().slice(0, 10)}.pdf`,
    );

  return (
    <div style={pageStyle}>
      <Header title="Pickup Numbers — Admin" subtitle="" />
      <div style={{ display: "flex", gap: 8, alignItems: "end" }}>
        <label style={labelStyle}>
          Student DB id
          <input
            value={studentDbIdInput}
            onChange={(e) => setStudentDbIdInput(e.target.value)}
            style={inputStyle}
            placeholder="e.g. 12345"
          />
        </label>
        <button onClick={loadStudent} style={primaryBtn}>
          Load
        </button>
        <button
          onClick={printAllActive}
          style={secondaryBtn}
          title="Print one PDF containing every active pickup tag at this school."
        >
          Print all active tags (school-wide)
        </button>
      </div>
      {msg && <div style={infoBox}>{msg}</div>}

      {studentDbId && (
        <>
          <h3 style={{ marginTop: 24 }}>Dismissal mode</h3>
          <div style={{ display: "flex", gap: 8 }}>
            <select
              value={dismissalMode}
              onChange={(e) => setDismissalMode(e.target.value)}
              style={inputStyle}
            >
              <option value="car_rider">car_rider</option>
              <option value="walker">walker</option>
              <option value="bus">bus</option>
              <option value="aftercare">aftercare</option>
              <option value="parent_pickup_only">parent_pickup_only</option>
            </select>
            <button onClick={setMode} style={secondaryBtn}>
              Set
            </button>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginTop: 24,
            }}
          >
            <h3 style={{ margin: 0 }}>Active authorizations</h3>
            <button
              onClick={printActiveForStudent}
              style={secondaryBtn}
              title="Print all active tags for this student in one PDF."
            >
              Print all for this student
            </button>
          </div>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>#</th>
                <th style={th}>Guardian</th>
                <th style={th}>Parent</th>
                <th style={th}>Restricted</th>
                <th style={th}>Active</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {auths.map((a) => (
                <tr key={a.id}>
                  <td style={td}>{a.pickupNumber}</td>
                  <td style={td}>{a.guardianLabel}</td>
                  <td style={td}>{a.parentDisplayName ?? a.parentId ?? "—"}</td>
                  <td style={td}>{a.restrictedFrom ? "yes" : "no"}</td>
                  <td style={td}>{a.active ? "yes" : "no"}</td>
                  <td style={td}>
                    <button
                      onClick={() =>
                        toggle(a.id, { restrictedFrom: !a.restrictedFrom })
                      }
                      style={smallBtn}
                    >
                      {a.restrictedFrom ? "Un-restrict" : "Restrict"}
                    </button>
                    <button
                      onClick={() => toggle(a.id, { active: !a.active })}
                      style={{ ...smallBtn, marginLeft: 6 }}
                    >
                      {a.active ? "Deactivate" : "Reactivate"}
                    </button>
                    <button
                      onClick={() => printOne(a)}
                      style={{ ...smallBtn, marginLeft: 6 }}
                      title="Download a single-tag PDF (reprint)."
                    >
                      Print tag
                    </button>
                  </td>
                </tr>
              ))}
              {auths.length === 0 && (
                <tr>
                  <td style={td} colSpan={6}>
                    No authorizations yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          <h3 style={{ marginTop: 24 }}>Issue a new number</h3>
          <div style={{ display: "grid", gap: 8, maxWidth: 480 }}>
            <label style={labelStyle}>
              Guardian label (e.g. "Mom", "Aunt Sarah")
              <input
                value={guardianLabel}
                onChange={(e) => setGuardianLabel(e.target.value)}
                style={inputStyle}
              />
            </label>
            <label style={labelStyle}>
              Parent portal id (optional, enables sibling lookup)
              <input
                value={parentIdInput}
                onChange={(e) => setParentIdInput(e.target.value)}
                style={inputStyle}
                placeholder="leave blank if no portal account"
              />
            </label>
            <label style={labelStyle}>
              Pickup number (optional — auto-issued if blank)
              <input
                value={pickupNumberInput}
                onChange={(e) => setPickupNumberInput(e.target.value)}
                style={inputStyle}
                placeholder="e.g. 1042"
              />
            </label>
            <label
              style={{ ...labelStyle, flexDirection: "row", alignItems: "center", gap: 8 }}
            >
              <input
                type="checkbox"
                checked={restricted}
                onChange={(e) => setRestricted(e.target.checked)}
              />
              Mark as RESTRICTED (no-contact / court order)
            </label>
            <button
              onClick={create}
              disabled={!guardianLabel.trim()}
              style={primaryBtn}
            >
              Issue number
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared UI helpers (inline-styled to keep this file self-contained — the
// pickup pages are rarely opened next to other staff-app pages so they
// don't need to share the global stylesheet).
// ---------------------------------------------------------------------------
function Header({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        marginBottom: 16,
      }}
    >
      <h1 style={{ margin: 0, fontSize: 24 }}>{title}</h1>
      <div style={{ color: "#6b7280", fontSize: 13 }}>{subtitle}</div>
    </div>
  );
}

function FullPageMsg({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        ...pageStyle,
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        textAlign: "center",
      }}
    >
      <div style={{ maxWidth: 420 }}>{children}</div>
    </div>
  );
}

function NoAccess({ role }: { role: string }) {
  return (
    <FullPageMsg>
      <strong>Access denied.</strong>
      <br />
      You do not have the {role} role for this school.
    </FullPageMsg>
  );
}

const pageStyle: React.CSSProperties = {
  fontFamily: "system-ui, -apple-system, sans-serif",
  padding: 16,
  maxWidth: 1100,
  margin: "0 auto",
  color: "#111827",
};
const twoCol: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(260px, 360px) 1fr",
  gap: 24,
};
const col: React.CSSProperties = { minWidth: 0 };
const padDisplay: React.CSSProperties = {
  fontFamily: "ui-monospace, monospace",
  fontSize: 56,
  textAlign: "center",
  padding: "16px 0",
  background: "#f3f4f6",
  borderRadius: 12,
  marginBottom: 16,
  letterSpacing: "0.1em",
};
const keypadGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(3, 1fr)",
  gap: 8,
};
const keyMain: React.CSSProperties = {
  fontSize: 28,
  padding: "20px 0",
  borderRadius: 10,
  border: "1px solid #d1d5db",
  background: "#fff",
  cursor: "pointer",
};
const keyAlt: React.CSSProperties = {
  ...keyMain,
  fontSize: 16,
  background: "#f9fafb",
};
const letterRow: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(8, 1fr)",
  gap: 6,
  marginTop: 8,
};
const keyLetter: React.CSSProperties = {
  fontSize: 18,
  padding: "12px 0",
  borderRadius: 8,
  border: "1px solid #d1d5db",
  background: "#f9fafb",
  cursor: "pointer",
};
const primaryBtn: React.CSSProperties = {
  width: "100%",
  marginTop: 12,
  padding: "14px 18px",
  background: "#2563eb",
  color: "#fff",
  border: "none",
  borderRadius: 10,
  fontSize: 18,
  fontWeight: 600,
  cursor: "pointer",
};
const secondaryBtn: React.CSSProperties = {
  ...primaryBtn,
  background: "#fff",
  color: "#2563eb",
  border: "1px solid #2563eb",
};
const smallBtn: React.CSSProperties = {
  padding: "6px 10px",
  background: "#fff",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 13,
};
const cardTitle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  marginBottom: 8,
};
const studentCard: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  padding: 12,
  marginBottom: 8,
};
const overrideBox: React.CSSProperties = {
  marginTop: 12,
  padding: 12,
  background: "#fef2f2",
  border: "1px solid #fecaca",
  borderRadius: 8,
};
const textareaStyle: React.CSSProperties = {
  width: "100%",
  marginTop: 6,
  padding: 8,
  borderRadius: 6,
  border: "1px solid #fca5a5",
  fontSize: 14,
  fontFamily: "inherit",
};
const inputStyle: React.CSSProperties = {
  padding: "8px 10px",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  fontSize: 14,
  width: "100%",
};
const labelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 13,
  color: "#374151",
};
const errBox: React.CSSProperties = {
  marginTop: 12,
  padding: 10,
  background: "#fef2f2",
  border: "1px solid #fecaca",
  color: "#991b1b",
  borderRadius: 6,
  fontSize: 14,
};
const warnBox: React.CSSProperties = {
  marginBottom: 12,
  padding: 10,
  background: "#fffbeb",
  border: "1px solid #fde68a",
  color: "#92400e",
  borderRadius: 6,
};
const infoBox: React.CSSProperties = {
  marginTop: 12,
  padding: 8,
  background: "#eff6ff",
  border: "1px solid #bfdbfe",
  borderRadius: 6,
  fontSize: 13,
};
const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 14,
};
const th: React.CSSProperties = {
  textAlign: "left",
  borderBottom: "2px solid #e5e7eb",
  padding: "8px 6px",
  fontSize: 12,
  textTransform: "uppercase",
  color: "#6b7280",
};
const td: React.CSSProperties = {
  borderBottom: "1px solid #f3f4f6",
  padding: "8px 6px",
};
const chipBlue: React.CSSProperties = {
  background: "#dbeafe",
  color: "#1e40af",
  padding: "2px 8px",
  borderRadius: 12,
  fontSize: 12,
};
const chipGreen: React.CSSProperties = {
  background: "#dcfce7",
  color: "#166534",
  padding: "2px 8px",
  borderRadius: 12,
  fontSize: 12,
};
const walkerRow: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: 16,
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  background: "#fff",
};
// ---------------------------------------------------------------------------
// TEACHER QUEUE — /pickup/teacher
//
// Any signed-in staff. Lists today's car-rider queue (newest at the
// bottom so a teacher who just glanced away spots the new arrival
// without scrolling). The server controls scope:
//   all_students → entire school queue, isOnMyRoster annotates each row.
//   own_roster   → only the caller's own roster (server-filtered).
//
// Mis-click protection:
//   - Confirm modal on Release.
//   - 10s undo toast after release. Undo writes a release_undone audit
//     row, which the queue derivation flips back to in_queue without
//     touching the original addedAt position.
// ---------------------------------------------------------------------------
type TeacherQueueEntry = {
  studentDbId: number;
  firstName: string;
  lastName: string;
  grade: number | null;
  addedAt: string;
  status: "in_queue" | "walking_out";
  isOnMyRoster: boolean;
};

function TeacherQueuePage({ me }: { me: Me }) {
  const [entries, setEntries] = useState<TeacherQueueEntry[]>([]);
  const [viewScope, setViewScope] = useState<"all_students" | "own_roster">(
    "all_students",
  );
  const [showMineOnly, setShowMineOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [confirmRelease, setConfirmRelease] =
    useState<TeacherQueueEntry | null>(null);
  const [undoFor, setUndoFor] = useState<{
    entry: TeacherQueueEntry;
    expiresAt: number;
  } | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [err, setErr] = useState<string | null>(null);

  // ---- Sound chime on new arrivals ---------------------------------------
  // Default OFF — schools with 30 cars/min would have chimes overlapping
  // nonstop (per replit.md design call). Persisted in localStorage so a
  // teacher who turned it on once doesn't have to re-enable on every page
  // load. First user click also primes the AudioContext: browsers block
  // playback until a user gesture, so we lazily create+resume on toggle.
  const [soundOn, setSoundOn] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem("pickup_teacher_sound") === "1";
    } catch {
      return false;
    }
  });
  const audioCtxRef = useRef<AudioContext | null>(null);
  const prevIdsRef = useRef<Set<number> | null>(null);

  const ensureAudio = useCallback(() => {
    if (audioCtxRef.current) return audioCtxRef.current;
    type AudioCtor = typeof AudioContext;
    const Ctor: AudioCtor | undefined =
      typeof window !== "undefined"
        ? window.AudioContext ??
          (window as unknown as { webkitAudioContext?: AudioCtor })
            .webkitAudioContext
        : undefined;
    if (!Ctor) return null;
    try {
      audioCtxRef.current = new Ctor();
      return audioCtxRef.current;
    } catch {
      return null;
    }
  }, []);

  // Two short 880Hz tones — 200ms each, 100ms gap. Synthesized so we
  // don't need to ship an audio asset.
  const beepBeep = useCallback(() => {
    const ctx = ensureAudio();
    if (!ctx) return;
    if (ctx.state === "suspended") void ctx.resume();
    const playTone = (offsetMs: number) => {
      const startSec = ctx.currentTime + offsetMs / 1000;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 880;
      // Quick attack/release so tones don't click. Volume capped at 0.18
      // — audible in a noisy classroom hallway but not piercing.
      gain.gain.setValueAtTime(0.0001, startSec);
      gain.gain.exponentialRampToValueAtTime(0.18, startSec + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, startSec + 0.2);
      osc.connect(gain).connect(ctx.destination);
      osc.start(startSec);
      osc.stop(startSec + 0.22);
    };
    playTone(0);
    playTone(300);
  }, [ensureAudio]);

  const toggleSound = useCallback(() => {
    setSoundOn((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem("pickup_teacher_sound", next ? "1" : "0");
      } catch {
        /* localStorage unavailable — ephemeral toggle is fine */
      }
      // Prime the AudioContext on the *enable* click so a future
      // beep (triggered by a poll, not a click) is allowed to play.
      if (next) {
        const ctx = ensureAudio();
        if (ctx?.state === "suspended") void ctx.resume();
      }
      return next;
    });
  }, [ensureAudio]);

  const reload = useCallback(async () => {
    const r = await authFetch("/api/pickup/teacher-queue");
    if (!r.ok) {
      setErr(await r.text());
      setLoading(false);
      return;
    }
    const j = (await r.json()) as {
      viewScope: "all_students" | "own_roster";
      entries: TeacherQueueEntry[];
    };
    setViewScope(j.viewScope);
    setEntries(j.entries ?? []);
    setLoading(false);

    // Diff against the previous set of student ids — beep if any
    // brand-new id appeared. Skip the very first reload (prevIds is
    // null) so a page refresh while students are already in line
    // doesn't fire a misleading chime.
    const nextIds = new Set((j.entries ?? []).map((e) => e.studentDbId));
    const prev = prevIdsRef.current;
    if (prev !== null) {
      let hasNew = false;
      for (const id of nextIds) {
        if (!prev.has(id)) {
          hasNew = true;
          break;
        }
      }
      if (hasNew && soundOn) beepBeep();
    }
    prevIdsRef.current = nextIds;
  }, [soundOn, beepBeep]);

  useEffect(() => {
    void reload();
    // Light polling — the queue changes on the order of seconds and
    // there's no websocket on this artifact yet. 4s matches the curb
    // and walker pages.
    const id = window.setInterval(() => void reload(), 4000);
    return () => window.clearInterval(id);
  }, [reload]);

  // Drives the undo toast countdown.
  useEffect(() => {
    if (!undoFor) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [undoFor]);

  // Auto-dismiss the undo toast once its window expires.
  useEffect(() => {
    if (undoFor && now >= undoFor.expiresAt) {
      setUndoFor(null);
    }
  }, [now, undoFor]);

  const visibleEntries = useMemo(() => {
    const base =
      showMineOnly && viewScope === "all_students"
        ? entries.filter((e) => e.isOnMyRoster)
        : entries;
    // Newest arrivals first: sort a copy descending by arrival time so the
    // most-recently-added car sits at the top of the teacher's list.
    return [...base].sort(
      (a, b) =>
        new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime(),
    );
  }, [entries, showMineOnly, viewScope]);

  // Pull a human-readable message out of an error response. The API
  // returns `{ error: "..." }`; never show the user the raw JSON blob.
  const readError = async (r: Response, fallback: string) => {
    try {
      const data = await r.clone().json();
      if (data && typeof data.error === "string") return data.error;
    } catch {
      // not JSON — fall through
    }
    return fallback;
  };

  const release = async (entry: TeacherQueueEntry) => {
    setErr(null);
    setConfirmRelease(null);
    const r = await authFetch("/api/pickup/queue/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        studentDbId: entry.studentDbId,
        action: "released_to_walk",
      }),
    });
    if (!r.ok) {
      setErr(await readError(r, "Couldn't release this student. Please try again."));
      return;
    }
    setUndoFor({ entry, expiresAt: Date.now() + 10_000 });
    void reload();
  };

  const undo = async () => {
    if (!undoFor || undoing) return;
    setUndoing(true);
    setErr(null);
    try {
      const r = await authFetch("/api/pickup/queue/release-undo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentDbId: undoFor.entry.studentDbId }),
      });
      // The undo is idempotent server-side, so a 2xx (including
      // "already undone") simply clears the toast. Only a genuine
      // conflict — the student was already picked up — surfaces a message.
      if (!r.ok) {
        setErr(await readError(r, "Couldn't undo the release."));
        setUndoFor(null);
        void reload();
        return;
      }
      setUndoFor(null);
      void reload();
    } finally {
      setUndoing(false);
    }
  };

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "24px 16px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 12,
        }}
      >
        <h1 style={{ margin: 0, fontSize: 24 }}>Pick-Up — teacher view</h1>
        <div style={{ fontSize: 13, color: "#6b7280" }}>
          Signed in as {me.displayName ?? "Staff"}
        </div>
      </div>
      <p style={{ color: "#6b7280", marginTop: 0, fontSize: 13 }}>
        Newest arrivals at the top. A blue left border means the student
        is on your class roster. Press Release when the student walks out;
        you have 10 seconds to undo.
      </p>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 12,
        }}
      >
        <span style={{ fontSize: 12, color: "#6b7280" }}>
          {viewScope === "own_roster"
            ? "School policy: only the student's own teacher can release."
            : "School policy: any teacher can release any student."}
        </span>
        {viewScope === "all_students" && (
          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 13,
            }}
          >
            <input
              type="checkbox"
              checked={showMineOnly}
              onChange={(e) => setShowMineOnly(e.target.checked)}
            />
            Show only my roster
          </label>
        )}
        <button
          type="button"
          onClick={toggleSound}
          aria-pressed={soundOn}
          title={
            soundOn
              ? "New-arrival chime is on. Click to silence."
              : "Click to play a chime when a new student joins the line."
          }
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 10px",
            fontSize: 12,
            fontWeight: 600,
            border: "1px solid",
            borderColor: soundOn ? "#16a34a" : "#d1d5db",
            background: soundOn ? "#dcfce7" : "white",
            color: soundOn ? "#15803d" : "#374151",
            borderRadius: 999,
            cursor: "pointer",
          }}
        >
          {soundOn ? "🔔 Sound on" : "🔕 Sound off"}
        </button>
      </div>

      {err && <div style={errBox}>{err}</div>}
      {loading ? (
        <div style={{ color: "#6b7280" }}>Loading queue…</div>
      ) : visibleEntries.length === 0 ? (
        <div
          style={{
            ...infoBox,
            marginTop: 0,
            padding: "16px 12px",
            textAlign: "center",
          }}
        >
          No students currently in the pick-up line.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {visibleEntries.map((entry) => {
            const walking = entry.status === "walking_out";
            const mine = entry.isOnMyRoster;
            return (
              <div
                key={entry.studentDbId}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "12px 14px",
                  background: walking ? "#f0fdf4" : "white",
                  border: "1px solid #e5e7eb",
                  borderLeft: mine
                    ? "4px solid #2563eb"
                    : "1px solid #e5e7eb",
                  borderRadius: 8,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 16 }}>
                    {entry.firstName} {entry.lastName}
                    {mine && (
                      <span
                        style={{
                          marginLeft: 8,
                          fontSize: 11,
                          fontWeight: 600,
                          color: "#1e40af",
                          background: "#dbeafe",
                          padding: "2px 6px",
                          borderRadius: 8,
                        }}
                      >
                        MY ROSTER
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: "#6b7280" }}>
                    {entry.grade !== null ? `Grade ${entry.grade} · ` : ""}
                    Added{" "}
                    {new Date(entry.addedAt).toLocaleTimeString([], {
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </div>
                </div>
                {walking ? (
                  <span style={chipGreen}>Walking out</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmRelease(entry)}
                    style={{
                      padding: "8px 14px",
                      borderRadius: 8,
                      border: "1px solid #2563eb",
                      background: "#2563eb",
                      color: "white",
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    Release
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {confirmRelease && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 50,
          }}
          onClick={() => setConfirmRelease(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "white",
              borderRadius: 12,
              padding: 20,
              maxWidth: 360,
              width: "90%",
              boxShadow: "0 20px 40px rgba(0,0,0,0.2)",
            }}
          >
            <h2 style={{ marginTop: 0, fontSize: 18 }}>Release student?</h2>
            <p style={{ fontSize: 14, color: "#374151" }}>
              {confirmRelease.firstName} {confirmRelease.lastName} will be
              marked as walking out to the curb. You'll have 10 seconds to
              undo.
            </p>
            <div
              style={{
                display: "flex",
                gap: 8,
                justifyContent: "flex-end",
                marginTop: 12,
              }}
            >
              <button
                type="button"
                onClick={() => setConfirmRelease(null)}
                style={{
                  padding: "8px 14px",
                  borderRadius: 8,
                  border: "1px solid #d1d5db",
                  background: "white",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void release(confirmRelease)}
                style={{
                  padding: "8px 14px",
                  borderRadius: 8,
                  border: "1px solid #2563eb",
                  background: "#2563eb",
                  color: "white",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Release
              </button>
            </div>
          </div>
        </div>
      )}

      {undoFor && (
        <div
          style={{
            position: "fixed",
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            background: "#111827",
            color: "white",
            padding: "10px 16px",
            borderRadius: 999,
            display: "flex",
            alignItems: "center",
            gap: 12,
            boxShadow: "0 10px 30px rgba(0,0,0,0.3)",
            zIndex: 60,
          }}
        >
          <span style={{ fontSize: 14 }}>
            Released {undoFor.entry.firstName} {undoFor.entry.lastName} ·{" "}
            {Math.max(0, Math.ceil((undoFor.expiresAt - now) / 1000))}s
          </span>
          <button
            type="button"
            onClick={() => void undo()}
            disabled={undoing}
            style={{
              padding: "4px 12px",
              borderRadius: 999,
              border: "1px solid #f59e0b",
              background: "#f59e0b",
              color: "#111827",
              fontWeight: 700,
              cursor: undoing ? "default" : "pointer",
              opacity: undoing ? 0.6 : 1,
            }}
          >
            {undoing ? "Undoing…" : "Undo"}
          </button>
        </div>
      )}
    </div>
  );
}

const linkStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "10px 16px",
  background: "#2563eb",
  color: "#fff",
  borderRadius: 8,
  textDecoration: "none",
};
const tileLinkStyle: React.CSSProperties = {
  display: "block",
  padding: "16px 20px",
  background: "#fff",
  border: "1px solid #e5e7eb",
  borderRadius: 10,
  color: "#111827",
  textDecoration: "none",
  fontWeight: 600,
  fontSize: 16,
};
