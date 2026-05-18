import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { authFetch } from "../lib/authToken";
import {
  HowToUseHelp,
  HowToSection,
  RoleSection,
  howtoListStyle,
} from "./HowToUseHelp";

// =============================================================================
// PickupSettingsPage — Settings → Pick-Up
//
// Two saveable knobs and a one-stop shop for the kiosk URLs the school
// needs to bookmark on each station:
//   - pickupCutoffTime: HH:MM after which the Admin Hub "Still on
//     campus" tile becomes visible.
//   - pickupTeacherViewScope: 'all_students' (any teacher can release
//     any student) vs 'own_roster' (only the student's own teacher,
//     verified server-side via section_roster).
//
// The URL list is read-only — copy buttons make it trivial to paste
// into a station's bookmark bar without typo'ing the path. The TV
// URLs are pulled from /api/displays/playlists so a school with three
// hallway TVs sees all three signage links in one place.
// =============================================================================

interface SettingsResp {
  pickupCutoffTime?: string | null;
  pickupTeacherViewScope?: "all_students" | "own_roster" | null;
  pickupInCarStepEnabled?: boolean | null;
  pickupWalkedOutDisplaySeconds?: number | null;
}

// /api/auth/me spreads the staff fields at the TOP level (see
// publicStaff() in routes/auth.ts). There is no `.staff` wrapper —
// reading me.staff.* would silently coerce every flag to false and
// paint every badge amber even for SuperUsers.
interface MeResp {
  isAdmin?: boolean;
  isSuperUser?: boolean;
  isDistrictAdmin?: boolean;
  capCarRiderMonitor?: boolean;
}

interface PlaylistRow {
  id: number;
  name: string;
}

const card: CSSProperties = {
  padding: "1rem 1.1rem",
  border: "1px solid var(--border, #e5e7eb)",
  borderRadius: 10,
  background: "var(--surface, #fff)",
  marginBottom: "1rem",
};

const label: CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--text-subtle)",
  marginBottom: 4,
  textTransform: "uppercase",
  letterSpacing: 0.5,
};

const inputStyle: CSSProperties = {
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid var(--border, #d1d5db)",
  fontSize: 14,
  minWidth: 140,
};

const urlRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 10px",
  borderRadius: 8,
  background: "var(--surface-soft, #f9fafb)",
  border: "1px solid var(--border, #e5e7eb)",
  marginBottom: 6,
  fontSize: 13,
};

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard API blocked (e.g. insecure context). Fallback:
          // select the text manually so the user can ctrl-c.
          // Intentionally silent — the visible URL is enough.
        }
      }}
      style={{
        padding: "4px 10px",
        borderRadius: 6,
        border: "1px solid var(--border, #d1d5db)",
        background: copied ? "#d1fae5" : "white",
        cursor: "pointer",
        fontSize: 12,
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function RoleBadge({ canOpen, label }: { canOpen: boolean; label: string }) {
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        padding: "2px 8px",
        borderRadius: 999,
        background: canOpen ? "#d1fae5" : "#fef3c7",
        color: canOpen ? "#065f46" : "#92400e",
        whiteSpace: "nowrap",
      }}
      title={
        canOpen
          ? "Your account can open this URL."
          : `This URL needs the ${label} role. It still works on a station that's signed in with that role — bookmark it there.`
      }
    >
      {canOpen ? "✓ You can open" : `🔒 ${label} only`}
    </span>
  );
}

function UrlListItem({
  title,
  path,
  canOpen,
  requiredLabel,
}: {
  title: string;
  path: string;
  canOpen: boolean;
  requiredLabel: string;
}) {
  const url = `${window.location.origin}${path}`;
  return (
    <div style={urlRow}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 2,
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontWeight: 600 }}>{title}</span>
          <RoleBadge canOpen={canOpen} label={requiredLabel} />
        </div>
        <div
          style={{
            color: "var(--text-subtle)",
            fontFamily: "monospace",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={url}
        >
          {url}
        </div>
      </div>
      <a
        href={path}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          padding: "4px 10px",
          borderRadius: 6,
          border: "1px solid var(--border, #d1d5db)",
          background: "white",
          fontSize: 12,
          fontWeight: 600,
          textDecoration: "none",
          color: "inherit",
        }}
      >
        Open
      </a>
      <CopyButton value={url} />
    </div>
  );
}

export default function PickupSettingsPage() {
  const [cutoff, setCutoff] = useState<string>("15:30");
  const [scope, setScope] = useState<"all_students" | "own_roster">(
    "all_students",
  );
  const [inCarStep, setInCarStep] = useState<boolean>(true);
  const [walkedOutSecs, setWalkedOutSecs] = useState<number>(300);
  const [playlists, setPlaylists] = useState<PlaylistRow[]>([]);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [canCurb, setCanCurb] = useState(false);
  const [canAdmin, setCanAdmin] = useState(false);

  useEffect(() => {
    void (async () => {
      const [s, p, m] = await Promise.all([
        authFetch("/api/school-settings"),
        authFetch("/api/displays/playlists"),
        authFetch("/api/auth/me"),
      ]);
      if (m.ok) {
        const me = (await m.json()) as MeResp;
        const isAdmin = Boolean(
          me.isAdmin || me.isSuperUser || me.isDistrictAdmin,
        );
        setCanAdmin(isAdmin);
        setCanCurb(isAdmin || Boolean(me.capCarRiderMonitor));
      }
      if (s.ok) {
        const d = (await s.json()) as SettingsResp;
        if (
          typeof d.pickupCutoffTime === "string" &&
          /^([01]\d|2[0-3]):[0-5]\d$/.test(d.pickupCutoffTime)
        ) {
          setCutoff(d.pickupCutoffTime);
        }
        if (
          d.pickupTeacherViewScope === "own_roster" ||
          d.pickupTeacherViewScope === "all_students"
        ) {
          setScope(d.pickupTeacherViewScope);
        }
        if (typeof d.pickupInCarStepEnabled === "boolean") {
          setInCarStep(d.pickupInCarStepEnabled);
        }
        if (
          typeof d.pickupWalkedOutDisplaySeconds === "number" &&
          Number.isFinite(d.pickupWalkedOutDisplaySeconds)
        ) {
          setWalkedOutSecs(d.pickupWalkedOutDisplaySeconds);
        }
      }
      if (p.ok) {
        const j = (await p.json()) as { playlists?: PlaylistRow[] };
        setPlaylists(j.playlists ?? []);
      }
    })();
  }, []);

  const save = async () => {
    setErr(null);
    setSaved(false);
    setSaving(true);
    try {
      const r = await authFetch("/api/school-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pickupCutoffTime: cutoff,
          pickupTeacherViewScope: scope,
          pickupInCarStepEnabled: inCarStep,
          pickupWalkedOutDisplaySeconds: walkedOutSecs,
        }),
      });
      if (!r.ok) {
        setErr(await r.text());
        return;
      }
      setSaved(true);
    } finally {
      setSaving(false);
    }
  };

  const tvUrls = useMemo(
    () =>
      playlists.map((p) => ({
        title: `TV signage — ${p.name}`,
        path: `/display/${p.id}`,
      })),
    [playlists],
  );
  // Walker / curb need the Car-Rider Monitor cap (or admin). Admin URL
  // needs admin/SU/DA. Teacher view is open to any signed-in staff. TVs
  // are public (no auth) so the badge is always green.

  return (
    <div>
      <h1 style={{ marginTop: 0 }}>Parent Pick-Up</h1>
      <p style={{ color: "var(--text-subtle)", marginTop: 0 }}>
        After-cutoff reconciliation, teacher release scope, and the kiosk
        URLs to bookmark on each station (curb tablet, walker iPad,
        teacher laptop, hallway TVs).
      </p>

      <HowToUseHelp title="How Pick-Up settings work">
        <HowToSection title="Cutoff time">
          The "🚗 Still on campus" tile on the Admin Hub stays hidden until
          this clock time. After cutoff, the front office sees a grouped
          list of every student with no release event today (in-car,
          walker-released, or auto-cleared) so they can call parents.
        </HowToSection>
        <HowToSection title="Teacher release scope">
          <ul style={howtoListStyle}>
            <li>
              <strong>Any teacher</strong> — the elementary default. The
              kid waiting in art class is released by the art teacher,
              not their homeroom. The audit log records who pressed the
              button.
            </li>
            <li>
              <strong>Only the student's own teacher</strong> — the
              middle/high default. A teacher can only release students on
              their own non-planning class roster (verified server-side
              via section_roster). Curb monitors override either setting.
            </li>
          </ul>
        </HowToSection>
        <RoleSection for="admin" title="Admin / SuperUser">
          Can change every setting on this page. Curb-monitor and walker-gate
          access is granted on the Staff page (Cap: Car-Rider Monitor).
        </RoleSection>
      </HowToUseHelp>

      <div style={card}>
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Settings</h2>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
          <div>
            <label style={label} htmlFor="pickup-cutoff">
              Cutoff time
            </label>
            <input
              id="pickup-cutoff"
              type="time"
              value={cutoff}
              onChange={(e) => setCutoff(e.target.value)}
              style={inputStyle}
            />
            <div
              style={{
                fontSize: 11,
                color: "var(--text-subtle)",
                marginTop: 4,
              }}
            >
              Reconciliation tile appears after this time.
            </div>
          </div>
          <div>
            <label style={label} htmlFor="pickup-scope">
              Teacher release scope
            </label>
            <select
              id="pickup-scope"
              value={scope}
              onChange={(e) =>
                setScope(
                  e.target.value === "own_roster"
                    ? "own_roster"
                    : "all_students",
                )
              }
              style={inputStyle}
            >
              <option value="all_students">
                Any teacher can release any student
              </option>
              <option value="own_roster">
                Only the student's own teacher
              </option>
            </select>
            <div
              style={{
                fontSize: 11,
                color: "var(--text-subtle)",
                marginTop: 4,
              }}
            >
              Enforced server-side on every release.
            </div>
          </div>
          <div>
            <label style={label} htmlFor="pickup-in-car">
              "In car" terminal step
            </label>
            <select
              id="pickup-in-car"
              value={inCarStep ? "on" : "off"}
              onChange={(e) => setInCarStep(e.target.value === "on")}
              style={inputStyle}
            >
              <option value="on">
                On — curb staff tap "in car" to clear the row
              </option>
              <option value="off">
                Off — "walking out" is the final step
              </option>
            </select>
            <div
              style={{
                fontSize: 11,
                color: "var(--text-subtle)",
                marginTop: 4,
              }}
            >
              Turn off if your school has no one tapping at the curb.
              The audit log still records every release. Avoid changing
              this during active dismissal — the reconciliation tile uses
              the current setting to interpret today's events.
            </div>
          </div>
          <div>
            <label style={label} htmlFor="pickup-walked-secs">
              Drop-from-list timer (seconds)
            </label>
            <input
              id="pickup-walked-secs"
              type="number"
              min={60}
              max={1800}
              step={30}
              value={walkedOutSecs}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n)) setWalkedOutSecs(n);
              }}
              disabled={inCarStep}
              style={{
                ...inputStyle,
                opacity: inCarStep ? 0.5 : 1,
                minWidth: 100,
              }}
            />
            <div
              style={{
                fontSize: 11,
                color: "var(--text-subtle)",
                marginTop: 4,
              }}
            >
              {inCarStep
                ? "Only used when the 'in car' step is off."
                : `How long a 'walking out' row stays visible to curb staff before dropping off the live list. 60–1800s (default 300 = 5 min).`}
            </div>
          </div>
        </div>
        <div
          style={{
            marginTop: 14,
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <button
            type="button"
            onClick={save}
            disabled={saving}
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              border: "1px solid #2563eb",
              background: "#2563eb",
              color: "white",
              fontWeight: 600,
              cursor: saving ? "default" : "pointer",
              opacity: saving ? 0.6 : 1,
            }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
          {saved && (
            <span style={{ color: "#059669", fontSize: 13 }}>Saved.</span>
          )}
          {err && <span style={{ color: "#b91c1c", fontSize: 13 }}>{err}</span>}
        </div>
      </div>

      <div style={card}>
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Kiosk URLs to bookmark</h2>
        <p
          style={{
            marginTop: 0,
            color: "var(--text-subtle)",
            fontSize: 13,
          }}
        >
          One link per station. Open each on the right device, then save it
          to the bookmark bar / home screen.
        </p>
        <UrlListItem
          title="Curb keypad (front office tablet)"
          path="/pickup/curb"
          canOpen={canCurb}
          requiredLabel="Car-Rider Monitor"
        />
        <UrlListItem
          title="Walker gate (walker dismissal door)"
          path="/pickup/walkers"
          canOpen={canCurb}
          requiredLabel="Car-Rider Monitor"
        />
        <UrlListItem
          title="Teacher view (any classroom laptop)"
          path="/pickup/teacher"
          canOpen={true}
          requiredLabel="Any signed-in staff"
        />
        <UrlListItem
          title="Manage pickup numbers"
          path="/pickup/admin"
          canOpen={canAdmin}
          requiredLabel="Admin"
        />
        {tvUrls.length === 0 ? (
          <div
            style={{
              fontSize: 12,
              color: "var(--text-subtle)",
              padding: "8px 10px",
            }}
          >
            No display playlists configured. Create one under Display
            Management to surface a TV URL here.
          </div>
        ) : (
          tvUrls.map((u) => (
            <UrlListItem
              key={u.path}
              title={u.title}
              path={u.path}
              canOpen={true}
              requiredLabel="Public"
            />
          ))
        )}
      </div>
    </div>
  );
}
