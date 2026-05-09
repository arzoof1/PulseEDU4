import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/authToken";

type ScheduleKind = "regular" | "activity" | "early_release" | "custom";

interface Period {
  id?: number;
  periodNumber: number;
  name: string;
  startTime: string;
  endTime: string;
}

interface Schedule {
  id: number;
  name: string;
  kind: ScheduleKind;
  isDefault: boolean;
  active: boolean;
  sortOrder: number;
  createdAt: string;
  periods: Period[];
}

const KIND_TILES: { kind: ScheduleKind; icon: string; title: string; subtitle: string }[] = [
  {
    kind: "regular",
    icon: "🔔",
    title: "Regular",
    subtitle: "Standard daily bell schedule.",
  },
  {
    kind: "activity",
    icon: "🎉",
    title: "Activity",
    subtitle: "Assemblies, pep rallies, or activity-day schedules.",
  },
  {
    kind: "early_release",
    icon: "🏁",
    title: "Early Release",
    subtitle: "Half-day or early dismissal schedules.",
  },
];

const KIND_LABEL: Record<ScheduleKind, string> = {
  regular: "Regular",
  activity: "Activity",
  early_release: "Early Release",
  custom: "Custom",
};

function blankPeriod(num: number): Period {
  return { periodNumber: num, name: `P${num}`, startTime: "08:00", endTime: "08:50" };
}

export default function BellScheduleSection() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // View modes: hub (3 kind tiles) -> kind list (schedules of that kind) -> editor
  const [activeKind, setActiveKind] = useState<ScheduleKind | null>(null);
  const [editingId, setEditingId] = useState<number | "new" | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await authFetch("/api/bell-schedules");
      if (!r.ok) throw new Error((await r.text()) || `HTTP ${r.status}`);
      const j = (await r.json()) as { schedules: Schedule[] };
      setSchedules(j.schedules);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const schedulesByKind = useMemo(() => {
    const m: Record<ScheduleKind, Schedule[]> = {
      regular: [],
      activity: [],
      early_release: [],
      custom: [],
    };
    for (const s of schedules) m[s.kind].push(s);
    return m;
  }, [schedules]);

  const editingSchedule: Schedule | null =
    editingId === null || editingId === "new"
      ? null
      : schedules.find((s) => s.id === editingId) ?? null;

  return (
    <section className="card">
      <div className="section-header-bar-teal" />
      <div className="section-header-band-hub">
        <h2 style={{ margin: 0, color: "white", fontSize: "1.5rem", fontWeight: 700 }}>
          School Bell Schedule
        </h2>
      </div>

      {error && (
        <div
          style={{
            margin: "0.75rem 0",
            padding: "0.5rem 0.75rem",
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#b91c1c",
            borderRadius: 6,
          }}
        >
          {error}
        </div>
      )}

      {loading && <p style={{ color: "var(--text-subtle)" }}>Loading…</p>}

      {!loading && activeKind === null && editingId === null && (
        <BellScheduleHub
          tiles={KIND_TILES.map((t) => ({
            ...t,
            count: schedulesByKind[t.kind].length,
            defaultName:
              schedulesByKind[t.kind].find((s) => s.isDefault)?.name ?? null,
          }))}
          onSelect={setActiveKind}
        />
      )}

      {!loading && activeKind !== null && editingId === null && (
        <KindScheduleList
          kind={activeKind}
          schedules={schedulesByKind[activeKind]}
          onBack={() => setActiveKind(null)}
          onEdit={(id) => setEditingId(id)}
          onNew={() => setEditingId("new")}
          confirmDeleteId={confirmDeleteId}
          onRequestDelete={(id) => setConfirmDeleteId(id)}
          onCancelDelete={() => setConfirmDeleteId(null)}
          onConfirmDelete={async (id) => {
            const r = await authFetch(`/api/bell-schedules/${id}`, { method: "DELETE" });
            setConfirmDeleteId(null);
            if (!r.ok) {
              const t = await r.text();
              setError(t || "Delete failed");
              return;
            }
            await refresh();
          }}
          onSetDefault={async (id) => {
            const r = await authFetch(`/api/bell-schedules/${id}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ isDefault: true }),
            });
            if (!r.ok) {
              const t = await r.text();
              alert(t || "Update failed");
              return;
            }
            await refresh();
          }}
        />
      )}

      {!loading && editingId !== null && (
        <ScheduleEditor
          initial={
            editingSchedule ?? {
              id: 0,
              name: "",
              kind: activeKind ?? "regular",
              isDefault: false,
              active: true,
              sortOrder: 0,
              createdAt: "",
              periods: [1, 2, 3, 4, 5, 6, 7].map(blankPeriod),
            }
          }
          isNew={editingId === "new"}
          onCancel={() => setEditingId(null)}
          onSaved={async () => {
            setEditingId(null);
            await refresh();
          }}
        />
      )}
    </section>
  );
}

function BellScheduleHub({
  tiles,
  onSelect,
}: {
  tiles: {
    kind: ScheduleKind;
    icon: string;
    title: string;
    subtitle: string;
    count: number;
    defaultName: string | null;
  }[];
  onSelect: (k: ScheduleKind) => void;
}) {
  return (
    <>
      <p style={{ color: "var(--text-subtle)", marginTop: "0.75rem" }}>
        Choose a schedule type to view, edit, or add bell schedules.
      </p>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
          gap: "0.75rem",
        }}
      >
        {tiles.map((t) => (
          <button
            key={t.kind}
            type="button"
            onClick={() => onSelect(t.kind)}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "0.35rem",
              padding: "1rem 1.1rem",
              border: "1px solid var(--border, #2a3447)",
              borderRadius: 10,
              background: "var(--card-bg, rgba(255,255,255,0.03))",
              cursor: "pointer",
              textAlign: "left",
              color: "inherit",
              font: "inherit",
              transition: "border-color 120ms",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.borderColor =
                "var(--accent, #3b82f6)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.borderColor =
                "var(--border, #2a3447)";
            }}
          >
            <div style={{ fontSize: "1.5rem", lineHeight: 1 }}>{t.icon}</div>
            <div style={{ fontWeight: 600 }}>{t.title}</div>
            <div style={{ fontSize: 12, color: "var(--text-subtle)" }}>
              {t.subtitle}
            </div>
            <div style={{ fontSize: 12, marginTop: 4 }}>
              {t.count === 0
                ? "No schedules yet"
                : `${t.count} schedule${t.count === 1 ? "" : "s"}`}
              {t.defaultName ? ` · default: ${t.defaultName}` : ""}
            </div>
          </button>
        ))}
      </div>
    </>
  );
}

function KindScheduleList({
  kind,
  schedules,
  onBack,
  onEdit,
  onNew,
  confirmDeleteId,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
  onSetDefault,
}: {
  kind: ScheduleKind;
  schedules: Schedule[];
  onBack: () => void;
  onEdit: (id: number) => void;
  onNew: () => void;
  confirmDeleteId: number | null;
  onRequestDelete: (id: number) => void;
  onCancelDelete: () => void;
  onConfirmDelete: (id: number) => Promise<void> | void;
  onSetDefault: (id: number) => void;
}) {
  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          margin: "0.75rem 0",
        }}
      >
        <button
          type="button"
          onClick={onBack}
          style={{
            background: "#ede9fe",
            color: "#6d28d9",
            border: "1px solid #ddd6fe",
            padding: "0.4rem 0.75rem",
            borderRadius: 6,
            cursor: "pointer",
            font: "inherit",
          }}
        >
          ← Back
        </button>
        <button
          type="button"
          onClick={onNew}
          style={{
            background: "#0d9488",
            color: "white",
            border: "none",
            padding: "0.5rem 0.9rem",
            borderRadius: 6,
            cursor: "pointer",
            font: "inherit",
            fontWeight: 600,
          }}
        >
          + New {KIND_LABEL[kind]} Schedule
        </button>
      </div>
      <h3 style={{ marginTop: 0 }}>{KIND_LABEL[kind]} Schedules</h3>
      {schedules.length === 0 ? (
        <p style={{ color: "var(--text-subtle)" }}>
          No {KIND_LABEL[kind].toLowerCase()} schedules yet. Click “New” above to create one.
        </p>
      ) : (
        <table className="pulse-table" style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border, #2a3447)" }}>
              <th style={{ padding: "0.5rem" }}>Name</th>
              <th style={{ padding: "0.5rem" }}>Periods</th>
              <th style={{ padding: "0.5rem" }}>Default</th>
              <th style={{ padding: "0.5rem", width: 1 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {schedules.map((s) => (
              <tr key={s.id} style={{ borderBottom: "1px solid var(--border, #2a3447)" }}>
                <td style={{ padding: "0.5rem" }}>{s.name}</td>
                <td style={{ padding: "0.5rem" }}>{s.periods.length}</td>
                <td style={{ padding: "0.5rem" }}>
                  {s.isDefault ? (
                    <span
                      style={{
                        background: "#0d9488",
                        color: "white",
                        borderRadius: 999,
                        padding: "0.1rem 0.55rem",
                        fontSize: "0.75rem",
                        fontWeight: 700,
                      }}
                    >
                      Default
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onSetDefault(s.id)}
                      style={{
                        background: "transparent",
                        border: "1px solid var(--border, #2a3447)",
                        padding: "0.2rem 0.55rem",
                        borderRadius: 6,
                        cursor: "pointer",
                        font: "inherit",
                        fontSize: "0.85rem",
                      }}
                    >
                      Set default
                    </button>
                  )}
                </td>
                <td style={{ padding: "0.5rem", whiteSpace: "nowrap" }}>
                  <button
                    type="button"
                    onClick={() => onEdit(s.id)}
                    style={{
                      background: "#ede9fe",
                      color: "#6d28d9",
                      border: "1px solid #ddd6fe",
                      padding: "0.3rem 0.65rem",
                      borderRadius: 6,
                      cursor: "pointer",
                      font: "inherit",
                      marginRight: 6,
                    }}
                  >
                    Edit
                  </button>
                  {confirmDeleteId === s.id ? (
                    <>
                      <span
                        style={{
                          marginRight: 6,
                          fontSize: "0.85rem",
                          color: "#b91c1c",
                          fontWeight: 600,
                        }}
                      >
                        Delete?
                      </span>
                      <button
                        type="button"
                        onClick={() => onConfirmDelete(s.id)}
                        style={{
                          background: "#dc2626",
                          color: "white",
                          border: "none",
                          padding: "0.3rem 0.65rem",
                          borderRadius: 6,
                          cursor: "pointer",
                          font: "inherit",
                          marginRight: 6,
                          fontWeight: 600,
                        }}
                      >
                        Yes, delete
                      </button>
                      <button
                        type="button"
                        onClick={onCancelDelete}
                        style={{
                          background: "transparent",
                          border: "1px solid var(--border, #2a3447)",
                          color: "inherit",
                          padding: "0.3rem 0.65rem",
                          borderRadius: 6,
                          cursor: "pointer",
                          font: "inherit",
                        }}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onRequestDelete(s.id)}
                      title="Delete"
                      style={{
                        background: "#fee2e2",
                        color: "#b91c1c",
                        border: "1px solid #fecaca",
                        padding: "0.3rem 0.65rem",
                        borderRadius: 6,
                        cursor: "pointer",
                        font: "inherit",
                      }}
                    >
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function ScheduleEditor({
  initial,
  isNew,
  onCancel,
  onSaved,
}: {
  initial: Schedule;
  isNew: boolean;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [kind, setKind] = useState<ScheduleKind>(initial.kind);
  const [isDefault, setIsDefault] = useState(initial.isDefault);
  const [periods, setPeriods] = useState<Period[]>(
    initial.periods.length > 0
      ? initial.periods.map((p) => ({ ...p }))
      : [1, 2, 3, 4, 5, 6, 7].map(blankPeriod),
  );
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const updatePeriod = (idx: number, patch: Partial<Period>) => {
    setPeriods((arr) => arr.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  };

  const addPeriod = () => {
    setPeriods((arr) => [
      ...arr,
      blankPeriod(arr.length > 0 ? Math.max(...arr.map((p) => p.periodNumber)) + 1 : 1),
    ]);
  };

  const removePeriod = (idx: number) => {
    setPeriods((arr) => arr.filter((_, i) => i !== idx));
  };

  const setPeriodCount = (n: number) => {
    if (!Number.isInteger(n) || n < 1 || n > 30) return;
    setPeriods((arr) => {
      if (n === arr.length) return arr;
      if (n > arr.length) {
        const extra: Period[] = [];
        for (let i = arr.length; i < n; i++) extra.push(blankPeriod(i + 1));
        return [...arr, ...extra];
      }
      return arr.slice(0, n);
    });
  };

  const save = async () => {
    setErr(null);
    if (!name.trim()) {
      setErr("Name is required");
      return;
    }
    if (periods.length === 0) {
      setErr("Add at least one period");
      return;
    }
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        kind,
        isDefault,
        periods: periods.map((p, i) => ({
          periodNumber: i + 1,
          name: p.name.trim() || `P${i + 1}`,
          startTime: p.startTime,
          endTime: p.endTime,
        })),
      };
      const url = isNew ? "/api/bell-schedules" : `/api/bell-schedules/${initial.id}`;
      const r = await authFetch(url, {
        method: isNew ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(t || `HTTP ${r.status}`);
      }
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div style={{ margin: "0.75rem 0" }}>
        <button
          type="button"
          onClick={onCancel}
          style={{
            background: "#ede9fe",
            color: "#6d28d9",
            border: "1px solid #ddd6fe",
            padding: "0.4rem 0.75rem",
            borderRadius: 6,
            cursor: "pointer",
            font: "inherit",
          }}
        >
          ← Cancel
        </button>
      </div>
      <h3 style={{ marginTop: 0 }}>
        {isNew ? "New" : "Edit"} Bell Schedule
      </h3>

      {err && (
        <div
          style={{
            margin: "0.5rem 0",
            padding: "0.5rem 0.75rem",
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#b91c1c",
            borderRadius: 6,
          }}
        >
          {err}
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: "0.75rem",
          marginBottom: "1rem",
        }}
      >
        <label style={{ display: "grid", gap: 4 }}>
          <span>Schedule name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., Regular Day"
          />
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <span>Kind</span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as ScheduleKind)}
          >
            <option value="regular">Regular</option>
            <option value="activity">Activity</option>
            <option value="early_release">Early Release</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <span>Number of periods</span>
          <input
            type="number"
            min={1}
            max={30}
            value={periods.length}
            onChange={(e) => setPeriodCount(Number(e.target.value))}
          />
        </label>
        <label style={{ display: "flex", alignItems: "end", gap: 6 }}>
          <input
            type="checkbox"
            checked={isDefault}
            onChange={(e) => setIsDefault(e.target.checked)}
          />
          <span>Default for this school</span>
        </label>
      </div>

      <table className="pulse-table" style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border, #2a3447)" }}>
            <th style={{ padding: "0.5rem", width: 80 }}>#</th>
            <th style={{ padding: "0.5rem" }}>Period name</th>
            <th style={{ padding: "0.5rem", width: 140 }}>Start (HH:MM)</th>
            <th style={{ padding: "0.5rem", width: 140 }}>End (HH:MM)</th>
            <th style={{ padding: "0.5rem", width: 1 }}></th>
          </tr>
        </thead>
        <tbody>
          {periods.map((p, idx) => (
            <tr key={idx} style={{ borderBottom: "1px solid var(--border, #2a3447)" }}>
              <td style={{ padding: "0.5rem" }}>{idx + 1}</td>
              <td style={{ padding: "0.5rem" }}>
                <input
                  type="text"
                  value={p.name}
                  onChange={(e) => updatePeriod(idx, { name: e.target.value })}
                  style={{ width: "100%" }}
                />
              </td>
              <td style={{ padding: "0.5rem" }}>
                <input
                  type="time"
                  value={p.startTime}
                  onChange={(e) => updatePeriod(idx, { startTime: e.target.value })}
                />
              </td>
              <td style={{ padding: "0.5rem" }}>
                <input
                  type="time"
                  value={p.endTime}
                  onChange={(e) => updatePeriod(idx, { endTime: e.target.value })}
                />
              </td>
              <td style={{ padding: "0.5rem" }}>
                <button
                  type="button"
                  onClick={() => removePeriod(idx)}
                  style={{
                    background: "#fee2e2",
                    color: "#b91c1c",
                    border: "1px solid #fecaca",
                    padding: "0.25rem 0.55rem",
                    borderRadius: 6,
                    cursor: "pointer",
                    font: "inherit",
                  }}
                  title="Remove period"
                >
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ display: "flex", gap: 8, marginTop: "0.75rem" }}>
        <button
          type="button"
          onClick={addPeriod}
          style={{
            background: "transparent",
            border: "1px solid var(--border, #2a3447)",
            color: "inherit",
            padding: "0.4rem 0.75rem",
            borderRadius: 6,
            cursor: "pointer",
            font: "inherit",
          }}
        >
          + Add period
        </button>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={save}
          disabled={saving}
          style={{
            background: "#0d9488",
            color: "white",
            border: "none",
            padding: "0.5rem 1rem",
            borderRadius: 6,
            cursor: saving ? "wait" : "pointer",
            font: "inherit",
            fontWeight: 600,
          }}
        >
          {saving ? "Saving…" : "Save schedule"}
        </button>
      </div>
    </>
  );
}
