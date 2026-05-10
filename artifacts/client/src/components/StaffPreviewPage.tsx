import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/authToken";
import { HowToUseHelp, HowToSection, RoleSection } from "./HowToUseHelp";

// Sister page to ParentAccess's "Preview as parent" — lets Admin /
// DistrictAdmin / SuperUser swap their session to any non-privileged staff
// member in scope. The server enforces the gate; this component just hides
// the UI from everyone else.

interface StaffRow {
  id: number;
  displayName: string;
  email: string;
  schoolId: number;
  isAdmin: boolean;
  isEseCoordinator: boolean;
  isPbisCoordinator: boolean;
  isBehaviorSpecialist: boolean;
  isIssTeacher: boolean;
  isDean: boolean;
  isMtssCoordinator: boolean;
  isCounselor: boolean;
  isSocialWorker: boolean;
  isSchoolPsychologist: boolean;
  isGuidanceCounselor: boolean;
}

const inputStyle: React.CSSProperties = {
  background: "var(--card-bg, rgba(255,255,255,0.03))",
  border: "1px solid var(--border, #2a3447)",
  borderRadius: 6,
  padding: "0.4rem 0.6rem",
  color: "inherit",
  fontSize: 14,
};

const btnGhost: React.CSSProperties = {
  background: "transparent",
  border: "1px solid var(--border, #2a3447)",
  color: "inherit",
  borderRadius: 6,
  padding: "0.3rem 0.7rem",
  cursor: "pointer",
  fontSize: 13,
};

const btnPrimary: React.CSSProperties = {
  ...btnGhost,
  background: "#1e40af",
  borderColor: "#1d4ed8",
  color: "white",
};

function rolesOf(s: StaffRow): string {
  const tags: string[] = [];
  if (s.isAdmin) tags.push("Admin");
  if (s.isPbisCoordinator) tags.push("PBIS Coord");
  if (s.isMtssCoordinator) tags.push("MTSS");
  if (s.isBehaviorSpecialist) tags.push("Behavior Spec");
  if (s.isDean) tags.push("Dean");
  if (s.isIssTeacher) tags.push("ISS Teacher");
  if (s.isEseCoordinator) tags.push("ESE Coord");
  if (s.isGuidanceCounselor) tags.push("Guidance");
  if (s.isCounselor) tags.push("Counselor");
  if (s.isSocialWorker) tags.push("Social Wkr");
  if (s.isSchoolPsychologist) tags.push("Psych");
  return tags.join(" · ") || "Teacher";
}

export default function StaffPreviewPage() {
  const [rows, setRows] = useState<StaffRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    authFetch("/api/admin/staff-preview/list")
      .then(async (r) => {
        if (!r.ok) throw new Error(await r.text());
        return (await r.json()) as StaffRow[];
      })
      .then((data) => {
        if (!cancelled) setRows(data);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err.message ?? err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      const hay =
        `${r.displayName} ${r.email} ${rolesOf(r)}`.toLowerCase();
      return hay.includes(q);
    });
  }, [rows, filter]);

  const previewAs = async (id: number) => {
    setBusyId(id);
    try {
      const r = await authFetch("/api/admin/staff-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetStaffId: id }),
      });
      if (!r.ok) {
        const text = await r.text();
        alert("Could not start preview: " + text);
        return;
      }
      // Server-side state is now in staff.preview_target_staff_id, so the
      // bearer token doesn't need to change — the next request will be
      // swapped by the middleware. Just reload in place.
      window.location.href = "/";
    } catch (err) {
      alert("Could not start preview: " + (err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <h2 style={{ margin: 0 }}>Preview as Staff</h2>
      <p style={{ color: "var(--text-subtle)", margin: "0.25rem 0 0.75rem" }}>
        Swap your session to view PulseEDU as another staff member. Useful for
        verifying role-gated screens. Opens in a new tab — your real account
        stays signed in here. SuperUser and District Admin accounts cannot be
        previewed (privilege guard).
      </p>
      <HowToUseHelp title="How to use Preview as Staff">
        <HowToSection title="Read-only view, in a new tab">
          Opens a fresh tab signed in as the chosen staff member.
          Your own session stays untouched in this tab. Every preview
          action is logged with both your identity and the previewed
          identity for audit.
        </HowToSection>
        <RoleSection for={["admin", "districtAdmin"]} title="Common uses">
          Verifying that a new role preset is showing the right
          screens, or reproducing a teacher's bug report without
          asking for their password. Never use to take action on a
          student record — always sign back in as yourself.
        </RoleSection>
      </HowToUseHelp>

      <div
        style={{
          display: "flex",
          gap: "0.5rem",
          flexWrap: "wrap",
          marginBottom: "0.75rem",
        }}
      >
        <input
          type="search"
          placeholder="Search by name, email, or role…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ ...inputStyle, maxWidth: 320, flex: "1 1 240px" }}
        />
      </div>

      {error && (
        <div
          style={{
            background: "#3f1d1d",
            color: "#fca5a5",
            padding: "0.5rem 0.75rem",
            borderRadius: 6,
            marginBottom: "0.75rem",
          }}
        >
          {error}
        </div>
      )}

      {loading ? (
        <p style={{ color: "var(--text-subtle)" }}>Loading…</p>
      ) : filtered.length === 0 ? (
        <p style={{ color: "var(--text-subtle)" }}>
          {rows.length === 0 ? "No staff in scope." : "No matches."}
        </p>
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.4rem",
          }}
        >
          {filtered.map((s) => (
            <div
              key={s.id}
              style={{
                border: "1px solid var(--border, #2a3447)",
                borderRadius: 8,
                padding: "0.55rem 0.75rem",
                background: "var(--card-bg, rgba(255,255,255,0.02))",
                display: "flex",
                alignItems: "center",
                gap: "0.75rem",
                flexWrap: "wrap",
              }}
            >
              <div style={{ flex: "1 1 240px", minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{s.displayName}</div>
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--text-subtle)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {s.email} · {rolesOf(s)}
                </div>
              </div>
              <button
                type="button"
                style={btnPrimary}
                disabled={busyId === s.id}
                onClick={() => void previewAs(s.id)}
              >
                {busyId === s.id ? "Opening…" : "Preview as"}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
