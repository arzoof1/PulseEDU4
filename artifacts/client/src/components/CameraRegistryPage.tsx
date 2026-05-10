import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { authFetch } from "../lib/authToken";
import {
  HowToUseHelp,
  HowToSection,
  howtoListStyle,
} from "./HowToUseHelp";

interface CameraRow {
  id: number;
  schoolId: number;
  name: string;
  location: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

const card: CSSProperties = {
  padding: "1rem 1.1rem",
  border: "1px solid var(--border, #e5e7eb)",
  borderRadius: 10,
  background: "var(--surface, #fff)",
  marginBottom: "1rem",
};

const labelStyle: CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--text-subtle)",
  marginBottom: 4,
  textTransform: "uppercase",
  letterSpacing: 0.5,
};

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "6px 10px",
  fontSize: 14,
  border: "1px solid var(--border, #e5e7eb)",
  borderRadius: 6,
  background: "var(--surface, #fff)",
};

const btnPrimary: CSSProperties = {
  padding: "6px 14px",
  fontSize: 13,
  fontWeight: 600,
  color: "#fff",
  background: "#0F172A",
  border: "1px solid #0F172A",
  borderRadius: 6,
  cursor: "pointer",
};

const btnGhost: CSSProperties = {
  padding: "6px 12px",
  fontSize: 13,
  fontWeight: 600,
  color: "#374151",
  background: "transparent",
  border: "1px solid var(--border, #e5e7eb)",
  borderRadius: 6,
  cursor: "pointer",
};

export default function CameraRegistryPage() {
  const [cameras, setCameras] = useState<CameraRow[]>([]);
  const [showInactive, setShowInactive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [newLocation, setNewLocation] = useState("");
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editLocation, setEditLocation] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await authFetch(
        `/api/watchlist/cameras${showInactive ? "?includeInactive=1" : ""}`,
      );
      if (!r.ok) {
        setError(await r.text());
        setCameras([]);
        return;
      }
      const j = (await r.json()) as { cameras: CameraRow[] };
      setCameras(j.cameras);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load cameras");
    } finally {
      setLoading(false);
    }
  }, [showInactive]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function addCamera() {
    if (!newName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const r = await authFetch("/api/watchlist/cameras", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName.trim(),
          location: newLocation.trim(),
        }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? `HTTP ${r.status}`);
        return;
      }
      setNewName("");
      setNewLocation("");
      await reload();
    } finally {
      setSaving(false);
    }
  }

  function startEdit(row: CameraRow) {
    setEditingId(row.id);
    setEditName(row.name);
    setEditLocation(row.location ?? "");
  }

  function cancelEdit() {
    setEditingId(null);
    setEditName("");
    setEditLocation("");
  }

  async function saveEdit() {
    if (editingId == null || !editName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const r = await authFetch(`/api/watchlist/cameras/${editingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editName.trim(),
          location: editLocation.trim(),
        }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? `HTTP ${r.status}`);
        return;
      }
      cancelEdit();
      await reload();
    } finally {
      setSaving(false);
    }
  }

  async function softDelete(id: number) {
    if (!confirm("Remove this camera from the dropdown? Past footage rows that already reference it will keep their original camera name.")) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const r = await authFetch(`/api/watchlist/cameras/${id}`, {
        method: "DELETE",
      });
      if (!r.ok) {
        setError(await r.text());
        return;
      }
      await reload();
    } finally {
      setSaving(false);
    }
  }

  async function reactivate(id: number) {
    setSaving(true);
    setError(null);
    try {
      const r = await authFetch(`/api/watchlist/cameras/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: true }),
      });
      if (!r.ok) {
        setError(await r.text());
        return;
      }
      await reload();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <h1 style={{ marginTop: 0 }}>Camera Registry</h1>
      <p style={{ color: "var(--text-subtle)", marginTop: 0 }}>
        The list of named security cameras at your school. Admins pick from
        this list when logging video evidence on a case, instead of typing
        the camera name by hand each time. Schools with 100+ cameras
        especially benefit — it eliminates typos and keeps the same camera
        spelled the same way across years of records.
      </p>

      <HowToUseHelp title="How to use the Camera Registry">
        <HowToSection title="What this page controls">
          <ul style={howtoListStyle}>
            <li>
              <strong>Names</strong> — what shows in the dropdown when an
              admin logs footage on a case. Use the same name your security
              system uses so admins can match the camera to the live feed.
            </li>
            <li>
              <strong>Locations</strong> — optional human description ("3rd
              floor north stairwell") that appears as a hint in the
              dropdown. Helpful when a camera name is just a number.
            </li>
            <li>
              <strong>Removed cameras</strong> — soft-deleted cameras stop
              appearing in the dropdown but their name is preserved on
              every past footage row that referenced them. Toggle "Show
              removed" to bring one back if it was deleted by mistake.
            </li>
          </ul>
        </HowToSection>
        <HowToSection title="Tips for large schools">
          <ul style={howtoListStyle}>
            <li>
              Use a consistent prefix scheme so filtering is fast — e.g.
              <em> Building 4 / Floor 2 / East / Cam 12</em>. Start typing
              "Building 4" in the dropdown and you'll narrow to one wing.
            </li>
            <li>
              Bulk-import via the Data Importer is on the roadmap. For now,
              this page is the place to add or rename cameras one at a time.
            </li>
          </ul>
        </HowToSection>
        <HowToSection title="Who can see this">
          <p style={{ margin: 0 }}>
            Only the Case Investigator group (admins, Behavior Specialists,
            MTSS Coordinators, Deans) sees this page or the camera dropdown
            on the case file.
          </p>
        </HowToSection>
      </HowToUseHelp>

      <section style={card}>
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Add a camera</h2>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr auto",
            gap: 10,
            alignItems: "end",
          }}
        >
          <div>
            <span style={labelStyle}>Camera name (required)</span>
            <input
              style={inputStyle}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. Cafeteria North"
              maxLength={200}
            />
          </div>
          <div>
            <span style={labelStyle}>Location (optional)</span>
            <input
              style={inputStyle}
              value={newLocation}
              onChange={(e) => setNewLocation(e.target.value)}
              placeholder="e.g. Cafeteria, north entrance"
              maxLength={200}
            />
          </div>
          <button
            type="button"
            onClick={() => void addCamera()}
            disabled={saving || !newName.trim()}
            style={{
              ...btnPrimary,
              opacity: !newName.trim() ? 0.4 : 1,
              cursor: !newName.trim() ? "not-allowed" : "pointer",
            }}
          >
            Add camera
          </button>
        </div>
      </section>

      <section style={card}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 8,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 16 }}>
            {showInactive ? "All cameras" : "Active cameras"} (
            {cameras.length})
          </h2>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 13,
              color: "var(--text-subtle)",
            }}
          >
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
            />
            Show removed
          </label>
        </div>

        {error && (
          <div
            style={{
              padding: "8px 12px",
              background: "#FEF2F2",
              border: "1px solid #FECACA",
              color: "#991B1B",
              borderRadius: 6,
              fontSize: 13,
              marginBottom: 10,
            }}
          >
            {error}
          </div>
        )}

        {loading ? (
          <div style={{ color: "var(--text-subtle)", fontSize: 13 }}>
            Loading…
          </div>
        ) : cameras.length === 0 ? (
          <div style={{ color: "var(--text-subtle)", fontSize: 13 }}>
            No cameras yet. Add one above to populate the dropdown on the
            video evidence form.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", fontSize: 12, color: "#6B7280" }}>
                <th style={{ padding: "6px 8px", borderBottom: "1px solid #E5E7EB" }}>Name</th>
                <th style={{ padding: "6px 8px", borderBottom: "1px solid #E5E7EB" }}>Location</th>
                <th style={{ padding: "6px 8px", borderBottom: "1px solid #E5E7EB", width: 90 }}>Status</th>
                <th style={{ padding: "6px 8px", borderBottom: "1px solid #E5E7EB", width: 200 }}></th>
              </tr>
            </thead>
            <tbody>
              {cameras.map((row) => {
                const isEditing = editingId === row.id;
                return (
                  <tr key={row.id} style={{ fontSize: 13, opacity: row.active ? 1 : 0.55 }}>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #F3F4F6" }}>
                      {isEditing ? (
                        <input
                          style={inputStyle}
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          maxLength={200}
                        />
                      ) : (
                        <strong>{row.name}</strong>
                      )}
                    </td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #F3F4F6" }}>
                      {isEditing ? (
                        <input
                          style={inputStyle}
                          value={editLocation}
                          onChange={(e) => setEditLocation(e.target.value)}
                          maxLength={200}
                        />
                      ) : (
                        row.location ?? <span style={{ color: "#9CA3AF" }}>—</span>
                      )}
                    </td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #F3F4F6" }}>
                      {row.active ? (
                        <span style={{ color: "#047857", fontWeight: 600 }}>Active</span>
                      ) : (
                        <span style={{ color: "#9F1D1D", fontWeight: 600 }}>Removed</span>
                      )}
                    </td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid #F3F4F6", textAlign: "right" }}>
                      {isEditing ? (
                        <div style={{ display: "inline-flex", gap: 6 }}>
                          <button
                            type="button"
                            style={btnPrimary}
                            disabled={saving || !editName.trim()}
                            onClick={() => void saveEdit()}
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            style={btnGhost}
                            disabled={saving}
                            onClick={cancelEdit}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div style={{ display: "inline-flex", gap: 6 }}>
                          {row.active ? (
                            <>
                              <button
                                type="button"
                                style={btnGhost}
                                disabled={saving}
                                onClick={() => startEdit(row)}
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                style={{ ...btnGhost, color: "#9F1D1D", borderColor: "#FECACA" }}
                                disabled={saving}
                                onClick={() => void softDelete(row.id)}
                              >
                                Remove
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              style={btnGhost}
                              disabled={saving}
                              onClick={() => void reactivate(row.id)}
                            >
                              Restore
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
