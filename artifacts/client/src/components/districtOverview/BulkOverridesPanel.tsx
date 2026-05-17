// BulkOverridesPanel — Phase 5 "Global Feature Flags" UX on the SuperUser
// Home. Lets a SuperUser flip one feature on or off for an entire
// district or for the whole platform in a single write. Backed by
// POST /api/feature-licensing/bulk-overrides which fans out the per-
// school override + reapply inside one transaction.
//
// Scoping mirrors the backend gate:
//   - "Platform" requires ALLOW_CROSS_DISTRICT_SUPERUSER=1.
//   - "District" is allowed on the caller's home district without the
//     env flag, and on any district with the flag.

import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../../lib/authToken";

type FeatureKey = { key: string; label: string };
type District = { id: number; name: string };

type BulkResponse = {
  applied: number;
  schoolIds: number[];
  skipped: number;
};

export function BulkOverridesPanel() {
  const [features, setFeatures] = useState<FeatureKey[]>([]);
  const [districts, setDistricts] = useState<District[]>([]);
  const [loadingMeta, setLoadingMeta] = useState(true);

  const [scope, setScope] = useState<"platform" | "district">("district");
  const [districtId, setDistrictId] = useState<number | "">("");
  const [featureKey, setFeatureKey] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [showUpsell, setShowUpsell] = useState(false);
  const [reason, setReason] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      authFetch("/api/feature-licensing/feature-keys").then((r) =>
        r.ok ? r.json() : null,
      ),
      authFetch("/api/superuser/overview").then((r) =>
        r.ok ? r.json() : null,
      ),
    ])
      .then(([f, o]) => {
        if (cancelled) return;
        const featuresList: FeatureKey[] = Array.isArray(f?.features)
          ? f.features.map((entry: unknown) => {
              if (typeof entry === "string") return { key: entry, label: entry };
              if (entry && typeof entry === "object") {
                const e = entry as { key?: string; label?: string };
                return { key: e.key ?? "", label: e.label ?? e.key ?? "" };
              }
              return { key: "", label: "" };
            })
            .filter((x: FeatureKey) => x.key)
          : [];
        setFeatures(featuresList);
        if (featuresList.length && !featureKey) setFeatureKey(featuresList[0].key);
        const ds: District[] = Array.isArray(o?.districts)
          ? o.districts.map((d: { id: number; name: string }) => ({
              id: d.id,
              name: d.name,
            }))
          : [];
        setDistricts(ds);
        if (ds.length && !districtId) setDistrictId(ds[0].id);
        setLoadingMeta(false);
      })
      .catch(() => {
        if (!cancelled) setLoadingMeta(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedFeatureLabel = useMemo(
    () => features.find((f) => f.key === featureKey)?.label ?? featureKey,
    [features, featureKey],
  );

  const canSubmit =
    !busy &&
    !!featureKey &&
    (scope === "platform" || typeof districtId === "number");

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const payload: Record<string, unknown> = {
        scope,
        featureKey,
        enabled,
        showUpsell,
      };
      if (scope === "district") payload.districtId = districtId;
      if (reason.trim()) payload.reason = reason.trim();
      if (expiresAt) payload.expiresAt = new Date(expiresAt).toISOString();
      const res = await authFetch("/api/feature-licensing/bulk-overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = (await res.json().catch(() => ({}))) as
        | BulkResponse
        | { error?: string };
      if (!res.ok) {
        setError(
          (json as { error?: string }).error ??
            `Bulk apply failed (HTTP ${res.status})`,
        );
      } else {
        const r = json as BulkResponse;
        setSuccess(
          `Applied "${selectedFeatureLabel}" = ${enabled ? "ON" : "OFF"} to ${r.applied} school${r.applied === 1 ? "" : "s"}.`,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bulk apply failed");
    } finally {
      setBusy(false);
    }
  };

  if (loadingMeta) {
    return (
      <div
        style={{
          marginTop: "1.25rem",
          padding: "0.75rem 1rem",
          color: "var(--text-subtle)",
          fontSize: "0.85rem",
        }}
      >
        Loading bulk-overrides panel…
      </div>
    );
  }

  return (
    <div
      style={{
        marginTop: "1.25rem",
        border: "1px solid var(--border, #e2e8f0)",
        borderRadius: 8,
        background: "var(--surface, #fff)",
        padding: "0.85rem 1rem",
      }}
    >
      <h3 style={{ margin: 0, fontSize: "1rem" }}>Global Feature Flags</h3>
      <p
        style={{
          marginTop: 4,
          color: "var(--text-subtle)",
          fontSize: "0.8rem",
        }}
      >
        Flip one feature on or off for an entire district — or for the
        whole platform — in a single audited write.
      </p>

      <form
        onSubmit={onSubmit}
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: "0.5rem 0.75rem",
          marginTop: "0.75rem",
          alignItems: "end",
        }}
      >
        <label style={{ fontSize: "0.8rem" }}>
          Scope
          <select
            value={scope}
            onChange={(e) =>
              setScope(e.target.value === "platform" ? "platform" : "district")
            }
            style={{ display: "block", width: "100%", marginTop: 2 }}
          >
            <option value="district">District</option>
            <option value="platform">Platform (all districts)</option>
          </select>
        </label>

        {scope === "district" && (
          <label style={{ fontSize: "0.8rem" }}>
            District
            <select
              value={districtId === "" ? "" : String(districtId)}
              onChange={(e) =>
                setDistrictId(e.target.value ? Number(e.target.value) : "")
              }
              style={{ display: "block", width: "100%", marginTop: 2 }}
            >
              {districts.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <label style={{ fontSize: "0.8rem" }}>
          Feature
          <select
            value={featureKey}
            onChange={(e) => setFeatureKey(e.target.value)}
            style={{ display: "block", width: "100%", marginTop: 2 }}
          >
            {features.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </select>
        </label>

        <label style={{ fontSize: "0.8rem" }}>
          Value
          <select
            value={enabled ? "on" : "off"}
            onChange={(e) => setEnabled(e.target.value === "on")}
            style={{ display: "block", width: "100%", marginTop: 2 }}
          >
            <option value="on">Enabled</option>
            <option value="off">Disabled</option>
          </select>
        </label>

        <label style={{ fontSize: "0.8rem" }}>
          Expires (optional)
          <input
            type="date"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
            style={{ display: "block", width: "100%", marginTop: 2 }}
          />
        </label>

        <label
          style={{
            fontSize: "0.8rem",
            gridColumn: "1 / -1",
          }}
        >
          Reason (recommended)
          <input
            type="text"
            placeholder='e.g. "Pilot for SY26"'
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            style={{ display: "block", width: "100%", marginTop: 2 }}
          />
        </label>

        <label
          style={{
            fontSize: "0.8rem",
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <input
            type="checkbox"
            checked={showUpsell}
            onChange={(e) => setShowUpsell(e.target.checked)}
          />
          Show upsell when off
        </label>

        <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8 }}>
          <button type="submit" disabled={!canSubmit}>
            {busy ? "Applying…" : "Apply"}
          </button>
          {error && (
            <span style={{ color: "#c00", fontSize: "0.8rem" }}>{error}</span>
          )}
          {success && (
            <span style={{ color: "#0a7", fontSize: "0.8rem" }}>{success}</span>
          )}
        </div>
      </form>
    </div>
  );
}

export default BulkOverridesPanel;
