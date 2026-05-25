// SuperUser Home — live cross-district rollup tiles. Replaces the
// placeholder PlaceholderCard grid. Three layers:
//   1) Four headline stat tiles (Districts / Schools / Students / Staff).
//   2) "Onboard a District" CTA that opens OnboardDistrictModal.
//   3) Per-district summary cards (school count, student count, staff
//      count, last-activity timestamp).
//
// Roadmap cards (Cross-District Reports, Global Feature Flags, Audit &
// Health) stay accessible inside a collapsed <details> below — the
// landing page leads with what works today.

import { useCallback, useEffect, useState } from "react";
import { authFetch } from "../../lib/authToken";
import OnboardDistrictModal from "./OnboardDistrictModal";
import OnboardSchoolModal from "./OnboardSchoolModal";
import EditDistrictModal from "./EditDistrictModal";
import { SlideConfirmModal } from "../PrivacyGate";

type DistrictSummary = {
  id: number;
  name: string;
  slug: string;
  stateDistrictCode: string | null;
  timezone: string;
  active: boolean;
  schoolCount: number;
  studentCount: number;
  staffCount: number;
  lastActivityAt: string | null;
};

type Overview = {
  totals: {
    districts: number;
    schools: number;
    students: number;
    staff: number;
  };
  districts: DistrictSummary[];
};

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div
      style={{
        border: "1px solid var(--border, #e2e8f0)",
        borderRadius: "var(--radius-sm, 8px)",
        background: "var(--surface, #fff)",
        padding: "0.85rem 1rem",
      }}
    >
      <div
        style={{
          fontSize: "0.75rem",
          color: "var(--text-subtle)",
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: "1.75rem", fontWeight: 700, marginTop: 4 }}>
        {value.toLocaleString()}
      </div>
    </div>
  );
}

function formatLastActivity(iso: string | null): string {
  if (!iso) return "No recent activity";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "No recent activity";
  const ms = Date.now() - d.getTime();
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  return d.toLocaleDateString();
}

export default function SuperUserHomeRollups() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showOnboard, setShowOnboard] = useState(false);
  const [addSchoolFor, setAddSchoolFor] = useState<
    { id: number; name: string } | null
  >(null);
  const [editing, setEditing] = useState<DistrictSummary | null>(null);
  const [togglingActive, setTogglingActive] = useState<number | null>(null);
  // Deactivation goes through a slide-to-confirm modal (same blur +
  // drag pattern as the teacher-roster PrivacyGate). A stray click on
  // a district row's "Deactivate" button would otherwise lock every
  // school in that district out of the app.
  const [pendingDeactivate, setPendingDeactivate] =
    useState<DistrictSummary | null>(null);
  const [seedBusy, setSeedBusy] = useState(false);
  const [seedResult, setSeedResult] = useState<string | null>(null);

  async function runSeedDemoCases() {
    if (
      !window.confirm(
        "Seed Parrott (school 1) demo data?\n\nPopulates parent emails + phones, emergency contacts, demo cases, OSS/ISS logs, and support notes. Idempotent — safe to re-click.",
      )
    )
      return;
    setSeedBusy(true);
    setSeedResult(null);
    try {
      const res = await authFetch("/api/admin/seed-demo-school-1", {
        method: "POST",
      });
      const body = (await res.json().catch(() => ({}))) as {
        parentEmails?: number;
        parentPhones?: number;
        emergencyContacts?: number;
        cases?: Array<{ title: string; status: string; caseNumber?: number }>;
        sideInteractions?: number;
        supportNotes?: number;
        ossLogs?: number;
        issAdminLogs?: number;
        error?: string;
        message?: string;
      };
      if (!res.ok) {
        throw new Error(body.message || body.error || `HTTP ${res.status}`);
      }
      const caseLines = (body.cases ?? [])
        .map(
          (c) =>
            `   • ${c.title} — ${c.status}${c.caseNumber ? ` (#${c.caseNumber})` : ""}`,
        )
        .join("\n");
      setSeedResult(
        [
          "Seed complete:",
          `• Parent emails filled: ${body.parentEmails ?? 0}`,
          `• Parent phones filled: ${body.parentPhones ?? 0}`,
          `• Emergency contacts added: ${body.emergencyContacts ?? 0}`,
          `• Support notes: ${body.supportNotes ?? 0}`,
          `• OSS logs: ${body.ossLogs ?? 0}`,
          `• ISS admin logs: ${body.issAdminLogs ?? 0}`,
          `• Side interactions: ${body.sideInteractions ?? 0}`,
          `• Cases:`,
          caseLines || "   (none)",
        ].join("\n"),
      );
    } catch (e) {
      setSeedResult(`Seed failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSeedBusy(false);
    }
  }

  const reload = useCallback(async () => {
    try {
      const res = await authFetch("/api/superuser/overview");
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

  // Reactivation is a recoverable, additive action — a plain confirm
  // is enough. Deactivation routes through the slide-to-confirm modal
  // (see pendingDeactivate / applyToggle below).
  async function toggleActive(d: DistrictSummary) {
    if (d.active) {
      setPendingDeactivate(d);
      return;
    }
    if (
      !window.confirm(
        `Reactivate ${d.name}?\n\nIt will reappear as a working tenant.`,
      )
    )
      return;
    await applyToggle(d, true);
  }

  async function applyToggle(d: DistrictSummary, next: boolean) {
    setTogglingActive(d.id);
    try {
      const res = await authFetch(`/api/tenancy/districts/${d.id}`, {
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
      {/* Headline stat tiles */}
      <div
        style={{
          display: "grid",
          gap: "0.75rem",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
        }}
      >
        <StatTile label="Districts" value={data.totals.districts} />
        <StatTile label="Schools" value={data.totals.schools} />
        <StatTile label="Students" value={data.totals.students} />
        <StatTile label="Staff" value={data.totals.staff} />
      </div>

      {/* Onboard CTA */}
      <div style={{ marginTop: "1rem", display: "flex", gap: "0.5rem" }}>
        <button
          type="button"
          onClick={() => setShowOnboard(true)}
          style={{
            padding: "0.55rem 1rem",
            border: "none",
            borderRadius: 6,
            background: "var(--primary, #2563eb)",
            color: "#fff",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          + Onboard a District
        </button>
        <button
          type="button"
          onClick={() => void reload()}
          style={{
            padding: "0.55rem 1rem",
            border: "1px solid var(--border, #e2e8f0)",
            borderRadius: 6,
            background: "var(--surface, #fff)",
            cursor: "pointer",
          }}
        >
          Refresh
        </button>
        <button
          type="button"
          onClick={() => void runSeedDemoCases()}
          disabled={seedBusy}
          title="Populate Parrott (school 1) with parent emails + phones, emergency contacts, demo cases, OSS/ISS logs, and support notes. Idempotent."
          style={{
            padding: "0.55rem 1rem",
            border: "1px solid var(--border, #e2e8f0)",
            borderRadius: 6,
            background: "var(--surface, #fff)",
            cursor: seedBusy ? "wait" : "pointer",
            opacity: seedBusy ? 0.6 : 1,
          }}
        >
          {seedBusy ? "Seeding…" : "Seed demo data (Parrott)"}
        </button>
      </div>
      {seedResult && (
        <pre
          style={{
            marginTop: "0.5rem",
            padding: "0.5rem 0.75rem",
            background: "var(--surface-subtle, #f8fafc)",
            border: "1px solid var(--border, #e2e8f0)",
            borderRadius: 6,
            fontSize: "0.8rem",
            whiteSpace: "pre-wrap",
          }}
        >
          {seedResult}
        </pre>
      )}

      {/* Per-district summary cards */}
      <h3 style={{ marginTop: "1.5rem", marginBottom: "0.5rem" }}>Districts</h3>
      {data.districts.length === 0 ? (
        <p style={{ color: "var(--text-subtle)" }}>
          No districts yet. Click "Onboard a District" to create the first.
        </p>
      ) : (
        <div
          style={{
            display: "grid",
            gap: "0.75rem",
            gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          }}
        >
          {data.districts.map((d) => (
            <div
              key={d.id}
              style={{
                border: "1px solid var(--border, #e2e8f0)",
                borderRadius: "var(--radius-sm, 8px)",
                background: "var(--surface, #fff)",
                padding: "0.85rem 1rem",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <div style={{ fontWeight: 600 }}>{d.name}</div>
                {!d.active && (
                  <span
                    style={{
                      fontSize: "0.7rem",
                      color: "#b91c1c",
                      background: "#fee2e2",
                      padding: "0.1rem 0.4rem",
                      borderRadius: 4,
                    }}
                  >
                    Inactive
                  </span>
                )}
              </div>
              <div
                style={{
                  fontSize: "0.75rem",
                  color: "var(--text-subtle)",
                  marginTop: 2,
                }}
              >
                {d.slug}
                {d.stateDistrictCode ? ` · code ${d.stateDistrictCode}` : ""}
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(3, 1fr)",
                  gap: 8,
                  marginTop: "0.75rem",
                }}
              >
                <div>
                  <div style={{ fontSize: "0.7rem", color: "var(--text-subtle)" }}>
                    Schools
                  </div>
                  <div style={{ fontSize: "1.15rem", fontWeight: 600 }}>
                    {d.schoolCount.toLocaleString()}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: "0.7rem", color: "var(--text-subtle)" }}>
                    Students
                  </div>
                  <div style={{ fontSize: "1.15rem", fontWeight: 600 }}>
                    {d.studentCount.toLocaleString()}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: "0.7rem", color: "var(--text-subtle)" }}>
                    Staff
                  </div>
                  <div style={{ fontSize: "1.15rem", fontWeight: 600 }}>
                    {d.staffCount.toLocaleString()}
                  </div>
                </div>
              </div>
              <div
                style={{
                  marginTop: "0.75rem",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <div
                  style={{
                    fontSize: "0.75rem",
                    color: "var(--text-subtle)",
                  }}
                >
                  Last activity: {formatLastActivity(d.lastActivityAt)}
                </div>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    onClick={() => setEditing(d)}
                    style={cardBtn}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => void toggleActive(d)}
                    disabled={togglingActive !== null}
                    style={{
                      ...cardBtn,
                      color: d.active ? "#b91c1c" : "#15803d",
                      opacity: togglingActive === d.id ? 0.6 : 1,
                    }}
                  >
                    {togglingActive === d.id
                      ? "…"
                      : d.active
                        ? "Deactivate"
                        : "Reactivate"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setAddSchoolFor({ id: d.id, name: d.name })}
                    disabled={!d.active}
                    title={!d.active ? "Reactivate the district first" : undefined}
                    style={{
                      ...cardBtn,
                      opacity: d.active ? 1 : 0.4,
                      cursor: d.active ? "pointer" : "not-allowed",
                    }}
                  >
                    + Add school
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showOnboard && (
        <OnboardDistrictModal
          onClose={() => setShowOnboard(false)}
          onCreated={() => {
            setShowOnboard(false);
            void reload();
          }}
        />
      )}
      {addSchoolFor && (
        <OnboardSchoolModal
          district={addSchoolFor}
          onClose={() => setAddSchoolFor(null)}
          onCreated={() => {
            setAddSchoolFor(null);
            void reload();
          }}
        />
      )}
      {editing && (
        <EditDistrictModal
          district={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}

      <SlideConfirmModal
        open={!!pendingDeactivate}
        title={
          pendingDeactivate
            ? `Deactivate ${pendingDeactivate.name}?`
            : "Deactivate district?"
        }
        message={
          pendingDeactivate ? (
            <>
              You're about to deactivate{" "}
              <strong>{pendingDeactivate.name}</strong>. This will hide all{" "}
              <strong>
                {pendingDeactivate.schoolCount.toLocaleString()} school
                {pendingDeactivate.schoolCount === 1 ? "" : "s"}
              </strong>{" "}
              from rollups and lock out{" "}
              <strong>
                {pendingDeactivate.staffCount.toLocaleString()} staff
              </strong>{" "}
              and every student in this district. Existing data is preserved
              and can be restored by reactivating. Make sure no one in this
              district is mid-session before continuing.
            </>
          ) : null
        }
        sliderIdleLabel="SLIDE TO DEACTIVATE DISTRICT →"
        sliderDoneLabel="DEACTIVATING…"
        sliderAriaLabel="Slide to deactivate district"
        footerHint="Slide the handle all the way to the right to deactivate."
        cancelLabel="Keep district active"
        onCancel={() => setPendingDeactivate(null)}
        onConfirm={() => {
          const d = pendingDeactivate;
          if (!d) return;
          setPendingDeactivate(null);
          void applyToggle(d, false);
        }}
      />
    </div>
  );
}

const cardBtn: React.CSSProperties = {
  padding: "0.3rem 0.6rem",
  fontSize: "0.75rem",
  border: "1px solid var(--border, #e2e8f0)",
  borderRadius: 6,
  background: "var(--surface, #fff)",
  cursor: "pointer",
  whiteSpace: "nowrap",
};
