import { useEffect, useMemo, useState, useCallback } from "react";
import { authFetch } from "../lib/authToken";

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
  capCarRiderMonitor: boolean;
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
          capCarRiderMonitor: Boolean(s.capCarRiderMonitor),
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
    if (!isAdmin(me)) return <NoAccess role="admin" />;
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
    firstName: string;
    lastName: string;
    grade: number;
    dismissalMode: string;
    restricted: boolean;
  } | null;
  siblings: Array<{
    authorizationId: number;
    studentDbId: number;
    studentId: string;
    firstName: string;
    lastName: string;
    grade: number;
    dismissalMode?: string;
    restricted: boolean;
  }>;
};

type QueueEntry = {
  position: number;
  studentId: string;
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

  const hasRestricted = allCandidates.some((c) => c.restricted);

  const addToLine = async () => {
    if (!hit || allCandidates.length === 0) return;
    const ids = allCandidates.map((c) => c.authorizationId);
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
              {allCandidates.map((c) => (
                <div
                  key={c.authorizationId}
                  style={{
                    ...studentCard,
                    borderColor: c.restricted ? "#dc2626" : "#e5e7eb",
                    background: c.restricted ? "#fef2f2" : "#fff",
                  }}
                >
                  <div style={{ fontWeight: 600 }}>
                    {c.firstName} {c.lastName}
                  </div>
                  <div style={{ color: "#6b7280", fontSize: 13 }}>
                    Grade {c.grade} · ID {c.studentId}
                  </div>
                  {c.restricted && (
                    <div style={{ color: "#dc2626", marginTop: 6, fontWeight: 600 }}>
                      RESTRICTED — guardian not authorized for this student
                    </div>
                  )}
                </div>
              ))}
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
                  (hasRestricted && overrideText.trim().length < 5) ||
                  (hasRestricted && !isAdmin(me))
                }
                style={{ ...primaryBtn, marginTop: 12 }}
              >
                {hasRestricted ? "Override + add to line" : "Add to line"}
              </button>
            </div>
          ) : (
            <div style={{ color: "#6b7280" }}>
              Type a pickup number and tap Look up. The car's authorized
              siblings will be added together.
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
              {queue.map((q) => (
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
  firstName: string;
  lastName: string;
  grade: number;
  released: { releasedAt: string; releasedBy: string } | null;
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
                    <div style={{ fontWeight: 600 }}>
                      {c.firstName} {c.lastName}
                    </div>
                    <div style={{ color: "#6b7280", fontSize: 13 }}>
                      Grade {c.grade} · ID {c.studentId} · walker
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
            <div>
              <div style={{ fontWeight: 600, fontSize: 18 }}>
                {r.firstName} {r.lastName}
              </div>
              <div style={{ color: "#6b7280", fontSize: 13 }}>
                Grade {r.grade} · ID {r.studentId}
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

          <h3 style={{ marginTop: 24 }}>Active authorizations</h3>
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
  const [now, setNow] = useState(Date.now());
  const [err, setErr] = useState<string | null>(null);

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
  }, []);

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
    if (showMineOnly && viewScope === "all_students") {
      return entries.filter((e) => e.isOnMyRoster);
    }
    return entries;
  }, [entries, showMineOnly, viewScope]);

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
      setErr(await r.text());
      return;
    }
    setUndoFor({ entry, expiresAt: Date.now() + 10_000 });
    void reload();
  };

  const undo = async () => {
    if (!undoFor) return;
    setErr(null);
    const r = await authFetch("/api/pickup/queue/release-undo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ studentDbId: undoFor.entry.studentDbId }),
    });
    if (!r.ok) {
      setErr(await r.text());
      return;
    }
    setUndoFor(null);
    void reload();
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
        Newest arrivals at the bottom. A blue left border means the student
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
            style={{
              padding: "4px 12px",
              borderRadius: 999,
              border: "1px solid #f59e0b",
              background: "#f59e0b",
              color: "#111827",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Undo
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
