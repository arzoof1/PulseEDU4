import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import * as XLSX from "xlsx";
import { authFetch } from "../lib/authToken";

// =============================================================================
// EligibilityHub — attendance-based participation eligibility for athletics,
// clubs, and activities. Manager-facing surface mounted as the "Eligibility
// Hub" sidebar item (School Admin group) and Tile Home admin tile.
//
// Talks to the server via authFetch directly (no OpenAPI codegen) — matching
// the DataImports / Pickup / Ticketing precedent. DEVIATION from the
// contract-first norm, documented in the commit message.
//
// Tabs: Activities & Rosters · At-Risk Report · Parent Notes · Upload.
//
// NO FLEID forward-facing: every student row renders `localSisId` (never the
// canonical studentId, which is a join key only).
// =============================================================================

type EligibilityStatus = "ok" | "warning" | "ineligible";

export type EligibilitySettings = {
  threshold: number;
  warningWindowDays: number;
  tardyToAbsenceRatio: number;
  parentNoteCap: number;
  districtAdNotify: boolean;
  semesterLabel: string;
  semesterStart: string | null;
  semesterEnd: string | null;
};

type Coach = {
  id: number;
  activityId: number;
  staffId: number;
  name: string | null;
};

type Activity = {
  id: number;
  schoolId: number;
  name: string;
  category: string;
  active: boolean;
  createdByStaffId: number | null;
  createdAt: string;
  updatedAt: string;
  memberCount: number;
  coaches: Coach[];
};

type RosterEntry = {
  memberId: number;
  studentId: string;
  jerseyNumber: string | null;
  localSisId: string | null;
  firstName: string;
  lastName: string;
  grade: number | null;
  countedAbsences: number;
  daysTardy: number;
  notesLeft: number;
  status: EligibilityStatus;
};

type AtRiskEntry = {
  activityId: number;
  activityName: string;
  studentId: string;
  localSisId: string | null;
  name: string;
  grade: number | null;
  jerseyNumber: string | null;
  daysAbsent: number;
  notesLeft: number;
  status: "warning" | "ineligible";
};

type ParentNote = {
  id: number;
  studentId: string;
  semesterLabel: string;
  reason: string | null;
  noteDate: string | null;
  enteredByStaffId: number;
  createdAt: string;
};

type UploadAudit = {
  id: number;
  semesterLabel: string;
  uploadedByStaffId: number;
  filename: string | null;
  rowCount: number;
  matchedCount: number;
  unmatchedCount: number;
  createdAt: string;
};

type DirectoryStaff = { id: number; displayName: string; email: string | null };

const STATUS_LABEL: Record<EligibilityStatus, string> = {
  ok: "OK",
  warning: "Warning",
  ineligible: "Ineligible",
};

function statusBadgeClass(status: EligibilityStatus): string {
  if (status === "ineligible") return "badge badge-danger";
  if (status === "warning") return "badge badge-warning";
  return "badge badge-success";
}

const TABS = [
  { key: "rosters", label: "Activities & Rosters" },
  { key: "atRisk", label: "At-Risk Report" },
  { key: "notes", label: "Parent Notes" },
  { key: "upload", label: "Upload" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

const tabBtnStyle = (active: boolean): CSSProperties => ({
  padding: "8px 16px",
  borderRadius: 8,
  border: active ? "1px solid var(--accent, #2563eb)" : "1px solid var(--border, #d1d5db)",
  background: active ? "var(--accent, #2563eb)" : "transparent",
  color: active ? "#fff" : "var(--text, #111827)",
  fontWeight: 600,
  cursor: "pointer",
});

async function downloadPdf(url: string, fallbackName: string) {
  // Authed PDFs can't open in the preview iframe (session cookie blocked;
  // window.open(blob) renders blank). Download to disk — see replit.md Gotchas.
  const res = await authFetch(url);
  if (!res.ok) {
    alert(`Could not generate PDF (${res.status})`);
    return;
  }
  const blob = await res.blob();
  const disposition = res.headers.get("Content-Disposition") || "";
  const m = disposition.match(/filename="([^"]+)"/);
  const name = m?.[1] || fallbackName;
  const objUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objUrl), 2000);
}

export default function EligibilityHub() {
  const [tab, setTab] = useState<TabKey>("rosters");
  const [settings, setSettings] = useState<EligibilitySettings | null>(null);

  useEffect(() => {
    let cancelled = false;
    authFetch("/api/eligibility/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d) setSettings(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h2 style={{ margin: 0 }}>Eligibility Hub</h2>
        <p style={{ margin: "4px 0 0", color: "var(--muted, #6b7280)", fontSize: 14 }}>
          Attendance-based participation eligibility for athletics, clubs, and
          activities.
          {settings && (
            <>
              {" "}
              <strong>{settings.semesterLabel}</strong> · ineligible at{" "}
              {settings.threshold}+ counted absences · warning within{" "}
              {settings.warningWindowDays}.
            </>
          )}
        </p>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            style={tabBtnStyle(tab === t.key)}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "rosters" && <RostersTab />}
      {tab === "atRisk" && <AtRiskTab />}
      {tab === "notes" && <ParentNotesTab />}
      {tab === "upload" && <UploadTab onUploaded={() => undefined} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab: Activities & Rosters
// ---------------------------------------------------------------------------

function RostersTab() {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [newName, setNewName] = useState("");
  const [newCategory, setNewCategory] = useState("athletics");
  const [busy, setBusy] = useState(false);

  const loadActivities = useCallback(async () => {
    setLoading(true);
    try {
      const r = await authFetch("/api/eligibility/activities");
      const d = r.ok ? ((await r.json()) as Activity[]) : [];
      setActivities(d);
      setSelectedId((prev) => prev ?? (d[0]?.id ?? null));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadActivities();
  }, [loadActivities]);

  const createActivity = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const r = await authFetch("/api/eligibility/activities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, category: newCategory }),
      });
      if (r.ok) {
        const row = (await r.json()) as Activity;
        setNewName("");
        await loadActivities();
        setSelectedId(row.id);
      } else {
        alert(`Could not create activity (${r.status})`);
      }
    } finally {
      setBusy(false);
    }
  };

  const selected = activities.find((a) => a.id === selectedId) ?? null;

  return (
    <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
      <div style={{ flex: "0 0 260px", minWidth: 240 }}>
        <h3 style={{ marginTop: 0 }}>Activities</h3>
        {loading ? (
          <p>Loading…</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {activities.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => setSelectedId(a.id)}
                style={{
                  textAlign: "left",
                  padding: "8px 10px",
                  borderRadius: 8,
                  border:
                    a.id === selectedId
                      ? "1px solid var(--accent, #2563eb)"
                      : "1px solid var(--border, #e5e7eb)",
                  background:
                    a.id === selectedId ? "rgba(37,99,235,0.08)" : "transparent",
                  cursor: "pointer",
                }}
              >
                <div style={{ fontWeight: 600 }}>{a.name}</div>
                <div style={{ fontSize: 12, color: "var(--muted, #6b7280)" }}>
                  {a.category} · {a.memberCount} member
                  {a.memberCount === 1 ? "" : "s"}
                </div>
              </button>
            ))}
            {activities.length === 0 && (
              <p style={{ color: "var(--muted, #6b7280)" }}>
                No activities yet. Create one below.
              </p>
            )}
          </div>
        )}

        <div style={{ marginTop: 16, borderTop: "1px solid var(--border, #e5e7eb)", paddingTop: 12 }}>
          <h4 style={{ margin: "0 0 8px" }}>New activity</h4>
          <input
            type="text"
            placeholder="Name (e.g. Football)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            style={{ width: "100%", marginBottom: 8 }}
          />
          <select
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
            style={{ width: "100%", marginBottom: 8 }}
          >
            <option value="athletics">Athletics</option>
            <option value="club">Club</option>
            <option value="activity">Activity</option>
          </select>
          <button
            type="button"
            className="btn"
            disabled={busy || !newName.trim()}
            onClick={createActivity}
          >
            Add activity
          </button>
        </div>
      </div>

      <div style={{ flex: "1 1 420px", minWidth: 360 }}>
        {selected ? (
          <ActivityDetail
            activity={selected}
            onChanged={loadActivities}
          />
        ) : (
          <p style={{ color: "var(--muted, #6b7280)" }}>
            Select an activity to manage its roster and coaches.
          </p>
        )}
      </div>
    </div>
  );
}

function ActivityDetail({
  activity,
  onChanged,
}: {
  activity: Activity;
  onChanged: () => Promise<void> | void;
}) {
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [addSis, setAddSis] = useState("");
  const [addJersey, setAddJersey] = useState("");
  const [busy, setBusy] = useState(false);
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);
  const [directory, setDirectory] = useState<DirectoryStaff[]>([]);
  const [coachStaffId, setCoachStaffId] = useState("");

  const loadRoster = useCallback(async () => {
    setLoading(true);
    try {
      const r = await authFetch(
        `/api/eligibility/activities/${activity.id}/roster`,
      );
      if (r.ok) {
        const d = (await r.json()) as { roster: RosterEntry[] };
        setRoster(d.roster ?? []);
      } else {
        setRoster([]);
      }
    } finally {
      setLoading(false);
    }
  }, [activity.id]);

  useEffect(() => {
    void loadRoster();
  }, [loadRoster]);

  useEffect(() => {
    authFetch("/api/staff-directory")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.staff) setDirectory(d.staff as DirectoryStaff[]);
      })
      .catch(() => {});
  }, []);

  const addMember = async () => {
    const localSisId = addSis.trim();
    if (!localSisId) return;
    setBusy(true);
    try {
      const r = await authFetch(
        `/api/eligibility/activities/${activity.id}/members`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            localSisId,
            jerseyNumber: addJersey.trim() || undefined,
          }),
        },
      );
      if (r.ok) {
        setAddSis("");
        setAddJersey("");
        await loadRoster();
        await onChanged();
      } else if (r.status === 404) {
        alert("No student in this school matches that SIS ID.");
      } else {
        alert(`Could not add member (${r.status})`);
      }
    } finally {
      setBusy(false);
    }
  };

  const updateJersey = async (memberId: number, jerseyNumber: string) => {
    await authFetch(`/api/eligibility/members/${memberId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jerseyNumber }),
    });
    await loadRoster();
  };

  const removeMember = async (memberId: number) => {
    if (!confirm("Remove this student from the roster?")) return;
    await authFetch(`/api/eligibility/members/${memberId}`, {
      method: "DELETE",
    });
    await loadRoster();
    await onChanged();
  };

  const onBulkFile = async (file: File) => {
    setBulkMsg("Parsing…");
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
        defval: "",
      });
      const rows = json
        .map((row) => {
          const localSisId = pickField(row, [
            "localsisid",
            "local_sis_id",
            "sisid",
            "sis_id",
            "studentid",
            "student_id",
            "id",
          ]);
          const jerseyNumber = pickField(row, [
            "jersey",
            "jerseynumber",
            "jersey_number",
            "number",
            "#",
          ]);
          return { localSisId, jerseyNumber: jerseyNumber || undefined };
        })
        .filter((r) => r.localSisId);
      if (rows.length === 0) {
        setBulkMsg("No rows with a SIS ID column were found.");
        return;
      }
      const r = await authFetch(
        `/api/eligibility/activities/${activity.id}/members/bulk`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rows }),
        },
      );
      if (r.ok) {
        const d = (await r.json()) as {
          matched: number;
          unmatchedCount: number;
          unmatched: string[];
        };
        setBulkMsg(
          `Added ${d.matched}. ${d.unmatchedCount} unmatched${
            d.unmatched.length ? `: ${d.unmatched.slice(0, 10).join(", ")}` : ""
          }`,
        );
        await loadRoster();
        await onChanged();
      } else {
        setBulkMsg(`Upload failed (${r.status}).`);
      }
    } catch (err) {
      setBulkMsg(`Could not parse file: ${(err as Error).message}`);
    }
  };

  const addCoach = async () => {
    const staffId = Number(coachStaffId);
    if (!staffId) return;
    const r = await authFetch(
      `/api/eligibility/activities/${activity.id}/coaches`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ staffId }),
      },
    );
    if (r.ok) {
      setCoachStaffId("");
      await onChanged();
    } else {
      alert(`Could not add coach (${r.status})`);
    }
  };

  const removeCoach = async (coachId: number) => {
    await authFetch(`/api/eligibility/coaches/${coachId}`, { method: "DELETE" });
    await onChanged();
  };

  return (
    <div>
      <h3 style={{ marginTop: 0 }}>{activity.name}</h3>

      {/* Coaches */}
      <div style={{ marginBottom: 16 }}>
        <h4 style={{ margin: "0 0 6px" }}>Coaches</h4>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
          {activity.coaches.map((c) => (
            <span key={c.id} className="badge badge-neutral">
              {c.name ?? `Staff #${c.staffId}`}
              <button
                type="button"
                onClick={() => removeCoach(c.id)}
                style={{
                  marginLeft: 6,
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                  color: "inherit",
                }}
                aria-label="Remove coach"
              >
                ×
              </button>
            </span>
          ))}
          {activity.coaches.length === 0 && (
            <span style={{ color: "var(--muted, #6b7280)", fontSize: 13 }}>
              No coaches assigned.
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <select
            value={coachStaffId}
            onChange={(e) => setCoachStaffId(e.target.value)}
          >
            <option value="">Add coach…</option>
            {directory.map((s) => (
              <option key={s.id} value={s.id}>
                {s.displayName}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn"
            disabled={!coachStaffId}
            onClick={addCoach}
          >
            Add
          </button>
        </div>
      </div>

      {/* Add member */}
      <div style={{ marginBottom: 12 }}>
        <h4 style={{ margin: "0 0 6px" }}>Add student</h4>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <input
            type="text"
            placeholder="SIS ID"
            value={addSis}
            onChange={(e) => setAddSis(e.target.value)}
          />
          <input
            type="text"
            placeholder="Jersey #"
            value={addJersey}
            onChange={(e) => setAddJersey(e.target.value)}
            style={{ width: 90 }}
          />
          <button
            type="button"
            className="btn"
            disabled={busy || !addSis.trim()}
            onClick={addMember}
          >
            Add
          </button>
          <label className="btn" style={{ cursor: "pointer" }}>
            Bulk upload (.xlsx/.csv)
            <input
              type="file"
              accept=".xlsx,.xls,.csv"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onBulkFile(f);
                e.target.value = "";
              }}
            />
          </label>
        </div>
        {bulkMsg && (
          <p style={{ fontSize: 13, color: "var(--muted, #6b7280)" }}>{bulkMsg}</p>
        )}
      </div>

      {/* Roster table */}
      {loading ? (
        <p>Loading roster…</p>
      ) : roster.length === 0 ? (
        <p style={{ color: "var(--muted, #6b7280)" }}>No students on this roster yet.</p>
      ) : (
        <table className="table" style={{ width: "100%" }}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Grade</th>
              <th>SIS ID</th>
              <th>Jersey</th>
              <th>Counted abs.</th>
              <th>Tardies</th>
              <th>Notes left</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {roster.map((m) => (
              <tr key={m.memberId}>
                <td>
                  {m.lastName}, {m.firstName}
                </td>
                <td>{m.grade ?? "—"}</td>
                <td>{m.localSisId ?? "—"}</td>
                <td>
                  <input
                    type="text"
                    defaultValue={m.jerseyNumber ?? ""}
                    style={{ width: 64 }}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v !== (m.jerseyNumber ?? "")) void updateJersey(m.memberId, v);
                    }}
                  />
                </td>
                <td>{m.countedAbsences}</td>
                <td>{m.daysTardy}</td>
                <td>{m.notesLeft}</td>
                <td>
                  <span className={statusBadgeClass(m.status)}>
                    {STATUS_LABEL[m.status]}
                  </span>
                </td>
                <td>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => removeMember(m.memberId)}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function pickField(row: Record<string, unknown>, keys: string[]): string {
  const norm: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    norm[k.toLowerCase().replace(/[^a-z0-9#_]/g, "")] = v;
  }
  for (const k of keys) {
    const key = k.toLowerCase().replace(/[^a-z0-9#_]/g, "");
    const v = norm[key];
    if (v !== undefined && v !== null && String(v).trim() !== "") {
      return String(v).trim();
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Tab: At-Risk Report
// ---------------------------------------------------------------------------

function AtRiskTab() {
  const [entries, setEntries] = useState<AtRiskEntry[]>([]);
  const [settings, setSettings] = useState<EligibilitySettings | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    authFetch("/api/eligibility/at-risk")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        setEntries(d.entries ?? []);
        setSettings(d.settings ?? null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3 style={{ margin: 0 }}>At-Risk Report</h3>
        <button
          type="button"
          className="btn"
          onClick={() =>
            downloadPdf(
              "/api/eligibility/at-risk.pdf",
              "at-risk-eligibility.pdf",
            )
          }
        >
          Download PDF
        </button>
      </div>
      {settings && (
        <p style={{ color: "var(--muted, #6b7280)", fontSize: 13 }}>
          {settings.semesterLabel} · ineligible at {settings.threshold}+ counted
          absences · warning within {settings.warningWindowDays}.
        </p>
      )}
      {loading ? (
        <p>Loading…</p>
      ) : entries.length === 0 ? (
        <p style={{ color: "var(--muted, #6b7280)" }}>
          No students are currently in the warning or ineligible zone.
        </p>
      ) : (
        <table className="table" style={{ width: "100%" }}>
          <thead>
            <tr>
              <th>Activity</th>
              <th>Name</th>
              <th>Grade</th>
              <th>SIS ID</th>
              <th>Jersey</th>
              <th>Days Absent</th>
              <th>Notes left</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => (
              <tr key={`${e.activityId}-${e.studentId}-${i}`}>
                <td>{e.activityName}</td>
                <td>{e.name}</td>
                <td>{e.grade ?? "—"}</td>
                <td>{e.localSisId ?? "—"}</td>
                <td>{e.jerseyNumber ?? "—"}</td>
                <td>{e.daysAbsent}</td>
                <td>{e.notesLeft}</td>
                <td>
                  <span className={statusBadgeClass(e.status)}>
                    {STATUS_LABEL[e.status]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab: Parent Notes
// ---------------------------------------------------------------------------

function ParentNotesTab() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<
    { studentId: string; localSisId: string | null; name: string; grade: number | null }[]
  >([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<{
    studentId: string;
    localSisId: string | null;
    name: string;
  } | null>(null);

  const [notes, setNotes] = useState<ParentNote[]>([]);
  const [cap, setCap] = useState(5);
  const [notesLeft, setNotesLeft] = useState(0);
  const [reason, setReason] = useState("");
  const [noteDate, setNoteDate] = useState("");
  const [busy, setBusy] = useState(false);

  const search = async () => {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    try {
      const r = await authFetch(
        `/api/student-lookup/search?q=${encodeURIComponent(q)}`,
      );
      if (r.ok) {
        const d = await r.json();
        const list = (d.results ?? d.students ?? d ?? []) as Array<
          Record<string, unknown>
        >;
        setResults(
          list.map((s) => ({
            studentId: String(s.studentId ?? s.id ?? ""),
            localSisId: (s.localSisId as string | null) ?? null,
            name: String(
              s.name ??
                `${s.firstName ?? ""} ${s.lastName ?? ""}`.trim() ??
                "",
            ),
            grade: (s.grade as number | null) ?? null,
          })),
        );
      }
    } finally {
      setSearching(false);
    }
  };

  const loadNotes = useCallback(async (studentId: string) => {
    const r = await authFetch(
      `/api/eligibility/parent-notes?studentId=${encodeURIComponent(studentId)}`,
    );
    if (r.ok) {
      const d = (await r.json()) as {
        notes: ParentNote[];
        cap: number;
        notesLeft: number;
      };
      setNotes(d.notes ?? []);
      setCap(d.cap);
      setNotesLeft(d.notesLeft);
    }
  }, []);

  const selectStudent = async (s: {
    studentId: string;
    localSisId: string | null;
    name: string;
  }) => {
    setSelected(s);
    await loadNotes(s.studentId);
  };

  const addNote = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const r = await authFetch("/api/eligibility/parent-notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId: selected.studentId,
          reason: reason.trim() || undefined,
          noteDate: noteDate || undefined,
        }),
      });
      if (r.status === 409) {
        const d = await r.json();
        alert(d.message ?? "Parent-note cap reached for this semester.");
      } else if (r.ok) {
        setReason("");
        setNoteDate("");
        await loadNotes(selected.studentId);
      } else {
        alert(`Could not log note (${r.status})`);
      }
    } finally {
      setBusy(false);
    }
  };

  const deleteNote = async (id: number) => {
    if (!selected) return;
    await authFetch(`/api/eligibility/parent-notes/${id}`, { method: "DELETE" });
    await loadNotes(selected.studentId);
  };

  return (
    <div>
      <h3 style={{ marginTop: 0 }}>Parent Notes</h3>
      <p style={{ color: "var(--muted, #6b7280)", fontSize: 13 }}>
        Each note excuses one absence. Logging the note IS the approval. Capped
        per semester (default {cap}).
      </p>

      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        <input
          type="text"
          placeholder="Search student by name or SIS ID"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void search();
          }}
          style={{ minWidth: 280 }}
        />
        <button type="button" className="btn" disabled={searching} onClick={search}>
          Search
        </button>
      </div>

      {!selected && results.length > 0 && (
        <table className="table" style={{ width: "100%", marginBottom: 12 }}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Grade</th>
              <th>SIS ID</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {results.map((s) => (
              <tr key={s.studentId}>
                <td>{s.name}</td>
                <td>{s.grade ?? "—"}</td>
                <td>{s.localSisId ?? "—"}</td>
                <td>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => selectStudent(s)}
                  >
                    Select
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {selected && (
        <div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 8,
            }}
          >
            <h4 style={{ margin: 0 }}>
              {selected.name}{" "}
              <span style={{ color: "var(--muted, #6b7280)", fontWeight: 400 }}>
                ({selected.localSisId ?? "—"})
              </span>
            </h4>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setSelected(null);
                setNotes([]);
              }}
            >
              ← Back to results
            </button>
          </div>

          <p style={{ fontSize: 13 }}>
            <strong>{notesLeft}</strong> of {cap} notes remaining this semester.
          </p>

          <div
            style={{
              display: "flex",
              gap: 6,
              flexWrap: "wrap",
              alignItems: "center",
              marginBottom: 12,
            }}
          >
            <input
              type="text"
              placeholder="Reason (optional)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              style={{ minWidth: 240 }}
            />
            <input
              type="date"
              value={noteDate}
              onChange={(e) => setNoteDate(e.target.value)}
            />
            <button
              type="button"
              className="btn"
              disabled={busy || notesLeft <= 0}
              onClick={addNote}
            >
              Log note
            </button>
          </div>

          {notes.length === 0 ? (
            <p style={{ color: "var(--muted, #6b7280)" }}>No notes logged yet.</p>
          ) : (
            <table className="table" style={{ width: "100%" }}>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Reason</th>
                  <th>Logged</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {notes.map((n) => (
                  <tr key={n.id}>
                    <td>{n.noteDate ?? "—"}</td>
                    <td>{n.reason ?? "—"}</td>
                    <td>{new Date(n.createdAt).toLocaleDateString()}</td>
                    <td>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => deleteNote(n.id)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab: Upload
// ---------------------------------------------------------------------------

function UploadTab({ onUploaded }: { onUploaded: () => void }) {
  const [uploads, setUploads] = useState<UploadAudit[]>([]);
  const [result, setResult] = useState<{
    matched: number;
    unmatchedCount: number;
    unmatched: string[];
    notified: number;
  } | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const loadUploads = useCallback(async () => {
    const r = await authFetch("/api/eligibility/uploads");
    if (r.ok) {
      const d = (await r.json()) as { uploads?: UploadAudit[] } | UploadAudit[];
      setUploads(Array.isArray(d) ? d : d.uploads ?? []);
    }
  }, []);

  useEffect(() => {
    void loadUploads();
  }, [loadUploads]);

  const onFile = async (file: File) => {
    setStatus("Parsing…");
    setResult(null);
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
        defval: "",
      });
      const rows = json
        .map((row) => {
          const localSisId = pickField(row, [
            "localsisid",
            "local_sis_id",
            "sisid",
            "sis_id",
            "studentid",
            "student_id",
            "id",
          ]);
          const absenceTotal = Number(
            pickField(row, [
              "absencetotal",
              "absence_total",
              "absences",
              "absent",
              "daysabsent",
              "days_absent",
            ]) || "0",
          );
          const daysTardy = Number(
            pickField(row, [
              "daystardy",
              "days_tardy",
              "tardies",
              "tardy",
            ]) || "0",
          );
          return {
            localSisId,
            absenceTotal: Number.isFinite(absenceTotal) ? absenceTotal : 0,
            daysTardy: Number.isFinite(daysTardy) ? daysTardy : 0,
          };
        })
        .filter((r) => r.localSisId);
      if (rows.length === 0) {
        setStatus("No rows with a SIS ID column were found.");
        return;
      }
      setStatus(`Uploading ${rows.length} rows…`);
      const r = await authFetch("/api/eligibility/attendance/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows, filename: file.name }),
      });
      if (r.ok) {
        const d = (await r.json()) as {
          matched: number;
          unmatchedCount: number;
          unmatched: string[];
          notified: number;
        };
        setResult(d);
        setStatus(null);
        await loadUploads();
        onUploaded();
      } else {
        setStatus(`Upload failed (${r.status}).`);
      }
    } catch (err) {
      setStatus(`Could not parse file: ${(err as Error).message}`);
    }
  };

  return (
    <div>
      <h3 style={{ marginTop: 0 }}>Daily Attendance Upload</h3>
      <p style={{ color: "var(--muted, #6b7280)", fontSize: 13 }}>
        Each upload REPLACES the stored absence/tardy totals for the current
        semester (totals are never summed across files). Columns: SIS ID,
        absence total, days tardy.
      </p>

      <label className="btn" style={{ cursor: "pointer", display: "inline-block" }}>
        Choose file (.xlsx/.csv)
        <input
          type="file"
          accept=".xlsx,.xls,.csv"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onFile(f);
            e.target.value = "";
          }}
        />
      </label>

      {status && <p style={{ fontSize: 14 }}>{status}</p>}

      {result && (
        <div
          className="card"
          style={{ marginTop: 12, background: "rgba(37,99,235,0.06)" }}
        >
          <p style={{ margin: 0 }}>
            <strong>{result.matched}</strong> students updated ·{" "}
            <strong>{result.notified}</strong> notifications sent ·{" "}
            <strong>{result.unmatchedCount}</strong> unmatched.
          </p>
          {result.unmatched.length > 0 && (
            <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--muted, #6b7280)" }}>
              Unmatched SIS IDs: {result.unmatched.slice(0, 25).join(", ")}
              {result.unmatched.length > 25 ? "…" : ""}
            </p>
          )}
        </div>
      )}

      <h4 style={{ margin: "20px 0 8px" }}>Upload history</h4>
      {uploads.length === 0 ? (
        <p style={{ color: "var(--muted, #6b7280)" }}>No uploads yet.</p>
      ) : (
        <table className="table" style={{ width: "100%" }}>
          <thead>
            <tr>
              <th>When</th>
              <th>File</th>
              <th>Rows</th>
              <th>Matched</th>
              <th>Unmatched</th>
            </tr>
          </thead>
          <tbody>
            {uploads.map((u) => (
              <tr key={u.id}>
                <td>{new Date(u.createdAt).toLocaleString()}</td>
                <td>{u.filename ?? "—"}</td>
                <td>{u.rowCount}</td>
                <td>{u.matchedCount}</td>
                <td>{u.unmatchedCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// EligibilitySettingsPanel — school-level rules (Settings → Eligibility tile).
// Threshold/window/ratio/cap + district-AD toggle + semester window. Edits are
// limited server-side to admin / district admin / SuperUser / Athletic
// Director (requireSettingsManager); GET reports canEditSettings so non-owners
// see a read-only view.
// ---------------------------------------------------------------------------

type SettingsResponse = EligibilitySettings & { canEditSettings?: boolean };

export function EligibilitySettingsPanel() {
  const [s, setS] = useState<EligibilitySettings | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await authFetch("/api/eligibility/settings");
      if (r.ok) {
        const d = (await r.json()) as SettingsResponse;
        const { canEditSettings, ...rest } = d;
        setS(rest);
        setCanEdit(Boolean(canEditSettings));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const update = <K extends keyof EligibilitySettings>(
    key: K,
    value: EligibilitySettings[K],
  ) => {
    setS((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  const save = async () => {
    if (!s) return;
    setSaving(true);
    try {
      const r = await authFetch("/api/eligibility/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threshold: s.threshold,
          warningWindowDays: s.warningWindowDays,
          tardyToAbsenceRatio: s.tardyToAbsenceRatio,
          parentNoteCap: s.parentNoteCap,
          districtAdNotify: s.districtAdNotify,
          semesterLabel: s.semesterLabel,
          semesterStart: s.semesterStart || null,
          semesterEnd: s.semesterEnd || null,
        }),
      });
      if (r.ok) {
        const d = (await r.json()) as SettingsResponse;
        const { canEditSettings, ...rest } = d;
        setS(rest);
        if (canEditSettings !== undefined) setCanEdit(Boolean(canEditSettings));
        setSavedAt(Date.now());
      } else {
        alert(`Could not save settings (${r.status})`);
      }
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p>Loading…</p>;
  if (!s) return <p>Could not load eligibility settings.</p>;

  const numField = (
    label: string,
    key: keyof EligibilitySettings,
    hint: string,
    min = 0,
  ) => (
    <label style={{ display: "block", marginBottom: 14 }}>
      <div style={{ fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 13, color: "var(--muted, #6b7280)", marginBottom: 4 }}>
        {hint}
      </div>
      <input
        type="number"
        min={min}
        value={String(s[key] ?? 0)}
        disabled={!canEdit}
        onChange={(e) => update(key, Number(e.target.value) as never)}
        style={{ width: 140 }}
      />
    </label>
  );

  return (
    <div className="card" style={{ maxWidth: 640 }}>
      <h2 style={{ marginTop: 0 }}>Eligibility Settings</h2>
      <p style={{ color: "var(--muted, #6b7280)", fontSize: 14 }}>
        School-wide rules applied uniformly across every activity. These are
        district defaults; set by district admin, Athletic Director, or
        SuperUser.
      </p>

      {!canEdit && (
        <div className="badge badge-warning" style={{ marginBottom: 12 }}>
          Read-only — only admin / district admin / Athletic Director / SuperUser
          can change these rules.
        </div>
      )}

      {numField(
        "Ineligibility threshold",
        "threshold",
        "Counted absences at or above this number make a student ineligible.",
        1,
      )}
      {numField(
        "Warning window (days)",
        "warningWindowDays",
        "How many absences below the threshold puts a student in the warning zone.",
        0,
      )}
      {numField(
        "Tardy-to-absence ratio",
        "tardyToAbsenceRatio",
        "Every N tardies counts as one absence. Set 0 to ignore tardies.",
        0,
      )}
      {numField(
        "Parent-note cap (per semester)",
        "parentNoteCap",
        "Maximum approved parent notes that can offset absences each semester.",
        0,
      )}

      <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16 }}>
        <input
          type="checkbox"
          checked={s.districtAdNotify}
          disabled={!canEdit}
          onChange={(e) => update("districtAdNotify", e.target.checked)}
        />
        <span>Notify the district Athletic Director on threshold crossings</span>
      </label>

      <div style={{ borderTop: "1px solid var(--border, #e5e7eb)", paddingTop: 12 }}>
        <h3 style={{ margin: "0 0 8px" }}>Current semester</h3>
        <label style={{ display: "block", marginBottom: 12 }}>
          <div style={{ fontWeight: 600 }}>Semester label</div>
          <input
            type="text"
            value={s.semesterLabel}
            disabled={!canEdit}
            onChange={(e) => update("semesterLabel", e.target.value)}
            style={{ minWidth: 240 }}
          />
        </label>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <label>
            <div style={{ fontWeight: 600 }}>Start</div>
            <input
              type="date"
              value={s.semesterStart ?? ""}
              disabled={!canEdit}
              onChange={(e) => update("semesterStart", e.target.value || null)}
            />
          </label>
          <label>
            <div style={{ fontWeight: 600 }}>End</div>
            <input
              type="date"
              value={s.semesterEnd ?? ""}
              disabled={!canEdit}
              onChange={(e) => update("semesterEnd", e.target.value || null)}
            />
          </label>
        </div>
      </div>

      {canEdit && (
        <div style={{ marginTop: 16, display: "flex", gap: 12, alignItems: "center" }}>
          <button type="button" className="btn" disabled={saving} onClick={save}>
            {saving ? "Saving…" : "Save settings"}
          </button>
          {savedAt && (
            <span style={{ color: "var(--muted, #6b7280)", fontSize: 13 }}>
              Saved.
            </span>
          )}
        </div>
      )}
    </div>
  );
}
