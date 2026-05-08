import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { authFetch } from "../lib/authToken";

interface ClosedRow {
  id: number;
  day: string;
  label: string | null;
  createdByName: string | null;
}

const input: CSSProperties = {
  padding: "0.4rem 0.55rem",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  font: "inherit",
};

export default function SchoolClosedDaysAdmin() {
  const [rows, setRows] = useState<ClosedRow[] | null>(null);
  const [day, setDay] = useState("");
  const [label, setLabel] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const today = new Date();
    const from = `${today.getFullYear()}-01-01`;
    const next = new Date(today);
    next.setFullYear(next.getFullYear() + 1);
    const to = `${next.getFullYear()}-12-31`;
    const r = await authFetch(
      `/api/school-closed-days?from=${from}&to=${to}`,
    );
    if (r.ok) setRows((await r.json()) as ClosedRow[]);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const add = async () => {
    setErr(null);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      setErr("Pick a date.");
      return;
    }
    const r = await authFetch("/api/school-closed-days", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ day, label: label.trim() || null }),
    });
    if (!r.ok) {
      setErr(await r.text());
      return;
    }
    setDay("");
    setLabel("");
    await reload();
  };

  const remove = async (id: number) => {
    if (!confirm("Remove this closed day?")) return;
    await authFetch(`/api/school-closed-days/${id}`, { method: "DELETE" });
    await reload();
  };

  return (
    <div>
      <p style={{ color: "var(--text-subtle)", marginTop: 0 }}>
        Days school is closed (holidays, planning days, hurricane days).
        ISS rollover and the Add Discipline Log calendar both skip these.
      </p>
      <div style={{ display: "flex", gap: 6, marginBottom: "0.75rem" }}>
        <input
          type="date"
          style={input}
          value={day}
          onChange={(e) => setDay(e.target.value)}
        />
        <input
          style={{ ...input, flex: 1 }}
          placeholder="Label (optional, e.g. Thanksgiving)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
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
          No closed days yet. Add the school calendar at start of year.
        </p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead style={{ textAlign: "left", background: "#f8fafc" }}>
            <tr>
              <th style={{ padding: "6px 10px" }}>Date</th>
              <th style={{ padding: "6px 10px" }}>Label</th>
              <th style={{ padding: "6px 10px" }}>Added by</th>
              <th style={{ padding: "6px 10px", width: 60 }} />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={{ borderTop: "1px solid #f1f5f9" }}>
                <td style={{ padding: "6px 10px" }}>{r.day}</td>
                <td style={{ padding: "6px 10px" }}>{r.label ?? "—"}</td>
                <td style={{ padding: "6px 10px" }}>
                  {r.createdByName ?? "—"}
                </td>
                <td style={{ padding: "6px 10px" }}>
                  <button
                    type="button"
                    onClick={() => void remove(r.id)}
                    style={{
                      padding: "3px 8px",
                      fontSize: 12,
                      border: "1px solid #fecaca",
                      borderRadius: 6,
                      background: "white",
                      color: "#b91c1c",
                      cursor: "pointer",
                    }}
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
