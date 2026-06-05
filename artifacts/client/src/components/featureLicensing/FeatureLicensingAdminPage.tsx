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
import {
  HowToUseHelp,
  HowToSection,
  RoleSection,
  howtoListStyle,
} from "../HowToUseHelp";

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

type AuditEntry = {
  id: number;
  schoolId: number;
  schoolName: string | null;
  action: string;
  overrideId: number | null;
  featureKey: string | null;
  payload: Record<string, unknown>;
  actorStaffId: number | null;
  actorName: string | null;
  createdAt: string;
};

type QuotaTelemetryRow = {
  schoolId: number;
  schoolName: string;
  feature: string;
  quotaName: string;
  current: number;
  quota: number;
  pct: number;
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
  const [canManageGlobalPlans, setCanManageGlobalPlans] = useState(false);
  const [schools, setSchools] = useState<SchoolRow[]>([]);
  const [editingPlan, setEditingPlan] = useState<Plan | null>(null);
  const [editingSchoolId, setEditingSchoolId] = useState<number | null>(null);
  const [pickingSchoolId, setPickingSchoolId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    try {
      const [fk, p, s] = await Promise.all([
        getJson<{ features: FeatureSpec[] }>("/api/feature-licensing/feature-keys"),
        getJson<{ plans: Plan[]; canManageGlobalPlans?: boolean }>(
          "/api/feature-licensing/plans",
        ),
        getJson<{ schools: SchoolRow[] }>("/api/feature-licensing/schools"),
      ]);
      setFeatures(fk.features);
      setPlans(p.plans);
      setCanManageGlobalPlans(Boolean(p.canManageGlobalPlans));
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
      <HowToUseHelp title="How to use Feature Licensing">
        <HowToSection title="What this page is">
          The SuperUser control for which features each school can access —
          plans on top, per-school assignment and overrides below.
        </HowToSection>
        <HowToSection title="Day-to-day">
          <ul style={howtoListStyle}>
            <li>
              <strong>Plans</strong> — define reusable feature bundles.
            </li>
            <li>
              <strong>Schools</strong> — assign a plan, or open a school's
              drawer to override individual features and seat quotas.
            </li>
          </ul>
        </HowToSection>
        <RoleSection for={["superUser"]} title="District-wide impact">
          Changes take effect immediately for every user at the affected
          school. Override sparingly — plans keep things consistent.
        </RoleSection>
      </HowToUseHelp>
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

      <QuotaTelemetrySection onError={setError} />

      <PlansSection
        plans={plans}
        features={features}
        canManage={canManageGlobalPlans}
        onEdit={setEditingPlan}
        onReload={reload}
        onError={setError}
      />

      <SchoolsSection
        schools={schools}
        plans={plans}
        onOpenOverrides={setEditingSchoolId}
        onOpenPicker={setPickingSchoolId}
        onReload={reload}
        onError={setError}
      />

      <AuditLogSection onError={setError} />

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

      {pickingSchoolId !== null &&
        (() => {
          const school = schools.find((s) => s.schoolId === pickingSchoolId);
          if (!school) return null;
          const plan = plans.find((p) => p.id === school.planId) ?? null;
          return (
            <FeaturePickerModal
              schoolId={pickingSchoolId}
              schoolName={school.schoolName}
              plan={plan}
              features={features}
              onClose={() => setPickingSchoolId(null)}
              onSaved={async () => {
                setPickingSchoolId(null);
                await reload();
                await refreshFeatures(true);
              }}
              onError={setError}
            />
          );
        })()}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quota telemetry tile (Phase 3) — schools-near-quota at ≥80% usage on any
// seat-style quota. Cheap GET, polled on mount only — admins refresh
// manually with the "Refresh" button.
// ---------------------------------------------------------------------------
function QuotaTelemetrySection({
  onError,
}: {
  onError: (msg: string) => void;
}) {
  const [rows, setRows] = useState<QuotaTelemetryRow[]>([]);
  const [threshold, setThreshold] = useState(0.8);
  const [loading, setLoading] = useState(true);

  async function reload() {
    try {
      setLoading(true);
      const r = await getJson<{
        threshold: number;
        rows: QuotaTelemetryRow[];
      }>(`/api/feature-licensing/quota-telemetry?threshold=${threshold}`);
      setRows(r.rows);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threshold]);

  return (
    <section
      className="card"
      style={{ marginBottom: "1.5rem", background: "var(--bg-soft, #fafafa)" }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "0.5rem",
        }}
      >
        <h3 style={{ margin: 0 }}>
          Schools near quota{" "}
          <span style={{ fontWeight: "normal", color: "#777", fontSize: "0.85em" }}>
            (≥ {Math.round(threshold * 100)}% usage)
          </span>
        </h3>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ fontSize: "0.85em" }}>
            Threshold:
            <select
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              style={{ marginLeft: 4 }}
            >
              <option value={0.5}>50%</option>
              <option value={0.7}>70%</option>
              <option value={0.8}>80%</option>
              <option value={0.9}>90%</option>
              <option value={1.0}>100%</option>
            </select>
          </label>
          <button onClick={reload}>Refresh</button>
        </div>
      </div>
      {loading ? (
        <p style={{ color: "#777", margin: 0 }}>Loading…</p>
      ) : rows.length === 0 ? (
        <p style={{ color: "#0a7", margin: 0 }}>
          ✓ No schools at or above the threshold on any seat quota.
        </p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left" }}>
              <th>School</th>
              <th>Feature</th>
              <th>Quota</th>
              <th>Usage</th>
              <th>%</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={`${r.schoolId}-${r.feature}-${r.quotaName}`}
                style={{ borderTop: "1px solid var(--border, #eee)" }}
              >
                <td>{r.schoolName}</td>
                <td>
                  <code style={{ fontSize: "0.85em" }}>{r.feature}</code>
                </td>
                <td>
                  <code style={{ fontSize: "0.85em" }}>{r.quotaName}</code>
                </td>
                <td>
                  {r.current} / {r.quota}
                </td>
                <td
                  style={{
                    color: r.pct >= 1 ? "#c33" : r.pct >= 0.9 ? "#d80" : "#333",
                    fontWeight: r.pct >= 0.9 ? 600 : 400,
                  }}
                >
                  {Math.round(r.pct * 100)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Audit log section (Phase 3) — recent activity from the override sweep
// cron + any future write events that land here. Read-only.
// ---------------------------------------------------------------------------
function AuditLogSection({
  onError,
}: {
  onError: (msg: string) => void;
}) {
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [limit, setLimit] = useState(50);
  const [loading, setLoading] = useState(true);

  async function reload() {
    try {
      setLoading(true);
      const r = await getJson<{ entries: AuditEntry[] }>(
        `/api/feature-licensing/audit?limit=${limit}`,
      );
      setRows(r.entries);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [limit]);

  function renderPayload(p: Record<string, unknown>): string {
    try {
      const compact = JSON.stringify(p);
      return compact.length > 80 ? compact.slice(0, 77) + "…" : compact;
    } catch {
      return "{}";
    }
  }

  return (
    <section style={{ marginTop: "2rem" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "0.5rem",
        }}
      >
        <h3 style={{ margin: 0 }}>Audit log</h3>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ fontSize: "0.85em" }}>
            Show:
            <select
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              style={{ marginLeft: 4 }}
            >
              <option value={25}>25</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value={250}>250</option>
            </select>
          </label>
          <button onClick={reload}>Refresh</button>
        </div>
      </div>
      <p
        style={{
          color: "var(--text-subtle, #555)",
          margin: "0 0 0.5rem 0",
          fontSize: "0.9em",
        }}
      >
        Append-only trail of licensing state changes. Today this is driven
        by the daily expired-override sweep cron; future plan/override
        write events will land here too.
      </p>
      {loading ? (
        <p style={{ color: "#777" }}>Loading…</p>
      ) : rows.length === 0 ? (
        <p style={{ color: "#777" }}>No audit entries yet.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left" }}>
              <th>When</th>
              <th>School</th>
              <th>Action</th>
              <th>Feature</th>
              <th>Actor</th>
              <th>Payload</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={{ borderTop: "1px solid var(--border, #eee)" }}>
                <td style={{ whiteSpace: "nowrap", fontSize: "0.85em" }}>
                  {new Date(r.createdAt).toLocaleString()}
                </td>
                <td>{r.schoolName ?? `#${r.schoolId}`}</td>
                <td>
                  <code style={{ fontSize: "0.85em" }}>{r.action}</code>
                </td>
                <td>
                  {r.featureKey ? (
                    <code style={{ fontSize: "0.85em" }}>{r.featureKey}</code>
                  ) : (
                    <span style={{ color: "#aaa" }}>—</span>
                  )}
                </td>
                <td>
                  {r.actorName ?? (
                    <span style={{ color: "#aaa" }}>
                      {r.actorStaffId ? `#${r.actorStaffId}` : "system"}
                    </span>
                  )}
                </td>
                <td style={{ fontFamily: "monospace", fontSize: "0.8em" }}>
                  {renderPayload(r.payload)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------
function PlansSection({
  plans,
  features,
  canManage,
  onEdit,
  onReload,
  onError,
}: {
  plans: Plan[];
  features: FeatureSpec[];
  canManage: boolean;
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
        {canManage ? (
          <button onClick={createBlank}>+ New plan</button>
        ) : (
          <span style={{ fontSize: "0.85em", color: "#777" }}>
            Read-only — global plan editing requires a cross-district
            SuperUser. Use per-school overrides below.
          </span>
        )}
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
                  {canManage ? (
                    <>
                      <button onClick={() => onEdit(p)}>Edit</button>{" "}
                      <button onClick={() => remove(p.id)}>Delete</button>
                    </>
                  ) : (
                    <span style={{ color: "#999", fontSize: "0.85em" }}>
                      read-only
                    </span>
                  )}
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
  onOpenPicker,
  onReload,
  onError,
}: {
  schools: SchoolRow[];
  plans: Plan[];
  onOpenOverrides: (id: number) => void;
  onOpenPicker: (id: number) => void;
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
                <button
                  onClick={() => onOpenPicker(s.schoolId)}
                  style={{ marginRight: 6 }}
                >
                  Pick features…
                </button>
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

  async function resetAll() {
    if (rows.length === 0) return;
    const confirmed = window.confirm(
      `Reset ${schoolName} back to pure plan defaults?\n\n` +
        `This will delete all ${rows.length} override row${
          rows.length === 1 ? "" : "s"
        } for this school. The school will then inherit every feature from its plan, and future plan changes will flow through automatically.`,
    );
    if (!confirmed) return;
    try {
      await deleteRequest(
        `/api/feature-licensing/schools/${schoolId}/overrides`,
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
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginTop: 12,
          gap: 8,
        }}
      >
        <button
          type="button"
          onClick={resetAll}
          disabled={rows.length === 0}
          title={
            rows.length === 0
              ? "No overrides to clear"
              : "Delete every override row and re-inherit from the plan"
          }
        >
          Reset to plan defaults
          {rows.length > 0 ? ` (${rows.length})` : ""}
        </button>
        <button onClick={onClose}>Close</button>
      </div>
    </ModalShell>
  );
}

// ---------------------------------------------------------------------------
// FeaturePickerModal — bulk "only these features are on for this school"
// picker. Writes one override row per feature with the desired enabled
// state, so the result is independent of the underlying plan. This is
// the surface SuperUsers actually wanted for the "Enterprise plan but
// I only want Hall Pass + Tardy Pass live for this school" case — the
// Overrides drawer required them to know plans default-on and then
// manually add 17 disable rows. Here they just check the two boxes
// they want on, hit Save, and the modal writes all 19 overrides
// (idempotent POST upserts).
// ---------------------------------------------------------------------------
function FeaturePickerModal({
  schoolId,
  schoolName,
  plan,
  features,
  onClose,
  onSaved,
  onError,
}: {
  schoolId: number;
  schoolName: string;
  plan: Plan | null;
  features: FeatureSpec[];
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  onError: (msg: string) => void;
}) {
  const [selected, setSelected] = useState<Record<string, boolean> | null>(
    null,
  );
  const [existingOverrides, setExistingOverrides] = useState<Override[]>([]);
  const [saving, setSaving] = useState(false);
  const [reason, setReason] = useState("");

  // Initial state: feature is "on" if there's an enabled override OR if
  // the plan defaults it on AND no disable override.
  useEffect(() => {
    void (async () => {
      try {
        const r = await getJson<{ overrides: Override[] }>(
          `/api/feature-licensing/schools/${schoolId}/overrides`,
        );
        setExistingOverrides(r.overrides);
        const overrideByKey = new Map(r.overrides.map((o) => [o.featureKey, o]));
        const init: Record<string, boolean> = {};
        for (const f of features) {
          const o = overrideByKey.get(f.key);
          if (o) {
            init[f.key] = o.enabled;
          } else {
            init[f.key] = Boolean(plan?.features?.[f.key]);
          }
        }
        setSelected(init);
      } catch (e) {
        onError(e instanceof Error ? e.message : String(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId]);

  function toggle(key: string, value: boolean) {
    setSelected((s) => (s ? { ...s, [key]: value } : s));
  }

  function selectAll(value: boolean) {
    if (!selected) return;
    const next: Record<string, boolean> = {};
    for (const f of features) next[f.key] = value;
    setSelected(next);
  }

  // Diff-based save (changed Apr 2026 after the demo footgun: previously
  // this wrote 19 override rows on every Save regardless of selection,
  // pinning the school's entire feature set as overrides and breaking
  // plan inheritance forever — even an unchanged Save bumped the
  // override count to 19). New behavior:
  //   - selected matches plan default → DELETE the existing override
  //     (if any) so the feature re-inherits from the plan.
  //   - selected differs from plan default → POST upsert.
  //   - no existing override and selection matches plan → no-op.
  // Net effect: overrideCount reflects only real deviations.
  async function save() {
    if (!selected) return;
    setSaving(true);
    try {
      const showUpsellByKey = new Map(
        existingOverrides.map((o) => [o.featureKey, o.showUpsell]),
      );
      const overrideByKey = new Map(
        existingOverrides.map((o) => [o.featureKey, o]),
      );
      const cleanedReason = reason.trim() || undefined;
      // Serial — each write opens a tx + reapplies licensing; parallel
      // would risk lock contention + out-of-order super_feature_* writes.
      for (const f of features) {
        const want = Boolean(selected[f.key]);
        const planDefault = Boolean(plan?.features?.[f.key]);
        const existing = overrideByKey.get(f.key);
        if (want === planDefault) {
          // Should re-inherit from plan. Drop any existing override row.
          if (existing) {
            await deleteRequest(
              `/api/feature-licensing/schools/${schoolId}/overrides/${existing.id}`,
            );
          }
        } else {
          // Genuine deviation — upsert.
          await sendJson(
            `/api/feature-licensing/schools/${schoolId}/overrides`,
            "POST",
            {
              featureKey: f.key,
              enabled: want,
              showUpsell: showUpsellByKey.get(f.key) ?? false,
              reason: cleanedReason,
            },
          );
        }
      }
      await onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const enabledCount = selected
    ? Object.values(selected).filter(Boolean).length
    : 0;

  return (
    <ModalShell
      title={`Pick features — ${schoolName}`}
      onClose={saving ? () => {} : onClose}
    >
      <p style={{ color: "var(--text-subtle, #555)", marginTop: 0 }}>
        Check the features that should be live for this school. We only
        save the boxes that <em>differ</em> from the plan (
        {plan ? <code>{plan.key}</code> : "no plan"}) — anything that
        matches the plan default stays inherited, so flipping a default
        in the plan still flows through. The override count on the
        Schools list will reflect just your real deviations.
      </p>

      {selected === null ? (
        <p>Loading…</p>
      ) : (
        <>
          <div style={{ marginBottom: 8, display: "flex", gap: 8 }}>
            <button type="button" onClick={() => selectAll(true)}>
              All on
            </button>
            <button type="button" onClick={() => selectAll(false)}>
              All off
            </button>
            <span
              style={{
                marginLeft: "auto",
                alignSelf: "center",
                color: "var(--text-subtle, #777)",
                fontSize: "0.85em",
              }}
            >
              {enabledCount} of {features.length} on
            </span>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
              gap: "6px 16px",
              border: "1px solid var(--border, #eee)",
              borderRadius: 6,
              padding: 10,
              maxHeight: "45vh",
              overflowY: "auto",
            }}
          >
            {features.map((f) => (
              <label
                key={f.key}
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  padding: "4px 6px",
                  borderRadius: 4,
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={selected[f.key] ?? false}
                  onChange={(e) => toggle(f.key, e.target.checked)}
                />
                <span>
                  <strong>{f.label}</strong>{" "}
                  <code style={{ fontSize: "0.8em", color: "#888" }}>
                    {f.key}
                  </code>
                </span>
              </label>
            ))}
          </div>

          <div style={{ marginTop: 12 }}>
            <label style={{ display: "block", fontSize: "0.85em" }}>
              Reason (optional, audited):
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. 'Starter tier for pilot school'"
                style={{
                  display: "block",
                  width: "100%",
                  marginTop: 4,
                  padding: "6px 8px",
                  border: "1px solid var(--border, #ddd)",
                  borderRadius: 4,
                  font: "inherit",
                  boxSizing: "border-box",
                }}
              />
            </label>
          </div>

          <div
            style={{
              textAlign: "right",
              marginTop: 12,
              display: "flex",
              gap: 8,
              justifyContent: "flex-end",
            }}
          >
            <button type="button" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="button" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </>
      )}
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
