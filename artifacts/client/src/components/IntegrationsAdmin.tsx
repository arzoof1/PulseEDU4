import { useEffect, useState } from "react";

type Config = {
  id: number;
  schoolName: string;
  sisProvider: string;
  sisConfig: Record<string, unknown> | null;
  sisLastSyncAt: string | null;
  sisLastSyncStatus: string | null;
  ssoProvider: string;
  ssoConfig: Record<string, unknown> | null;
};

type Payload = {
  config: Config;
  supportedSisProviders: readonly string[];
  supportedSsoProviders: readonly string[];
};

const SIS_LABELS: Record<string, string> = {
  none: "None (use built-in roster)",
  skyward: "Skyward",
  classlink: "ClassLink (OneRoster)",
};

const SSO_LABELS: Record<string, string> = {
  none: "None (local password login)",
  classlink: "ClassLink SSO",
};

export default function IntegrationsAdmin() {
  const [data, setData] = useState<Payload | null>(null);
  const [saving, setSaving] = useState(false);
  const [pingResult, setPingResult] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/district-integrations", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Payload | null) => setData(d))
      .catch(() => {});
  }, []);

  if (!data) return null;
  const { config, supportedSisProviders, supportedSsoProviders } = data;

  async function update(patch: Partial<Config>) {
    setSaving(true);
    try {
      const res = await fetch("/api/district-integrations", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(patch),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Save failed");
      setData((d) => (d ? { ...d, config: j.config } : d));
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function pingSis() {
    setPingResult("Testing…");
    try {
      const res = await fetch("/api/district-integrations/sis-ping", {
        method: "POST",
        credentials: "include",
      });
      const j = await res.json();
      setPingResult(`${j.ok ? "OK" : "Fail"} — ${j.message}`);
    } catch (err) {
      setPingResult(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="card" style={{ marginTop: "1rem" }}>
      <h2>SIS &amp; SSO Integrations</h2>
      <p style={{ color: "var(--text-subtle)", marginTop: 0 }}>
        Choose which student-information system supplies your roster and which
        identity provider handles sign-in. Each adapter reads its credentials
        from server environment variables — fill the matching env vars and use
        “Test connection” below.
      </p>

      <div style={{ display: "grid", gap: "0.75rem", maxWidth: 560 }}>
        <label style={{ display: "grid", gap: "0.25rem" }}>
          <span>SIS (roster source)</span>
          <select
            value={config.sisProvider}
            disabled={saving}
            onChange={(e) => update({ sisProvider: e.target.value })}
          >
            {supportedSisProviders.map((p) => (
              <option key={p} value={p}>
                {SIS_LABELS[p] ?? p}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: "grid", gap: "0.25rem" }}>
          <span>SSO (sign-in provider)</span>
          <select
            value={config.ssoProvider}
            disabled={saving}
            onChange={(e) => update({ ssoProvider: e.target.value })}
          >
            {supportedSsoProviders.map((p) => (
              <option key={p} value={p}>
                {SSO_LABELS[p] ?? p}
              </option>
            ))}
          </select>
        </label>

        <div
          style={{
            display: "flex",
            gap: "0.5rem",
            alignItems: "center",
            marginTop: "0.25rem",
          }}
        >
          <button
            type="button"
            onClick={pingSis}
            disabled={config.sisProvider === "none"}
          >
            Test SIS connection
          </button>
          {pingResult && (
            <span style={{ fontSize: 12, color: "var(--text-subtle)" }}>
              {pingResult}
            </span>
          )}
        </div>

        {config.sisLastSyncAt && (
          <p style={{ fontSize: 12, color: "var(--text-subtle)" }}>
            Last sync: {new Date(config.sisLastSyncAt).toLocaleString()} (
            {config.sisLastSyncStatus ?? "unknown"})
          </p>
        )}
      </div>
    </div>
  );
}
