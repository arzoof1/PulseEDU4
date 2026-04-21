import { useEffect, useMemo, useState } from "react";

type BoolKey = string;

type StaffRow = {
  id: number;
  email: string;
  displayName: string;
  active: boolean;
  [key: string]: unknown;
};

type CustomRole = {
  id: number;
  key: string;
  label: string;
  capabilities: string[];
};

interface Props {
  currentUser: {
    id: number;
    isSuperUser?: boolean;
    isAdmin?: boolean;
    capManageRoles?: boolean;
  };
}

// Pages displayed as the columns of the matrix.
const PAGES: { key: BoolKey; label: string; group: string }[] = [
  { group: "Daily", key: "capHallPasses", label: "Hall Passes" },
  { group: "Daily", key: "capTardies", label: "Tardies" },
  { group: "Daily", key: "capStudentActivity", label: "Student Activity" },
  { group: "Daily", key: "capPbisAward", label: "PBIS Award" },
  { group: "Daily", key: "capParentEmail", label: "Parent Email" },
  { group: "Daily", key: "capSupportNotes", label: "Support Notes" },
  { group: "Daily", key: "capAccommodationLog", label: "Accommodation Log" },
  { group: "Daily", key: "capPulloutsRequest", label: "Request Pullout" },
  { group: "Daily", key: "capInterventionLog", label: "Log Intervention" },
  { group: "Daily", key: "capReports", label: "Reports" },
  { group: "Daily", key: "capKioskActivate", label: "Kiosk Activate" },
  { group: "Manage", key: "capHallPassesViewAll", label: "Hall Passes (All)" },
  { group: "Manage", key: "capPbisManage", label: "PBIS Manage" },
  { group: "Manage", key: "capAccommodationManage", label: "Accommodations Manage" },
  { group: "Manage", key: "capPulloutsVerify", label: "Verify Pullouts" },
  { group: "Manage", key: "capPulloutsReview", label: "Pullout Review" },
  { group: "Manage", key: "capInterventionManage", label: "Intervention Manage" },
  { group: "Manage", key: "capIssDashboard", label: "ISS Dashboard" },
  { group: "Manage", key: "capManageLocations", label: "Manage Locations" },
  { group: "Admin", key: "capStaffRoles", label: "Staff & Roles" },
  { group: "Admin", key: "capManageRoles", label: "Manage Roles" },
];

// Built-in roles that act as "preset" buttons. Clicking applies the
// capability bundle to the staff member.
const ROLE_PRESETS: {
  flag: BoolKey;
  label: string;
  capabilities: BoolKey[];
}[] = [
  {
    flag: "isSuperUser",
    label: "SuperUser",
    capabilities: PAGES.map((p) => p.key),
  },
  {
    flag: "isAdmin",
    label: "Admin",
    capabilities: PAGES.map((p) => p.key),
  },
  {
    flag: "isBehaviorSpecialist",
    label: "Behavior Specialist",
    capabilities: [
      "capHallPasses",
      "capTardies",
      "capStudentActivity",
      "capPbisAward",
      "capSupportNotes",
      "capInterventionLog",
      "capPulloutsRequest",
      "capPulloutsReview",
      "capInterventionManage",
    ],
  },
  {
    flag: "isEseCoordinator",
    label: "ESE Coordinator",
    capabilities: [
      "capHallPasses",
      "capStudentActivity",
      "capAccommodationLog",
      "capAccommodationManage",
      "capReports",
    ],
  },
  {
    flag: "isCounselor",
    label: "School Counselor",
    capabilities: [
      "capStudentActivity",
      "capSupportNotes",
      "capPbisAward",
      "capInterventionLog",
    ],
  },
  {
    flag: "isDean",
    label: "Dean of Students",
    capabilities: [
      "capHallPasses",
      "capTardies",
      "capStudentActivity",
      "capSupportNotes",
      "capPulloutsRequest",
      "capPulloutsVerify",
      "capIssDashboard",
      "capInterventionLog",
      "capHallPassesViewAll",
    ],
  },
  {
    flag: "isMtssCoordinator",
    label: "MTSS",
    capabilities: [
      "capStudentActivity",
      "capInterventionLog",
      "capInterventionManage",
      "capSupportNotes",
      "capPulloutsVerify",
    ],
  },
  {
    flag: "isSocialWorker",
    label: "School Social Worker",
    capabilities: [
      "capStudentActivity",
      "capSupportNotes",
      "capInterventionLog",
    ],
  },
  {
    flag: "isPbisCoordinator",
    label: "PBIS Coord.",
    capabilities: [
      "capPbisAward",
      "capPbisManage",
      "capStudentActivity",
      "capReports",
    ],
  },
  {
    flag: "isIssTeacher",
    label: "ISS Teacher",
    capabilities: [
      "capStudentActivity",
      "capIssDashboard",
      "capSupportNotes",
    ],
  },
];

const TEACHER_BASELINE: BoolKey[] = [
  "capHallPasses",
  "capTardies",
  "capStudentActivity",
  "capPbisAward",
  "capParentEmail",
  "capSupportNotes",
  "capAccommodationLog",
  "capPulloutsRequest",
  "capInterventionLog",
  "capReports",
  "capKioskActivate",
];

export default function StaffRolesMatrix({ currentUser }: Props) {
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [customRoles, setCustomRoles] = useState<CustomRole[]>([]);
  const [filter, setFilter] = useState("");
  const [savingId, setSavingId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [showAddStaff, setShowAddStaff] = useState(false);
  const [showAddRole, setShowAddRole] = useState(false);

  const canManageRoles =
    Boolean(currentUser.isSuperUser) || Boolean(currentUser.capManageRoles);

  async function refresh() {
    try {
      const [s, r] = await Promise.all([
        fetch("/api/admin/staff", { credentials: "include" }).then((res) =>
          res.ok ? res.json() : Promise.reject(res.statusText),
        ),
        fetch("/api/custom-roles", { credentials: "include" }).then((res) =>
          res.ok ? res.json() : [],
        ),
      ]);
      setStaff(s);
      setCustomRoles(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return staff;
    return staff.filter(
      (s) =>
        s.displayName.toLowerCase().includes(q) ||
        s.email.toLowerCase().includes(q),
    );
  }, [filter, staff]);

  async function patchStaff(id: number, body: Record<string, boolean>) {
    setSavingId(id);
    setError("");
    // optimistic
    setStaff((prev) =>
      prev.map((s) => (s.id === id ? { ...s, ...body } : s)),
    );
    try {
      const res = await fetch(`/api/admin/staff/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `Save failed (${res.status})`);
      }
      const updated = await res.json();
      setStaff((prev) => prev.map((s) => (s.id === id ? updated : s)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await refresh();
    } finally {
      setSavingId(null);
    }
  }

  function applyPreset(staffId: number, capabilities: BoolKey[]) {
    const body: Record<string, boolean> = {};
    for (const cap of PAGES.map((p) => p.key)) {
      body[cap] = capabilities.includes(cap);
    }
    patchStaff(staffId, body);
  }

  function applyCustomRole(staffId: number, role: CustomRole) {
    const body: Record<string, boolean> = {};
    for (const cap of PAGES.map((p) => p.key)) {
      body[cap] = role.capabilities.includes(cap);
    }
    patchStaff(staffId, body);
  }

  function applyTeacherBaseline(staffId: number) {
    applyPreset(staffId, TEACHER_BASELINE);
  }

  return (
    <div className="card" style={{ marginTop: "1rem" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <div>
          <h2 style={{ margin: 0 }}>Staff &amp; Roles</h2>
          <p style={{ color: "var(--text-subtle)", margin: "4px 0 0" }}>
            Toggle any cell to grant or revoke that page for that user. Click a
            role label to apply its preset bundle.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            type="search"
            placeholder="Search name or email…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ minWidth: 220 }}
          />
          <button type="button" onClick={() => setShowAddStaff(true)}>
            + Add Staff
          </button>
          {canManageRoles && (
            <button type="button" onClick={() => setShowAddRole(true)}>
              + Add Role
            </button>
          )}
        </div>
      </div>

      {error && (
        <div
          role="alert"
          style={{
            marginTop: 8,
            padding: 8,
            background: "#fee2e2",
            color: "#991b1b",
            borderRadius: 6,
          }}
        >
          {error}
        </div>
      )}

      <div style={{ overflow: "auto", marginTop: 12, maxHeight: "70vh" }}>
        <table
          style={{
            borderCollapse: "separate",
            borderSpacing: 0,
            fontSize: 13,
            minWidth: 1200,
          }}
        >
          <thead>
            <tr>
              <th
                style={{
                  ...stickyTh,
                  left: 0,
                  zIndex: 4,
                  minWidth: 220,
                  textAlign: "left",
                }}
              >
                Staff
              </th>
              <th
                style={{
                  ...stickyTh,
                  left: 220,
                  zIndex: 4,
                  minWidth: 360,
                  textAlign: "left",
                }}
              >
                Role presets
              </th>
              {PAGES.map((p) => (
                <th
                  key={p.key}
                  style={{
                    ...stickyTh,
                    minWidth: 90,
                    fontSize: 11,
                    fontWeight: 600,
                    color: "var(--text-subtle)",
                  }}
                  title={p.group + " · " + p.label}
                >
                  <div style={{ writingMode: "vertical-rl", transform: "rotate(180deg)", padding: "8px 4px" }}>
                    {p.label}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((s) => {
              const isSelf = s.id === currentUser.id;
              const isSaving = savingId === s.id;
              return (
                <tr
                  key={s.id}
                  style={{
                    background: isSaving ? "#fef9c3" : undefined,
                    opacity: s.active ? 1 : 0.5,
                  }}
                >
                  <td
                    style={{
                      ...stickyTd,
                      left: 0,
                      zIndex: 2,
                      minWidth: 220,
                    }}
                  >
                    <div style={{ fontWeight: 600 }}>{s.displayName}</div>
                    <div style={{ fontSize: 11, color: "var(--text-subtle)" }}>
                      {s.email}
                    </div>
                  </td>
                  <td
                    style={{
                      ...stickyTd,
                      left: 220,
                      zIndex: 2,
                      minWidth: 360,
                    }}
                  >
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                      <button
                        type="button"
                        className="ghost"
                        style={pillStyle(false)}
                        title="Set to teacher baseline"
                        onClick={() => applyTeacherBaseline(s.id)}
                      >
                        Teacher
                      </button>
                      {ROLE_PRESETS.map((r) => {
                        const active = Boolean(s[r.flag]);
                        const disabled =
                          (r.flag === "isSuperUser" &&
                            !currentUser.isSuperUser) ||
                          (r.flag === "isAdmin" &&
                            !currentUser.isSuperUser &&
                            !currentUser.isAdmin) ||
                          (isSelf &&
                            (r.flag === "isSuperUser" ||
                              r.flag === "isAdmin") &&
                            active);
                        return (
                          <button
                            key={r.flag}
                            type="button"
                            disabled={disabled}
                            style={pillStyle(active)}
                            title={
                              active
                                ? `Remove role + clear preset capabilities`
                                : `Apply role + preset capabilities`
                            }
                            onClick={() => {
                              const newVal = !active;
                              patchStaff(s.id, { [r.flag]: newVal });
                              if (newVal) {
                                applyPreset(s.id, r.capabilities);
                              }
                            }}
                          >
                            {r.label}
                          </button>
                        );
                      })}
                      {customRoles.map((r) => (
                        <button
                          key={r.key}
                          type="button"
                          style={pillStyle(false)}
                          title="Apply custom role preset"
                          onClick={() => applyCustomRole(s.id, r)}
                        >
                          {r.label}
                        </button>
                      ))}
                    </div>
                  </td>
                  {PAGES.map((p) => {
                    const checked = Boolean(s[p.key]);
                    return (
                      <td
                        key={p.key}
                        style={{
                          textAlign: "center",
                          padding: "4px 6px",
                          borderBottom: "1px solid #f1f5f9",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) =>
                            patchStaff(s.id, { [p.key]: e.target.checked })
                          }
                        />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={PAGES.length + 2} style={{ padding: 16 }}>
                  No staff match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showAddStaff && (
        <AddStaffModal
          onClose={() => setShowAddStaff(false)}
          onCreated={() => {
            setShowAddStaff(false);
            refresh();
          }}
          canCreateAdmin={
            Boolean(currentUser.isAdmin) || Boolean(currentUser.isSuperUser)
          }
          canCreateSuper={Boolean(currentUser.isSuperUser)}
        />
      )}
      {showAddRole && canManageRoles && (
        <AddRoleModal
          onClose={() => setShowAddRole(false)}
          onCreated={() => {
            setShowAddRole(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

const stickyTh: React.CSSProperties = {
  position: "sticky",
  top: 0,
  background: "#f8fafc",
  borderBottom: "1px solid #cbd5e1",
  padding: "6px 8px",
  zIndex: 3,
};
const stickyTd: React.CSSProperties = {
  position: "sticky",
  background: "#fff",
  borderBottom: "1px solid #f1f5f9",
  padding: "6px 8px",
};

function pillStyle(active: boolean): React.CSSProperties {
  return {
    fontSize: 11,
    padding: "2px 8px",
    borderRadius: 999,
    border: active ? "1px solid #2563eb" : "1px solid #cbd5e1",
    background: active ? "#dbeafe" : "#fff",
    color: active ? "#1e3a8a" : "#334155",
    cursor: "pointer",
  };
}

function AddStaffModal({
  onClose,
  onCreated,
  canCreateAdmin,
  canCreateSuper,
}: {
  onClose: () => void;
  onCreated: () => void;
  canCreateAdmin: boolean;
  canCreateSuper: boolean;
}) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [makeAdmin, setMakeAdmin] = useState(false);
  const [makeSuper, setMakeSuper] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit() {
    setBusy(true);
    setErr("");
    try {
      const res = await fetch("/api/admin/staff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          email,
          displayName,
          password,
          isAdmin: makeAdmin,
          isSuperUser: makeSuper,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `Failed (${res.status})`);
      }
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell title="Add Staff" onClose={onClose}>
      <div style={{ display: "grid", gap: 8 }}>
        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          Display name
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </label>
        <label>
          Temporary password (min 8 chars)
          <input
            type="text"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {canCreateAdmin && (
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={makeAdmin}
              onChange={(e) => setMakeAdmin(e.target.checked)}
            />
            Grant Admin
          </label>
        )}
        {canCreateSuper && (
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={makeSuper}
              onChange={(e) => setMakeSuper(e.target.checked)}
            />
            Grant SuperUser
          </label>
        )}
        {err && (
          <div style={{ color: "#991b1b", fontSize: 12 }}>{err}</div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" disabled={busy} onClick={submit}>
            {busy ? "Saving…" : "Create"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function AddRoleModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [label, setLabel] = useState("");
  const [caps, setCaps] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  function toggle(k: string) {
    setCaps((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  async function submit() {
    setBusy(true);
    setErr("");
    try {
      const res = await fetch("/api/custom-roles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          key: label,
          label,
          capabilities: [...caps],
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `Failed (${res.status})`);
      }
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell title="Add Role" onClose={onClose}>
      <div style={{ display: "grid", gap: 8 }}>
        <label>
          Role name
          <input value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <div style={{ fontSize: 12, color: "var(--text-subtle)" }}>
          Pages this role grants:
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 4,
            maxHeight: 240,
            overflow: "auto",
            border: "1px solid #e2e8f0",
            padding: 8,
            borderRadius: 6,
          }}
        >
          {PAGES.map((p) => (
            <label
              key={p.key}
              style={{ display: "flex", gap: 6, alignItems: "center" }}
            >
              <input
                type="checkbox"
                checked={caps.has(p.key)}
                onChange={() => toggle(p.key)}
              />
              {p.label}
            </label>
          ))}
        </div>
        {err && <div style={{ color: "#991b1b", fontSize: 12 }}>{err}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" disabled={busy || !label} onClick={submit}>
            {busy ? "Saving…" : "Create role"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function ModalShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: 8,
          padding: 16,
          minWidth: 360,
          maxWidth: 520,
          maxHeight: "90vh",
          overflow: "auto",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 8,
          }}
        >
          <h3 style={{ margin: 0 }}>{title}</h3>
          <button type="button" onClick={onClose}>
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
