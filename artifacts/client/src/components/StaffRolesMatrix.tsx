import { useEffect, useMemo, useRef, useState } from "react";
import { authFetch } from "../lib/authToken";
import { HowToUseHelp, HowToSection, RoleSection, howtoListStyle } from "./HowToUseHelp";
import StudentPhoto from "./StudentPhoto";

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

// Fixed academic departments — kept in sync with DEPARTMENTS in the
// adminStaff route (the server validates writes against the same set).
const DEPARTMENTS = [
  "ELA",
  "Math",
  "Science",
  "Social Studies",
  "CTE",
  "Elective",
  "Other",
] as const;

type HouseOption = {
  id: number;
  name: string;
  color: string;
  iconKey: string | null;
  studentCount: number;
  staffCount: number;
};

interface Props {
  currentUser: {
    id: number;
    isSuperUser?: boolean;
    isDistrictAdmin?: boolean;
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
  { group: "Admin", key: "capManageDisplays", label: "Manage Displays" },
  { group: "Admin", key: "capManageDismissal", label: "Set Dismissal Mode" },
  { group: "Admin", key: "capTourNotify", label: "Tour Alerts" },
  { group: "Admin", key: "capManageEsign", label: "e-Sign Documents" },
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
    flag: "isDistrictAdmin",
    label: "District Admin",
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
    flag: "isSchoolPsychologist",
    label: "School Psych",
    capabilities: [
      "capStudentActivity",
      "capInterventionLog",
      "capInterventionManage",
      "capSupportNotes",
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
  // Non-Exempt: minimal capability bundle. The sidebar collapses to
  // Hall Pass + Tardy Pass + Comp Time when this flag is on (App.tsx
  // nav filter). The preset also flips exemptStatus to 'non_exempt'
  // server-side so Comp Time accrual works — admins can independently
  // mark other staff non-exempt without applying this role.
  {
    flag: "isNonExemptRole",
    label: "Non-Exempt",
    capabilities: ["capHallPasses", "capTardies"],
  },
  // Front Office: teacher baseline + ISS dashboard for student lookups,
  // minus Request Pullout (pullouts are a teacher referral). Watchlists
  // and Accommodations come through the teacher baseline. AST submit
  // and Comp Time visibility are governed by exemptStatus / feature
  // flags, not capability flags.
  {
    flag: "isFrontOffice",
    label: "Front Office",
    capabilities: [
      "capHallPasses",
      "capTardies",
      "capStudentActivity",
      "capPbisAward",
      "capParentEmail",
      "capSupportNotes",
      "capAccommodationLog",
      "capInterventionLog",
      "capReports",
      "capKioskActivate",
    ],
  },
  // SRO: full teacher view, action-capable. Broken out as its own role
  // so future SRO-specific surfaces (incident logs, etc) can target it.
  {
    flag: "isSro",
    label: "SRO",
    capabilities: [...TEACHER_BASELINE],
  },
  // Guardian / hall monitor: full teacher view, action-capable.
  {
    flag: "isGuardian",
    label: "Guardian",
    capabilities: [...TEACHER_BASELINE],
  },
];

export default function StaffRolesMatrix({ currentUser }: Props) {
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [customRoles, setCustomRoles] = useState<CustomRole[]>([]);
  // Houses for the per-staff house picker. We keep a live count of
  // staff-per-house so admins can pick the smallest one ("recommended").
  // Recomputed locally on every patchStaff so the counts update without
  // a server round-trip.
  const [houses, setHouses] = useState<HouseOption[]>([]);
  const [filter, setFilter] = useState("");
  const [savingId, setSavingId] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const [showAddStaff, setShowAddStaff] = useState(false);
  const [showAddRole, setShowAddRole] = useState(false);
  const [pwResetTarget, setPwResetTarget] = useState<StaffRow | null>(null);
  const [pwResetValue, setPwResetValue] = useState("");
  const [pwResetBusy, setPwResetBusy] = useState(false);
  const [tempPwTarget, setTempPwTarget] = useState<StaffRow | null>(null);
  const [tempPwBusy, setTempPwBusy] = useState(false);
  const [tempPwResult, setTempPwResult] = useState<{
    tempPassword: string;
    displayName: string;
    email: string;
  } | null>(null);

  const canManageRoles =
    Boolean(currentUser.isSuperUser) || Boolean(currentUser.capManageRoles);
  const canResetPasswords =
    Boolean(currentUser.isSuperUser) || Boolean(currentUser.isAdmin);

  async function generateTempPw(target: StaffRow) {
    // Confirm here (not on click) so the modal can stay simple, and so
    // mis-clicks on the row button don't immediately invalidate the
    // target's existing password.
    if (
      !window.confirm(
        `Generate a new temporary password for ${target.displayName}? ` +
          `Their current password will stop working immediately.`,
      )
    ) {
      return;
    }
    setTempPwBusy(true);
    setError("");
    try {
      const res = await authFetch(
        `/api/admin/staff/${target.id}/reset-temp-password`,
        { method: "POST" },
      );
      const j = (await res.json().catch(() => ({}))) as {
        tempPassword?: string;
        displayName?: string;
        email?: string;
        error?: string;
      };
      if (!res.ok || !j.tempPassword) {
        throw new Error(j.error || `Reset failed (${res.status})`);
      }
      setTempPwResult({
        tempPassword: j.tempPassword,
        displayName: j.displayName ?? target.displayName,
        email: j.email ?? target.email,
      });
      setTempPwTarget(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTempPwBusy(false);
    }
  }

  async function submitPwReset() {
    if (!pwResetTarget) return;
    if (pwResetValue.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setPwResetBusy(true);
    setError("");
    try {
      const res = await authFetch(
        `/api/admin/staff/${pwResetTarget.id}/password`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ newPassword: pwResetValue }),
        },
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `Reset failed (${res.status})`);
      }
      setPwResetTarget(null);
      setPwResetValue("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPwResetBusy(false);
    }
  }

  async function refresh() {
    try {
      const [s, r, h] = await Promise.all([
        authFetch("/api/admin/staff").then((res) =>
          res.ok ? res.json() : Promise.reject(res.statusText),
        ),
        authFetch("/api/custom-roles").then((res) =>
          res.ok ? res.json() : [],
        ),
        authFetch("/api/houses/with-staff-counts").then((res) =>
          res.ok ? res.json() : { houses: [] },
        ),
      ]);
      setStaff(s);
      setCustomRoles(r);
      setHouses(
        (h?.houses ?? []) as HouseOption[],
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // Derived: live staff-per-house counts that reflect optimistic
  // patches. We don't refetch /api/houses/with-staff-counts on every
  // edit — instead, we re-derive staffCount from the in-memory staff
  // array. Smallest house is the "recommended" pick.
  const housesWithLiveCounts = useMemo<HouseOption[]>(() => {
    const liveCounts = new Map<number, number>();
    for (const s of staff) {
      if (!s.active) continue;
      const hid = (s["houseId"] as number | null) ?? null;
      if (hid !== null) liveCounts.set(hid, (liveCounts.get(hid) ?? 0) + 1);
    }
    return houses.map((h) => ({
      ...h,
      staffCount: liveCounts.get(h.id) ?? 0,
    }));
  }, [houses, staff]);
  const recommendedHouseId = useMemo<number | null>(() => {
    if (housesWithLiveCounts.length === 0) return null;
    let best = housesWithLiveCounts[0];
    for (const h of housesWithLiveCounts) {
      if (h.staffCount < best.staffCount) best = h;
    }
    return best.id;
  }, [housesWithLiveCounts]);

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

  async function patchStaff(
    id: number,
    body: Record<string, boolean | string | number | null>,
  ) {
    setSavingId(id);
    setError("");
    // optimistic
    setStaff((prev) =>
      prev.map((s) => (s.id === id ? { ...s, ...body } : s)),
    );
    try {
      const res = await authFetch(`/api/admin/staff/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
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

  function setStaffPhoto(id: number, key: string | null) {
    setStaff((prev) =>
      prev.map((s) => (s.id === id ? { ...s, photoObjectKey: key } : s)),
    );
  }

  async function exportCsv() {
    setExporting(true);
    setError("");
    try {
      const res = await authFetch("/api/admin/staff/export.csv");
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `Export failed (${res.status})`);
      }
      // Download to disk (a blob opened in a new tab renders blank inside the
      // Replit preview iframe — see PDFs/blobs gotcha).
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `staff-roster-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
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
          <HowToUseHelp title="How to use Staff &amp; Roles">
            <HowToSection title="What this page is">
              The permissions matrix for every staff member at this
              school. Rows are people, columns are pages/features,
              and a green check means that person can access it.
            </HowToSection>
            <HowToSection title="Two ways to grant access">
              <ul style={howtoListStyle}>
                <li><strong>Cell click</strong> — toggles a single page for one person. Use for one-off exceptions (e.g., "give the librarian access to the display playlist").</li>
                <li><strong>Role label click</strong> — applies that role's preset bundle (e.g., "Counselor" turns on guidance + safety-plan editor + parent-access).</li>
              </ul>
            </HowToSection>
            <RoleSection for={["admin", "districtAdmin", "superUser"]} title="Adding new staff">
              Use "+ Add Staff" to invite by email. New users land
              with no permissions — apply a role preset, then refine
              individual cells. Removing the last admin is blocked.
            </RoleSection>
          </HowToUseHelp>
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
          <button
            type="button"
            className="ghost"
            onClick={exportCsv}
            disabled={exporting}
            title="Download the full staff roster (name, email, role, department, and contact details) as a CSV you can open in Excel."
          >
            {exporting ? "Exporting…" : "Export staff (CSV)"}
          </button>
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
        <table className="pulse-table"
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
              <th
                style={{
                  ...stickyTh,
                  zIndex: 4,
                  minWidth: 140,
                  textAlign: "left",
                }}
                title="Pre-fills the origin room when this user creates a hall pass."
              >
                Default room
              </th>
              <th
                style={{
                  ...stickyTh,
                  zIndex: 4,
                  minWidth: 170,
                  textAlign: "left",
                }}
                title="PBIS house affiliation. Prints on the kiosk activation card and shows in any 'your house' surfaces. The smallest house is recommended so the picker keeps teams balanced."
              >
                House
              </th>
              <th
                style={{
                  ...stickyTh,
                  zIndex: 4,
                  minWidth: 150,
                  textAlign: "left",
                }}
                title="Academic department. Included in the staff CSV export."
              >
                Department
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
                    <div
                      style={{ display: "flex", gap: 8, alignItems: "flex-start" }}
                    >
                      <StaffPhotoControl
                        staffId={s.id}
                        displayName={s.displayName}
                        photoObjectKey={
                          (s.photoObjectKey as string | null | undefined) ?? null
                        }
                        onChange={(key) => setStaffPhoto(s.id, key)}
                      />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600 }}>{s.displayName}</div>
                        <div
                          style={{ fontSize: 11, color: "var(--text-subtle)" }}
                        >
                          {s.email}
                        </div>
                      </div>
                    </div>
                    {canResetPasswords &&
                      // Self-reset uses the user-pill "Change password" flow
                      // (which proves the caller knows the current password).
                      s.id !== currentUser.id &&
                      // Inactive accounts must be reactivated first.
                      s.active &&
                      // Non-SuperUser can't reset a SuperUser's password.
                      (!Boolean(s.isSuperUser) || currentUser.isSuperUser) && (
                        <div
                          style={{
                            marginTop: 4,
                            display: "flex",
                            flexWrap: "wrap",
                            gap: 4,
                          }}
                        >
                          <button
                            type="button"
                            className="ghost"
                            onClick={() => {
                              setPwResetTarget(s);
                              setPwResetValue("");
                            }}
                            style={{ fontSize: 11, padding: "2px 6px" }}
                          >
                            Reset password
                          </button>
                          <button
                            type="button"
                            className="ghost"
                            title="Generate a fresh CSPRNG temp password and show it once — for resending invites or recovering lost first-login credentials."
                            disabled={tempPwBusy}
                            onClick={() => generateTempPw(s)}
                            style={{ fontSize: 11, padding: "2px 6px" }}
                          >
                            {tempPwBusy ? "…" : "Reset to temp"}
                          </button>
                        </div>
                      )}
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
                          (r.flag === "isDistrictAdmin" &&
                            !currentUser.isSuperUser) ||
                          (r.flag === "isAdmin" &&
                            !currentUser.isSuperUser &&
                            !currentUser.isAdmin) ||
                          (isSelf &&
                            (r.flag === "isSuperUser" ||
                              r.flag === "isDistrictAdmin" ||
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
                  <td
                    style={{
                      padding: "4px 6px",
                      borderBottom: "1px solid #f1f5f9",
                      minWidth: 140,
                    }}
                  >
                    <DefaultRoomCell
                      value={(s["defaultRoom"] as string | null) ?? ""}
                      saving={isSaving}
                      onSave={(next) =>
                        patchStaff(s.id, {
                          defaultRoom: next.trim() === "" ? null : next.trim(),
                        })
                      }
                    />
                  </td>
                  <td
                    style={{
                      padding: "4px 6px",
                      borderBottom: "1px solid #f1f5f9",
                      minWidth: 170,
                    }}
                  >
                    <HouseCell
                      value={(s["houseId"] as number | null) ?? null}
                      houses={housesWithLiveCounts}
                      recommendedHouseId={recommendedHouseId}
                      saving={isSaving}
                      onSave={(next) =>
                        patchStaff(s.id, { houseId: next })
                      }
                    />
                  </td>
                  <td
                    style={{
                      padding: "4px 6px",
                      borderBottom: "1px solid #f1f5f9",
                      minWidth: 150,
                    }}
                  >
                    <select
                      value={(s["department"] as string | null) ?? ""}
                      disabled={isSaving}
                      onChange={(e) =>
                        patchStaff(s.id, {
                          department: e.target.value === "" ? null : e.target.value,
                        })
                      }
                      style={{ width: "100%" }}
                    >
                      <option value="">—</option>
                      {DEPARTMENTS.map((d) => (
                        <option key={d} value={d}>
                          {d}
                        </option>
                      ))}
                    </select>
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
                <td colSpan={PAGES.length + 5} style={{ padding: 16 }}>
                  No staff match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {pwResetTarget && (
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
          onClick={() => !pwResetBusy && setPwResetTarget(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "white",
              padding: 16,
              borderRadius: 8,
              minWidth: 320,
              maxWidth: "90vw",
            }}
          >
            <h3 style={{ marginTop: 0 }}>Reset password</h3>
            <p style={{ margin: "4px 0 12px", fontSize: 13 }}>
              Set a new password for{" "}
              <strong>{pwResetTarget.displayName}</strong> ({pwResetTarget.email}
              ). They'll use it on next sign-in.
            </p>
            <input
              type="text"
              autoFocus
              value={pwResetValue}
              onChange={(e) => setPwResetValue(e.target.value)}
              placeholder="New password (min 8 chars)"
              style={{ width: "100%", padding: "6px 8px", fontSize: 14 }}
            />
            <div
              style={{
                marginTop: 12,
                display: "flex",
                gap: 8,
                justifyContent: "flex-end",
              }}
            >
              <button
                type="button"
                disabled={pwResetBusy}
                onClick={() => setPwResetTarget(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={pwResetBusy || pwResetValue.length < 8}
                onClick={submitPwReset}
              >
                {pwResetBusy ? "Saving…" : "Set password"}
              </button>
            </div>
          </div>
        </div>
      )}

      {tempPwResult && (
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
          onClick={() => setTempPwResult(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "white",
              padding: 16,
              borderRadius: 8,
              minWidth: 360,
              maxWidth: "90vw",
            }}
          >
            <h3 style={{ marginTop: 0 }}>Temporary password generated</h3>
            <p style={{ margin: "4px 0 12px", fontSize: 13 }}>
              Copy this password and send it to{" "}
              <strong>{tempPwResult.displayName}</strong> (
              {tempPwResult.email}) over a trusted channel. They should
              change it on first sign-in.{" "}
              <strong>You won't be able to see it again.</strong>
            </p>
            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                background: "#f8fafc",
                border: "1px solid #e2e8f0",
                borderRadius: 6,
                padding: "8px 10px",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: 15,
                userSelect: "all",
                wordBreak: "break-all",
              }}
            >
              {tempPwResult.tempPassword}
            </div>
            <div
              style={{
                marginTop: 12,
                display: "flex",
                gap: 8,
                justifyContent: "flex-end",
              }}
            >
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(tempPwResult.tempPassword)
                    .catch(() => {});
                }}
              >
                Copy
              </button>
              <button type="button" onClick={() => setTempPwResult(null)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {showAddStaff && (
        <AddStaffModal
          actorId={currentUser.id}
          onClose={() => setShowAddStaff(false)}
          onCreated={() => {
            setShowAddStaff(false);
            refresh();
          }}
          canCreateAdmin={
            Boolean(currentUser.isAdmin) || Boolean(currentUser.isSuperUser)
          }
          canCreateDistrict={Boolean(currentUser.isSuperUser)}
          canCreateSuper={Boolean(currentUser.isSuperUser)}
        />
      )}
      {showAddRole && canManageRoles && (
        <AddRoleModal
          actorId={currentUser.id}
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
  actorId,
  onClose,
  onCreated,
  canCreateAdmin,
  canCreateDistrict,
  canCreateSuper,
}: {
  actorId: number;
  onClose: () => void;
  onCreated: () => void;
  canCreateAdmin: boolean;
  canCreateDistrict: boolean;
  canCreateSuper: boolean;
}) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [makeAdmin, setMakeAdmin] = useState(false);
  const [makeDistrict, setMakeDistrict] = useState(false);
  const [makeSuper, setMakeSuper] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit() {
    setBusy(true);
    setErr("");
    try {
      const res = await authFetch(`/api/admin/staff`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          displayName,
          password,
          isAdmin: makeAdmin,
          isDistrictAdmin: makeDistrict,
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
        {canCreateDistrict && (
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={makeDistrict}
              onChange={(e) => setMakeDistrict(e.target.checked)}
            />
            Grant District Admin
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
  actorId,
  onClose,
  onCreated,
}: {
  actorId: number;
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
      const res = await authFetch(`/api/custom-roles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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

function HouseCell({
  value,
  houses,
  recommendedHouseId,
  saving,
  onSave,
}: {
  value: number | null;
  houses: HouseOption[];
  recommendedHouseId: number | null;
  saving: boolean;
  onSave: (next: number | null) => void;
}) {
  // No houses configured for this school — show a quiet placeholder so
  // admins understand the field is intentionally empty rather than broken.
  if (houses.length === 0) {
    return (
      <span style={{ fontSize: 11, color: "var(--text-subtle)" }}>
        No houses
      </span>
    );
  }
  const selected = houses.find((h) => h.id === value) ?? null;
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
      {/* Color swatch echoes the chosen house — disappears when unset. */}
      <span
        aria-hidden
        style={{
          display: "inline-block",
          width: 12,
          height: 12,
          borderRadius: 3,
          background: selected ? selected.color : "transparent",
          border: selected ? "1px solid rgba(0,0,0,0.1)" : "1px dashed #cbd5e1",
          flexShrink: 0,
        }}
      />
      <select
        disabled={saving}
        value={value === null ? "" : String(value)}
        onChange={(e) => {
          const v = e.target.value;
          onSave(v === "" ? null : Number(v));
        }}
        style={{ fontSize: 12, padding: "2px 4px", minWidth: 130 }}
      >
        <option value="">— None —</option>
        {houses.map((h) => {
          const isRec = h.id === recommendedHouseId;
          const label =
            `${h.name} (${h.staffCount} staff)` +
            (isRec ? " · recommended" : "");
          return (
            <option key={h.id} value={h.id}>
              {label}
            </option>
          );
        })}
      </select>
    </div>
  );
}

function DefaultRoomCell({
  value,
  saving,
  onSave,
}: {
  value: string;
  saving: boolean;
  onSave: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  const dirty = draft !== value;
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="—"
        disabled={saving}
        style={{ width: 110, fontSize: 12, padding: "2px 4px" }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && dirty) onSave(draft);
          if (e.key === "Escape") setDraft(value);
        }}
        onBlur={() => {
          if (dirty) onSave(draft);
        }}
      />
    </div>
  );
}

// Square teacher avatar + upload/remove controls, shown in the Staff &
// Roles name cell. The uploaded photo feeds both this avatar and the
// teacher ID badge PDF. Upload pipeline mirrors the student-photo flow:
//   1) POST /api/storage/uploads/request-url
//   2) PUT  uploadURL  (file body)
//   3) POST /api/staff/:staffId/photo  { objectPath }
// No photo-consent toggle for staff (admins manage their own roster).
function StaffPhotoControl({
  staffId,
  displayName,
  photoObjectKey,
  onChange,
}: {
  staffId: number;
  displayName: string;
  photoObjectKey: string | null;
  onChange: (key: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const parts = displayName.trim().split(/\s+/);
  const firstName = parts[0] ?? "";
  const lastName = parts.length > 1 ? parts.slice(1).join(" ") : "";

  async function upload(file: File) {
    setBusy(true);
    setErr(null);
    try {
      const reqRes = await authFetch("/api/storage/uploads/request-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: file.name || `staff-${staffId}.jpg`,
          size: file.size,
          contentType: file.type || "image/jpeg",
        }),
      });
      if (!reqRes.ok) throw new Error("Could not start upload");
      const { uploadURL, objectPath } = (await reqRes.json()) as {
        uploadURL: string;
        objectPath: string;
      };
      const putRes = await fetch(uploadURL, {
        method: "PUT",
        headers: { "Content-Type": file.type || "image/jpeg" },
        body: file,
      });
      if (!putRes.ok) throw new Error("Upload failed");
      const saveRes = await authFetch(`/api/staff/${staffId}/photo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ objectPath }),
      });
      if (!saveRes.ok) {
        const j = (await saveRes.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(j.error ?? "Could not save photo");
      }
      const j = (await saveRes.json().catch(() => ({}))) as {
        photoObjectKey?: string;
      };
      onChange(j.photoObjectKey ?? objectPath);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function remove() {
    if (!window.confirm(`Remove ${displayName}'s photo?`)) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await authFetch(`/api/staff/${staffId}/photo`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? "Could not remove photo");
      }
      onChange(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 4,
      }}
    >
      <StudentPhoto
        firstName={firstName}
        lastName={lastName}
        photoObjectKey={photoObjectKey}
        photoConsent={true}
        size={44}
        style={{ borderRadius: 8 }}
      />
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
        }}
      />
      <div style={{ display: "flex", gap: 4 }}>
        <button
          type="button"
          className="ghost"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          style={{ fontSize: 10, padding: "1px 5px" }}
          title="Upload a photo for this teacher's ID badge"
        >
          {busy ? "…" : photoObjectKey ? "Replace" : "Photo"}
        </button>
        {photoObjectKey && (
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() => void remove()}
            style={{ fontSize: 10, padding: "1px 5px" }}
          >
            Remove
          </button>
        )}
      </div>
      {err && (
        <div style={{ fontSize: 10, color: "#b91c1c", maxWidth: 80 }}>
          {err}
        </div>
      )}
    </div>
  );
}
