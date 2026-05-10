// Settings → MTSS: admin for Tier 3 intervention strategy categories +
// items. Core Team only. Fed into the Tier 3 weekly form's
// "Interventions Used This Week" checklist.
import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/authToken";
import { HowToUseHelp, HowToSection, RoleSection } from "./HowToUseHelp";

interface Cat {
  id: number;
  name: string;
  sortOrder: number;
  active: boolean;
}
interface Strat {
  id: number;
  categoryId: number;
  name: string;
  sortOrder: number;
  active: boolean;
}

export default function Tier3StrategiesAdmin() {
  const [cats, setCats] = useState<Cat[]>([]);
  const [strats, setStrats] = useState<Strat[]>([]);
  const [newCat, setNewCat] = useState("");
  const [newStratByCat, setNewStratByCat] = useState<Record<number, string>>(
    {},
  );
  const [msg, setMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [c, s] = await Promise.all([
        authFetch("/api/tier3-strategy-categories"),
        authFetch("/api/tier3-strategies"),
      ]);
      if (c.ok) setCats(await c.json());
      if (s.ok) setStrats(await s.json());
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const stratsByCat = useMemo(() => {
    const m = new Map<number, Strat[]>();
    for (const s of strats) {
      const arr = m.get(s.categoryId) ?? [];
      arr.push(s);
      m.set(s.categoryId, arr);
    }
    return m;
  }, [strats]);

  async function addCat() {
    if (!newCat.trim()) return;
    setMsg(null);
    try {
      const r = await authFetch("/api/tier3-strategy-categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newCat.trim() }),
      });
      if (!r.ok) throw new Error(await r.text());
      setNewCat("");
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Add failed");
    }
  }

  async function patchCat(id: number, patch: Partial<Cat>) {
    setMsg(null);
    try {
      const r = await authFetch(`/api/tier3-strategy-categories/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error(await r.text());
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Save failed");
    }
  }

  async function deleteCat(id: number) {
    if (!confirm("Delete category and all its strategies?")) return;
    try {
      const r = await authFetch(`/api/tier3-strategy-categories/${id}`, {
        method: "DELETE",
      });
      if (!r.ok) throw new Error(await r.text());
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Delete failed");
    }
  }

  async function addStrat(catId: number) {
    const name = (newStratByCat[catId] ?? "").trim();
    if (!name) return;
    try {
      const r = await authFetch("/api/tier3-strategies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categoryId: catId, name }),
      });
      if (!r.ok) throw new Error(await r.text());
      setNewStratByCat({ ...newStratByCat, [catId]: "" });
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Add failed");
    }
  }

  async function patchStrat(id: number, patch: Partial<Strat>) {
    try {
      const r = await authFetch(`/api/tier3-strategies/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error(await r.text());
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Save failed");
    }
  }

  async function deleteStrat(id: number) {
    if (!confirm("Delete this strategy?")) return;
    try {
      const r = await authFetch(`/api/tier3-strategies/${id}`, {
        method: "DELETE",
      });
      if (!r.ok) throw new Error(await r.text());
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Delete failed");
    }
  }

  return (
    <section style={{ display: "grid", gap: "1rem", maxWidth: 760 }}>
      <h3 style={{ margin: 0 }}>Intervention Strategies (Tier 3)</h3>
      <p style={{ margin: 0, fontSize: "0.85rem", color: "#475569" }}>
        These categories and strategies appear on the Tier 3 weekly form's
        "Interventions Used This Week" checklist. Inactive items are hidden
        from teachers but kept in historical records.
      </p>
      <HowToUseHelp title="How to manage Tier 3 Strategies">
        <HowToSection title="What this list controls">
          The checkbox list teachers see when documenting weekly Tier 3
          plan progress. Categories are the section headers; strategies
          are the individual checkboxes inside each.
        </HowToSection>
        <RoleSection for={["mtssCoordinator", "admin", "coreTeam"]} title="Editing tips">
          Keep labels short — they have to fit on a single line in the
          weekly form. Deactivating an item removes it from new forms
          but historical entries keep the original label.
        </RoleSection>
      </HowToUseHelp>

      {msg && (
        <div
          style={{
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#b91c1c",
            padding: "0.4rem 0.6rem",
            borderRadius: 6,
            fontSize: "0.85rem",
          }}
        >
          {msg}
        </div>
      )}

      <div style={{ display: "flex", gap: "0.5rem" }}>
        <input
          value={newCat}
          onChange={(e) => setNewCat(e.target.value)}
          placeholder="New category name…"
          style={{
            padding: "0.4rem 0.6rem",
            borderRadius: 6,
            border: "1px solid #cbd5e1",
            flex: 1,
          }}
        />
        <button type="button" onClick={addCat} disabled={loading}>
          Add category
        </button>
      </div>

      {cats
        .slice()
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
        .map((c) => (
          <div
            key={c.id}
            style={{
              border: "1px solid #e2e8f0",
              borderRadius: 8,
              padding: "0.6rem 0.75rem",
              opacity: c.active ? 1 : 0.6,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                marginBottom: "0.5rem",
              }}
            >
              <input
                value={c.name}
                onChange={(e) =>
                  setCats(
                    cats.map((x) =>
                      x.id === c.id ? { ...x, name: e.target.value } : x,
                    ),
                  )
                }
                onBlur={() => patchCat(c.id, { name: c.name })}
                style={{
                  fontWeight: 600,
                  fontSize: "1rem",
                  border: "1px solid transparent",
                  padding: "0.2rem 0.4rem",
                }}
              />
              <label style={{ fontSize: "0.8rem" }}>
                <input
                  type="checkbox"
                  checked={c.active}
                  onChange={(e) => patchCat(c.id, { active: e.target.checked })}
                />{" "}
                active
              </label>
              <button
                type="button"
                onClick={() => deleteCat(c.id)}
                style={{
                  marginLeft: "auto",
                  color: "#b91c1c",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                }}
              >
                Delete
              </button>
            </div>

            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {(stratsByCat.get(c.id) ?? [])
                .slice()
                .sort(
                  (a, b) =>
                    a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
                )
                .map((s) => (
                  <li
                    key={s.id}
                    style={{
                      display: "flex",
                      gap: "0.5rem",
                      alignItems: "center",
                      padding: "0.25rem 0",
                      opacity: s.active ? 1 : 0.55,
                    }}
                  >
                    <input
                      value={s.name}
                      onChange={(e) =>
                        setStrats(
                          strats.map((x) =>
                            x.id === s.id
                              ? { ...x, name: e.target.value }
                              : x,
                          ),
                        )
                      }
                      onBlur={() => patchStrat(s.id, { name: s.name })}
                      style={{
                        flex: 1,
                        border: "1px solid transparent",
                        padding: "0.2rem 0.4rem",
                      }}
                    />
                    <label style={{ fontSize: "0.8rem" }}>
                      <input
                        type="checkbox"
                        checked={s.active}
                        onChange={(e) =>
                          patchStrat(s.id, { active: e.target.checked })
                        }
                      />{" "}
                      active
                    </label>
                    <button
                      type="button"
                      onClick={() => deleteStrat(s.id)}
                      style={{
                        color: "#b91c1c",
                        background: "transparent",
                        border: "none",
                        cursor: "pointer",
                        fontSize: "0.8rem",
                      }}
                    >
                      ✕
                    </button>
                  </li>
                ))}
            </ul>

            <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.4rem" }}>
              <input
                value={newStratByCat[c.id] ?? ""}
                onChange={(e) =>
                  setNewStratByCat({
                    ...newStratByCat,
                    [c.id]: e.target.value,
                  })
                }
                placeholder="New strategy…"
                style={{
                  flex: 1,
                  padding: "0.3rem 0.5rem",
                  borderRadius: 4,
                  border: "1px solid #cbd5e1",
                  fontSize: "0.9rem",
                }}
              />
              <button
                type="button"
                onClick={() => addStrat(c.id)}
                style={{ fontSize: "0.85rem" }}
              >
                Add
              </button>
            </div>
          </div>
        ))}
    </section>
  );
}
