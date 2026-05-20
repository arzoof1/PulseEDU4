import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/authToken";
import { HowToUseHelp, HowToSection, RoleSection } from "./HowToUseHelp";

// SuperUser-only cross-school feature management. Renders a grid of
// every school × every super_feature_* flag and a separate panel to
// edit / create tier presets that bulk-apply a set of features to a
// school in one click. The page consults its own /superuser/school-plans
// + /superuser/tier-presets endpoints rather than the per-school
// /school-settings endpoint so a SuperUser can change any school
// without first switching their session into it.

type SchoolRow = {
  schoolId: number;
  schoolName: string;
  tierPresetId: number | null;
  superFlags: Record<string, boolean>;
  adminFlags: Record<string, boolean>;
};

type Preset = {
  id: number;
  name: string;
  description: string;
  isBuiltIn: boolean;
  featureKeys: string[];
};

// Pretty labels and groupings for the feature columns. Keep these
// in sync with the FEATURE_KEYS list in
// artifacts/api-server/src/routes/schoolSettings.ts.
const FEATURE_LABELS: Record<string, string> = {
  HallPasses: "Hall Passes",
  TardyPass: "Tardy Pass",
  FamilyComm: "Family Comm",
  Pbis: "PBIS Points",
  SchoolStore: "PBIS Store",
  Accommodations: "Accommodations",
  LogIntervention: "Log Intervention",
  RequestPullout: "Request Pullout",
  MtssPlans: "MTSS Plans",
  BehaviorSpecialist: "Behavior Specialist",
  IssDashboard: "ISS Dashboard",
  Displays: "Displays / Signage",
  BellSchedule: "Bell Schedule",
  EarlyWarning: "Early Warning",
  Academics: "Academics",
  DataImports: "Data Imports",
  Houses: "PBIS Houses",
  ParentPortal: "Parent Portal",
};

async function jget<T>(url: string): Promise<T> {
  const r = await authFetch(url);
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

async function jsend<T>(
  url: string,
  method: "PATCH" | "POST" | "DELETE",
  body?: unknown,
): Promise<T> {
  const r = await authFetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

const cellBtn: React.CSSProperties = {
  width: 22,
  height: 22,
  border: "1px solid #cbd5e1",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 14,
  lineHeight: "20px",
  padding: 0,
};

export default function SchoolPlansAdminPage() {
  const [tab, setTab] = useState<"grid" | "presets">("grid");
  const [schools, setSchools] = useState<SchoolRow[]>([]);
  const [featureKeys, setFeatureKeys] = useState<string[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  // Per-row inline status banner ("saved" / "applied Pro" / etc).
  const [rowStatus, setRowStatus] = useState<Record<number, string>>({});

  const reload = async () => {
    setLoading(true);
    setErr(null);
    try {
      const [grid, ps] = await Promise.all([
        jget<{ schools: SchoolRow[]; featureKeys: string[] }>(
          "/api/superuser/school-plans",
        ),
        jget<{ presets: Preset[]; featureKeys: string[] }>(
          "/api/superuser/tier-presets",
        ),
      ]);
      setSchools(grid.schools);
      setFeatureKeys(grid.featureKeys);
      setPresets(ps.presets);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setLoading(false);
  };

  useEffect(() => {
    reload();
  }, []);

  const filteredSchools = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return schools;
    return schools.filter((s) => s.schoolName.toLowerCase().includes(q));
  }, [schools, filter]);

  const flashRow = (schoolId: number, msg: string) => {
    setRowStatus((m) => ({ ...m, [schoolId]: msg }));
    setTimeout(
      () =>
        setRowStatus((m) => {
          const next = { ...m };
          delete next[schoolId];
          return next;
        }),
      1800,
    );
  };

  const toggleFlag = async (
    schoolId: number,
    key: string,
    nextValue: boolean,
  ) => {
    try {
      const data = await jsend<{
        schoolId: number;
        superFlags: Record<string, boolean>;
        tierPresetId: number | null;
      }>(`/api/superuser/school-plans/${schoolId}`, "PATCH", {
        superFlags: { [key]: nextValue },
      });
      setSchools((rows) =>
        rows.map((r) =>
          r.schoolId === schoolId
            ? {
                ...r,
                superFlags: { ...r.superFlags, ...data.superFlags },
                tierPresetId: data.tierPresetId,
              }
            : r,
        ),
      );
      flashRow(schoolId, "Saved");
    } catch (e) {
      flashRow(schoolId, e instanceof Error ? e.message : String(e));
    }
  };

  const applyPreset = async (schoolId: number, presetId: number) => {
    try {
      const data = await jsend<{
        schoolId: number;
        superFlags: Record<string, boolean>;
        tierPresetId: number | null;
      }>(`/api/superuser/school-plans/${schoolId}/apply-preset`, "POST", {
        presetId,
      });
      setSchools((rows) =>
        rows.map((r) =>
          r.schoolId === schoolId
            ? {
                ...r,
                superFlags: data.superFlags,
                tierPresetId: data.tierPresetId,
              }
            : r,
        ),
      );
      const preset = presets.find((p) => p.id === presetId);
      flashRow(schoolId, `Applied ${preset?.name ?? "preset"}`);
    } catch (e) {
      flashRow(schoolId, e instanceof Error ? e.message : String(e));
    }
  };

  if (loading) return <div style={{ padding: 16 }}>Loading…</div>;
  if (err)
    return (
      <div style={{ padding: 16, color: "#dc2626" }}>
        Failed to load: {err}
      </div>
    );

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: "1.4rem" }}>School Plans</h1>
        <div style={{ color: "#64748b", fontSize: "0.9rem", marginTop: 4 }}>
          Cross-school feature control for the SuperUser. Flip any
          feature on or off for any school, or apply a tier preset
          (Basic / Pro / Enterprise) to bulk-set a school's available
          features. Admins still control whether enabled features are
          actually live in their school's settings.
        </div>
        <HowToUseHelp title="How to use School Plans">
          <HowToSection title="Two-layer feature flags">
            This page sets what features are <em>available</em> to a
            school. The school's own admin then decides which available
            features are <em>turned on</em> in their Settings. Both
            layers must be true for the feature to render.
          </HowToSection>
          <RoleSection for={["superUser"]} title="When to use presets vs grid">
            Use the preset tab to bring a new school onboard quickly
            (Basic gets the core, Pro adds Insights + Parent, Enterprise
            unlocks everything). Use the grid for one-off changes after
            launch.
          </RoleSection>
        </HowToUseHelp>
      </div>

      {/* tab strip */}
      <div style={{ display: "flex", gap: 4, borderBottom: "1px solid #e2e8f0" }}>
        {(["grid", "presets"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            style={{
              padding: "8px 16px",
              border: "none",
              borderBottom:
                tab === t ? "2px solid #2563eb" : "2px solid transparent",
              background: "transparent",
              cursor: "pointer",
              fontWeight: tab === t ? 700 : 400,
              color: tab === t ? "#0f172a" : "#64748b",
            }}
          >
            {t === "grid" ? "Schools × Features" : "Tier Presets"}
          </button>
        ))}
      </div>

      {tab === "grid" && (
        <div>
          <div style={{ marginBottom: 12, display: "flex", gap: 12, alignItems: "center" }}>
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={`Filter ${schools.length} schools…`}
              style={{
                padding: "6px 10px",
                border: "1px solid #cbd5e1",
                borderRadius: 6,
                minWidth: 240,
              }}
            />
            <span style={{ color: "#64748b", fontSize: "0.85rem" }}>
              {filteredSchools.length} shown
            </span>
          </div>

          <div style={{ overflow: "auto", border: "1px solid #e2e8f0", borderRadius: 8 }}>
            <table className="pulse-table" style={{ borderCollapse: "collapse", minWidth: "100%" }}>
              <thead>
                <tr style={{ background: "#f8fafc" }}>
                  <th
                    style={{
                      position: "sticky",
                      left: 0,
                      background: "#f8fafc",
                      padding: "8px 12px",
                      textAlign: "left",
                      borderBottom: "1px solid #e2e8f0",
                      borderRight: "1px solid #e2e8f0",
                      minWidth: 200,
                      zIndex: 1,
                    }}
                  >
                    School
                  </th>
                  <th
                    style={{
                      padding: "8px 12px",
                      textAlign: "left",
                      borderBottom: "1px solid #e2e8f0",
                      minWidth: 140,
                    }}
                  >
                    Apply preset
                  </th>
                  {featureKeys.map((k) => (
                    <th
                      key={k}
                      style={{
                        padding: "8px 6px",
                        textAlign: "center",
                        borderBottom: "1px solid #e2e8f0",
                        fontSize: "0.78rem",
                        fontWeight: 600,
                        color: "#0f172a",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {FEATURE_LABELS[k] ?? k}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredSchools.map((s) => {
                  const presetName =
                    presets.find((p) => p.id === s.tierPresetId)?.name;
                  const status = rowStatus[s.schoolId];
                  return (
                    <tr key={s.schoolId} style={{ borderBottom: "1px solid #f1f5f9" }}>
                      <td
                        style={{
                          position: "sticky",
                          left: 0,
                          background: "white",
                          padding: "6px 12px",
                          borderRight: "1px solid #e2e8f0",
                          minWidth: 200,
                          zIndex: 1,
                        }}
                      >
                        <div style={{ fontWeight: 600 }}>{s.schoolName}</div>
                        <div
                          style={{
                            fontSize: "0.72rem",
                            color: status ? "#16a34a" : "#94a3b8",
                          }}
                        >
                          {status
                            ? status
                            : presetName
                              ? `Currently: ${presetName}`
                              : "Custom"}
                        </div>
                      </td>
                      <td style={{ padding: "6px 12px" }}>
                        <select
                          value=""
                          onChange={(e) => {
                            const id = Number(e.target.value);
                            if (Number.isFinite(id)) applyPreset(s.schoolId, id);
                            e.target.value = "";
                          }}
                          style={{
                            padding: "4px 8px",
                            border: "1px solid #cbd5e1",
                            borderRadius: 6,
                          }}
                        >
                          <option value="">Apply…</option>
                          {presets.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      {featureKeys.map((k) => {
                        const on = Boolean(s.superFlags[k]);
                        const adminOn = Boolean(s.adminFlags[k]);
                        return (
                          <td
                            key={k}
                            style={{
                              textAlign: "center",
                              padding: "4px",
                              background: on
                                ? adminOn
                                  ? "#ecfdf5"
                                  : "#fef9c3"
                                : "#f1f5f9",
                            }}
                            title={
                              on
                                ? adminOn
                                  ? "Available + admin enabled (live)"
                                  : "Available, but admin has it off"
                                : "Not in this school's plan"
                            }
                          >
                            <button
                              type="button"
                              onClick={() => toggleFlag(s.schoolId, k, !on)}
                              style={{
                                ...cellBtn,
                                background: on ? "#16a34a" : "white",
                                color: on ? "white" : "#cbd5e1",
                                borderColor: on ? "#16a34a" : "#cbd5e1",
                              }}
                            >
                              {on ? "✓" : ""}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 12, fontSize: "0.8rem", color: "#64748b" }}>
            <span style={{ background: "#ecfdf5", padding: "2px 6px", borderRadius: 4 }}>green</span> = available + admin enabled (live).{" "}
            <span style={{ background: "#fef9c3", padding: "2px 6px", borderRadius: 4 }}>yellow</span> = available but admin turned it off in their settings.{" "}
            <span style={{ background: "#f1f5f9", padding: "2px 6px", borderRadius: 4 }}>gray</span> = not in this school's plan.
          </div>
        </div>
      )}

      {tab === "presets" && (
        <PresetEditor
          presets={presets}
          featureKeys={featureKeys}
          onChanged={reload}
        />
      )}
    </div>
  );
}

function PresetEditor(props: {
  presets: Preset[];
  featureKeys: string[];
  onChanged: () => void;
}) {
  const { presets, featureKeys, onChanged } = props;
  const [draft, setDraft] = useState<{
    name: string;
    description: string;
    featureKeys: string[];
  }>({ name: "", description: "", featureKeys: [] });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const togglePresetFeature = async (preset: Preset, key: string) => {
    const next = preset.featureKeys.includes(key)
      ? preset.featureKeys.filter((k) => k !== key)
      : [...preset.featureKeys, key];
    setBusy(true);
    setErr(null);
    try {
      await jsend(`/api/superuser/tier-presets/${preset.id}`, "PATCH", {
        featureKeys: next,
      });
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  const createDraft = async () => {
    if (!draft.name.trim()) {
      setErr("Name is required");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await jsend("/api/superuser/tier-presets", "POST", draft);
      setDraft({ name: "", description: "", featureKeys: [] });
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  const removePreset = async (preset: Preset) => {
    if (preset.isBuiltIn) return;
    if (!confirm(`Delete preset "${preset.name}"?`)) return;
    setBusy(true);
    setErr(null);
    try {
      await jsend(`/api/superuser/tier-presets/${preset.id}`, "DELETE");
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {err && (
        <div style={{ color: "#dc2626", fontSize: "0.85rem" }}>{err}</div>
      )}

      {presets.map((p) => (
        <div
          key={p.id}
          style={{
            border: "1px solid #e2e8f0",
            borderRadius: 8,
            padding: 12,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <div>
              <div style={{ fontWeight: 700 }}>
                {p.name}{" "}
                {p.isBuiltIn && (
                  <span
                    style={{
                      background: "#e0e7ff",
                      color: "#4338ca",
                      fontSize: "0.7rem",
                      padding: "2px 6px",
                      borderRadius: 4,
                      marginLeft: 4,
                    }}
                  >
                    Built-in
                  </span>
                )}
              </div>
              <div style={{ color: "#64748b", fontSize: "0.85rem" }}>
                {p.description}
              </div>
            </div>
            {!p.isBuiltIn && (
              <button
                type="button"
                onClick={() => removePreset(p)}
                disabled={busy}
                style={{
                  padding: "4px 10px",
                  border: "1px solid #fca5a5",
                  borderRadius: 6,
                  background: "white",
                  color: "#dc2626",
                  cursor: "pointer",
                }}
              >
                Delete
              </button>
            )}
          </div>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
            }}
          >
            {featureKeys.map((k) => {
              const on = p.featureKeys.includes(k);
              return (
                <button
                  key={k}
                  type="button"
                  disabled={busy}
                  onClick={() => togglePresetFeature(p, k)}
                  style={{
                    padding: "4px 10px",
                    border: on ? "1px solid #16a34a" : "1px solid #cbd5e1",
                    background: on ? "#dcfce7" : "white",
                    color: on ? "#166534" : "#475569",
                    borderRadius: 999,
                    cursor: "pointer",
                    fontSize: "0.78rem",
                  }}
                >
                  {on ? "✓ " : ""}
                  {FEATURE_LABELS[k] ?? k}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      <div
        style={{
          border: "1px dashed #cbd5e1",
          borderRadius: 8,
          padding: 12,
          background: "#f8fafc",
        }}
      >
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Create new preset</div>
        <div style={{ display: "grid", gap: 8 }}>
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="Name (e.g. School District Pilot)"
            style={{ padding: "6px 10px", border: "1px solid #cbd5e1", borderRadius: 6 }}
          />
          <input
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            placeholder="Description"
            style={{ padding: "6px 10px", border: "1px solid #cbd5e1", borderRadius: 6 }}
          />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {featureKeys.map((k) => {
              const on = draft.featureKeys.includes(k);
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() =>
                    setDraft({
                      ...draft,
                      featureKeys: on
                        ? draft.featureKeys.filter((x) => x !== k)
                        : [...draft.featureKeys, k],
                    })
                  }
                  style={{
                    padding: "4px 10px",
                    border: on ? "1px solid #16a34a" : "1px solid #cbd5e1",
                    background: on ? "#dcfce7" : "white",
                    color: on ? "#166534" : "#475569",
                    borderRadius: 999,
                    cursor: "pointer",
                    fontSize: "0.78rem",
                  }}
                >
                  {on ? "✓ " : ""}
                  {FEATURE_LABELS[k] ?? k}
                </button>
              );
            })}
          </div>
          <div>
            <button
              type="button"
              onClick={createDraft}
              disabled={busy || !draft.name.trim()}
              style={{
                padding: "6px 14px",
                border: "1px solid #2563eb",
                background: "#2563eb",
                color: "white",
                borderRadius: 6,
                cursor: "pointer",
                fontWeight: 600,
                opacity: busy || !draft.name.trim() ? 0.5 : 1,
              }}
            >
              Create preset
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
