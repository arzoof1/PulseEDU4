import { useState } from "react";
import { authFetch } from "../lib/authToken";

// One-click starter pack for a school's configurable pick lists.
// Admin-only tile. POST /api/pick-lists/load-starter inserts the curated
// default catalog (PBIS reasons, intervention strategies, pullout reasons,
// case closure outcomes, separation tags, communication types, Tier 3
// strategies) for the current school, skipping anything that already
// exists — safe to click more than once.

const LIST_LABELS: Record<string, string> = {
  pbisReasons: "PBIS reasons (positive + behavior quick-log)",
  interventionTypes: "Intervention strategies",
  pulloutReasons: "Pullout reasons",
  caseOutcomes: "Case closure outcomes",
  separationTags: "Separation reason tags",
  communicationTypes: "Communication types",
  tier3Categories: "Tier 3 strategy categories",
  tier3Strategies: "Tier 3 strategies",
};

export default function StarterListsPanel() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    added: Record<string, number>;
    skipped: Record<string, number>;
  } | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await authFetch("/api/pick-lists/load-starter", {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || `Request failed (${res.status})`);
      }
      const body = (await res.json()) as {
        added: Record<string, number>;
        skipped: Record<string, number>;
      };
      setResult(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const totalAdded = result
    ? Object.values(result.added).reduce((a, b) => a + b, 0)
    : 0;

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <h2 style={{ marginTop: 0 }}>Starter Pick Lists</h2>
      <p style={{ maxWidth: 640 }}>
        Load a proven starter set into every configurable pick list for this
        school: PBIS positive reasons, classroom behavior quick-log reasons,
        intervention strategies, pullout reasons, case closure outcomes,
        separation reason tags, communication types, and Tier&nbsp;3
        strategies.
      </p>
      <p style={{ maxWidth: 640, color: "var(--muted, #64748b)", fontSize: "0.9rem" }}>
        Safe to run any time: nothing is changed or deleted — entries the
        school already has are left alone, and only missing ones are added.
        Everything loaded here can be renamed, deactivated, or deleted from
        the normal list editors afterward.
      </p>
      <button className="btn" onClick={() => void run()} disabled={busy}>
        {busy ? "Loading starter lists…" : "Load starter lists"}
      </button>
      {error && (
        <p style={{ color: "#b91c1c", marginTop: "0.75rem" }}>{error}</p>
      )}
      {result && (
        <div style={{ marginTop: "1rem" }}>
          <p style={{ fontWeight: 600 }}>
            {totalAdded > 0
              ? `Done — ${totalAdded} new entr${totalAdded === 1 ? "y" : "ies"} added.`
              : "Done — every starter entry was already present. Nothing changed."}
          </p>
          <table style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: "0.25rem 0.75rem 0.25rem 0" }}>List</th>
                <th style={{ textAlign: "right", padding: "0.25rem 0.75rem" }}>Added</th>
                <th style={{ textAlign: "right", padding: "0.25rem 0" }}>Already there</th>
              </tr>
            </thead>
            <tbody>
              {Object.keys(LIST_LABELS).map((key) => (
                <tr key={key}>
                  <td style={{ padding: "0.2rem 0.75rem 0.2rem 0" }}>{LIST_LABELS[key]}</td>
                  <td style={{ textAlign: "right", padding: "0.2rem 0.75rem" }}>
                    {result.added[key] ?? 0}
                  </td>
                  <td style={{ textAlign: "right", padding: "0.2rem 0" }}>
                    {result.skipped[key] ?? 0}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
