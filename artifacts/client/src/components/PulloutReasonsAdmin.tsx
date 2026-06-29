import { useEffect, useState } from "react";
import { authFetch } from "../lib/authToken";

// Self-contained editor for the school's pullout-reason list (the quick-pick
// reasons teachers see when requesting a behavior-specialist pullout). Hits the
// same /api/pullout-reasons endpoints used by Site Management, so edits made
// here and there stay in sync. Server enforces the admin/BS/MTSS/dean gate.
type PulloutReason = {
  id: number;
  name: string;
  category: string;
  active: boolean;
};

export default function PulloutReasonsAdmin() {
  const [list, setList] = useState<PulloutReason[]>([]);
  const [msg, setMsg] = useState("");
  const [newName, setNewName] = useState("");
  const [newCategory, setNewCategory] = useState("Behavior");

  const load = async () => {
    setMsg("");
    try {
      const res = await authFetch("/api/pullout-reasons");
      if (res.status === 401) {
        setList([]);
        return;
      }
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setList([]);
        setMsg(j.error || `Couldn't load reasons (HTTP ${res.status}).`);
        return;
      }
      const data = (await res.json()) as PulloutReason[];
      setList(Array.isArray(data) ? data : []);
    } catch (e) {
      setList([]);
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const add = async () => {
    const name = newName.trim();
    if (!name) {
      setMsg("Name is required.");
      return;
    }
    setMsg("");
    try {
      const res = await authFetch("/api/pullout-reasons", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          category: newCategory.trim() || "General",
        }),
      });
      if (res.status === 401) {
        throw new Error(
          "Your session expired. Please refresh the page and sign in again.",
        );
      }
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      setNewName("");
      void load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const toggleActive = async (id: number, active: boolean) => {
    setMsg("");
    try {
      const res = await authFetch(`/api/pullout-reasons/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      void load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (id: number, name: string) => {
    if (
      !window.confirm(
        `Delete the pullout reason "${name}"? Past pullouts using it stay intact.`,
      )
    ) {
      return;
    }
    setMsg("");
    try {
      const res = await authFetch(`/api/pullout-reasons/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      void load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const sorted = [...list].sort((a, b) =>
    a.category === b.category
      ? a.name.localeCompare(b.name)
      : a.category.localeCompare(b.category),
  );

  return (
    <div>
      <h3 style={{ marginTop: 0 }}>Pullout Reasons</h3>
      <p style={{ marginTop: 0, color: "var(--muted, #64748b)" }}>
        Manage the quick-pick reasons teachers see when requesting a
        behavior-specialist pullout. Deactivate reasons to hide them from the
        form without losing past records.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr auto",
          gap: "0.5rem",
          alignItems: "end",
          marginBottom: "0.75rem",
          maxWidth: "48rem",
        }}
      >
        <label>
          <div style={{ fontSize: "0.85rem" }}>Name</div>
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="e.g. Threats"
            style={{ width: "100%" }}
          />
        </label>
        <label>
          <div style={{ fontSize: "0.85rem" }}>Category</div>
          <input
            type="text"
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
            placeholder="Behavior"
            style={{ width: "100%" }}
          />
        </label>
        <button type="button" onClick={add}>
          Add Reason
        </button>
      </div>

      {msg && (
        <div style={{ color: "crimson", marginBottom: "0.5rem" }}>{msg}</div>
      )}

      {sorted.length === 0 ? (
        <div style={{ color: "var(--muted, #64748b)" }}>No reasons yet.</div>
      ) : (
        <table
          className="pulse-table"
          style={{ width: "100%", borderCollapse: "collapse", maxWidth: "48rem" }}
        >
          <thead>
            <tr style={{ borderBottom: "1px solid #ccc", textAlign: "left" }}>
              <th style={{ padding: "0.4rem" }}>Category</th>
              <th style={{ padding: "0.4rem" }}>Reason</th>
              <th style={{ padding: "0.4rem" }}>Active</th>
              <th style={{ padding: "0.4rem" }}></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.id} style={{ borderBottom: "1px solid #eee" }}>
                <td style={{ padding: "0.4rem" }}>{r.category}</td>
                <td style={{ padding: "0.4rem" }}>{r.name}</td>
                <td style={{ padding: "0.4rem" }}>{r.active ? "Yes" : "No"}</td>
                <td
                  style={{
                    padding: "0.4rem",
                    display: "flex",
                    gap: "0.4rem",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => toggleActive(r.id, !r.active)}
                  >
                    {r.active ? "Deactivate" : "Activate"}
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(r.id, r.name)}
                    style={{ color: "crimson" }}
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
  );
}
