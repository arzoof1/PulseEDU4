import { useCallback, useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/authToken";
import { HowToUseHelp, HowToSection, RoleSection, howtoListStyle } from "./HowToUseHelp";

type InviteStatus =
  | "not_sent"
  | "no_email"
  | "pending"
  | "accepted"
  | "expired"
  | "revoked";

interface InviteRow {
  id: number;
  email: string;
  status: InviteStatus;
  sentAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  acceptedParentName: string | null;
  acceptedLastLoginAt: string | null;
  resendCount: number;
  lastResentAt: string | null;
}

interface StudentRow {
  student: {
    id: number;
    studentId: string;
    localSisId: string | null;
    firstName: string;
    lastName: string;
    grade: string | null;
    parentName: string | null;
    parentEmail: string | null;
  };
  overallStatus: InviteStatus;
  invites: InviteRow[];
}

const STATUS_COLOR: Record<InviteStatus, { bg: string; fg: string; label: string }> = {
  not_sent: { bg: "#1f2937", fg: "#9ca3af", label: "Not sent" },
  no_email: { bg: "#3f1d1d", fg: "#fca5a5", label: "No email on file" },
  pending: { bg: "#1e3a5c", fg: "#93c5fd", label: "Pending" },
  accepted: { bg: "#14532d", fg: "#86efac", label: "Accepted" },
  expired: { bg: "#3f2d1d", fg: "#fcd34d", label: "Expired" },
  revoked: { bg: "#3f1d1d", fg: "#fca5a5", label: "Revoked" },
};

function StatusPill({ status }: { status: InviteStatus }) {
  const c = STATUS_COLOR[status];
  return (
    <span
      style={{
        background: c.bg,
        color: c.fg,
        fontSize: 11,
        fontWeight: 600,
        padding: "0.15rem 0.55rem",
        borderRadius: 999,
        whiteSpace: "nowrap",
      }}
    >
      {c.label}
    </span>
  );
}

function fmtDate(s: string | null): string {
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const inputStyle: React.CSSProperties = {
  background: "var(--card-bg, rgba(255,255,255,0.03))",
  border: "1px solid var(--border, #2a3447)",
  borderRadius: 6,
  padding: "0.4rem 0.6rem",
  color: "inherit",
  font: "inherit",
  minWidth: 0,
  width: "100%",
};

const btnPrimary: React.CSSProperties = {
  background: "var(--accent, #3b82f6)",
  border: "1px solid var(--accent, #3b82f6)",
  color: "white",
  padding: "0.4rem 0.85rem",
  borderRadius: 6,
  cursor: "pointer",
  font: "inherit",
  fontWeight: 600,
  whiteSpace: "nowrap",
};

const btnGhost: React.CSSProperties = {
  background: "transparent",
  border: "1px solid var(--border, #2a3447)",
  color: "inherit",
  padding: "0.35rem 0.7rem",
  borderRadius: 6,
  cursor: "pointer",
  font: "inherit",
  whiteSpace: "nowrap",
};

const btnDanger: React.CSSProperties = {
  ...btnGhost,
  borderColor: "#7f1d1d",
  color: "#fca5a5",
};

export default function ParentAccess() {
  const [rows, setRows] = useState<StudentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | InviteStatus>("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  const showFlash = useCallback((kind: "ok" | "err", msg: string) => {
    setFlash({ kind, msg });
    window.setTimeout(() => setFlash(null), 4000);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await authFetch("/api/admin/parent-invites");
      if (!r.ok) throw new Error(`Failed to load (${r.status})`);
      const data = (await r.json()) as { rows: StudentRow[] };
      setRows(data.rows ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sendOne = useCallback(
    async (studentId: number, email: string, key: string) => {
      setBusyId(key);
      try {
        const r = await authFetch("/api/admin/parent-invites/send-one", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ studentId, email }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          showFlash("err", (j as { error?: string }).error ?? "Send failed");
          return false;
        }
        showFlash("ok", `Invite sent to ${email}`);
        await load();
        return true;
      } catch (err) {
        showFlash("err", err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        setBusyId(null);
      }
    },
    [load, showFlash],
  );

  const resendInvite = useCallback(
    async (inviteId: number) => {
      const key = `resend:${inviteId}`;
      setBusyId(key);
      try {
        const r = await authFetch(`/api/admin/parent-invites/${inviteId}/resend`, {
          method: "POST",
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          showFlash("err", (j as { error?: string }).error ?? "Resend failed");
          return;
        }
        showFlash("ok", "Invite resent.");
        await load();
      } catch (err) {
        showFlash("err", err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
      }
    },
    [load, showFlash],
  );

  const revokeInvite = useCallback(
    async (inviteId: number) => {
      if (!window.confirm("Revoke this invite? The link will stop working.")) return;
      const key = `revoke:${inviteId}`;
      setBusyId(key);
      try {
        const r = await authFetch(`/api/admin/parent-invites/${inviteId}/revoke`, {
          method: "POST",
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          showFlash("err", (j as { error?: string }).error ?? "Revoke failed");
          return;
        }
        showFlash("ok", "Invite revoked.");
        await load();
      } catch (err) {
        showFlash("err", err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
      }
    },
    [load, showFlash],
  );

  const sendAllEligible = useCallback(async () => {
    if (
      !window.confirm(
        "Send invites to every student who has a parent email on file and no live invite yet?",
      )
    )
      return;
    setBulkBusy(true);
    try {
      const r = await authFetch("/api/admin/parent-invites/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const j = (await r.json().catch(() => ({}))) as {
        results?: Array<{ status: string }>;
        error?: string;
      };
      if (!r.ok) {
        showFlash("err", j.error ?? "Bulk send failed");
        return;
      }
      const sent = (j.results ?? []).filter((x) => x.status === "sent").length;
      const skipped = (j.results ?? []).filter((x) => x.status === "skipped").length;
      const failed = (j.results ?? []).filter((x) => x.status === "failed").length;
      showFlash(
        "ok",
        `Sent ${sent}. Skipped ${skipped} (already invited or no email). ${failed ? `Failed ${failed}.` : ""}`,
      );
      await load();
    } catch (err) {
      showFlash("err", err instanceof Error ? err.message : String(err));
    } finally {
      setBulkBusy(false);
    }
  }, [load, showFlash]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return rows.filter((r) => {
      if (statusFilter !== "all" && r.overallStatus !== statusFilter) return false;
      if (!q) return true;
      const hay = [
        r.student.firstName,
        r.student.lastName,
        r.student.studentId,
        r.student.parentEmail ?? "",
        r.student.parentName ?? "",
        ...r.invites.map((i) => i.email),
        ...r.invites.map((i) => i.acceptedParentName ?? ""),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [rows, filter, statusFilter]);

  const counts = useMemo(() => {
    const c = { total: rows.length, accepted: 0, pending: 0, expired: 0, none: 0 };
    for (const r of rows) {
      if (r.overallStatus === "accepted") c.accepted++;
      else if (r.overallStatus === "pending") c.pending++;
      else if (r.overallStatus === "expired") c.expired++;
      else c.none++;
    }
    return c;
  }, [rows]);

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "1rem",
          flexWrap: "wrap",
          marginBottom: "0.75rem",
        }}
      >
        <div>
          <h2 style={{ margin: 0 }}>Parent Access</h2>
          <p style={{ color: "var(--text-subtle)", margin: "0.25rem 0 0" }}>
            Invite parents to the HeartBEAT Snapshot portal. Each parent gets an
            email link to set their own password.
          </p>
          <HowToUseHelp title="How to use Parent Access">
            <HowToSection title="What this page is">
              The roster of parent accounts for this school plus their
              linked students. Use "Invite parent" to create an account,
              then link one or more students to it.
            </HowToSection>
            <HowToSection title="What parents see in the portal">
              <ul style={howtoListStyle}>
                <li>HeartBEAT pillars (PBIS, hall passes, tardies, accommodations, staff notes).</li>
                <li>One row per linked student with a sibling switcher.</li>
                <li>PDF export of the current snapshot.</li>
              </ul>
              Use "Section visibility" to hide categories your school is
              not ready to expose to families yet.
            </HowToSection>
            <RoleSection for={["admin", "coreTeam"]} title="Daily admin tasks">
              Resend an invite if the email expired (links are good for
              7 days). "Revoke access" disables sign-in but keeps the
              account so audit data is preserved.
            </RoleSection>
          </HowToUseHelp>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <button
            type="button"
            style={btnGhost}
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
          <button
            type="button"
            style={btnPrimary}
            onClick={() => void sendAllEligible()}
            disabled={bulkBusy || loading}
          >
            {bulkBusy ? "Sending…" : "Send to all eligible"}
          </button>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: "0.5rem",
          marginBottom: "0.75rem",
        }}
      >
        <SummaryStat label="Students" value={counts.total} />
        <SummaryStat label="Accepted" value={counts.accepted} tone="ok" />
        <SummaryStat label="Pending" value={counts.pending} tone="info" />
        <SummaryStat label="Expired" value={counts.expired} tone="warn" />
        <SummaryStat label="No invite yet" value={counts.none} />
      </div>

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
          placeholder="Search by name, ID, or email…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ ...inputStyle, maxWidth: 320 }}
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
          style={{ ...inputStyle, maxWidth: 200 }}
        >
          <option value="all">All statuses</option>
          <option value="accepted">Accepted</option>
          <option value="pending">Pending</option>
          <option value="expired">Expired</option>
          <option value="not_sent">Not sent</option>
          <option value="no_email">No email</option>
        </select>
      </div>

      {flash && (
        <div
          style={{
            background: flash.kind === "ok" ? "#14532d" : "#3f1d1d",
            color: flash.kind === "ok" ? "#86efac" : "#fca5a5",
            border: `1px solid ${flash.kind === "ok" ? "#22c55e44" : "#ef444444"}`,
            padding: "0.5rem 0.75rem",
            borderRadius: 6,
            marginBottom: "0.75rem",
          }}
        >
          {flash.msg}
        </div>
      )}

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

      {loading && rows.length === 0 ? (
        <p style={{ color: "var(--text-subtle)" }}>Loading…</p>
      ) : filtered.length === 0 ? (
        <p style={{ color: "var(--text-subtle)" }}>
          {rows.length === 0 ? "No students in this school yet." : "No matches."}
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {filtered.map((row) => (
            <StudentInviteRow
              key={row.student.id}
              row={row}
              busyId={busyId}
              onSend={(email, key) => sendOne(row.student.id, email, key)}
              onResend={resendInvite}
              onRevoke={revokeInvite}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SummaryStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "ok" | "info" | "warn";
}) {
  const color =
    tone === "ok"
      ? "#86efac"
      : tone === "info"
        ? "#93c5fd"
        : tone === "warn"
          ? "#fcd34d"
          : "inherit";
  return (
    <div
      style={{
        border: "1px solid var(--border, #2a3447)",
        borderRadius: 8,
        padding: "0.5rem 0.75rem",
      }}
    >
      <div style={{ fontSize: 11, color: "var(--text-subtle)" }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}

async function previewAsParentOf(studentRowId: number): Promise<void> {
  // Staff-only "preview as parent" — see the parent-facing HeartBEAT for any
  // student in your school without going through invite + email + accept-pw.
  // Server creates/uses a sentinel parent and swaps the session cookie, so
  // this tab becomes the parent. Open in a new tab so the staff tab keeps
  // its own session.
  const win = window.open("", "_blank");
  try {
    const r = await authFetch("/api/admin/parent-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ studentRowId }),
    });
    if (!r.ok) {
      const text = await r.text();
      if (win) win.close();
      alert("Could not open preview: " + text);
      return;
    }
    if (win) {
      win.location.href = "/parent";
    } else {
      window.location.href = "/parent";
    }
  } catch (err) {
    if (win) win.close();
    alert("Could not open preview: " + (err as Error).message);
  }
}

function StudentInviteRow({
  row,
  busyId,
  onSend,
  onResend,
  onRevoke,
}: {
  row: StudentRow;
  busyId: string | null;
  onSend: (email: string, key: string) => Promise<boolean>;
  onResend: (inviteId: number) => Promise<void>;
  onRevoke: (inviteId: number) => Promise<void>;
}) {
  const { student, invites, overallStatus } = row;
  const fullName = `${student.lastName}, ${student.firstName}`;
  // Default email for the first send: prefer Skyward parent_email if no
  // invite has been created yet for this student.
  const initialEmail =
    invites.length === 0 && student.parentEmail ? student.parentEmail : "";
  const [draftEmail, setDraftEmail] = useState(initialEmail);
  const [showAddForm, setShowAddForm] = useState(invites.length === 0);
  const sendKey = `send:${student.id}`;
  const isSendingRow = busyId === sendKey;

  const handleSend = async () => {
    const email = draftEmail.trim();
    if (!email) return;
    const ok = await onSend(email, sendKey);
    if (ok) {
      setDraftEmail("");
      setShowAddForm(false);
    }
  };

  return (
    <div
      style={{
        border: "1px solid var(--border, #2a3447)",
        borderRadius: 8,
        padding: "0.75rem 0.85rem",
        background: "var(--card-bg, rgba(255,255,255,0.02))",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: "1rem",
          flexWrap: "wrap",
          marginBottom: invites.length === 0 ? 0 : "0.6rem",
        }}
      >
        <div>
          <div style={{ fontWeight: 600 }}>{fullName}</div>
          <div style={{ fontSize: 12, color: "var(--text-subtle)" }}>
            {/* Prefer the local SIS ID (Skyward / Focus) since that's
                what the front office uses. Fall back to the FLEID
                (canonical `student_id`) when the local ID hasn't
                been imported for this student. */}
            ID {student.localSisId ?? student.studentId}
            {student.grade ? ` · Grade ${student.grade}` : ""}
            {student.parentName ? ` · Skyward parent: ${student.parentName}` : ""}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <button
            type="button"
            style={btnGhost}
            title="Open the parent-facing HeartBEAT for this student in a new tab. Staff-only QA tool — no email sent, no real parent account created."
            onClick={() => void previewAsParentOf(student.id)}
          >
            Preview as parent
          </button>
          <StatusPill status={overallStatus} />
        </div>
      </div>

      {invites.length > 0 && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.4rem",
            marginBottom: "0.6rem",
          }}
        >
          {invites.map((inv) => (
            <div
              key={inv.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.6rem",
                flexWrap: "wrap",
                padding: "0.4rem 0.55rem",
                background: "rgba(255,255,255,0.02)",
                border: "1px solid var(--border, #2a3447)",
                borderRadius: 6,
              }}
            >
              <span style={{ fontFamily: "monospace", fontSize: 13, flex: "1 1 240px" }}>
                {inv.email}
              </span>
              <StatusPill status={inv.status} />
              <span style={{ fontSize: 11, color: "var(--text-subtle)" }}>
                {inv.status === "accepted"
                  ? `Accepted ${fmtDate(inv.acceptedAt)}${inv.acceptedParentName ? ` · ${inv.acceptedParentName}` : ""}${inv.acceptedLastLoginAt ? ` · last sign-in ${fmtDate(inv.acceptedLastLoginAt)}` : " · never signed in"}`
                  : inv.status === "pending"
                    ? `Sent ${fmtDate(inv.sentAt)} · expires ${fmtDate(inv.expiresAt)}${inv.resendCount ? ` · resent ${inv.resendCount}×` : ""}`
                    : inv.status === "expired"
                      ? `Sent ${fmtDate(inv.sentAt)} · expired ${fmtDate(inv.expiresAt)}`
                      : `Sent ${fmtDate(inv.sentAt)}`}
              </span>
              <div style={{ display: "flex", gap: "0.35rem", marginLeft: "auto" }}>
                {inv.status === "pending" && (
                  <button
                    type="button"
                    style={btnGhost}
                    disabled={busyId === `resend:${inv.id}`}
                    onClick={() => void onResend(inv.id)}
                  >
                    {busyId === `resend:${inv.id}` ? "…" : "Resend"}
                  </button>
                )}
                {(inv.status === "pending" || inv.status === "expired") && (
                  <button
                    type="button"
                    style={btnDanger}
                    disabled={busyId === `revoke:${inv.id}`}
                    onClick={() => void onRevoke(inv.id)}
                  >
                    {busyId === `revoke:${inv.id}` ? "…" : "Revoke"}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {showAddForm ? (
        <div
          style={{
            display: "flex",
            gap: "0.5rem",
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <input
            type="email"
            placeholder={
              invites.length === 0 ? "parent@example.com" : "Add another email (mom, dad, grandma…)"
            }
            value={draftEmail}
            onChange={(e) => setDraftEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleSend();
            }}
            style={{ ...inputStyle, flex: "1 1 240px" }}
          />
          <button
            type="button"
            style={btnPrimary}
            disabled={isSendingRow || !draftEmail.trim()}
            onClick={() => void handleSend()}
          >
            {isSendingRow ? "Sending…" : "Send invite"}
          </button>
          {invites.length > 0 && (
            <button
              type="button"
              style={btnGhost}
              onClick={() => {
                setShowAddForm(false);
                setDraftEmail("");
              }}
            >
              Cancel
            </button>
          )}
        </div>
      ) : (
        <button
          type="button"
          style={btnGhost}
          onClick={() => setShowAddForm(true)}
        >
          + Add another email
        </button>
      )}
    </div>
  );
}
