// SuperUser / District Admin ClassLink → PulseEDU sync control panel.
// Manual per-school sync, run-all, live roster counts, and staff
// set-password invite (email + copy-link fallback).

import { useCallback, useEffect, useState } from "react";
import { authFetch } from "../lib/authToken";
import {
  HowToUseHelp,
  HowToSection,
  RoleSection,
  howtoListStyle,
} from "./HowToUseHelp";

type LiveCounts = {
  students: number;
  staffActive: number;
  teachers: number;
  admins: number;
  otherStaff: number;
  pulseAdmins: number;
  needingPassword: number;
  sections: number;
  enrollments: number;
};

type IntegrationRow = {
  id: number;
  schoolName: string;
  sisProvider: string;
  sisLastSyncAt: string | null;
  sisLastSyncStatus: string | null;
  resolvedSchoolId: number | null;
  resolvedSchoolName: string | null;
  resolvedStateSchoolCode: string | null;
  configuredSchoolOrgSourcedId: string | null;
  configuredStateSchoolCode: string | null;
  syncButtonLabel: string;
  live: LiveCounts | null;
};

type DashboardResponse = {
  emailEnabled: boolean;
  mockMode: boolean;
  integrations: IntegrationRow[];
};

type SyncResult = {
  ok: boolean;
  status: string;
  schoolName: string;
  message: string;
  counts?: Record<string, number>;
  errors?: string[];
};

type InviteRow = {
  staffId: number;
  email: string;
  displayName: string;
  emailSent: boolean;
  emailStatus: string;
  resetUrl: string;
  emailError?: string;
};

type DiscoveredSchool = {
  sourcedId: string;
  name: string;
  identifier: string | null;
  stateCode: string | null;
};

type DiscoveryResponse = {
  newSchools: DiscoveredSchool[];
  skippedNoCode: DiscoveredSchool[];
  existingCount: number;
  totalFeedSchools: number;
  usingFixtures: boolean;
};

function formatWhen(iso: string | null): string {
  if (!iso) return "Never";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function statusColor(status: string | null): string {
  if (!status) return "var(--muted, #6b7280)";
  const s = status.toLowerCase();
  if (s === "success") return "#15803d";
  if (s === "partial") return "#a16207";
  if (s === "failed") return "#b91c1c";
  return "var(--muted, #6b7280)";
}

function StatChip({ label, value }: { label: string; value: number }) {
  return (
    <div
      style={{
        minWidth: 88,
        padding: "10px 12px",
        background: "var(--surface-2, #f3f4f6)",
        borderRadius: 8,
      }}
    >
      <div
        style={{
          fontSize: 11,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          color: "var(--muted, #6b7280)",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.1 }}>
        {value.toLocaleString()}
      </div>
    </div>
  );
}

export default function ClassLinkSyncPanel() {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | "all" | null>(null);
  const [banner, setBanner] = useState<{
    tone: "ok" | "warn" | "err";
    text: string;
  } | null>(null);
  const [inviteResults, setInviteResults] = useState<{
    schoolName: string;
    invites: InviteRow[];
    message: string;
  } | null>(null);
  // "Check for new schools" flow: null = closed; otherwise the discovery
  // result plus which sourcedIds the admin has ticked for onboarding.
  const [discovery, setDiscovery] = useState<DiscoveryResponse | null>(null);
  const [selectedOrgIds, setSelectedOrgIds] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await authFetch("/api/sis-sync/district-dashboard");
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error || `Failed to load (${res.status})`);
      }
      const json = (await res.json()) as DashboardResponse;
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function runOne(row: IntegrationRow) {
    setBusyId(row.id);
    setBanner(null);
    setInviteResults(null);
    try {
      const res = await authFetch(`/api/sis-sync/run/${row.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const json = (await res.json()) as SyncResult & { error?: string };
      if (!res.ok && !json.message) {
        throw new Error(json.error || `Sync failed (${res.status})`);
      }
      const counts = json.counts
        ? ` students ${json.counts.studentsUpserted ?? 0}, staff ${json.counts.staffUpserted ?? 0}, sections ${json.counts.sectionsWritten ?? 0}`
        : "";
      const warnBits = (json.errors ?? []).slice(0, 2).join(" · ");
      setBanner({
        tone: json.ok
          ? json.status === "partial"
            ? "warn"
            : "ok"
          : json.status === "partial"
            ? "warn"
            : "err",
        text: `${row.syncButtonLabel}: ${json.message || json.error || "Done."}${counts}${
          warnBits && json.status === "partial" ? ` — ${warnBits}` : ""
        }`,
      });
      await load();
    } catch (err) {
      setBanner({
        tone: "err",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusyId(null);
    }
  }

  async function runAll() {
    setBusyId("all");
    setBanner(null);
    setInviteResults(null);
    try {
      const res = await authFetch("/api/sis-sync/run-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const json = (await res.json()) as {
        ok: boolean;
        message: string;
        error?: string;
        results?: SyncResult[];
      };
      if (!res.ok) {
        throw new Error(json.error || `Sync-all failed (${res.status})`);
      }
      const failed = (json.results ?? []).filter((r) => !r.ok).length;
      setBanner({
        tone: json.ok ? "ok" : failed > 0 ? "warn" : "err",
        text: json.message,
      });
      await load();
    } catch (err) {
      setBanner({
        tone: "err",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusyId(null);
    }
  }

  async function inviteSchool(row: IntegrationRow) {
    if (row.resolvedSchoolId == null) {
      setBanner({
        tone: "err",
        text: `${row.schoolName} is not mapped to a PulseEDU school yet.`,
      });
      return;
    }
    setBusyId(row.id);
    setBanner(null);
    try {
      const res = await authFetch("/api/sis-sync/invite-passwords", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          integrationId: row.id,
          onlyNeedingPassword: true,
        }),
      });
      const json = (await res.json()) as {
        message?: string;
        error?: string;
        invites?: InviteRow[];
        emailSent?: number;
        invited?: number;
      };
      if (!res.ok) {
        throw new Error(json.error || `Invite failed (${res.status})`);
      }
      setInviteResults({
        schoolName: row.schoolName,
        invites: json.invites ?? [],
        message: json.message ?? "Invites created.",
      });
      setBanner({
        tone: "ok",
        text: `${row.schoolName}: ${json.message}`,
      });
      await load();
    } catch (err) {
      setBanner({
        tone: "err",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusyId(null);
    }
  }

  async function checkNewSchools() {
    setBusyId("all");
    setBanner(null);
    setInviteResults(null);
    try {
      const res = await authFetch("/api/sis-sync/discover-schools");
      const json = (await res.json()) as DiscoveryResponse & { error?: string };
      if (!res.ok) {
        throw new Error(json.error || `Discovery failed (${res.status})`);
      }
      if (json.newSchools.length === 0) {
        setBanner({
          tone: "ok",
          text: `No new schools in the ClassLink feed — all ${json.existingCount} school org(s) are already in PulseEDU.`,
        });
        return;
      }
      // Nothing pre-ticked: adding a school is an explicit, per-school choice
      // (the feed can contain schools the district hasn't purchased).
      setSelectedOrgIds(new Set());
      setDiscovery(json);
    } catch (err) {
      setBanner({
        tone: "err",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusyId(null);
    }
  }

  async function onboardSelected() {
    if (selectedOrgIds.size === 0) return;
    setBusyId("all");
    setBanner(null);
    try {
      const res = await authFetch("/api/sis-sync/onboard-schools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourcedIds: [...selectedOrgIds] }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        message?: string;
        error?: string;
        onboarded?: Array<{ name: string }>;
      };
      if (!res.ok) {
        throw new Error(json.error || `Onboarding failed (${res.status})`);
      }
      setDiscovery(null);
      setSelectedOrgIds(new Set());
      setBanner({
        tone: json.ok ? "ok" : "warn",
        text: json.message ?? "Done.",
      });
      await load();
    } catch (err) {
      setBanner({
        tone: "err",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusyId(null);
    }
  }

  function toggleOrg(sourcedId: string) {
    setSelectedOrgIds((prev) => {
      const next = new Set(prev);
      if (next.has(sourcedId)) next.delete(sourcedId);
      else next.add(sourcedId);
      return next;
    });
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setBanner({ tone: "ok", text: "Link copied to clipboard." });
    } catch {
      setBanner({
        tone: "warn",
        text: "Could not copy automatically — select the link manually.",
      });
    }
  }

  if (loading) {
    return <p style={{ padding: 24 }}>Loading ClassLink sync console…</p>;
  }

  if (error) {
    return (
      <div style={{ padding: 24 }}>
        <p style={{ color: "#b91c1c" }}>{error}</p>
        <button type="button" onClick={() => void load()}>
          Retry
        </button>
      </div>
    );
  }

  const integrations = data?.integrations ?? [];
  const busy = busyId !== null;

  return (
    <div style={{ padding: "8px 4px 32px", maxWidth: 1100 }}>
      <HowToUseHelp title="How to use ClassLink Sync">
        <HowToSection title="What this page is">
          District control panel for pulling ClassLink OneRoster data into
          PulseEDU without waiting on the nightly cron. Use it to verify
          counts, re-run a school sync after ClassLink changes, and hand staff
          a set-password invite when SSO is not available.
        </HowToSection>
        <RoleSection for={["districtAdmin", "superUser"]} title="Workflow">
          <ol style={howtoListStyle}>
            <li>
              Sync one school (or Sync all) and confirm students / teachers /
              admins / sections match expectations.
            </li>
            <li>
              For staff still needing a password, use Invite passwords — email
              when enabled, otherwise copy the link and send it yourself.
            </li>
            <li>
              New ClassLink administrators are flagged as PulseEDU admins on
              first import only.
            </li>
            <li>
              When the district adds a school to ClassLink, use Check for new
              schools to review and add it here, then run that school's Sync
              button to pull its roster.
            </li>
          </ol>
        </RoleSection>
      </HowToUseHelp>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 12,
          margin: "16px 0 20px",
        }}
      >
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700 }}>
          ClassLink Sync
        </h1>
        <button
          type="button"
          disabled={busy || integrations.length === 0}
          onClick={() => void runAll()}
          style={{
            padding: "8px 14px",
            borderRadius: 8,
            border: "none",
            background: "#0f766e",
            color: "#fff",
            fontWeight: 600,
            cursor: busy ? "wait" : "pointer",
          }}
        >
          {busyId === "all" ? "Syncing all…" : "Sync all schools"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void load()}
          style={{
            padding: "8px 14px",
            borderRadius: 8,
            border: "1px solid var(--border, #d1d5db)",
            background: "transparent",
            fontWeight: 600,
            cursor: busy ? "wait" : "pointer",
          }}
        >
          Refresh counts
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void checkNewSchools()}
          style={{
            padding: "8px 14px",
            borderRadius: 8,
            border: "1px solid var(--border, #d1d5db)",
            background: "transparent",
            fontWeight: 600,
            cursor: busy ? "wait" : "pointer",
          }}
        >
          Check for new schools
        </button>
        {data?.mockMode && (
          <span style={{ fontSize: 13, color: "#a16207" }}>
            CLASSLINK_MOCK is on (fixture mode)
          </span>
        )}
        {data && !data.emailEnabled && (
          <span style={{ fontSize: 13, color: "#a16207" }}>
            EMAIL_ENABLED is off — invites return copy links only
          </span>
        )}
      </div>

      {banner && (
        <div
          role="status"
          style={{
            marginBottom: 16,
            padding: "12px 14px",
            borderRadius: 8,
            background:
              banner.tone === "ok"
                ? "#ecfdf5"
                : banner.tone === "warn"
                  ? "#fffbeb"
                  : "#fef2f2",
            color:
              banner.tone === "ok"
                ? "#065f46"
                : banner.tone === "warn"
                  ? "#92400e"
                  : "#991b1b",
            border: `1px solid ${
              banner.tone === "ok"
                ? "#a7f3d0"
                : banner.tone === "warn"
                  ? "#fde68a"
                  : "#fecaca"
            }`,
          }}
        >
          {banner.text}
        </div>
      )}

      {integrations.length === 0 && (
        <p style={{ color: "var(--muted, #6b7280)" }}>
          No ClassLink integrations configured in district_integrations yet.
        </p>
      )}

      {discovery && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="New ClassLink schools"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 60,
            background: "rgba(15, 23, 42, 0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
        >
          <div
            style={{
              width: "100%",
              maxWidth: 560,
              maxHeight: "85vh",
              overflowY: "auto",
              background: "var(--surface, #fff)",
              borderRadius: 12,
              padding: 20,
              boxShadow: "0 20px 45px rgba(15, 23, 42, 0.25)",
            }}
          >
            <h3 style={{ margin: "0 0 6px", fontSize: 18 }}>
              New schools in the ClassLink feed
            </h3>
            <p
              style={{
                margin: "0 0 14px",
                fontSize: 13,
                color: "var(--muted, #6b7280)",
              }}
            >
              {discovery.totalFeedSchools} school org(s) in the feed ·{" "}
              {discovery.existingCount} already in PulseEDU ·{" "}
              {discovery.newSchools.length} new. Tick the schools to add — only
              ticked schools are created. Rosters are pulled afterwards with
              each school's Sync button.
              {discovery.usingFixtures
                ? " (CLASSLINK_MOCK fixture data)"
                : ""}
            </p>
            <div style={{ display: "grid", gap: 8, marginBottom: 14 }}>
              {discovery.newSchools.map((org) => (
                <label
                  key={org.sourcedId}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 10,
                    padding: "10px 12px",
                    border: "1px solid var(--border, #e5e7eb)",
                    borderRadius: 8,
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selectedOrgIds.has(org.sourcedId)}
                    onChange={() => toggleOrg(org.sourcedId)}
                    style={{ marginTop: 3 }}
                  />
                  <span>
                    <span style={{ fontWeight: 600 }}>{org.name}</span>
                    <span
                      style={{
                        display: "block",
                        fontSize: 12,
                        color: "var(--muted, #6b7280)",
                      }}
                    >
                      State code {org.stateCode ?? "—"} · orgId {org.sourcedId}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            {discovery.skippedNoCode.length > 0 && (
              <p style={{ fontSize: 12, color: "#a16207", marginBottom: 14 }}>
                {discovery.skippedNoCode.length} org(s) have no state code and
                cannot be onboarded:{" "}
                {discovery.skippedNoCode.map((o) => o.name).join(", ")}
              </p>
            )}
            <div
              style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}
            >
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setDiscovery(null);
                  setSelectedOrgIds(new Set());
                }}
                style={{
                  padding: "8px 14px",
                  borderRadius: 8,
                  border: "1px solid var(--border, #d1d5db)",
                  background: "transparent",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy || selectedOrgIds.size === 0}
                onClick={() => void onboardSelected()}
                style={{
                  padding: "8px 14px",
                  borderRadius: 8,
                  border: "none",
                  background:
                    selectedOrgIds.size === 0 ? "#9ca3af" : "#0f766e",
                  color: "#fff",
                  fontWeight: 600,
                  cursor:
                    busy || selectedOrgIds.size === 0
                      ? "not-allowed"
                      : "pointer",
                }}
              >
                {busyId === "all"
                  ? "Adding…"
                  : `Add ${selectedOrgIds.size} school${selectedOrgIds.size === 1 ? "" : "s"}`}
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={{ display: "grid", gap: 16 }}>
        {integrations.map((row) => {
          const live = row.live;
          const syncing = busyId === row.id;
          return (
            <section
              key={row.id}
              style={{
                border: "1px solid var(--border, #e5e7eb)",
                borderRadius: 12,
                padding: 16,
                background: "var(--surface, #fff)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 12,
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                  marginBottom: 12,
                }}
              >
                <div>
                  <h2 style={{ margin: "0 0 4px", fontSize: 18 }}>
                    {row.schoolName}
                  </h2>
                  <div style={{ fontSize: 13, color: "var(--muted, #6b7280)" }}>
                    Provider: {row.sisProvider}
                    {row.resolvedSchoolId != null
                      ? ` · Pulse school #${row.resolvedSchoolId}`
                      : " · Not mapped"}
                    {row.resolvedSchoolName &&
                    row.resolvedSchoolName !== row.schoolName
                      ? ` (${row.resolvedSchoolName})`
                      : ""}
                    {row.resolvedStateSchoolCode
                      ? ` · code ${row.resolvedStateSchoolCode}`
                      : ""}
                    {row.configuredSchoolOrgSourcedId
                      ? ` · orgId ${row.configuredSchoolOrgSourcedId}`
                      : ""}
                  </div>
                  <div style={{ fontSize: 13, marginTop: 4 }}>
                    Last sync: {formatWhen(row.sisLastSyncAt)} ·{" "}
                    <span style={{ color: statusColor(row.sisLastSyncStatus) }}>
                      {row.sisLastSyncStatus ?? "n/a"}
                    </span>
                  </div>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <button
                    type="button"
                    disabled={busy || row.sisProvider === "none"}
                    onClick={() => void runOne(row)}
                    style={{
                      padding: "8px 12px",
                      borderRadius: 8,
                      border: "none",
                      background: row.sisProvider === "none" ? "#9ca3af" : "#2563eb",
                      color: "#fff",
                      fontWeight: 600,
                      cursor: busy || row.sisProvider === "none" ? "not-allowed" : "pointer",
                    }}
                  >
                    {syncing ? "Syncing…" : row.syncButtonLabel}
                  </button>
                  <button
                    type="button"
                    disabled={busy || row.resolvedSchoolId == null}
                    onClick={() => void inviteSchool(row)}
                    style={{
                      padding: "8px 12px",
                      borderRadius: 8,
                      border: "1px solid var(--border, #d1d5db)",
                      background: "transparent",
                      fontWeight: 600,
                      cursor: busy ? "wait" : "pointer",
                    }}
                  >
                    Invite passwords
                    {live && live.needingPassword > 0
                      ? ` (${live.needingPassword})`
                      : ""}
                  </button>
                </div>
              </div>

              {live ? (
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 8,
                  }}
                >
                  <StatChip label="Students" value={live.students} />
                  <StatChip label="Teachers" value={live.teachers} />
                  <StatChip label="SIS admins" value={live.admins} />
                  <StatChip label="Other staff" value={live.otherStaff} />
                  <StatChip label="Pulse admins" value={live.pulseAdmins} />
                  <StatChip label="Need password" value={live.needingPassword} />
                  <StatChip label="Sections" value={live.sections} />
                  <StatChip label="Enrollments" value={live.enrollments} />
                </div>
              ) : (
                <p style={{ margin: 0, color: "var(--muted, #6b7280)" }}>
                  Map this integration to a PulseEDU school (sis_config
                  stateSchoolCode / schoolId) to see live counts.
                </p>
              )}
            </section>
          );
        })}
      </div>

      {inviteResults && inviteResults.invites.length > 0 && (
        <section style={{ marginTop: 28 }}>
          <h3 style={{ marginBottom: 8 }}>
            Password invites — {inviteResults.schoolName}
          </h3>
          <p style={{ fontSize: 13, color: "var(--muted, #6b7280)" }}>
            {inviteResults.message} Links expire in 30 minutes.
          </p>
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 13,
              }}
            >
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>
                  <th style={{ padding: "8px 6px" }}>Name</th>
                  <th style={{ padding: "8px 6px" }}>Email</th>
                  <th style={{ padding: "8px 6px" }}>Email status</th>
                  <th style={{ padding: "8px 6px" }}>Copy link</th>
                </tr>
              </thead>
              <tbody>
                {inviteResults.invites.map((inv) => (
                  <tr
                    key={inv.staffId}
                    style={{ borderBottom: "1px solid #f3f4f6" }}
                  >
                    <td style={{ padding: "8px 6px" }}>{inv.displayName}</td>
                    <td style={{ padding: "8px 6px" }}>{inv.email}</td>
                    <td style={{ padding: "8px 6px" }}>
                      {inv.emailSent ? "sent" : inv.emailStatus}
                      {inv.emailError ? ` — ${inv.emailError}` : ""}
                    </td>
                    <td style={{ padding: "8px 6px" }}>
                      <button
                        type="button"
                        onClick={() => void copyText(inv.resetUrl)}
                        style={{
                          padding: "4px 8px",
                          borderRadius: 6,
                          border: "1px solid #d1d5db",
                          background: "#fff",
                          cursor: "pointer",
                        }}
                      >
                        Copy
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
