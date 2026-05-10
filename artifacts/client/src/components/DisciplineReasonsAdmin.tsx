import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { authFetch } from "../lib/authToken";
import { HowToUseHelp, HowToSection, RoleSection } from "./HowToUseHelp";

interface ReasonRow {
  id: number;
  label: string;
  active: boolean;
  sortOrder: number;
}

const input: CSSProperties = {
  padding: "0.4rem 0.55rem",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  font: "inherit",
};

export default function DisciplineReasonsAdmin() {
  const [rows, setRows] = useState<ReasonRow[] | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const r = await authFetch("/api/discipline-reasons");
    if (r.ok) setRows((await r.json()) as ReasonRow[]);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const add = async () => {
    setErr(null);
    if (!newLabel.trim()) return;
    const r = await authFetch("/api/discipline-reasons", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: newLabel.trim() }),
    });
    if (!r.ok) {
      setErr(await r.text());
      return;
    }
    setNewLabel("");
    await reload();
  };

  const toggle = async (row: ReasonRow) => {
    await authFetch(`/api/discipline-reasons/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !row.active }),
    });
    await reload();
  };

  return (
    <div>
      <p style={{ color: "var(--text-subtle)", marginTop: 0 }}>
        These are the choices that appear in the Add ISS / OSS Log modal's
        Reason dropdown. Inactive reasons are hidden from the dropdown but
        kept on historical logs.
      </p>
      <HowToUseHelp title="How to manage Discipline Reasons">
        <HowToSection title="Keep it short and consistent">
          Short labels are easier to scan in the modal and group
          cleanly in Insights → Behavior. If you must add a long
          phrase, abbreviate the rare half ("Hall — verbal conflict").
        </HowToSection>
        <RoleSection for={["admin", "dean", "coreTeam"]} title="Editing tips">
          Inactivate (don't delete) reasons that are no longer used —
          historical logs keep the original label and reports stay
          accurate.
        </RoleSection>
      </HowToUseHelp>
      <div style={{ display: "flex", gap: 6, marginBottom: "0.75rem" }}>
        <input
          style={{ ...input, flex: 1 }}
          placeholder="New reason label (e.g. Disruptive behavior)"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          maxLength={200}
        />
        <button
          type="button"
          onClick={() => void add()}
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
      {err && (
        <div style={{ color: "#b91c1c", fontSize: 13, marginBottom: 8 }}>
          {err}
        </div>
      )}
      {rows === null ? (
        <p style={{ color: "var(--text-subtle)" }}>Loading…</p>
      ) : rows.length === 0 ? (
        <p style={{ color: "var(--text-subtle)" }}>
          No reasons yet. Add a few common ones to make logging faster.
        </p>
      ) : (
        <table className="pulse-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead style={{ textAlign: "left", background: "#f8fafc" }}>
            <tr>
              <th style={{ padding: "6px 10px" }}>Reason</th>
              <th style={{ padding: "6px 10px", width: 90 }}>Active</th>
              <th style={{ padding: "6px 10px", width: 60 }} />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={{ borderTop: "1px solid #f1f5f9" }}>
                <td style={{ padding: "6px 10px" }}>{r.label}</td>
                <td style={{ padding: "6px 10px" }}>
                  {r.active ? "Yes" : "No"}
                </td>
                <td style={{ padding: "6px 10px" }}>
                  <button
                    type="button"
                    onClick={() => void toggle(r)}
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
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
