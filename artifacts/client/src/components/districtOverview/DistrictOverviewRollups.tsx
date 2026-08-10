// District Overview — per-school rollup for the caller's district.
// Replaces the District Admin landing placeholder grid. Shows district
// header + totals plus a per-school table (students, staff, PBIS pts
// last 7d, hall passes last 7d, ISS days last 7d) with a "Switch to
// this school" button on each row that reuses /api/tenancy/switch-school.

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { authFetch } from "../../lib/authToken";
import EditSchoolModal from "./EditSchoolModal";
import ChangePlanModal from "./ChangePlanModal";

type SchoolRow = {
  id: number;
  name: string;
  shortName: string | null;
  stateSchoolCode: string | null;
  isPrimary: boolean;
  active: boolean;
  planId: number | null;
  planKey: string | null;
  planLabel: string | null;
  studentCount: number;
  staffCount: number;
  pbisPoints7d: number;
  pbisEntries7d: number;
  hallPasses7d: number;
  issDays7d: number;
};

type Overview = {
  district: {
    id: number;
    name: string;
    slug: string;
    timezone: string;
  };
  totals: {
    schools: number;
    students: number;
    staff: number;
  };
  schools: SchoolRow[];
  // Server tells us whether the caller is allowed to invoke
  // /api/tenancy/switch-school (SuperUser-only today). District Admins
  // who lack the bit see the row without the "Switch to" action so the
  // demo doesn't surface a 403.
  caller: { isSuperUser: boolean };
};

function StatPill({ label, value }: { label: string; value: number }) {
  return (
    <div
      style={{
        border: "1px solid var(--border, #e2e8f0)",
        borderRadius: "var(--radius-sm, 8px)",
        background: "var(--surface, #fff)",
        padding: "0.75rem 1rem",
        minWidth: 110,
      }}
    >
      <div
        style={{
          fontSize: "0.7rem",
          color: "var(--text-subtle)",
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: "1.5rem", fontWeight: 700, marginTop: 2 }}>
        {value.toLocaleString()}
      </div>
    </div>
  );
}

// District-wide two-factor (MFA) policy card (Section 1.8). Lets a District
// Admin require MFA across every school in their district. Reads/writes
// /api/district-admin/mfa-policy (scoped server-side to the caller's own
// district). The GET is District-Admin-gated, so this card silently hides
// itself (returns null) for anyone without district authority.
type DistrictMfaPolicy = {
  name: string;
  mfaRequiredPrivileged: boolean;
  mfaRequiredStaff: boolean;
};

function DistrictMfaPolicyCard() {
  const [policy, setPolicy] = useState<DistrictMfaPolicy | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch("/api/district-admin/mfa-policy");
        if (!res.ok) {
          if (!cancelled) setBlocked(true); // 403/409 → not a district admin
          return;
        }
        const j = (await res.json()) as DistrictMfaPolicy;
        if (!cancelled) setPolicy(j);
      } catch {
        if (!cancelled) setBlocked(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function update(
    field: "mfaRequiredPrivileged" | "mfaRequiredStaff",
    value: boolean,
  ) {
    if (!policy) return;
    if (
      value &&
      !window.confirm(
        `Require two-factor across all of ${policy.name}?\n\n` +
          "Every affected user in the district — including you — will be forced " +
          "to set up an authenticator app at their next request. Continue?",
      )
    )
      return;
    const prev = policy;
    setPolicy({ ...policy, [field]: value }); // optimistic
    setSaving(true);
    setSaved(false);
    setErr(null);
    try {
      const res = await authFetch("/api/district-admin/mfa-policy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `Save failed (${res.status})`);
      }
      const j = (await res.json()) as DistrictMfaPolicy;
      setPolicy(j);
      setSaved(true);
    } catch (e) {
      setPolicy(prev); // revert on failure
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (blocked || !policy) return null;

  const rowStyle: CSSProperties = {
    display: "flex",
    gap: "0.5rem",
    alignItems: "flex-start",
    marginTop: "0.6rem",
  };
  const subStyle: CSSProperties = {
    color: "var(--text-subtle, #64748b)",
    fontSize: "0.85rem",
    fontWeight: "normal",
  };

  return (
    <div
      className="card"
      style={{
        marginTop: "0.75rem",
        border: "1px solid var(--border, #e2e8f0)",
        borderRadius: "var(--radius-sm, 8px)",
        padding: "1rem",
      }}
    >
      <div style={{ fontWeight: 700 }}>
        District-wide two-factor (MFA) policy
      </div>
      <div style={{ ...subStyle, marginTop: "0.15rem" }}>
        Applies to every school in {policy.name}. Combined (ORed) with each
        school's own two-factor setting — turning it on here enforces MFA
        district-wide even for schools that haven't enabled it.
      </div>

      <label style={rowStyle}>
        <input
          type="checkbox"
          checked={policy.mfaRequiredPrivileged}
          disabled={saving}
          onChange={(e) =>
            void update("mfaRequiredPrivileged", e.target.checked)
          }
          style={{ marginTop: "0.2rem" }}
        />
        <span style={{ display: "grid", gap: "0.15rem" }}>
          <span style={{ fontWeight: 600 }}>
            Require two-factor for all admins (district-wide)
          </span>
          <span style={subStyle}>
            SuperUsers, District Admins, and School Admins across the district
            must enter an authenticator code at sign-in.
          </span>
        </span>
      </label>

      <label style={rowStyle}>
        <input
          type="checkbox"
          checked={policy.mfaRequiredStaff}
          disabled={saving}
          onChange={(e) => void update("mfaRequiredStaff", e.target.checked)}
          style={{ marginTop: "0.2rem" }}
        />
        <span style={{ display: "grid", gap: "0.15rem" }}>
          <span style={{ fontWeight: 600 }}>
            Require two-factor for all staff (district-wide)
          </span>
          <span style={subStyle}>
            Extends the requirement to every staff member with a login across
            the district (teachers, support staff, and specialist roles).
          </span>
        </span>
      </label>

      {err && (
        <div style={{ color: "#b91c1c", fontSize: 12, marginTop: "0.5rem" }}>
          {err}
        </div>
      )}
      {saved && !err && (
        <div style={{ color: "#166534", fontSize: 12, marginTop: "0.5rem" }}>
          Saved.
        </div>
      )}
    </div>
  );
}

export default function DistrictOverviewRollups() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState<number | null>(null);
  const [editing, setEditing] = useState<SchoolRow | null>(null);
  const [changingPlan, setChangingPlan] = useState<SchoolRow | null>(null);
  const [togglingActive, setTogglingActive] = useState<number | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await authFetch("/api/district-admin/overview");
      if (!res.ok) throw new Error(`overview → ${res.status}`);
      setData((await res.json()) as Overview);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function toggleActive(s: SchoolRow) {
    const next = !s.active;
    const verb = next ? "reactivate" : "deactivate";
    if (
      !window.confirm(
        `${verb === "deactivate" ? "Deactivate" : "Reactivate"} ${s.name}?\n\n` +
          (next
            ? "It will reappear in rollups and lookups."
            : "It will be hidden from rollups and most lookups. Existing data is preserved."),
      )
    )
      return;
    setTogglingActive(s.id);
    try {
      const res = await authFetch(`/api/tenancy/schools/${s.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTogglingActive(null);
    }
  }

  async function switchTo(schoolId: number) {
    setSwitching(schoolId);
    try {
      const res = await authFetch("/api/tenancy/switch-school", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schoolId }),
      });
      if (!res.ok) throw new Error(`switch → ${res.status}`);
      // Full reload so every cached query refetches under the new schoolId.
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSwitching(null);
    }
  }

  if (error) {
    return (
      <div style={{ color: "#b91c1c", marginTop: "0.5rem" }}>
        Failed to load overview: {error}
      </div>
    );
  }
  if (!data) {
    return (
      <div style={{ color: "var(--text-subtle)", marginTop: "0.5rem" }}>
        Loading overview…
      </div>
    );
  }

  return (
    <div style={{ marginTop: "1rem" }}>
      {/* District header */}
      <div style={{ marginBottom: "0.75rem" }}>
        <div style={{ fontSize: "1.15rem", fontWeight: 700 }}>
          {data.district.name}
        </div>
        <div style={{ fontSize: "0.75rem", color: "var(--text-subtle)" }}>
          {data.district.slug} · {data.district.timezone}
        </div>
      </div>

      {/* Totals */}
      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
        <StatPill label="Schools" value={data.totals.schools} />
        <StatPill label="Students" value={data.totals.students} />
        <StatPill label="Active Staff" value={data.totals.staff} />
      </div>

      {/* District-wide MFA policy (Section 1.8) */}
      <DistrictMfaPolicyCard />

      <div
        style={{ marginTop: "0.75rem", display: "flex", gap: "0.5rem" }}
      >
        <button
          type="button"
          onClick={() => void reload()}
          style={{
            padding: "0.45rem 0.85rem",
            border: "1px solid var(--border, #e2e8f0)",
            borderRadius: 6,
            background: "var(--surface, #fff)",
            cursor: "pointer",
          }}
        >
          Refresh
        </button>
      </div>

      {/* Per-school table */}
      <h3 style={{ marginTop: "1.5rem", marginBottom: "0.5rem" }}>
        Schools (last 7 days)
      </h3>
      {data.schools.length === 0 ? (
        <p style={{ color: "var(--text-subtle)" }}>No schools in district.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "0.9rem",
            }}
          >
            <thead>
              <tr style={{ background: "var(--surface-muted, #f8fafc)" }}>
                <th style={th}>School</th>
                <th style={th}>Plan</th>
                <th style={thRight}>Students</th>
                <th style={thRight}>Staff</th>
                <th style={thRight}>PBIS pts (7d)</th>
                <th style={thRight}>Hall passes (7d)</th>
                <th style={thRight}>ISS days (7d)</th>
                {data.caller.isSuperUser && (
                  <th style={th} colSpan={4}></th>
                )}
              </tr>
            </thead>
            <tbody>
              {data.schools.map((s) => (
                <tr
                  key={s.id}
                  style={{ borderTop: "1px solid var(--border, #e2e8f0)" }}
                >
                  <td style={td}>
                    <div style={{ fontWeight: 600 }}>{s.name}</div>
                    <div
                      style={{
                        fontSize: "0.72rem",
                        color: "var(--text-subtle)",
                      }}
                    >
                      {s.shortName ?? "—"}
                      {s.isPrimary ? " · primary" : ""}
                      {s.stateSchoolCode ? ` · ${s.stateSchoolCode}` : ""}
                    </div>
                  </td>
                  <td style={td}>
                    <span style={{ fontSize: "0.8rem" }}>
                      {s.planLabel ?? (
                        <span style={{ color: "var(--text-subtle)" }}>—</span>
                      )}
                    </span>
                  </td>
                  <td style={tdRight}>{s.studentCount.toLocaleString()}</td>
                  <td style={tdRight}>{s.staffCount.toLocaleString()}</td>
                  <td style={tdRight}>{s.pbisPoints7d.toLocaleString()}</td>
                  <td style={tdRight}>{s.hallPasses7d.toLocaleString()}</td>
                  <td style={tdRight}>{s.issDays7d.toLocaleString()}</td>
                  {data.caller.isSuperUser && (
                    <>
                      <td style={td}>
                        <button
                          type="button"
                          onClick={() => setEditing(s)}
                          style={rowBtn}
                        >
                          Edit
                        </button>
                      </td>
                      <td style={td}>
                        <button
                          type="button"
                          onClick={() => void toggleActive(s)}
                          disabled={
                            togglingActive !== null ||
                            (s.isPrimary && s.active)
                          }
                          title={
                            s.isPrimary && s.active
                              ? "Primary school cannot be deactivated"
                              : undefined
                          }
                          style={{
                            ...rowBtn,
                            color: s.active ? "#b91c1c" : "#15803d",
                            opacity:
                              s.isPrimary && s.active
                                ? 0.4
                                : togglingActive === s.id
                                  ? 0.6
                                  : 1,
                          }}
                        >
                          {togglingActive === s.id
                            ? "…"
                            : s.active
                              ? "Deactivate"
                              : "Reactivate"}
                        </button>
                      </td>
                      <td style={td}>
                        <button
                          type="button"
                          onClick={() => setChangingPlan(s)}
                          style={rowBtn}
                        >
                          Plan
                        </button>
                      </td>
                      <td style={td}>
                        <button
                          type="button"
                          onClick={() => switchTo(s.id)}
                          disabled={switching !== null}
                          style={{
                            ...rowBtn,
                            cursor:
                              switching !== null ? "not-allowed" : "pointer",
                          }}
                        >
                          {switching === s.id ? "Switching…" : "Switch to"}
                        </button>
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <EditSchoolModal
          school={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}
      {changingPlan && (
        <ChangePlanModal
          school={{
            id: changingPlan.id,
            name: changingPlan.name,
            planId: changingPlan.planId,
            planLabel: changingPlan.planLabel,
          }}
          onClose={() => setChangingPlan(null)}
          onSaved={() => {
            setChangingPlan(null);
            void reload();
          }}
        />
      )}
    </div>
  );
}

const rowBtn: React.CSSProperties = {
  padding: "0.35rem 0.65rem",
  border: "1px solid var(--border, #e2e8f0)",
  borderRadius: 5,
  background: "var(--surface, #fff)",
  cursor: "pointer",
  fontSize: "0.8rem",
};

const th: React.CSSProperties = {
  padding: "0.5rem 0.75rem",
  textAlign: "left",
  fontSize: "0.75rem",
  textTransform: "uppercase",
  letterSpacing: 0.5,
  color: "var(--text-subtle)",
};
const thRight: React.CSSProperties = { ...th, textAlign: "right" };
const td: React.CSSProperties = {
  padding: "0.6rem 0.75rem",
  verticalAlign: "top",
};
const tdRight: React.CSSProperties = {
  ...td,
  textAlign: "right",
  fontVariantNumeric: "tabular-nums",
};
