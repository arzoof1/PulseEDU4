// Curates the per-school list of "reason tags" that teachers pick from
// when filing a Separation Suggestion in Teacher Roster. Mirrors the
// pattern of DisciplineReasonsAdmin: add, list, toggle active. Inactive
// tags are hidden from the modal dropdown but kept on historical flags
// so the aggregate view stays readable.

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { authFetch } from "../lib/authToken";
import { HowToUseHelp, HowToSection, RoleSection } from "./HowToUseHelp";

interface TagRow {
  id: number;
  schoolId: number;
  label: string;
  sortOrder: number;
  active: boolean;
}

const inputStyle: CSSProperties = {
  padding: "0.4rem 0.55rem",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  font: "inherit",
};

export default function SeparationTagsAdmin() {
  const [rows, setRows] = useState<TagRow[] | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const r = await authFetch("/api/separation-reason-tags");
    if (r.ok) setRows((await r.json()) as TagRow[]);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const add = async () => {
    setErr(null);
    if (!newLabel.trim()) return;
    const r = await authFetch("/api/separation-reason-tags", {
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

  const toggle = async (row: TagRow) => {
    await authFetch(`/api/separation-reason-tags/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !row.active }),
    });
    await reload();
  };

  return (
    <div>
      <p style={{ color: "var(--text-subtle)", marginTop: 0 }}>
        These are the reason chips a teacher can attach when flagging a pair
        of students who shouldn't be scheduled together. Kept short and
        standardized so the aggregate view (Insights → Behavior → Separation
        Suggestions) can group flags by reason. Disabling a tag hides it from
        the teacher dropdown but keeps it readable on historical flags.
      </p>
      <HowToUseHelp title="How to manage Separation Tags">
        <HowToSection title="What good labels look like">
          Short (≤ 24 chars), action-neutral, group-able. "Verbal
          conflict" and "Family-asked" beat "Verbal conflict in the
          hallway last fall" — the dashboard rolls them up by tag.
        </HowToSection>
        <RoleSection for={["admin", "coreTeam"]} title="When to add vs. consolidate">
          Resist the urge to add a new tag for every situation. If two
          existing tags would cover it, use both rather than mint a
          third — fewer choices keeps the teacher dropdown fast.
        </RoleSection>
      </HowToUseHelp>
      <div style={{ display: "flex", gap: 6, marginBottom: "0.75rem" }}>
        <input
          style={{ ...inputStyle, flex: 1 }}
          placeholder="New tag label (e.g. Verbal conflict)"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          maxLength={200}
          onKeyDown={(e) => {
            if (e.key === "Enter") void add();
          }}
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
          No tags yet. Add a few common ones (e.g. "Verbal conflict",
          "Off-task pair", "Cheating risk") so teachers have quick picks.
        </p>
      ) : (
        <table className="pulse-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead style={{ textAlign: "left", background: "#f8fafc" }}>
            <tr>
              <th style={{ padding: "6px 10px" }}>Label</th>
              <th style={{ padding: "6px 10px", width: 90 }}>Active</th>
              <th style={{ padding: "6px 10px", width: 90 }} />
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
