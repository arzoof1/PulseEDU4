import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/authToken";

type LocationRow = {
  id: number;
  name: string;
  kind: string;
  isOrigin: boolean;
  isDestination: boolean;
  studentVisible: boolean;
  active: boolean;
};

type PairRow = {
  id: number;
  originLocationId: number;
  destinationLocationId: number;
  originName: string;
  destinationName: string;
};

const KINDS: Array<{ value: string; label: string }> = [
  { value: "classroom", label: "Classroom" },
  { value: "common_area", label: "Common Area" },
  { value: "restroom", label: "Restroom" },
  { value: "office", label: "Office" },
];

interface Props {
  onChanged?: () => void;
}

export default function LocationsAdmin({ onChanged }: Props) {
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [pairs, setPairs] = useState<PairRow[]>([]);
  const [showInactive, setShowInactive] = useState(false);
  const [filter, setFilter] = useState("");
  const [savingId, setSavingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedOrigin, setExpandedOrigin] = useState<number | null>(null);

  // New-location form state
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState("classroom");
  const [newIsOrigin, setNewIsOrigin] = useState(true);
  const [newIsDestination, setNewIsDestination] = useState(false);
  const [newStudentVisible, setNewStudentVisible] = useState(false);
  const [creating, setCreating] = useState(false);

  async function reload() {
    try {
      const [locRes, pairRes] = await Promise.all([
        authFetch("/api/locations"),
        authFetch("/api/location-allowed-destinations"),
      ]);
      if (locRes.ok) setLocations(await locRes.json());
      if (pairRes.ok) setPairs(await pairRes.json());
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  const filteredLocations = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return locations
      .filter((l) => (showInactive ? true : l.active))
      .filter((l) => (q ? l.name.toLowerCase().includes(q) : true))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [locations, filter, showInactive]);

  const destinationOptions = useMemo(
    () =>
      locations
        .filter((l) => l.isDestination && l.active)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [locations],
  );

  const pairsByOrigin = useMemo(() => {
    const map = new Map<number, PairRow[]>();
    for (const p of pairs) {
      const list = map.get(p.originLocationId) ?? [];
      list.push(p);
      map.set(p.originLocationId, list);
    }
    return map;
  }, [pairs]);

  async function patchLocation(id: number, patch: Partial<LocationRow>) {
    setSavingId(id);
    setError(null);
    try {
      const res = await authFetch(`/api/locations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? "Save failed");
      }
      await reload();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingId(null);
    }
  }

  async function createLocation() {
    if (!newName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const res = await authFetch("/api/locations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName.trim(),
          kind: newKind,
          isOrigin: newIsOrigin,
          isDestination: newIsDestination,
          studentVisible: newStudentVisible,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? "Create failed");
      }
      setNewName("");
      setNewKind("classroom");
      setNewIsOrigin(true);
      setNewIsDestination(false);
      setNewStudentVisible(false);
      await reload();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  async function addPair(originId: number, destId: number) {
    setError(null);
    try {
      const res = await authFetch("/api/location-allowed-destinations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          originLocationId: originId,
          destinationLocationId: destId,
        }),
      });
      if (!res.ok && res.status !== 409) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? "Add failed");
      }
      await reload();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const [wiring, setWiring] = useState(false);
  async function wireClassroomMesh() {
    const ok = window.confirm(
      `Turn every classroom into both an Origin and a Destination, ` +
        `and create allowed-destination pairings between every pair of ` +
        `classrooms?\n\nThis is safe to run repeatedly — existing pairings ` +
        `are preserved. Useful after adding new classrooms.`,
    );
    if (!ok) return;
    setWiring(true);
    setError(null);
    try {
      const res = await authFetch("/api/locations/wire-classrooms-mesh", {
        method: "POST",
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? "Wire failed");
      window.alert(
        `Done. Considered ${j.classroomsConsidered} classrooms, ` +
          `updated ${j.flagsUpdated} flag rows, created ${j.pairsCreated} new pairings.`,
      );
      await reload();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWiring(false);
    }
  }

  async function deleteLocation(id: number, name: string) {
    const ok = window.confirm(
      `Delete the location "${name}"?\n\n` +
        `Past hall passes, tardies, and kiosk records will be unaffected ` +
        `(they store the location name as text). Any allowed-destination ` +
        `pairings for this location will also be removed.\n\n` +
        `If you just want to hide it instead, uncheck "Active".`,
    );
    if (!ok) return;
    setSavingId(id);
    setError(null);
    try {
      const res = await authFetch(`/api/locations/${id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? "Delete failed");
      }
      await reload();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingId(null);
    }
  }

  async function removePair(pairId: number) {
    setError(null);
    try {
      const res = await authFetch(
        `/api/location-allowed-destinations/${pairId}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? "Remove failed");
      }
      await reload();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="card" style={{ marginTop: "1rem" }}>
      <h2 style={{ marginTop: 0 }}>Locations</h2>
      <p style={{ color: "var(--text-subtle)", marginTop: 0 }}>
        Add, rename, or deactivate the rooms and destinations used by Hall
        Passes, Tardies, and the Kiosk. Deactivated rooms stay on existing
        records but won't appear in new pickers.
      </p>

      {error && (
        <div
          style={{
            background: "var(--danger-bg, #fee)",
            color: "var(--danger, #c00)",
            padding: "0.5rem 0.75rem",
            borderRadius: 6,
            marginBottom: "0.75rem",
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      {/* Add new */}
      <details style={{ marginBottom: "1rem" }}>
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>
          + Add a location
        </summary>
        <div
          style={{
            display: "grid",
            gap: "0.5rem",
            marginTop: "0.5rem",
            padding: "0.75rem",
            border: "1px solid var(--border)",
            borderRadius: 6,
            maxWidth: 520,
          }}
        >
          <label style={{ display: "grid", gap: "0.25rem" }}>
            <span>Name</span>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. Room 401, Auditorium"
            />
          </label>
          <label style={{ display: "grid", gap: "0.25rem" }}>
            <span>Kind</span>
            <select value={newKind} onChange={(e) => setNewKind(e.target.value)}>
              {KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
          <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
            <label style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
              <input
                type="checkbox"
                checked={newIsOrigin}
                onChange={(e) => setNewIsOrigin(e.target.checked)}
              />
              <span>Origin (passes start here)</span>
            </label>
            <label style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
              <input
                type="checkbox"
                checked={newIsDestination}
                onChange={(e) => setNewIsDestination(e.target.checked)}
              />
              <span>Destination (passes go here)</span>
            </label>
            <label style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
              <input
                type="checkbox"
                checked={newStudentVisible}
                onChange={(e) => setNewStudentVisible(e.target.checked)}
              />
              <span>Student-visible at Kiosk</span>
            </label>
          </div>
          <div>
            <button
              type="button"
              onClick={createLocation}
              disabled={creating || !newName.trim()}
            >
              {creating ? "Adding…" : "Add location"}
            </button>
          </div>
        </div>
      </details>

      {/* Filter / toggle */}
      <div
        style={{
          display: "flex",
          gap: "0.75rem",
          alignItems: "center",
          marginBottom: "0.5rem",
          flexWrap: "wrap",
        }}
      >
        <input
          type="text"
          placeholder="Filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ maxWidth: 240 }}
        />
        <label
          style={{ display: "flex", gap: "0.4rem", alignItems: "center", fontSize: 13 }}
        >
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />
          <span>Show inactive</span>
        </label>
        <button
          type="button"
          onClick={wireClassroomMesh}
          disabled={wiring}
          title="Make every classroom both an Origin and a Destination, and create allowed pairings between every pair of classrooms."
          style={{ marginLeft: "auto" }}
        >
          {wiring ? "Wiring…" : "Wire all classrooms ↔ classrooms"}
        </button>
      </div>

      {/* Table */}
      <div style={{ overflowX: "auto" }}>
        <table className="pulse-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border)" }}>
              <th style={{ padding: "0.4rem 0.5rem" }}>Name</th>
              <th style={{ padding: "0.4rem 0.5rem" }}>Kind</th>
              <th style={{ padding: "0.4rem 0.5rem" }}>Origin</th>
              <th style={{ padding: "0.4rem 0.5rem" }}>Destination</th>
              <th style={{ padding: "0.4rem 0.5rem" }}>Kiosk-visible</th>
              <th style={{ padding: "0.4rem 0.5rem" }}>Active</th>
              <th style={{ padding: "0.4rem 0.5rem" }}></th>
            </tr>
          </thead>
          <tbody>
            {filteredLocations.map((loc) => {
              const isExpanded = expandedOrigin === loc.id;
              const myPairs = pairsByOrigin.get(loc.id) ?? [];
              const usedDestIds = new Set(myPairs.map((p) => p.destinationLocationId));
              return (
                <FragmentRow
                  key={loc.id}
                  loc={loc}
                  myPairs={myPairs}
                  destinationOptions={destinationOptions.filter(
                    (d) => d.id !== loc.id && !usedDestIds.has(d.id),
                  )}
                  isExpanded={isExpanded}
                  onToggleExpand={() =>
                    setExpandedOrigin(isExpanded ? null : loc.id)
                  }
                  saving={savingId === loc.id}
                  onPatch={(patch) => patchLocation(loc.id, patch)}
                  onAddPair={(destId) => addPair(loc.id, destId)}
                  onRemovePair={(pairId) => removePair(pairId)}
                  onDelete={() => deleteLocation(loc.id, loc.name)}
                />
              );
            })}
            {filteredLocations.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  style={{ padding: "0.75rem", color: "var(--text-subtle)" }}
                >
                  No locations match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface RowProps {
  loc: LocationRow;
  myPairs: PairRow[];
  destinationOptions: LocationRow[];
  isExpanded: boolean;
  onToggleExpand: () => void;
  saving: boolean;
  onPatch: (patch: Partial<LocationRow>) => void;
  onAddPair: (destId: number) => void;
  onRemovePair: (pairId: number) => void;
  onDelete: () => void;
}

function FragmentRow({
  loc,
  myPairs,
  destinationOptions,
  isExpanded,
  onToggleExpand,
  saving,
  onPatch,
  onAddPair,
  onRemovePair,
  onDelete,
}: RowProps) {
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(loc.name);
  const [pickDest, setPickDest] = useState("");

  return (
    <>
      <tr style={{ borderBottom: "1px solid var(--border)", opacity: loc.active ? 1 : 0.55 }}>
        <td style={{ padding: "0.4rem 0.5rem" }}>
          {editingName ? (
            <span style={{ display: "inline-flex", gap: "0.25rem" }}>
              <input
                type="text"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                style={{ width: 180 }}
              />
              <button
                type="button"
                onClick={() => {
                  if (draftName.trim() && draftName.trim() !== loc.name) {
                    onPatch({ name: draftName.trim() });
                  }
                  setEditingName(false);
                }}
                disabled={saving}
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => {
                  setDraftName(loc.name);
                  setEditingName(false);
                }}
              >
                Cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => {
                setDraftName(loc.name);
                setEditingName(true);
              }}
              style={{
                background: "none",
                border: "none",
                padding: 0,
                color: "inherit",
                cursor: "pointer",
                textDecoration: "underline dotted",
                font: "inherit",
              }}
              title="Rename"
            >
              {loc.name}
            </button>
          )}
        </td>
        <td style={{ padding: "0.4rem 0.5rem" }}>
          <select
            value={loc.kind}
            disabled={saving}
            onChange={(e) => onPatch({ kind: e.target.value })}
          >
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </td>
        <td style={{ padding: "0.4rem 0.5rem", textAlign: "center" }}>
          <input
            type="checkbox"
            checked={loc.isOrigin}
            disabled={saving}
            onChange={(e) => onPatch({ isOrigin: e.target.checked })}
          />
        </td>
        <td style={{ padding: "0.4rem 0.5rem", textAlign: "center" }}>
          <input
            type="checkbox"
            checked={loc.isDestination}
            disabled={saving}
            onChange={(e) => onPatch({ isDestination: e.target.checked })}
          />
        </td>
        <td style={{ padding: "0.4rem 0.5rem", textAlign: "center" }}>
          <input
            type="checkbox"
            checked={loc.studentVisible}
            disabled={saving}
            onChange={(e) => onPatch({ studentVisible: e.target.checked })}
          />
        </td>
        <td style={{ padding: "0.4rem 0.5rem", textAlign: "center" }}>
          <input
            type="checkbox"
            checked={loc.active}
            disabled={saving}
            onChange={(e) => onPatch({ active: e.target.checked })}
          />
        </td>
        <td style={{ padding: "0.4rem 0.5rem", textAlign: "right" }}>
          <span style={{ display: "inline-flex", gap: "0.35rem", justifyContent: "flex-end", flexWrap: "wrap" }}>
            {!editingName && (
              <button
                type="button"
                onClick={() => {
                  setDraftName(loc.name);
                  setEditingName(true);
                }}
                disabled={saving}
                title="Rename this location"
              >
                Edit
              </button>
            )}
            {loc.isOrigin && (
              <button type="button" onClick={onToggleExpand}>
                {isExpanded ? "Hide" : `Allowed (${myPairs.length})`}
              </button>
            )}
            <button
              type="button"
              onClick={onDelete}
              disabled={saving}
              style={{ color: "var(--danger, #c00)" }}
              title="Delete this location"
            >
              Delete
            </button>
          </span>
        </td>
      </tr>
      {isExpanded && loc.isOrigin && (
        <tr>
          <td
            colSpan={7}
            style={{
              padding: "0.5rem 0.75rem 0.75rem 1.5rem",
              background: "var(--surface-muted, #fafafa)",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <div style={{ fontSize: 13, marginBottom: "0.4rem" }}>
              Allowed destinations from <strong>{loc.name}</strong>:
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginBottom: "0.5rem" }}>
              {myPairs.length === 0 && (
                <span style={{ color: "var(--text-subtle)", fontSize: 13 }}>
                  None yet.
                </span>
              )}
              {myPairs
                .slice()
                .sort((a, b) => a.destinationName.localeCompare(b.destinationName))
                .map((p) => (
                  <span
                    key={p.id}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "0.3rem",
                      border: "1px solid var(--border)",
                      borderRadius: 999,
                      padding: "0.15rem 0.5rem",
                      fontSize: 13,
                      background: "var(--surface, #fff)",
                    }}
                  >
                    {p.destinationName}
                    <button
                      type="button"
                      onClick={() => onRemovePair(p.id)}
                      title="Remove"
                      style={{
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        padding: 0,
                        color: "var(--text-subtle)",
                        fontSize: 14,
                      }}
                    >
                      ×
                    </button>
                  </span>
                ))}
            </div>
            <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
              <select
                value={pickDest}
                onChange={(e) => setPickDest(e.target.value)}
              >
                <option value="">Add destination…</option>
                {destinationOptions.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={!pickDest}
                onClick={() => {
                  const id = Number(pickDest);
                  if (Number.isInteger(id) && id > 0) {
                    onAddPair(id);
                    setPickDest("");
                  }
                }}
              >
                Add
              </button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
