import { useEffect, useState } from "react";
import { authFetch } from "../lib/authToken";
import { HowToUseHelp, HowToSection, RoleSection } from "./HowToUseHelp";

interface Row {
  id: number;
  name: string;
  category: string;
  active: boolean;
  tier: string | null;
}

type TierVal = "" | "2" | "3";

export default function TrustedAdultInterventionsAdmin() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newCategory, setNewCategory] = useState("Trusted Adult");
  const [newTier, setNewTier] = useState<TierVal>("");

  const load = async () => {
    setLoading(true);
    try {
      const r = await authFetch("/api/trusted-adult-interventions");
      if (!r.ok) throw new Error(await r.text());
      setRows(await r.json());
    } catch (e: unknown) {
      setMsg(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const add = async () => {
    setMsg(null);
    if (!newName.trim()) {
      setMsg("Name is required");
      return;
    }
    try {
      const r = await authFetch("/api/trusted-adult-interventions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName.trim(),
          category: newCategory.trim() || "Trusted Adult",
          tier: newTier === "" ? null : newTier,
        }),
      });
      if (!r.ok) throw new Error(await r.text());
      setNewName("");
      setNewCategory("Trusted Adult");
      setNewTier("");
      await load();
    } catch (e: unknown) {
      setMsg(e instanceof Error ? e.message : "Failed to add");
    }
  };

  const toggleActive = async (id: number, active: boolean) => {
    try {
      const r = await authFetch(`/api/trusted-adult-interventions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active }),
      });
      if (!r.ok) throw new Error(await r.text());
      await load();
    } catch (e: unknown) {
      setMsg(e instanceof Error ? e.message : "Failed to update");
    }
  };

  const remove = async (id: number) => {
    try {
      const r = await authFetch(`/api/trusted-adult-interventions/${id}`, {
        method: "DELETE",
      });
      if (!r.ok) throw new Error(await r.text());
      await load();
    } catch (e: unknown) {
      setMsg(e instanceof Error ? e.message : "Failed to delete");
    }
  };

  return (
    <section className="card">
      <div className="section-header-bar-teal" />
      <div className="section-header-band-hub" />
      <h2>Trusted Adult Interventions</h2>
      <p style={{ marginTop: 0, color: "var(--muted, #666)" }}>
        Manage the list of interventions a trusted adult delivers when a student
        checks in or out. These appear in the Log Intervention Check-In/Out
        flow.
      </p>
      <HowToUseHelp title="How to manage Trusted Adult Interventions">
        <HowToSection title="What this list controls">
          The picklist a trusted adult sees when they log a check-in
          or check-out with their student. Examples: "Snack &amp;
          breathing reset", "Walk and talk", "Restorative apology".
        </HowToSection>
        <RoleSection for={["mtssCoordinator", "behaviorSpecialist", "admin"]} title="Tip">
          Keep the list short (≤ 8 items). Trusted-adult check-ins
          should feel quick — long picklists encourage staff to skip
          the log entirely.
        </RoleSection>
      </HowToUseHelp>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 7rem auto",
          gap: "0.5rem",
          alignItems: "end",
          marginBottom: "0.75rem",
          maxWidth: "52rem",
        }}
      >
        <label>
          <div style={{ fontSize: "0.85rem" }}>Name</div>
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="e.g. Restorative Chat"
            style={{ width: "100%" }}
          />
        </label>
        <label>
          <div style={{ fontSize: "0.85rem" }}>Category</div>
          <input
            type="text"
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
            placeholder="Trusted Adult"
            style={{ width: "100%" }}
          />
        </label>
        <label>
          <div style={{ fontSize: "0.85rem" }}>Tier</div>
          <select
            value={newTier}
            onChange={(e) => setNewTier(e.target.value as TierVal)}
            style={{ width: "100%" }}
          >
            <option value="">— Any —</option>
            <option value="2">Tier 2</option>
            <option value="3">Tier 3</option>
          </select>
        </label>
        <button type="button" onClick={add}>
          Add Intervention
        </button>
      </div>

      {msg && (
        <div style={{ color: "crimson", marginBottom: "0.5rem" }}>{msg}</div>
      )}

      {loading ? (
        <div style={{ color: "var(--muted, #666)" }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ color: "var(--muted, #666)" }}>
          No interventions yet.
        </div>
      ) : (
        <table className="pulse-table"
          style={{
            width: "100%",
            borderCollapse: "collapse",
            maxWidth: "48rem",
          }}
        >
          <thead>
            <tr style={{ borderBottom: "1px solid #ccc", textAlign: "left" }}>
              <th style={{ padding: "0.4rem" }}>Category</th>
              <th style={{ padding: "0.4rem" }}>Name</th>
              <th style={{ padding: "0.4rem" }}>Tier</th>
              <th style={{ padding: "0.4rem" }}>Active</th>
              <th style={{ padding: "0.4rem" }}></th>
            </tr>
          </thead>
          <tbody>
            {rows
              .slice()
              .sort((a, b) =>
                a.category === b.category
                  ? a.name.localeCompare(b.name)
                  : a.category.localeCompare(b.category),
              )
              .map((r) => (
                <tr key={r.id} style={{ borderBottom: "1px solid #eee" }}>
                  <td style={{ padding: "0.4rem" }}>{r.category}</td>
                  <td style={{ padding: "0.4rem" }}>{r.name}</td>
                  <td style={{ padding: "0.4rem" }}>
                    <select
                      value={r.tier ?? ""}
                      onChange={async (e) => {
                        const v = e.target.value;
                        try {
                          const res = await authFetch(
                            `/api/trusted-adult-interventions/${r.id}`,
                            {
                              method: "PATCH",
                              headers: {
                                "Content-Type": "application/json",
                              },
                              body: JSON.stringify({
                                tier: v === "" ? null : v,
                              }),
                            },
                          );
                          if (!res.ok) throw new Error(await res.text());
                          await load();
                        } catch (err) {
                          setMsg(
                            err instanceof Error
                              ? err.message
                              : "Failed to update tier",
                          );
                        }
                      }}
                    >
                      <option value="">— Any —</option>
                      <option value="2">Tier 2</option>
                      <option value="3">Tier 3</option>
                    </select>
                  </td>
                  <td style={{ padding: "0.4rem" }}>
                    {r.active ? "Yes" : "No"}
                  </td>
                  <td
                    style={{
                      padding: "0.4rem",
                      display: "flex",
                      gap: "0.4rem",
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => toggleActive(r.id, !r.active)}
                    >
                      {r.active ? "Deactivate" : "Activate"}
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(r.id)}
                      style={{
                        background: "#fee2e2",
                        color: "#991b1b",
                        border: "1px solid #fecaca",
                      }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
