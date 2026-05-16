// SuperUser-only admin page for feature licensing.
//
// One page, two stacked sections (Plans + Schools) instead of two routes.
// Plans CRUD on top, Schools (with plan assignment + per-school override
// drawer) below. We deliberately render a compact UI here — this is an
// admin surface used by a handful of people, not a polished tenant page.
//
// Skips React Query / Orval — calls the JSON endpoints with `authFetch`
// directly because the contract is internal and unlikely to grow.

import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../../lib/authToken";
import { refreshFeatures } from "../../lib/features";

type FeatureSpec = {
  key: string;
  label: string;
  description: string;
  schoolSettingsKey: string | null;
  quotas: { name: string; type: "number" | "stringList"; label: string; hint?: string }[];
};

type Plan = {
  id: number;
  key: string;
  label: string;
  description: string | null;
  features: Record<string, true>;
  quotas: Record<string, Record<string, number | string[]>>;
};

type SchoolRow = {
  schoolId: number;
  schoolName: string;
  planId: number | null;
  planKey: string | null;
  planLabel: string | null;
  overrideCount: number;
};

type Override = {
  id: number;
  schoolId: number;
  featureKey: string;
  enabled: boolean;
  showUpsell: boolean;
  quotas: Record<string, number | string[]>;
  expiresAt: string | null;
  reason: string | null;
  grantedByStaffId: number | null;
  createdAt: string;
};

async function getJson<T>(url: string): Promise<T> {
  const res = await authFetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function sendJson<T>(url: string, method: string, body: unknown): Promise<T> {
  const res = await authFetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${url} → ${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

async function deleteRequest(url: string): Promise<void> {
  const res = await authFetch(url, { method: "DELETE" });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
}

export default function FeatureLicensingAdminPage() {
  const [features, setFeatures] = useState<FeatureSpec[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [schools, setSchools] = useState<SchoolRow[]>([]);
  const [editingPlan, setEditingPlan] = useState<Plan | null>(null);
  const [editingSchoolId, setEditingSchoolId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    try {
      const [fk, p, s] = await Promise.all([
        getJson<{ features: FeatureSpec[] }>("/api/feature-licensing/feature-keys"),
        getJson<{ plans: Plan[] }>("/api/feature-licensing/plans"),
        getJson<{ schools: SchoolRow[] }>("/api/feature-licensing/schools"),
      ]);
      setFeatures(fk.features);
      setPlans(p.plans);
      setSchools(s.schools);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <h2 style={{ marginTop: 0 }}>Feature Licensing</h2>
      <p style={{ color: "var(--text-subtle, #555)", marginTop: 0 }}>
        SuperUser surface for managing Plans (bundles of features) and
        per-school Overrides. Phase 1 — quotas are plumbing only, no
        enforcement yet.
      </p>
      {error && (
        <div className="card" style={{ background: "#fee", marginBottom: "1rem" }}>
          {error}
        </div>
      )}

      <PlansSection
        plans={plans}
        features={features}
        onEdit={setEditingPlan}
        onReload={reload}
        onError={setError}
      />

      <SchoolsSection
        schools={schools}
        plans={plans}
        onOpenOverrides={setEditingSchoolId}
        onReload={reload}
        onError={setError}
      />

      {editingPlan !== null && (
        <PlanEditorModal
          plan={editingPlan}
          features={features}
          onClose={() => setEditingPlan(null)}
          onSaved={async () => {
            setEditingPlan(null);
            await reload();
            await refreshFeatures(true);
          }}
          onError={setError}
        />
      )}

      {editingSchoolId !== null && (
        <OverridesDrawer
          schoolId={editingSchoolId}
          schoolName={
            schools.find((s) => s.schoolId === editingSchoolId)?.schoolName ?? ""
          }
          features={features}
          onClose={() => setEditingSchoolId(null)}
          onChanged={async () => {
            await reload();
            await refreshFeatures(true);
          }}
          onError={setError}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------
function PlansSection({
  plans,
  features,
  onEdit,
  onReload,
  onError,
}: {
  plans: Plan[];
  features: FeatureSpec[];
  onEdit: (p: Plan) => void;
  onReload: () => void | Promise<void>;
  onError: (msg: string) => void;
}) {
  async function createBlank() {
    try {
      const key = window.prompt("New plan key (lowercase, e.g. starter):");
      if (!key) return;
      const label = window.prompt("Display label:", key) ?? key;
      await sendJson<{ plan: Plan }>("/api/feature-licensing/plans", "POST", {
        key,
        label,
        features: {},
        quotas: {},
      });
      await onReload();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }

  async function remove(id: number) {
    if (!window.confirm("Delete this plan? Refused if any school still uses it."))
      return;
    try {
      await deleteRequest(`/api/feature-licensing/plans/${id}`);
      await onReload();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <section style={{ marginBottom: "2rem" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "0.5rem",
        }}
      >
        <h3 style={{ margin: 0 }}>Plans</h3>
        <button onClick={createBlank}>+ New plan</button>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left" }}>
            <th>Key</th>
            <th>Label</th>
            <th>Features</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {plans.map((p) => {
            const onCount = Object.keys(p.features ?? {}).length;
            return (
              <tr key={p.id} style={{ borderTop: "1px solid var(--border, #eee)" }}>
                <td>
                  <code>{p.key}</code>
                </td>
                <td>{p.label}</td>
                <td>
                  {onCount} / {features.length}
                </td>
                <td style={{ textAlign: "right" }}>
                  <button onClick={() => onEdit(p)}>Edit</button>{" "}
                  <button onClick={() => remove(p.id)}>Delete</button>
                </td>
              </tr>
            );
          })}
          {plans.length === 0 && (
            <tr>
              <td colSpan={4} style={{ color: "var(--text-subtle, #777)" }}>
                No plans yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

function PlanEditorModal({
  plan,
  features,
  onClose,
  onSaved,
  onError,
}: {
  plan: Plan;
  features: FeatureSpec[];
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  onError: (msg: string) => void;
}) {
  const [label, setLabel] = useState(plan.label);
  const [description, setDescription] = useState(plan.description ?? "");
  const [enabled, setEnabled] = useState<Record<string, boolean>>(
    () =>
      Object.fromEntries(features.map((f) => [f.key, plan.features?.[f.key] === true])),
  );
  const [quotasJson, setQuotasJson] = useState(
    JSON.stringify(plan.quotas ?? {}, null, 2),
  );

  async function save() {
    try {
      let parsedQuotas: unknown = {};
      try {
        parsedQuotas = JSON.parse(quotasJson || "{}");
      } catch {
        onError("Quotas is not valid JSON");
        return;
      }
      const featuresPatch: Record<string, true> = {};
      for (const [k, v] of Object.entries(enabled)) if (v) featuresPatch[k] = true;
      await sendJson(`/api/feature-licensing/plans/${plan.id}`, "PATCH", {
        label,
        description,
        features: featuresPatch,
        quotas: parsedQuotas,
      });
      await onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <ModalShell title={`Edit plan — ${plan.key}`} onClose={onClose}>
      <label>
        Label
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          style={{ width: "100%" }}
        />
      </label>
      <label style={{ display: "block", marginTop: 8 }}>
        Description
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          style={{ width: "100%" }}
        />
      </label>
      <h4 style={{ marginBottom: 4 }}>Features</h4>
      <div
        style={{
          maxHeight: 260,
          overflow: "auto",
          border: "1px solid var(--border, #ddd)",
          padding: 8,
          borderRadius: 4,
        }}
      >
        {features.map((f) => (
          <label
            key={f.key}
            style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 4 }}
          >
            <input
              type="checkbox"
              checked={!!enabled[f.key]}
              onChange={(e) =>
                setEnabled((prev) => ({ ...prev, [f.key]: e.target.checked }))
              }
            />
            <span>
              <strong>{f.label}</strong>{" "}
              <code style={{ fontSize: "0.8em", color: "#777" }}>{f.key}</code>
              <div style={{ fontSize: "0.85em", color: "var(--text-subtle, #777)" }}>
                {f.description}
              </div>
            </span>
          </label>
        ))}
      </div>
      <h4 style={{ marginBottom: 4 }}>Quotas (raw JSON)</h4>
      <textarea
        value={quotasJson}
        onChange={(e) => setQuotasJson(e.target.value)}
        rows={6}
        style={{ width: "100%", fontFamily: "monospace" }}
      />
      <div style={{ marginTop: 12, textAlign: "right" }}>
        <button onClick={onClose}>Cancel</button>{" "}
        <button onClick={save}>Save</button>
      </div>
    </ModalShell>
  );
}

// ---------------------------------------------------------------------------
// Schools
// ---------------------------------------------------------------------------
function SchoolsSection({
  schools,
  plans,
  onOpenOverrides,
  onReload,
  onError,
}: {
  schools: SchoolRow[];
  plans: Plan[];
  onOpenOverrides: (id: number) => void;
  onReload: () => void | Promise<void>;
  onError: (msg: string) => void;
}) {
  async function changePlan(schoolId: number, planId: number | null) {
    try {
      await sendJson(`/api/feature-licensing/schools/${schoolId}/plan`, "PATCH", {
        planId,
      });
      await onReload();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <section>
      <h3 style={{ marginBottom: "0.5rem" }}>Schools</h3>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left" }}>
            <th>School</th>
            <th>Plan</th>
            <th>Overrides</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {schools.map((s) => (
            <tr key={s.schoolId} style={{ borderTop: "1px solid var(--border, #eee)" }}>
              <td>{s.schoolName}</td>
              <td>
                <select
                  value={s.planId ?? ""}
                  onChange={(e) =>
                    changePlan(
                      s.schoolId,
                      e.target.value === "" ? null : Number(e.target.value),
                    )
                  }
                >
                  <option value="">(none)</option>
                  {plans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </td>
              <td>{s.overrideCount}</td>
              <td style={{ textAlign: "right" }}>
                <button onClick={() => onOpenOverrides(s.schoolId)}>
                  Overrides…
                </button>
              </td>
            </tr>
          ))}
          {schools.length === 0 && (
            <tr>
              <td colSpan={4} style={{ color: "var(--text-subtle, #777)" }}>
                No schools.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

function OverridesDrawer({
  schoolId,
  schoolName,
  features,
  onClose,
  onChanged,
  onError,
}: {
  schoolId: number;
  schoolName: string;
  features: FeatureSpec[];
  onClose: () => void;
  onChanged: () => void | Promise<void>;
  onError: (msg: string) => void;
}) {
  const [rows, setRows] = useState<Override[]>([]);
  const byKey = useMemo(() => new Map(rows.map((r) => [r.featureKey, r])), [rows]);

  async function reload() {
    try {
      const r = await getJson<{ overrides: Override[] }>(
        `/api/feature-licensing/schools/${schoolId}/overrides`,
      );
      setRows(r.overrides);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId]);

  async function upsert(
    featureKey: string,
    patch: { enabled: boolean; showUpsell: boolean; reason?: string },
  ) {
    try {
      await sendJson(
        `/api/feature-licensing/schools/${schoolId}/overrides`,
        "POST",
        { featureKey, ...patch },
      );
      await reload();
      await onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }

  async function remove(overrideId: number) {
    try {
      await deleteRequest(
        `/api/feature-licensing/schools/${schoolId}/overrides/${overrideId}`,
      );
      await reload();
      await onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <ModalShell title={`Overrides — ${schoolName}`} onClose={onClose}>
      <p style={{ color: "var(--text-subtle, #555)" }}>
        Each row is a per-school override that sits on top of the plan.
        Toggling <strong>Enabled</strong> flips the feature on/off for
        this school regardless of the plan. <strong>Show upsell</strong>{" "}
        opts this school into the Hybrid upsell surface (locked nav item
        + "contact admin to upgrade" page) when the feature is off.
      </p>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left" }}>
            <th>Feature</th>
            <th>Enabled</th>
            <th>Show upsell</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {features.map((f) => {
            const r = byKey.get(f.key);
            return (
              <tr key={f.key} style={{ borderTop: "1px solid var(--border, #eee)" }}>
                <td>
                  <strong>{f.label}</strong>{" "}
                  <code style={{ fontSize: "0.8em", color: "#777" }}>{f.key}</code>
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={r?.enabled ?? false}
                    onChange={(e) =>
                      upsert(f.key, {
                        enabled: e.target.checked,
                        showUpsell: r?.showUpsell ?? false,
                      })
                    }
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={r?.showUpsell ?? false}
                    onChange={(e) =>
                      upsert(f.key, {
                        enabled: r?.enabled ?? false,
                        showUpsell: e.target.checked,
                      })
                    }
                  />
                </td>
                <td style={{ textAlign: "right" }}>
                  {r && <button onClick={() => remove(r.id)}>Clear</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div style={{ textAlign: "right", marginTop: 12 }}>
        <button onClick={onClose}>Close</button>
      </div>
    </ModalShell>
  );
}

function ModalShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{
          width: "min(720px, 92vw)",
          maxHeight: "88vh",
          overflow: "auto",
          background: "var(--bg, #fff)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "0.5rem",
          }}
        >
          <h3 style={{ margin: 0 }}>{title}</h3>
          <button onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}
