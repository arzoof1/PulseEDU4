import { useEffect, useMemo, useState } from "react";

type StaffUser = { id: number; displayName: string };

type StaffDefaultRow = {
  id: number;
  staffId: number | null;
  staffName: string;
  defaultLocationName: string | null;
};

interface Props {
  staffUsers: StaffUser[];
  originLocations: string[];
  onSaved?: () => void;
}

export default function StaffDefaultsAdmin({
  staffUsers,
  originLocations,
  onSaved,
}: Props) {
  const [rows, setRows] = useState<StaffDefaultRow[]>([]);
  const [savingFor, setSavingFor] = useState<number | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    fetch("/api/staff-defaults")
      .then((r) => r.json())
      .then((data: StaffDefaultRow[]) => setRows(data))
      .catch(() => {});
  }, []);

  const roomByStaffId = useMemo(() => {
    const map = new Map<number, string>();
    for (const r of rows) {
      if (r.staffId != null && r.defaultLocationName) {
        map.set(r.staffId, r.defaultLocationName);
      } else if (!r.staffId) {
        // Legacy row keyed by name only — match best-effort.
        const match = staffUsers.find((s) => s.displayName === r.staffName);
        if (match && r.defaultLocationName) {
          map.set(match.id, r.defaultLocationName);
        }
      }
    }
    return map;
  }, [rows, staffUsers]);

  async function save(staffId: number, room: string) {
    setSavingFor(staffId);
    try {
      const res = await fetch("/api/staff-defaults", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ staffId, defaultLocationName: room }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? "Save failed");
      }
      const refreshed = await fetch("/api/staff-defaults").then((r) =>
        r.json(),
      );
      setRows(refreshed);
      onSaved?.();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingFor(null);
    }
  }

  const filtered = staffUsers.filter((s) =>
    s.displayName.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div className="card" style={{ marginTop: "1rem" }}>
      <h2>Default Rooms (per staff)</h2>
      <p style={{ color: "var(--text-subtle)", marginTop: 0 }}>
        Each teacher's home room. Used to auto-fill the “From” field on Hall
        Passes and as the fallback when activating the kiosk. When SIS sync is
        enabled this list is refreshed from the SIS automatically.
      </p>
      <input
        type="text"
        placeholder="Filter staff…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        style={{ marginBottom: "0.5rem", maxWidth: 320 }}
      />
      <div style={{ display: "grid", gap: "0.4rem" }}>
        {filtered.map((s) => {
          const current = roomByStaffId.get(s.id) ?? "";
          return (
            <div
              key={s.id}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 240px 80px",
                gap: "0.5rem",
                alignItems: "center",
              }}
            >
              <span>{s.displayName}</span>
              <select
                value={current}
                disabled={savingFor === s.id}
                onChange={(e) => save(s.id, e.target.value)}
              >
                <option value="">(none — roaming)</option>
                {originLocations.map((loc) => (
                  <option key={loc} value={loc}>
                    {loc}
                  </option>
                ))}
              </select>
              <span style={{ fontSize: 12, color: "var(--text-subtle)" }}>
                {savingFor === s.id ? "Saving…" : ""}
              </span>
            </div>
          );
        })}
        {filtered.length === 0 && (
          <p style={{ color: "var(--text-subtle)" }}>No staff match.</p>
        )}
      </div>
    </div>
  );
}
