import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/authToken";

type ScheduleKind = "regular" | "activity" | "early_release" | "custom";

interface Period {
  id?: number;
  periodNumber: number;
  name: string;
  startTime: string;
  endTime: string;
  // Counts toward the parent-portal on-time streak. Defaults TRUE
  // (matches DB). Toggle OFF for lunch / advisory / passing periods
  // so the streak only reflects academic periods.
  includedInOnTimeStreak?: boolean;
}

type BlockType = "period" | "lunch" | "passing" | "advisory" | "homeroom" | "custom";

interface VariantBlock {
  id?: number;
  blockType: BlockType;
  periodNumber: number | null;
  name: string;
  startTime: string;
  endTime: string;
  includedInOnTimeStreak: boolean;
}

interface Variant {
  id: number;
  name: string;
  isDefault: boolean;
  blocks: VariantBlock[];
  grades: string[];
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
  variants?: Variant[];
}

const BLOCK_TYPE_LABEL: Record<BlockType, string> = {
  period: "Class period",
  lunch: "Lunch",
  passing: "Passing",
  advisory: "Advisory",
  homeroom: "Homeroom",
  custom: "Other",
};

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
  return {
    periodNumber: num,
    name: `P${num}`,
    startTime: "08:00",
    endTime: "08:50",
    includedInOnTimeStreak: true,
  };
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
          onRefresh={async (next) => {
            setSchedules(next);
          }}
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
  onRefresh,
}: {
  initial: Schedule;
  isNew: boolean;
  onCancel: () => void;
  onSaved: () => void;
  onRefresh: (schedules: Schedule[]) => void | Promise<void>;
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
          // Default TRUE if the legacy row never had the field set.
          includedInOnTimeStreak: p.includedInOnTimeStreak !== false,
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

      <div
        style={{
          margin: "0.5rem 0 0.75rem",
          padding: "0.6rem 0.85rem",
          background: "#eff6ff",
          border: "1px solid #bfdbfe",
          color: "#1e40af",
          borderRadius: 6,
          fontSize: "0.9rem",
          lineHeight: 1.5,
        }}
      >
        <strong>How this works:</strong>{" "}
        {isNew ? (
          <>
            Step 1 — name this schedule and enter its periods below, then
            save. Step 2 — if different grade levels follow different
            timings (for example, staggered lunches for Grades 6, 7, and
            8), reopen the saved schedule and add each grade&apos;s
            timeline under <em>Grade schedules (variants)</em>, which
            appears after saving.
          </>
        ) : (
          <>
            The period list below is the school-wide default timing. If
            grade levels follow different timings (for example, staggered
            lunches for Grades 6, 7, and 8), scroll down to{" "}
            <em>Grade schedules (variants)</em> to add a timeline for each
            grade and assign grades to it. Grades without their own
            variant follow the default. Once grade variants exist, edit
            timing there rather than in this period list.
          </>
        )}
      </div>

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
            <th style={{ padding: "0.5rem", width: 160 }} title="When ON, this period counts toward the parent-portal on-time streak. Turn OFF for lunch / advisory / passing periods.">
              On-time streak
            </th>
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
              <td style={{ padding: "0.5rem", textAlign: "center" }}>
                <input
                  type="checkbox"
                  checked={p.includedInOnTimeStreak !== false}
                  onChange={(e) =>
                    updatePeriod(idx, { includedInOnTimeStreak: e.target.checked })
                  }
                  title="Count this period toward the parent-portal on-time streak"
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

      {!isNew && (
        <VariantsSection
          scheduleId={initial.id}
          variants={initial.variants ?? []}
          onSchedules={onRefresh}
        />
      )}

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

// ---------------------------------------------------------------------------
// Grade Variants — multiple simultaneous timing patterns under one Day Type
// (e.g. Grade 6 / Grade 7 / Grade 8 with staggered lunches).
// ---------------------------------------------------------------------------

function blankBlock(): VariantBlock {
  return {
    blockType: "period",
    periodNumber: 1,
    name: "P1",
    startTime: "08:00",
    endTime: "08:50",
    includedInOnTimeStreak: true,
  };
}

function VariantsSection({
  scheduleId,
  variants,
  onSchedules,
}: {
  scheduleId: number;
  variants: Variant[];
  onSchedules: (schedules: Schedule[]) => void | Promise<void>;
}) {
  const [editing, setEditing] = useState<Variant | "new" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const call = async (url: string, method: string, body?: unknown) => {
    setErr(null);
    setBusy(true);
    try {
      const r = await authFetch(url, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await r.text();
      if (!r.ok) {
        try {
          setErr((JSON.parse(text) as { error?: string }).error || text);
        } catch {
          setErr(text || `HTTP ${r.status}`);
        }
        return false;
      }
      const j = JSON.parse(text) as { schedules: Schedule[] };
      await onSchedules(j.schedules);
      return true;
    } catch (e) {
      setErr((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        marginTop: "1.25rem",
        padding: "0.9rem 1rem",
        border: "1px solid var(--border, #2a3447)",
        borderRadius: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <h4 style={{ margin: 0 }}>Grade schedules (variants)</h4>
        <div style={{ flex: 1 }} />
        {editing === null && (
          <button
            type="button"
            onClick={() => setEditing("new")}
            style={{
              background: "#0d9488",
              color: "white",
              border: "none",
              padding: "0.35rem 0.75rem",
              borderRadius: 6,
              cursor: "pointer",
              font: "inherit",
              fontWeight: 600,
            }}
          >
            + Add grade schedule
          </button>
        )}
      </div>
      <p style={{ color: "var(--text-subtle)", fontSize: 13, margin: "0.4rem 0 0.75rem" }}>
        Different grade levels can follow different timings on the same day —
        for example staggered lunches for Grades 6, 7, and 8. Students in a
        grade without its own schedule follow the default.
      </p>

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

      {editing === null ? (
        variants.length === 0 ? (
          <p style={{ color: "var(--text-subtle)" }}>
            No variants yet — everyone follows the period list above.
          </p>
        ) : (
          <table className="pulse-table" style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border, #2a3447)" }}>
                <th style={{ padding: "0.5rem" }}>Name</th>
                <th style={{ padding: "0.5rem" }}>Grades</th>
                <th style={{ padding: "0.5rem" }}>Blocks</th>
                <th style={{ padding: "0.5rem" }}>Default</th>
                <th style={{ padding: "0.5rem", width: 1 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {variants.map((v) => (
                <tr key={v.id} style={{ borderBottom: "1px solid var(--border, #2a3447)" }}>
                  <td style={{ padding: "0.5rem" }}>{v.name}</td>
                  <td style={{ padding: "0.5rem" }}>
                    {v.grades.length > 0 ? v.grades.join(", ") : "—"}
                  </td>
                  <td style={{ padding: "0.5rem" }}>
                    {v.blocks.length}
                    {v.blocks.some((b) => b.blockType === "lunch") ? " · incl. lunch" : ""}
                  </td>
                  <td style={{ padding: "0.5rem" }}>
                    {v.isDefault ? (
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
                        disabled={busy}
                        onClick={() =>
                          call(
                            `/api/bell-schedules/${scheduleId}/variants/${v.id}`,
                            "PUT",
                            { isDefault: true },
                          )
                        }
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
                      onClick={() => setEditing(v)}
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
                    {!v.isDefault && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          call(
                            `/api/bell-schedules/${scheduleId}/variants/${v.id}`,
                            "DELETE",
                          )
                        }
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
        )
      ) : (
        <VariantEditor
          initial={
            editing === "new"
              ? {
                  id: 0,
                  name: "",
                  isDefault: false,
                  blocks: [blankBlock()],
                  grades: [],
                }
              : editing
          }
          isNew={editing === "new"}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSave={async (payload) => {
            const ok = await call(
              editing === "new"
                ? `/api/bell-schedules/${scheduleId}/variants`
                : `/api/bell-schedules/${scheduleId}/variants/${(editing as Variant).id}`,
              editing === "new" ? "POST" : "PUT",
              payload,
            );
            if (ok) setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function VariantEditor({
  initial,
  isNew,
  busy,
  onCancel,
  onSave,
}: {
  initial: Variant;
  isNew: boolean;
  busy: boolean;
  onCancel: () => void;
  onSave: (payload: {
    name: string;
    blocks: VariantBlock[];
    grades: string[];
  }) => void | Promise<void>;
}) {
  const [name, setName] = useState(initial.name);
  const [gradesText, setGradesText] = useState(initial.grades.join(", "));
  const [blocks, setBlocks] = useState<VariantBlock[]>(
    initial.blocks.map((b) => ({ ...b })),
  );
  const [localErr, setLocalErr] = useState<string | null>(null);

  const update = (idx: number, patch: Partial<VariantBlock>) =>
    setBlocks((arr) => arr.map((b, i) => (i === idx ? { ...b, ...patch } : b)));

  return (
    <div style={{ marginTop: "0.5rem" }}>
      <h5 style={{ margin: "0 0 0.5rem" }}>
        {isNew ? "New grade schedule" : `Edit: ${initial.name}`}
      </h5>
      {localErr && (
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
          {localErr}
        </div>
      )}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: "0.75rem",
          marginBottom: "0.75rem",
        }}
      >
        <label style={{ display: "grid", gap: 4 }}>
          <span>Variant name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., Grade 6 Schedule"
          />
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <span>Grades (comma-separated)</span>
          <input
            type="text"
            value={gradesText}
            onChange={(e) => setGradesText(e.target.value)}
            placeholder="e.g., 6 or 6, 7"
          />
        </label>
      </div>

      <table className="pulse-table" style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border, #2a3447)" }}>
            <th style={{ padding: "0.5rem", width: 140 }}>Type</th>
            <th style={{ padding: "0.5rem", width: 70 }}>Period #</th>
            <th style={{ padding: "0.5rem" }}>Name</th>
            <th style={{ padding: "0.5rem", width: 130 }}>Start</th>
            <th style={{ padding: "0.5rem", width: 130 }}>End</th>
            <th style={{ padding: "0.5rem", width: 120 }} title="Counts toward the parent-portal on-time streak">
              Streak
            </th>
            <th style={{ padding: "0.5rem", width: 1 }}></th>
          </tr>
        </thead>
        <tbody>
          {blocks.map((b, idx) => (
            <tr key={idx} style={{ borderBottom: "1px solid var(--border, #2a3447)" }}>
              <td style={{ padding: "0.5rem" }}>
                <select
                  value={b.blockType}
                  onChange={(e) => {
                    const t = e.target.value as BlockType;
                    update(idx, {
                      blockType: t,
                      periodNumber: t === "period" ? b.periodNumber ?? 1 : null,
                      includedInOnTimeStreak: t === "period",
                      name:
                        b.name && b.name !== BLOCK_TYPE_LABEL[b.blockType]
                          ? b.name
                          : t === "period"
                            ? b.name
                            : BLOCK_TYPE_LABEL[t],
                    });
                  }}
                >
                  {(Object.keys(BLOCK_TYPE_LABEL) as BlockType[]).map((t) => (
                    <option key={t} value={t}>
                      {BLOCK_TYPE_LABEL[t]}
                    </option>
                  ))}
                </select>
              </td>
              <td style={{ padding: "0.5rem" }}>
                {b.blockType === "period" ? (
                  <input
                    type="number"
                    min={1}
                    value={b.periodNumber ?? 1}
                    onChange={(e) =>
                      update(idx, { periodNumber: Number(e.target.value) })
                    }
                    style={{ width: 60 }}
                  />
                ) : (
                  <span style={{ color: "var(--text-subtle)" }}>—</span>
                )}
              </td>
              <td style={{ padding: "0.5rem" }}>
                <input
                  type="text"
                  value={b.name}
                  onChange={(e) => update(idx, { name: e.target.value })}
                  style={{ width: "100%" }}
                />
              </td>
              <td style={{ padding: "0.5rem" }}>
                <input
                  type="time"
                  value={b.startTime}
                  onChange={(e) => update(idx, { startTime: e.target.value })}
                />
              </td>
              <td style={{ padding: "0.5rem" }}>
                <input
                  type="time"
                  value={b.endTime}
                  onChange={(e) => update(idx, { endTime: e.target.value })}
                />
              </td>
              <td style={{ padding: "0.5rem", textAlign: "center" }}>
                {b.blockType === "period" ? (
                  <input
                    type="checkbox"
                    checked={b.includedInOnTimeStreak}
                    onChange={(e) =>
                      update(idx, { includedInOnTimeStreak: e.target.checked })
                    }
                  />
                ) : (
                  <span style={{ color: "var(--text-subtle)" }}>—</span>
                )}
              </td>
              <td style={{ padding: "0.5rem" }}>
                <button
                  type="button"
                  onClick={() => setBlocks((arr) => arr.filter((_, i) => i !== idx))}
                  style={{
                    background: "#fee2e2",
                    color: "#b91c1c",
                    border: "1px solid #fecaca",
                    padding: "0.25rem 0.55rem",
                    borderRadius: 6,
                    cursor: "pointer",
                    font: "inherit",
                  }}
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
          onClick={() =>
            setBlocks((arr) => {
              const maxP = Math.max(
                0,
                ...arr
                  .filter((b) => b.blockType === "period" && b.periodNumber != null)
                  .map((b) => b.periodNumber as number),
              );
              const last = arr[arr.length - 1];
              return [
                ...arr,
                {
                  ...blankBlock(),
                  periodNumber: maxP + 1,
                  name: `P${maxP + 1}`,
                  startTime: last ? last.endTime : "08:00",
                  endTime: last ? last.endTime : "08:50",
                },
              ];
            })
          }
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
          + Add block
        </button>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={onCancel}
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
          Cancel
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setLocalErr(null);
            if (!name.trim()) {
              setLocalErr("Variant name is required");
              return;
            }
            if (blocks.length === 0) {
              setLocalErr("Add at least one block");
              return;
            }
            const grades = gradesText
              .split(",")
              .map((g) => g.trim())
              .filter(Boolean);
            onSave({ name: name.trim(), blocks, grades });
          }}
          style={{
            background: "#0d9488",
            color: "white",
            border: "none",
            padding: "0.5rem 1rem",
            borderRadius: 6,
            cursor: busy ? "wait" : "pointer",
            font: "inherit",
            fontWeight: 600,
          }}
        >
          {busy ? "Saving…" : isNew ? "Create variant" : "Save variant"}
        </button>
      </div>
    </div>
  );
}
