import { Component, type ReactNode, useEffect, useState } from "react";
import { authFetch } from "../lib/authToken";

class TenancyErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error("TenancyPanel crashed:", error);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="card" style={{ marginBottom: "1rem" }}>
          <h2 style={{ marginTop: 0 }}>Tenancy</h2>
          <p style={{ color: "#b91c1c" }}>
            The tenancy panel hit an error and was isolated so the rest of the
            app keeps working. Please reload the page. If you still see this
            after a hard refresh, let the team know.
          </p>
          <pre
            style={{
              fontSize: 11,
              background: "#1f2937",
              color: "#f9fafb",
              padding: "0.5rem",
              borderRadius: 4,
              overflow: "auto",
            }}
          >
            {String(this.state.error?.message ?? this.state.error)}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

interface DistrictRow {
  id: number;
  name: string;
  slug: string;
  stateDistrictCode: string | null;
  timezone: string;
  active: boolean;
}

interface SchoolRow {
  id: number;
  districtId: number;
  name: string;
  shortName: string | null;
  stateSchoolCode: string | null;
  isPrimary: boolean;
  active: boolean;
}

interface TenancyStatus {
  districts: DistrictRow[];
  schools: SchoolRow[];
  counts: Record<string, number>;
  perSchool: Record<string, Record<string, number>>;
  orphans: Record<string, number>;
  totalOrphans: number;
  perSchoolBreakdownAvailable: boolean;
}

const tableLabels: Record<string, string> = {
  students: "Students",
  staff: "Staff",
  hall_passes: "Hall passes",
  tardies: "Tardies",
  pbis_entries: "PBIS entries",
  pullouts: "Pullouts",
  accommodation_logs: "Accommodation logs",
  support_notes: "Support notes",
  intervention_entries: "Intervention entries",
  iss_roster: "ISS roster entries",
  school_settings: "Settings rows",
  bell_schedules: "Bell schedules",
  pbis_reasons: "PBIS reasons",
  pbis_milestones: "PBIS milestones",
};

export default function TenancyPanel() {
  return (
    <TenancyErrorBoundary>
      <TenancyPanelInner />
    </TenancyErrorBoundary>
  );
}

function TenancyPanelInner() {
  const [status, setStatus] = useState<TenancyStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  // Create-school form state. Keyed BY districtId because the panel now
  // renders one create-form per district (Hernando + Pasco today, more
  // tomorrow). Sharing a single set of refs across forms caused two
  // visible bugs: (a) typing in Hernando's input filled Pasco's field
  // too, and (b) submitting against one district painted the success/
  // error banner under both. Each per-district form now owns its own
  // input values, in-flight flag, and result message. On success we
  // bump reloadKey to refetch /tenancy/status so the new school appears
  // in the schools table and per-school count grid.
  type DraftSchool = { name: string; short: string; code: string };
  const emptyDraft: DraftSchool = { name: "", short: "", code: "" };
  const [drafts, setDrafts] = useState<Record<number, DraftSchool>>({});
  const [creatingDistrictId, setCreatingDistrictId] = useState<number | null>(
    null,
  );
  const [createMessage, setCreateMessage] = useState<
    { districtId: number; kind: "ok" | "err"; text: string } | null
  >(null);

  const getDraft = (districtId: number): DraftSchool =>
    drafts[districtId] ?? emptyDraft;
  const updateDraft = (districtId: number, patch: Partial<DraftSchool>) => {
    setDrafts((prev) => ({
      ...prev,
      [districtId]: { ...(prev[districtId] ?? emptyDraft), ...patch },
    }));
  };
  const clearDraft = (districtId: number) => {
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[districtId];
      return next;
    });
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const r = await authFetch("/api/tenancy/status");
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body?.error ?? `HTTP ${r.status}`);
        }
        const data = (await r.json()) as TenancyStatus;
        if (!cancelled) setStatus(data);
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Failed to load tenancy");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const submitCreate = async (districtId: number) => {
    const draft = getDraft(districtId);
    setCreatingDistrictId(districtId);
    setCreateMessage(null);
    try {
      const r = await authFetch("/api/tenancy/schools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          districtId,
          name: draft.name,
          shortName: draft.short || null,
          stateSchoolCode: draft.code || null,
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(body?.error ?? `HTTP ${r.status}`);
      }
      setCreateMessage({
        districtId,
        kind: "ok",
        text: `Created “${body?.school?.name ?? draft.name}” (id ${body?.school?.id}). Switch to it from the school badge in the top bar — dashboards should be empty.`,
      });
      clearDraft(districtId);
      setReloadKey((k) => k + 1);
    } catch (e) {
      setCreateMessage({
        districtId,
        kind: "err",
        text: e instanceof Error ? e.message : "Create failed",
      });
    } finally {
      setCreatingDistrictId(null);
    }
  };

  if (loading) {
    return (
      <div className="card" style={{ marginBottom: "1rem" }}>
        <h2 style={{ marginTop: 0 }}>Tenancy</h2>
        <p style={{ color: "var(--text-subtle)" }}>Loading…</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="card" style={{ marginBottom: "1rem" }}>
        <h2 style={{ marginTop: 0 }}>Tenancy</h2>
        <p style={{ color: "#b91c1c" }}>{error}</p>
      </div>
    );
  }
  if (!status) return null;

  // Defensive defaults in case an older API response shape is cached or the
  // server is mid-deploy. Never let undefined fields crash the panel.
  const districts = Array.isArray(status.districts) ? status.districts : [];
  const schools = Array.isArray(status.schools) ? status.schools : [];
  const counts = (status.counts ?? {}) as Record<string, number>;
  const perSchool = (status.perSchool ?? {}) as Record<
    string,
    Record<string, number>
  >;
  const orphans = (status.orphans ?? {}) as Record<string, number>;
  const totalOrphans = Number(status.totalOrphans ?? 0);

  // D6 (Pasco onboarding): the panel now iterates every district instead
  // of locking onto districts[0]. Per-district sections (header, "create
  // school" form, schools table) render once per district. Global sections
  // (data integrity, per-school counts) span all districts. Schools with
  // zero rows across every counted table are hidden from the count grid so
  // it doesn't blow out to 100+ columns the moment Pasco is loaded.
  const orphansClean = totalOrphans === 0;
  const schoolsWithAnyRows = new Set<number>();
  for (const tableCounts of Object.values(perSchool)) {
    for (const [sidStr, n] of Object.entries(tableCounts)) {
      if (Number(n) > 0) schoolsWithAnyRows.add(Number(sidStr));
    }
  }
  const visibleSchoolsForCounts = schools.filter((s) =>
    schoolsWithAnyRows.has(s.id),
  );

  const cellStyle = { padding: "0.4rem", textAlign: "right" as const };
  const headStyle = {
    padding: "0.4rem",
    textAlign: "right" as const,
    fontSize: 12,
    color: "var(--text-subtle)",
  };

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <h2 style={{ marginTop: 0 }}>Tenancy</h2>
      <p style={{ color: "var(--text-subtle)", marginTop: 0 }}>
        Districts and schools registered in this PulseEDU instance.
      </p>

      {districts.map((district) => {
        const schoolsForDistrict = schools.filter(
          (s) => s.districtId === district.id,
        );
        const draft = getDraft(district.id);
        const isCreating = creatingDistrictId === district.id;
        const myMessage =
          createMessage && createMessage.districtId === district.id
            ? createMessage
            : null;
        return (
        <div key={district.id}>
        <section style={{ marginBottom: "1.25rem" }}>
          <div
            style={{
              display: "flex",
              gap: "0.75rem",
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <h3 style={{ margin: 0 }}>{district.name}</h3>
            <span
              style={{
                background: "#ede9fe",
                color: "#6d28d9",
                borderRadius: 999,
                padding: "0.1rem 0.6rem",
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              slug: {district.slug}
            </span>
            {district.stateDistrictCode && (
              <span
                style={{
                  background: "#e0f2fe",
                  color: "#0369a1",
                  borderRadius: 999,
                  padding: "0.1rem 0.6rem",
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                state district code: {district.stateDistrictCode}
              </span>
            )}
            <span
              style={{
                background: "#dcfce7",
                color: "#166534",
                borderRadius: 999,
                padding: "0.1rem 0.6rem",
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              tz: {district.timezone}
            </span>
          </div>
        </section>

        <section
          style={{
            marginBottom: "1.25rem",
            border: "1px dashed var(--border, #2a3447)",
            borderRadius: 6,
            padding: "0.75rem",
          }}
        >
          <h3 style={{ marginTop: 0, marginBottom: "0.4rem" }}>
            Create new school
          </h3>
          <p
            style={{
              color: "var(--text-subtle)",
              marginTop: 0,
              fontSize: 13,
            }}
          >
            New schools start empty. After creating one, use the school badge
            in the top bar to switch into it — every dashboard should be blank
            until you add data, proving silo isolation. Switch back to your
            home school to restore the original view.
          </p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1.6fr 0.8fr 0.8fr auto",
              gap: "0.5rem",
              alignItems: "end",
            }}
          >
            <label style={{ display: "block", fontSize: 13 }}>
              School name
              <input
                type="text"
                value={draft.name}
                onChange={(e) =>
                  updateDraft(district.id, { name: e.target.value })
                }
                placeholder="e.g. Test Middle School"
                style={{ display: "block", width: "100%", padding: "0.35rem" }}
              />
            </label>
            <label style={{ display: "block", fontSize: 13 }}>
              Short name (optional)
              <input
                type="text"
                value={draft.short}
                onChange={(e) =>
                  updateDraft(district.id, { short: e.target.value })
                }
                placeholder="Test"
                style={{ display: "block", width: "100%", padding: "0.35rem" }}
              />
            </label>
            <label style={{ display: "block", fontSize: 13 }}>
              State code (optional)
              <input
                type="text"
                value={draft.code}
                onChange={(e) =>
                  updateDraft(district.id, { code: e.target.value })
                }
                placeholder="9999"
                style={{ display: "block", width: "100%", padding: "0.35rem" }}
              />
            </label>
            <button
              type="button"
              disabled={isCreating || !draft.name.trim()}
              onClick={() => submitCreate(district.id)}
              style={{
                padding: "0.5rem 0.9rem",
                background: "#0d9488",
                color: "white",
                border: "none",
                borderRadius: 4,
                cursor:
                  isCreating || !draft.name.trim()
                    ? "not-allowed"
                    : "pointer",
                opacity: isCreating || !draft.name.trim() ? 0.6 : 1,
              }}
            >
              {isCreating ? "Creating…" : "Create school"}
            </button>
          </div>
          {myMessage && (
            <p
              style={{
                color: myMessage.kind === "ok" ? "#166534" : "#b91c1c",
                fontSize: 13,
                marginBottom: 0,
              }}
            >
              {myMessage.text}
            </p>
          )}
        </section>

      <section style={{ marginBottom: "1.25rem" }}>
        <h3 style={{ marginBottom: "0.5rem" }}>
          Schools ({schoolsForDistrict.length})
        </h3>
        <table className="pulse-table"
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: "0.92rem",
          }}
        >
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border, #2a3447)" }}>
              <th style={{ textAlign: "left", padding: "0.4rem" }}>School</th>
              <th style={{ textAlign: "left", padding: "0.4rem" }}>Short</th>
              <th style={{ textAlign: "left", padding: "0.4rem" }}>
                State code
              </th>
              <th style={{ textAlign: "left", padding: "0.4rem" }}>Primary</th>
              <th style={{ textAlign: "left", padding: "0.4rem" }}>Active</th>
            </tr>
          </thead>
          <tbody>
            {schoolsForDistrict.map((s) => (
              <tr
                key={s.id}
                style={{ borderBottom: "1px solid var(--border, #2a3447)" }}
              >
                <td style={{ padding: "0.4rem", fontWeight: 600 }}>
                  {s.name}
                </td>
                <td style={{ padding: "0.4rem" }}>{s.shortName ?? "—"}</td>
                <td style={{ padding: "0.4rem" }}>
                  {s.stateSchoolCode ?? "—"}
                </td>
                <td style={{ padding: "0.4rem" }}>
                  {s.isPrimary ? (
                    <span
                      style={{
                        background: "#0d9488",
                        color: "white",
                        borderRadius: 999,
                        padding: "0.1rem 0.55rem",
                        fontSize: 11,
                        fontWeight: 700,
                      }}
                    >
                      PRIMARY
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td style={{ padding: "0.4rem" }}>
                  {s.active ? "Yes" : "No"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      </div>
        );
      })}

      <section style={{ marginBottom: "1.25rem" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.6rem",
            marginBottom: "0.5rem",
          }}
        >
          <h3 style={{ margin: 0 }}>Data integrity check</h3>
          <span
            style={{
              background: orphansClean ? "#dcfce7" : "#fee2e2",
              color: orphansClean ? "#166534" : "#991b1b",
              borderRadius: 999,
              padding: "0.15rem 0.7rem",
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            {orphansClean
              ? `✓ All records assigned to a school (0 orphans)`
              : `✗ ${totalOrphans} orphan rows`}
          </span>
        </div>
        {!orphansClean && (
          <p style={{ color: "#991b1b", marginTop: 0, fontSize: 13 }}>
            Tables with orphans:&nbsp;
            {Object.entries(orphans)
              .filter(([, n]) => n > 0)
              .map(([k, n]) => `${tableLabels[k] ?? k} (${n})`)
              .join(", ")}
            .
          </p>
        )}
      </section>

      <section style={{ marginBottom: "0.5rem" }}>
        <h3 style={{ marginBottom: "0.5rem" }}>Per-school row counts</h3>
        <p style={{ color: "var(--text-subtle)", marginTop: 0, fontSize: 13 }}>
          Showing only schools with at least one row across the counted
          tables. Empty schools (incl. brand-new silos) are hidden so the
          grid stays readable when a district has many schools.
        </p>
        <div style={{ overflowX: "auto" }}>
          <table className="pulse-table"
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "0.9rem",
            }}
          >
            <thead>
              <tr
                style={{
                  borderBottom: "1px solid var(--border, #2a3447)",
                }}
              >
                <th style={{ textAlign: "left", padding: "0.4rem" }}>
                  Table
                </th>
                {visibleSchoolsForCounts.map((s) => (
                  <th key={s.id} style={headStyle}>
                    {s.shortName ?? s.name}
                    {s.isPrimary ? " ★" : ""}
                  </th>
                ))}
                <th style={headStyle}>Total</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(counts).map(([key, total]) => (
                <tr
                  key={key}
                  style={{
                    borderBottom: "1px solid var(--border, #2a3447)",
                  }}
                >
                  <td style={{ padding: "0.4rem", fontWeight: 600 }}>
                    {tableLabels[key] ?? key}
                  </td>
                  {visibleSchoolsForCounts.map((s) => {
                    const n = perSchool[key]?.[String(s.id)] ?? 0;
                    return (
                      <td
                        key={s.id}
                        style={{
                          ...cellStyle,
                          color:
                            n === 0 ? "var(--text-subtle)" : "inherit",
                        }}
                      >
                        {n.toLocaleString()}
                      </td>
                    );
                  })}
                  <td
                    style={{
                      ...cellStyle,
                      fontWeight: 700,
                    }}
                  >
                    {total.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
