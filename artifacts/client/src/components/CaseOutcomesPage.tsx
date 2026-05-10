import { useEffect, useState } from "react";
import { authFetch } from "../lib/authToken";

// Per-school case-closure outcome catalog. Admins/SuperUsers can add,
// edit (label/description/sort order), and retire outcomes. The `code`
// is immutable post-create — historical closed cases reference it.

interface OutcomeRow {
  id: number;
  code: string;
  label: string;
  description: string;
  sortOrder: number;
  active: boolean;
  createdByName: string;
  createdAt: string;
}

export default function CaseOutcomesPage() {
  const [rows, setRows] = useState<OutcomeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Record<number, Partial<OutcomeRow>>>(
    {},
  );
  const [newLabel, setNewLabel] = useState("");
  const [newCode, setNewCode] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await authFetch("/api/watchlist/case-outcomes?all=1");
      const j = (await r.json()) as { outcomes: OutcomeRow[] };
      setRows(j.outcomes ?? []);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const add = async () => {
    if (!newLabel.trim()) return;
    setBusy(true);
    try {
      const r = await authFetch("/api/watchlist/case-outcomes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: newLabel,
          code: newCode || undefined,
          description: newDesc,
          sortOrder: (rows.length + 1) * 10,
        }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setErr(j.error ?? "Failed to add outcome");
        return;
      }
      setNewLabel("");
      setNewCode("");
      setNewDesc("");
      setErr(null);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const save = async (id: number) => {
    const patch = editing[id];
    if (!patch) return;
    setBusy(true);
    try {
      const r = await authFetch(`/api/watchlist/case-outcomes/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setErr(j.error ?? "Failed to save");
        return;
      }
      setEditing((prev) => {
        const { [id]: _, ...rest } = prev;
        return rest;
      });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (row: OutcomeRow) => {
    setBusy(true);
    try {
      await authFetch(`/api/watchlist/case-outcomes/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !row.active }),
      });
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <h2 style={{ marginTop: 0 }}>Case Closure Outcomes</h2>
      <p style={{ color: "var(--ink-soft)", marginTop: 0 }}>
        Every case must be closed with one of these outcomes. Add ones that
        match your school's discipline language; retire defaults you don't use.
        Codes are permanent (historical cases reference them) — labels and
        descriptions can be edited at any time.
      </p>

      {err && (
        <div
          style={{
            padding: "0.5rem 0.75rem",
            background: "#FFE4E1",
            color: "#7A1F1F",
            borderRadius: 6,
            marginBottom: "0.75rem",
          }}
        >
          {err}
        </div>
      )}

      {loading ? (
        <div>Loading…</div>
      ) : (
        <table className="table" style={{ width: "100%" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Label</th>
              <th style={{ textAlign: "left" }}>Code</th>
              <th style={{ textAlign: "left" }}>Description</th>
              <th style={{ textAlign: "right" }}>Order</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const draft = editing[row.id];
              const isEditing = !!draft;
              return (
                <tr
                  key={row.id}
                  style={{ opacity: row.active ? 1 : 0.55 }}
                >
                  <td>
                    {isEditing ? (
                      <input
                        value={draft.label ?? row.label}
                        onChange={(e) =>
                          setEditing((p) => ({
                            ...p,
                            [row.id]: { ...p[row.id], label: e.target.value },
                          }))
                        }
                        style={{ width: "100%" }}
                      />
                    ) : (
                      <strong>{row.label}</strong>
                    )}
                  </td>
                  <td>
                    <code style={{ fontSize: "0.85em" }}>{row.code}</code>
                  </td>
                  <td>
                    {isEditing ? (
                      <input
                        value={draft.description ?? row.description}
                        onChange={(e) =>
                          setEditing((p) => ({
                            ...p,
                            [row.id]: {
                              ...p[row.id],
                              description: e.target.value,
                            },
                          }))
                        }
                        style={{ width: "100%" }}
                      />
                    ) : (
                      <span style={{ color: "var(--ink-soft)" }}>
                        {row.description || "—"}
                      </span>
                    )}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {isEditing ? (
                      <input
                        type="number"
                        value={draft.sortOrder ?? row.sortOrder}
                        onChange={(e) =>
                          setEditing((p) => ({
                            ...p,
                            [row.id]: {
                              ...p[row.id],
                              sortOrder: Number(e.target.value),
                            },
                          }))
                        }
                        style={{ width: 70 }}
                      />
                    ) : (
                      row.sortOrder
                    )}
                  </td>
                  <td style={{ textAlign: "center" }}>
                    {row.active ? "Active" : "Retired"}
                  </td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    {isEditing ? (
                      <>
                        <button
                          type="button"
                          onClick={() => void save(row.id)}
                          disabled={busy}
                          style={{ marginRight: 4 }}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setEditing((p) => {
                              const { [row.id]: _, ...rest } = p;
                              return rest;
                            })
                          }
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() =>
                            setEditing((p) => ({ ...p, [row.id]: {} }))
                          }
                          style={{ marginRight: 4 }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => void toggle(row)}
                          disabled={busy}
                        >
                          {row.active ? "Retire" : "Restore"}
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <h3 style={{ marginTop: "1.25rem" }}>Add new outcome</h3>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 2fr auto",
          gap: 8,
          alignItems: "end",
        }}
      >
        <label>
          <div style={{ fontSize: 11, color: "var(--ink-soft)" }}>Label</div>
          <input
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="e.g. Restorative Conference"
            style={{ width: "100%" }}
          />
        </label>
        <label>
          <div style={{ fontSize: 11, color: "var(--ink-soft)" }}>
            Code (auto from label if blank)
          </div>
          <input
            value={newCode}
            onChange={(e) => setNewCode(e.target.value.toLowerCase())}
            placeholder="restorative_conference"
            style={{ width: "100%" }}
          />
        </label>
        <label>
          <div style={{ fontSize: 11, color: "var(--ink-soft)" }}>
            Description (optional)
          </div>
          <input
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            placeholder="Shown as a tooltip in the close-case dropdown."
            style={{ width: "100%" }}
          />
        </label>
        <button type="button" onClick={() => void add()} disabled={busy || !newLabel.trim()}>
          Add
        </button>
      </div>
    </div>
  );
}
