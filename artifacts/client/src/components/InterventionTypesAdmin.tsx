import { useEffect, useState } from "react";
import { authFetch } from "../lib/authToken";

// Self-contained editor for the school's intervention list (the strategies
// teachers pick when logging a negative behavior). Hits the same
// /api/intervention-types endpoints used by Site Management, so edits made
// here and there stay in sync. Server enforces the admin/BS/MTSS/dean gate.
type InterventionType = {
  id: number;
  name: string;
  category: string;
  requiresNote: boolean;
  active: boolean;
};

export default function InterventionTypesAdmin() {
  const [list, setList] = useState<InterventionType[]>([]);
  const [msg, setMsg] = useState("");

  const [newName, setNewName] = useState("");
  const [newCategory, setNewCategory] = useState("Classroom");
  const [newRequiresNote, setNewRequiresNote] = useState(false);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editCategory, setEditCategory] = useState("");
  const [editRequiresNote, setEditRequiresNote] = useState(false);

  const load = async () => {
    setMsg("");
    try {
      const res = await authFetch("/api/intervention-types");
      if (res.status === 401) {
        setList([]);
        return;
      }
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setList([]);
        setMsg(j.error || `Couldn't load interventions (HTTP ${res.status}).`);
        return;
      }
      const data = (await res.json()) as InterventionType[];
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
      const res = await authFetch("/api/intervention-types", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          category: newCategory.trim() || "Classroom",
          requiresNote: newRequiresNote,
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
      setNewRequiresNote(false);
      void load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const startEdit = (i: InterventionType) => {
    setMsg("");
    setEditingId(i.id);
    setEditName(i.name);
    setEditCategory(i.category);
    setEditRequiresNote(i.requiresNote);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditName("");
    setEditCategory("");
    setEditRequiresNote(false);
  };

  const saveEdit = async (id: number) => {
    const name = editName.trim();
    if (!name) {
      setMsg("Name is required.");
      return;
    }
    setMsg("");
    try {
      const res = await authFetch(`/api/intervention-types/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          category: editCategory.trim() || "Classroom",
          requiresNote: editRequiresNote,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      cancelEdit();
      void load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const toggleActive = async (id: number, active: boolean) => {
    setMsg("");
    try {
      const res = await authFetch(`/api/intervention-types/${id}`, {
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
        `Delete intervention "${name}"? This permanently removes it from the picker. Existing logged entries keep the name as a snapshot and are not affected.`,
      )
    ) {
      return;
    }
    setMsg("");
    try {
      const res = await authFetch(`/api/intervention-types/${id}`, {
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
      <h3 style={{ marginTop: 0 }}>Intervention List</h3>
      <p style={{ marginTop: 0, color: "var(--muted, #64748b)" }}>
        Add, edit, or remove the interventions teachers can pick when logging a
        negative behavior. Deactivate an intervention to hide it from the picker
        without losing past records.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr auto auto",
          gap: "0.5rem",
          alignItems: "end",
          marginBottom: "0.75rem",
          maxWidth: "52rem",
        }}
      >
        <label>
          <div style={{ fontSize: "0.85rem" }}>Name</div>
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="e.g. Redirect / proximity"
            style={{ width: "100%" }}
          />
        </label>
        <label>
          <div style={{ fontSize: "0.85rem" }}>Category</div>
          <input
            type="text"
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
            placeholder="Classroom"
            style={{ width: "100%" }}
          />
        </label>
        <label
          style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}
        >
          <input
            type="checkbox"
            checked={newRequiresNote}
            onChange={(e) => setNewRequiresNote(e.target.checked)}
          />
          <span style={{ fontSize: "0.85rem" }}>Requires note</span>
        </label>
        <button type="button" onClick={add}>
          Add
        </button>
      </div>

      {msg && (
        <div style={{ color: "crimson", marginBottom: "0.5rem" }}>{msg}</div>
      )}

      {sorted.length === 0 ? (
        <div style={{ color: "var(--muted, #64748b)" }}>
          No interventions yet.
        </div>
      ) : (
        <table
          className="pulse-table"
          style={{ width: "100%", borderCollapse: "collapse", maxWidth: "52rem" }}
        >
          <thead>
            <tr style={{ borderBottom: "1px solid #ccc", textAlign: "left" }}>
              <th style={{ padding: "0.4rem" }}>Category</th>
              <th style={{ padding: "0.4rem" }}>Intervention</th>
              <th style={{ padding: "0.4rem" }}>Note?</th>
              <th style={{ padding: "0.4rem" }}>Active</th>
              <th style={{ padding: "0.4rem" }}></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((i) =>
              editingId === i.id ? (
                <tr key={i.id} style={{ borderBottom: "1px solid #eee" }}>
                  <td style={{ padding: "0.4rem" }}>
                    <input
                      type="text"
                      value={editCategory}
                      onChange={(e) => setEditCategory(e.target.value)}
                      style={{ width: "100%" }}
                    />
                  </td>
                  <td style={{ padding: "0.4rem" }}>
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      style={{ width: "100%" }}
                    />
                  </td>
                  <td style={{ padding: "0.4rem" }}>
                    <input
                      type="checkbox"
                      checked={editRequiresNote}
                      onChange={(e) => setEditRequiresNote(e.target.checked)}
                    />
                  </td>
                  <td style={{ padding: "0.4rem" }}>{i.active ? "Yes" : "No"}</td>
                  <td
                    style={{
                      padding: "0.4rem",
                      display: "flex",
                      gap: "0.4rem",
                    }}
                  >
                    <button type="button" onClick={() => saveEdit(i.id)}>
                      Save
                    </button>
                    <button type="button" onClick={cancelEdit}>
                      Cancel
                    </button>
                  </td>
                </tr>
              ) : (
                <tr key={i.id} style={{ borderBottom: "1px solid #eee" }}>
                  <td style={{ padding: "0.4rem" }}>{i.category}</td>
                  <td style={{ padding: "0.4rem" }}>{i.name}</td>
                  <td style={{ padding: "0.4rem" }}>
                    {i.requiresNote ? "Yes" : "No"}
                  </td>
                  <td style={{ padding: "0.4rem" }}>{i.active ? "Yes" : "No"}</td>
                  <td
                    style={{
                      padding: "0.4rem",
                      display: "flex",
                      gap: "0.4rem",
                    }}
                  >
                    <button type="button" onClick={() => startEdit(i)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleActive(i.id, !i.active)}
                    >
                      {i.active ? "Deactivate" : "Activate"}
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(i.id, i.name)}
                      style={{ color: "crimson" }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
