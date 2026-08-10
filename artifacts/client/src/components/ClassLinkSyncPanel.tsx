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
      setBanner({
        tone: json.ok ? "ok" : json.status === "partial" ? "warn" : "err",
        text: `${row.syncButtonLabel}: ${json.message || json.error || "Done."}${counts}`,
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
                    {row.resolvedStateSchoolCode
                      ? ` · code ${row.resolvedStateSchoolCode}`
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
                    disabled={busy}
                    onClick={() => void runOne(row)}
                    style={{
                      padding: "8px 12px",
                      borderRadius: 8,
                      border: "none",
                      background: "#2563eb",
                      color: "#fff",
                      fontWeight: 600,
                      cursor: busy ? "wait" : "pointer",
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
