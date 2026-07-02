// Staff feature pilots — school-admin panel rendered under the School
// Features grid. Lets an admin run a feature for a handful of staff
// while the school-wide switch stays OFF ("Pilot" mode). The district
// license (super_feature_*) always wins: the server only honors pilot
// rows when the super half is on, and family-facing features are not
// pilotable at all (they never appear in this panel).
//
// Server contract (routes/featureLicensing.ts):
//   GET /api/school-features/pilots            → { pilots: { [key]: {staffId, displayName}[] } }
//   PUT /api/school-features/pilots/:key       ← { staffIds: number[] } (full replace)
import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/authToken";
import { refreshFeatures } from "../lib/features";

type PilotMember = { staffId: number; displayName: string };
type StaffLite = { id: number; displayName: string; active?: boolean };

export type PilotableFeatureRow = {
  /** lib/featureLicensing.ts key, e.g. "dataChats" */
  key: string;
  label: string;
  /** Both super + admin toggles currently ON (pilot list is dormant). */
  schoolWideOn: boolean;
  /** District SuperUser half — when off, pilots are inert too. */
  superOn: boolean;
};

export default function FeaturePilotsPanel({
  features,
}: {
  features: ReadonlyArray<PilotableFeatureRow>;
}) {
  const [pilots, setPilots] = useState<Record<string, PilotMember[]>>({});
  const [staff, setStaff] = useState<StaffLite[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [pRes, sRes] = await Promise.all([
          authFetch("/api/school-features/pilots"),
          authFetch("/api/admin/staff"),
        ]);
        if (cancelled) return;
        if (!pRes.ok || !sRes.ok) {
          setLoadError("Couldn't load pilot data.");
          setLoaded(true);
          return;
        }
        const pJson = (await pRes.json()) as {
          pilots?: Record<string, PilotMember[]>;
        };
        const sJson = (await sRes.json()) as StaffLite[];
        if (cancelled) return;
        setPilots(pJson.pilots ?? {});
        setStaff(
          (Array.isArray(sJson) ? sJson : []).filter(
            (r) => r.active !== false,
          ),
        );
        setLoaded(true);
      } catch {
        if (!cancelled) {
          setLoadError("Couldn't load pilot data.");
          setLoaded(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filteredStaff = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return staff;
    return staff.filter((s) => s.displayName.toLowerCase().includes(q));
  }, [staff, search]);

  const openEditor = (key: string) => {
    setOpenKey(key);
    setSearch("");
    setSaveError(null);
    setDraft(new Set((pilots[key] ?? []).map((m) => m.staffId)));
  };

  const save = async (key: string) => {
    setSaving(true);
    setSaveError(null);
    try {
      const staffIds = [...draft];
      const res = await authFetch(`/api/school-features/pilots/${key}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ staffIds }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setSaveError(j?.error ?? "Save failed.");
        return;
      }
      const byId = new Map(staff.map((s) => [s.id, s.displayName]));
      setPilots((prev) => ({
        ...prev,
        [key]: staffIds.map((id) => ({
          staffId: id,
          displayName: byId.get(id) ?? `Staff #${id}`,
        })),
      }));
      setOpenKey(null);
      // The acting admin may themselves be in/out of a pilot — refresh
      // the licensing snapshot so nav gates react immediately.
      void refreshFeatures(true);
    } catch {
      setSaveError("Save failed.");
    } finally {
      setSaving(false);
    }
  };

  if (features.length === 0) return null;

  return (
    <div style={{ marginTop: "1.5rem" }}>
      <h3 style={{ marginBottom: 4 }}>Staff pilots</h3>
      <p style={{ color: "var(--text-subtle)", marginTop: 0, fontSize: 13 }}>
        Run a feature for a few staff before turning it on school-wide. A
        pilot only takes effect while the school-wide switch above is OFF
        (and the district allows the feature). Family-facing features
        can&rsquo;t be piloted.
      </p>
      {loadError && <p style={{ color: "#b91c1c" }}>{loadError}</p>}
      {!loaded && !loadError && (
        <p style={{ color: "var(--text-subtle)" }}>Loading…</p>
      )}
      {loaded && !loadError && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {features.map((f) => {
            const members = pilots[f.key] ?? [];
            const isOpen = openKey === f.key;
            const hint = !f.superOn
              ? "Disabled by your district — pilot has no effect."
              : f.schoolWideOn
                ? "School-wide ON — everyone already has it; the pilot list is ignored."
                : members.length > 0
                  ? `Pilot · ${members.length} staff`
                  : "Off · no pilot";
            return (
              <div
                key={f.key}
                style={{
                  border: "1px solid var(--border, #ddd)",
                  borderRadius: 8,
                  padding: "0.5rem 0.75rem",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    flexWrap: "wrap",
                  }}
                >
                  <div style={{ fontWeight: 500, flex: "1 1 auto" }}>
                    {f.label}
                    <span
                      style={{
                        marginLeft: 8,
                        fontSize: 12,
                        color:
                          f.superOn && !f.schoolWideOn && members.length > 0
                            ? "#b45309"
                            : "var(--text-subtle)",
                      }}
                    >
                      {hint}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => (isOpen ? setOpenKey(null) : openEditor(f.key))}
                  >
                    {isOpen ? "Close" : "Manage pilot"}
                  </button>
                </div>
                {members.length > 0 && !isOpen && (
                  <div
                    style={{
                      marginTop: 4,
                      fontSize: 12,
                      color: "var(--text-subtle)",
                    }}
                  >
                    {members.map((m) => m.displayName).join(", ")}
                  </div>
                )}
                {isOpen && (
                  <div style={{ marginTop: 8 }}>
                    <input
                      type="text"
                      placeholder="Search staff…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      style={{ width: "100%", maxWidth: 320 }}
                    />
                    <div
                      style={{
                        maxHeight: 220,
                        overflowY: "auto",
                        marginTop: 6,
                        border: "1px solid var(--border, #eee)",
                        borderRadius: 6,
                        padding: "0.25rem 0.5rem",
                      }}
                    >
                      {filteredStaff.map((s) => (
                        <label
                          key={s.id}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "2px 0",
                            fontSize: 13,
                            cursor: "pointer",
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={draft.has(s.id)}
                            onChange={(e) => {
                              setDraft((prev) => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(s.id);
                                else next.delete(s.id);
                                return next;
                              });
                            }}
                          />
                          {s.displayName}
                        </label>
                      ))}
                      {filteredStaff.length === 0 && (
                        <div
                          style={{
                            fontSize: 12,
                            color: "var(--text-subtle)",
                            padding: "4px 0",
                          }}
                        >
                          No matching staff.
                        </div>
                      )}
                    </div>
                    <div
                      style={{
                        marginTop: 8,
                        display: "flex",
                        gap: 8,
                        alignItems: "center",
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => void save(f.key)}
                        disabled={saving}
                      >
                        {saving ? "Saving…" : `Save pilot (${draft.size})`}
                      </button>
                      <button
                        type="button"
                        onClick={() => setOpenKey(null)}
                        disabled={saving}
                      >
                        Cancel
                      </button>
                      {saveError && (
                        <span style={{ color: "#b91c1c", fontSize: 13 }}>
                          {saveError}
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
