import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { authFetch } from "../lib/authToken";
import { HowToUseHelp, HowToSection, RoleSection } from "./HowToUseHelp";

// A reason row from either scope. The merged school-facing GET tags
// each row with `scope`; the district-only GET returns the same shape.
interface ReasonRow {
  id: number;
  label: string;
  active: boolean;
  sortOrder: number;
  scope?: "district" | "school";
}

const input: CSSProperties = {
  padding: "0.4rem 0.55rem",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  font: "inherit",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 14,
};

function ReasonTable({
  rows,
  onToggle,
  readOnly,
}: {
  rows: ReasonRow[];
  onToggle?: (row: ReasonRow) => void;
  readOnly?: boolean;
}) {
  return (
    <table className="pulse-table" style={tableStyle}>
      <thead style={{ textAlign: "left", background: "#f8fafc" }}>
        <tr>
          <th style={{ padding: "6px 10px" }}>Reason</th>
          <th style={{ padding: "6px 10px", width: 90 }}>Active</th>
          {!readOnly && <th style={{ padding: "6px 10px", width: 60 }} />}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} style={{ borderTop: "1px solid #f1f5f9" }}>
            <td style={{ padding: "6px 10px" }}>{r.label}</td>
            <td style={{ padding: "6px 10px" }}>{r.active ? "Yes" : "No"}</td>
            {!readOnly && (
              <td style={{ padding: "6px 10px" }}>
                <button
                  type="button"
                  onClick={() => onToggle?.(r)}
                  style={{
                    padding: "3px 8px",
                    fontSize: 12,
                    border: "1px solid #cbd5e1",
                    borderRadius: 6,
                    background: "white",
                    cursor: "pointer",
                  }}
                >
                  {r.active ? "Disable" : "Enable"}
                </button>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function DisciplineReasonsAdmin() {
  // Merged list (district + school) — drives the school section.
  const [merged, setMerged] = useState<ReasonRow[] | null>(null);
  // District-scoped CRUD list — only loads successfully for district
  // admins / superusers. A 403 means "this user can only manage the
  // school list" and we render the district section read-only above.
  const [districtRows, setDistrictRows] = useState<ReasonRow[] | null>(null);
  const [canEditDistrict, setCanEditDistrict] = useState(false);

  const [newSchoolLabel, setNewSchoolLabel] = useState("");
  const [newDistrictLabel, setNewDistrictLabel] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [mergedResp, districtResp] = await Promise.all([
      authFetch("/api/discipline-reasons"),
      authFetch("/api/district-discipline-reasons"),
    ]);
    if (mergedResp.ok) {
      setMerged((await mergedResp.json()) as ReasonRow[]);
    }
    if (districtResp.ok) {
      setDistrictRows((await districtResp.json()) as ReasonRow[]);
      setCanEditDistrict(true);
    } else {
      setDistrictRows(null);
      setCanEditDistrict(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const addSchool = async () => {
    setErr(null);
    if (!newSchoolLabel.trim()) return;
    const r = await authFetch("/api/discipline-reasons", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: newSchoolLabel.trim() }),
    });
    if (!r.ok) {
      setErr(await r.text());
      return;
    }
    setNewSchoolLabel("");
    await reload();
  };

  const addDistrict = async () => {
    setErr(null);
    if (!newDistrictLabel.trim()) return;
    const r = await authFetch("/api/district-discipline-reasons", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: newDistrictLabel.trim() }),
    });
    if (!r.ok) {
      setErr(await r.text());
      return;
    }
    setNewDistrictLabel("");
    await reload();
  };

  const toggleSchool = async (row: ReasonRow) => {
    await authFetch(`/api/discipline-reasons/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !row.active }),
    });
    await reload();
  };

  const toggleDistrict = async (row: ReasonRow) => {
    await authFetch(`/api/district-discipline-reasons/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !row.active }),
    });
    await reload();
  };

  // Split the merged list into the two scope buckets so each renders
  // under its own header. When the user can edit district rows we
  // prefer the editable `districtRows` list because it includes the
  // full set (the merged view already filtered to "for this school").
  const mergedDistrict =
    (canEditDistrict ? districtRows : null) ??
    (merged ?? []).filter((r) => r.scope === "district");
  const mergedSchool = (merged ?? []).filter((r) => r.scope === "school");

  return (
    <div>
      <p style={{ color: "var(--text-subtle)", marginTop: 0 }}>
        These are the choices that appear in the Add ISS / OSS Log modal's
        Reason dropdown. Reasons are kept in two lists: a{" "}
        <strong>district master list</strong> that every school in the
        district sees, and a <strong>school list</strong> that only this
        school sees. Disabled reasons are hidden from the dropdown but
        stay on historical logs.
      </p>
      <HowToUseHelp title="How to manage Discipline Reasons">
        <HowToSection title="When to use each list">
          Use the <strong>district master list</strong> for codes that
          match the district's Code of Conduct (e.g. <em>FIT — Fighting</em>,{" "}
          <em>DSR — Disrespect</em>) so every school logs the same way.
          Use the <strong>school list</strong> for reasons that only one
          school tracks. The Add ISS / OSS Log dropdown shows both,
          district first.
        </HowToSection>
        <RoleSection for={["admin", "dean", "coreTeam"]} title="Editing tips">
          Inactivate (don't delete) reasons that are no longer used —
          historical logs keep the original label and reports stay
          accurate. If a school purchased the app standalone, the
          district master list will be empty and only the school list
          is used.
        </RoleSection>
      </HowToUseHelp>

      {err && (
        <div style={{ color: "#b91c1c", fontSize: 13, marginBottom: 8 }}>
          {err}
        </div>
      )}

      <section
        style={{
          marginBottom: "1.25rem",
          padding: "0.9rem 1rem",
          border: "1px solid #c7d2fe",
          background: "#eef2ff",
          borderRadius: 8,
        }}
      >
        <h3 style={{ margin: "0 0 0.5rem" }}>
          District master list{" "}
          <span
            style={{
              fontSize: 11,
              marginLeft: 6,
              padding: "2px 8px",
              background: "#4338ca",
              color: "white",
              borderRadius: 999,
              verticalAlign: "middle",
            }}
          >
            DISTRICT
          </span>
        </h3>
        {canEditDistrict ? (
          <div style={{ display: "flex", gap: 6, marginBottom: "0.75rem" }}>
            <input
              style={{ ...input, flex: 1 }}
              placeholder="New district reason (e.g. FIT — Fighting)"
              value={newDistrictLabel}
              onChange={(e) => setNewDistrictLabel(e.target.value)}
              maxLength={200}
            />
            <button
              type="button"
              onClick={() => void addDistrict()}
              style={{
                padding: "0.4rem 0.9rem",
                background: "#4338ca",
                color: "white",
                border: "none",
                borderRadius: 6,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Add
            </button>
          </div>
        ) : (
          <p
            style={{
              margin: "0 0 0.5rem",
              fontSize: 12,
              color: "var(--text-subtle)",
            }}
          >
            Read-only. Ask a district admin to update the master list.
          </p>
        )}
        {mergedDistrict.length === 0 ? (
          <p style={{ color: "var(--text-subtle)", marginBottom: 0 }}>
            No district reasons yet.
            {canEditDistrict
              ? " Add codes that match your Code of Conduct."
              : ""}
          </p>
        ) : (
          <ReasonTable
            rows={mergedDistrict}
            onToggle={canEditDistrict ? toggleDistrict : undefined}
            readOnly={!canEditDistrict}
          />
        )}
      </section>

      <section>
        <h3 style={{ margin: "0 0 0.5rem" }}>
          This school's list{" "}
          <span
            style={{
              fontSize: 11,
              marginLeft: 6,
              padding: "2px 8px",
              background: "#0f766e",
              color: "white",
              borderRadius: 999,
              verticalAlign: "middle",
            }}
          >
            SCHOOL
          </span>
        </h3>
        <div style={{ display: "flex", gap: 6, marginBottom: "0.75rem" }}>
          <input
            style={{ ...input, flex: 1 }}
            placeholder="New school-only reason (e.g. Disruptive behavior)"
            value={newSchoolLabel}
            onChange={(e) => setNewSchoolLabel(e.target.value)}
            maxLength={200}
          />
          <button
            type="button"
            onClick={() => void addSchool()}
            style={{
              padding: "0.4rem 0.9rem",
              background: "#1d4ed8",
              color: "white",
              border: "none",
              borderRadius: 6,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Add
          </button>
        </div>
        {merged === null ? (
          <p style={{ color: "var(--text-subtle)" }}>Loading…</p>
        ) : mergedSchool.length === 0 ? (
          <p style={{ color: "var(--text-subtle)" }}>
            No school-only reasons yet.
          </p>
        ) : (
          <ReasonTable rows={mergedSchool} onToggle={toggleSchool} />
        )}
      </section>
    </div>
  );
}
