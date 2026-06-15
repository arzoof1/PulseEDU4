// Instruction Log — 3rd Teacher Roster tab.
//
// Teachers pick a subject, then either log new instruction (multi-select
// benchmark codes + optional backdate + optional notes) or browse the
// history of what they've already logged (filterable by benchmark).
//
// Owner-only delete; Core Team viewing another teacher's log is
// read-only.
import { useCallback, useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/authToken";
import BenchmarkStar from "./BenchmarkStar";
import StandardsBookModal from "./StandardsBookModal";

interface CatalogRow {
  code: string;
  category: string | null;
  label: string | null;
  description?: string | null;
  source: string;
}

interface HistoryRow {
  id: number;
  benchmarkCode: string;
  deliveredOn: string;
  notes: string | null;
  createdAt: string;
}

interface CountEntry {
  count: number;
  lastTaughtOn: string;
}

interface Props {
  teacherId: number | null;
  isOwnRoster: boolean;
  // Core Team may log on a teacher's behalf (coaches, admin coverage,
  // substitutes). Defaults false so non-CT callers stay read-only.
  isCoreTeam?: boolean;
}

const SUBJECTS: Array<{ value: string; label: string }> = [
  { value: "ela", label: "ELA" },
  { value: "math", label: "Math" },
  { value: "writing", label: "Writing" },
  { value: "science", label: "Science" },
  { value: "social_studies", label: "Social Studies" },
];

function todayISO(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

// Pull the grade token out of a Florida benchmark code:
// "ELA.6.R.1.1" → "6", "MA.7.NSO.1.1" → "7", "ELA.K.R.1.1" → "K".
function gradeTokenOf(code: string): string | null {
  const parts = code.split(".");
  return parts.length >= 2 && parts[1] ? parts[1].toUpperCase() : null;
}

function gradeLabel(g: number | string): string {
  const s = String(g).toUpperCase();
  return s === "K" || s === "0" ? "K" : `G${s}`;
}

export default function TeacherInstructionLogTab({
  teacherId,
  isOwnRoster,
  isCoreTeam = false,
}: Props) {
  // Form is editable for the owning teacher OR a Core Team member viewing
  // someone else's roster (proxy logging).
  const canEdit = isOwnRoster || isCoreTeam;
  // Proxy logging is shown whenever a Core Team member is viewing a
  // teacher that isn't themselves. We compare against the signed-in
  // user via the isOwnRoster prop, but see the teacherQuery note for
  // why we can't rely on isOwnRoster for the actual save target.
  const proxyLogging = !isOwnRoster && isCoreTeam;
  const [subject, setSubject] = useState<string>("ela");
  const [catalog, setCatalog] = useState<CatalogRow[]>([]);
  const [counts, setCounts] = useState<Record<string, CountEntry>>({});
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [ownerCanDelete, setOwnerCanDelete] = useState<boolean>(isOwnRoster);
  const [standardsBookOpen, setStandardsBookOpen] = useState(false);
  // Inline-edit state for a history row. Only one row is edited at a
  // time. editId is the row's id (null = nothing being edited);
  // editDraft holds the working copy of the editable fields.
  const [editId, setEditId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<{
    benchmarkCode: string;
    deliveredOn: string;
    notes: string;
  }>({ benchmarkCode: "", deliveredOn: "", notes: "" });
  const [editSaving, setEditSaving] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);

  // Grade picker (multi-select). teacherGrades comes from the catalog
  // endpoint (derived from the teacher's actual rostered students);
  // selectedGrades is the user's narrowing on top of that. Starts EMPTY
  // intentionally — the user picks grades themselves. An empty set is
  // treated as "no narrowing" (show every benchmark the teacher has
  // access to), so the dropdown is never blank by default.
  const [teacherGrades, setTeacherGrades] = useState<number[]>([]);
  const [selectedGrades, setSelectedGrades] = useState<Set<string>>(new Set());

  // Add-form state
  const [selectedCodes, setSelectedCodes] = useState<string[]>([]);
  const [deliveredOn, setDeliveredOn] = useState<string>(todayISO());
  const [notes, setNotes] = useState<string>("");
  const [saving, setSaving] = useState<boolean>(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState<string | null>(null);

  // Always pass teacherId when we have one. Previously this was gated on
  // !isOwnRoster, but `isOwnRoster = teacherId === defaultTeacherId` and
  // defaultTeacherId is the *last-picked* teacher (persisted across
  // visits in App.tsx), so an admin re-opening the page with Donna
  // pre-selected got isOwnRoster=true and the param was dropped — the
  // server then defaulted to the admin's own id, so reads + writes
  // landed on the admin's record while the Benchmarks tab (which always
  // sends teacherId) correctly read Donna's. Result: badges disagreed
  // between the two sub-tabs. Server already enforces Core Team for any
  // cross-staff teacherId, so unconditionally sending it is safe.
  const teacherQuery = teacherId ? `&teacherId=${teacherId}` : "";

  const loadAll = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const [catRes, cntRes, hisRes] = await Promise.all([
        authFetch(
          // allGrades=1: server returns the full school catalog for the
          // subject (not just the teacher's roster grades) so the pill
          // row can offer every grade and the user can log against any
          // of them. We then narrow client-side via selectedGrades.
          `/api/teacher-roster/benchmark-catalog?subject=${subject}&allGrades=1${teacherQuery}`,
        ),
        // cache: "no-store" on counts + history so the badge and the
        // visible row list always reflect the latest deliveries after a
        // save or a tab switch. Express weak-ETag can otherwise replay a
        // stale body via 304 and the page looks frozen. Matches the same
        // treatment in TeacherBenchmarksTab.
        authFetch(
          `/api/teacher-roster/benchmark-deliveries/counts?subject=${subject}${teacherQuery}`,
          { cache: "no-store" },
        ),
        authFetch(
          `/api/teacher-roster/benchmark-deliveries?subject=${subject}${teacherQuery}`,
          { cache: "no-store" },
        ),
      ]);
      if (!catRes.ok) throw new Error(`catalog ${catRes.status}`);
      if (!cntRes.ok) throw new Error(`counts ${cntRes.status}`);
      if (!hisRes.ok) throw new Error(`history ${hisRes.status}`);
      const catJson = (await catRes.json()) as {
        benchmarks: CatalogRow[];
        grades?: number[];
      };
      const cntJson = (await cntRes.json()) as {
        counts: Record<string, CountEntry>;
      };
      const hisJson = (await hisRes.json()) as {
        rows: HistoryRow[];
        ownerCanDelete: boolean;
        canEdit?: boolean;
      };
      setCatalog(catJson.benchmarks ?? []);
      setCounts(cntJson.counts ?? {});
      setHistory(hisJson.rows ?? []);
      // Server returns `canEdit` (preferred) and `ownerCanDelete` as an
      // alias for back-compat. Older bundles won't break either way.
      setOwnerCanDelete(hisJson.canEdit ?? hisJson.ownerCanDelete);

      // Derive pill row from the grades actually present in the
      // (school-wide) catalog. This way a 6th-grade teacher's roster
      // doesn't hide G7 / G8 pills — the user can choose to log against
      // any grade in the school catalog. Selection stays opt-in; if the
      // available set shrinks (subject change), prune stale picks.
      const tokens = new Set<string>();
      for (const r of catJson.benchmarks ?? []) {
        const parts = r.code.split(".");
        if (parts.length >= 2 && parts[1]) tokens.add(parts[1].toUpperCase());
      }
      const sortable = (t: string) => (t === "K" ? -1 : Number(t));
      const gs = Array.from(tokens)
        .map((t) => (t === "K" ? 0 : Number(t)))
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => a - b);
      setTeacherGrades((prev) => {
        const same =
          prev.length === gs.length && prev.every((v, i) => v === gs[i]);
        if (!same) {
          setSelectedGrades(
            (cur) => new Set([...cur].filter((tok) => tokens.has(tok))),
          );
        }
        return same ? prev : gs;
      });
      void sortable; // kept for future K-grade ordering
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [subject, teacherQuery]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // Narrow the catalog (used by the Add picker AND the Filter-history
  // dropdown) to whichever grades the user currently has selected.
  // When the user has every grade checked, this is a no-op.
  const gradeFilteredCatalog = useMemo(() => {
    // No grades chosen → empty list. The picker shows a "pick a grade"
    // hint instead, so the user always logs against an explicit grade.
    if (selectedGrades.size === 0) return [];
    return catalog.filter((r) => {
      const tok = gradeTokenOf(r.code);
      return tok != null && selectedGrades.has(tok);
    });
  }, [catalog, selectedGrades]);

  // History rows respect the same grade filter so the user can scope a
  // pivot down to e.g. only G7 standards without resetting other state.
  const gradeFilteredHistory = useMemo(() => {
    if (selectedGrades.size === 0) return history;
    return history.filter((r) => {
      const tok = gradeTokenOf(r.benchmarkCode);
      return tok != null && selectedGrades.has(tok);
    });
  }, [history, selectedGrades]);

  // Group catalog by category for the picker.
  const grouped = useMemo(() => {
    const m = new Map<string, CatalogRow[]>();
    for (const r of gradeFilteredCatalog) {
      const k = r.category ?? "(uncategorized)";
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    }
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [gradeFilteredCatalog]);

  const toggleGrade = (tok: string) => {
    setSelectedGrades((prev) => {
      const next = new Set(prev);
      if (next.has(tok)) next.delete(tok);
      else next.add(tok);
      return next;
    });
  };

  const toggleCode = (code: string) => {
    setSelectedCodes((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code],
    );
  };

  const submit = async () => {
    if (selectedCodes.length === 0) {
      setSaveErr("Pick at least one benchmark");
      return;
    }
    setSaving(true);
    setSaveErr(null);
    setSaveOk(null);
    try {
      const res = await authFetch(
        "/api/teacher-roster/benchmark-deliveries",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            subject,
            benchmarkCodes: selectedCodes,
            deliveredOn,
            notes: notes.trim() || undefined,
            // Always target the displayed teacher when we have an id —
            // same reasoning as teacherQuery above (isOwnRoster can be
            // a false positive after the admin re-opens the page with
            // a previously-picked teacher). Server enforces Core Team
            // for any cross-staff write.
            teacherId: teacherId ?? undefined,
          }),
        },
      );
      const j = (await res.json()) as { created?: number; error?: string };
      if (!res.ok) throw new Error(j.error ?? `Save failed (${res.status})`);
      setSaveOk(
        `Logged ${j.created} benchmark${(j.created ?? 0) === 1 ? "" : "s"}.`,
      );
      setSelectedCodes([]);
      setNotes("");
      await loadAll();
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: number) => {
    if (!confirm("Delete this instruction log entry?")) return;
    const res = await authFetch(
      `/api/teacher-roster/benchmark-deliveries/${id}`,
      { method: "DELETE" },
    );
    if (!res.ok) {
      alert("Delete failed");
      return;
    }
    await loadAll();
  };

  const startEdit = (row: HistoryRow) => {
    setEditId(row.id);
    setEditDraft({
      benchmarkCode: row.benchmarkCode,
      deliveredOn: row.deliveredOn,
      notes: row.notes ?? "",
    });
  };

  const cancelEdit = () => {
    setEditId(null);
  };

  const saveEdit = async () => {
    if (editId == null) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(editDraft.deliveredOn)) {
      alert("Delivered date must be a valid date.");
      return;
    }
    if (!editDraft.benchmarkCode.trim()) {
      alert("Benchmark code is required.");
      return;
    }
    setEditSaving(true);
    try {
      const res = await authFetch(
        `/api/teacher-roster/benchmark-deliveries/${editId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            benchmarkCode: editDraft.benchmarkCode.trim(),
            deliveredOn: editDraft.deliveredOn,
            notes: editDraft.notes.trim() || null,
          }),
        },
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        alert(j.error ?? "Edit failed");
        return;
      }
      setEditId(null);
      await loadAll();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Edit failed");
    } finally {
      setEditSaving(false);
    }
  };

  const downloadCsv = () => {
    const url = `/api/teacher-roster/benchmark-deliveries/export.csv?subject=${subject}${teacherQuery}`;
    window.open(url, "_blank", "noopener");
  };

  const benchmarkLabel = (code: string): string => {
    const row = catalog.find((c) => c.code === code);
    return row?.label ? `${code} — ${row.label}` : code;
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ fontSize: 13 }}>
          Subject:&nbsp;
          <select
            value={subject}
            onChange={(e) => {
              setSubject(e.target.value);
              setSelectedCodes([]);
            }}
          >
            {SUBJECTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        {teacherGrades.length > 0 && (
          <div
            style={{
              display: "flex",
              gap: 6,
              alignItems: "center",
              fontSize: 13,
            }}
          >
            <span>Grades:</span>
            {teacherGrades.map((g) => {
              const t = String(g) === "0" ? "K" : String(g).toUpperCase();
              const checked = selectedGrades.has(t);
              return (
                <button
                  key={g}
                  type="button"
                  onClick={() => toggleGrade(t)}
                  aria-pressed={checked}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    padding: "3px 10px",
                    borderRadius: 999,
                    border: "1px solid",
                    borderColor: checked ? "#a78bfa" : "#cbd5e1",
                    background: checked ? "#ddd6fe" : "white",
                    color: checked ? "#4c1d95" : "#475569",
                    cursor: "pointer",
                    fontWeight: checked ? 600 : 400,
                    fontSize: 12,
                    userSelect: "none",
                  }}
                >
                  {gradeLabel(g)}
                </button>
              );
            })}
          </div>
        )}
        <button onClick={downloadCsv} style={{ padding: "4px 10px" }}>
          Export CSV
        </button>
        {subject === "ela" && (
          <button
            onClick={() => setStandardsBookOpen(true)}
            style={{
              padding: "4px 10px",
              background: "#1e3a8a",
              color: "white",
              border: "1px solid #1e3a8a",
              borderRadius: 6,
              cursor: "pointer",
              fontWeight: 600,
            }}
          >
            ELA BEST Standards
          </button>
        )}
        {loading && <span style={{ fontSize: 12, color: "#6b7280" }}>Loading…</span>}
        {err && <span style={{ fontSize: 12, color: "#b91c1c" }}>{err}</span>}
      </div>
      <StandardsBookModal
        open={standardsBookOpen}
        onClose={() => setStandardsBookOpen(false)}
      />

      {/* Add form — owner only */}
      {canEdit && (
        <div
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 8,
            padding: 12,
            background: "#fafafa",
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
            Log instruction
            {proxyLogging && (
              <span
                style={{
                  marginLeft: 8,
                  fontSize: 11,
                  fontWeight: 500,
                  color: "#92400e",
                  background: "#fef3c7",
                  border: "1px solid #fde68a",
                  borderRadius: 3,
                  padding: "1px 6px",
                }}
              >
                Logging on behalf of this teacher (Core Team)
              </span>
            )}
          </div>
          {catalog.length === 0 ? (
            <div style={{ fontSize: 12, color: "#6b7280" }}>
              No standards catalog for {subject.toUpperCase()} yet. ELA / Math
              auto-populate from FAST imports; Writing / Science / Social
              Studies need an admin to import a standards CSV.
            </div>
          ) : (
            <>
              <div
                style={{
                  maxHeight: 220,
                  overflowY: "auto",
                  border: "1px solid #e5e7eb",
                  borderRadius: 4,
                  padding: 8,
                  background: "white",
                  marginBottom: 8,
                }}
              >
                {grouped.length === 0 && (
                  <div
                    style={{
                      fontSize: 12,
                      color: "#6b7280",
                      padding: "8px 4px",
                    }}
                  >
                    Pick a grade above to see benchmarks.
                  </div>
                )}
                {grouped.map(([cat, codes]) => (
                  <div key={cat} style={{ marginBottom: 8 }}>
                    <div
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        color: "#1e3a8a",
                        background: "#dbeafe",
                        padding: "2px 6px",
                        borderRadius: 3,
                        marginBottom: 4,
                      }}
                    >
                      {cat}
                    </div>
                    {codes.map((c) => {
                      const checked = selectedCodes.includes(c.code);
                      return (
                        <label
                          key={c.code}
                          title={
                            c.description
                              ? `${c.code}${c.label ? ` — ${c.label}` : ""}\n\n${c.description}`
                              : undefined
                          }
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            fontSize: 12,
                            padding: "2px 4px",
                            cursor: "pointer",
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleCode(c.code)}
                          />
                          <BenchmarkStar
                            count={counts[c.code]?.count ?? 0}
                            lastTaughtOn={counts[c.code]?.lastTaughtOn ?? null}
                            size={18}
                          />
                          <span style={{ fontFamily: "monospace" }}>
                            {c.code}
                          </span>
                          {c.label && (
                            <span style={{ color: "#6b7280" }}>— {c.label}</span>
                          )}
                        </label>
                      );
                    })}
                  </div>
                ))}
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 12,
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                <label style={{ fontSize: 12 }}>
                  Delivered on:&nbsp;
                  <input
                    type="date"
                    value={deliveredOn}
                    max={todayISO()}
                    onChange={(e) => setDeliveredOn(e.target.value)}
                  />
                </label>
                <label style={{ fontSize: 12, flex: 1, minWidth: 200 }}>
                  Notes (optional):&nbsp;
                  <input
                    type="text"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value.slice(0, 280))}
                    placeholder="e.g. warm-up + guided practice"
                    style={{ width: "100%", padding: "2px 6px" }}
                  />
                </label>
                <button
                  onClick={submit}
                  disabled={saving || selectedCodes.length === 0}
                  style={{
                    padding: "4px 12px",
                    background:
                      selectedCodes.length === 0 ? "#e5e7eb" : "#1e3a8a",
                    color:
                      selectedCodes.length === 0 ? "#9ca3af" : "white",
                    border: "none",
                    borderRadius: 4,
                    fontWeight: 600,
                    cursor:
                      selectedCodes.length === 0 ? "not-allowed" : "pointer",
                  }}
                >
                  {saving
                    ? "Saving…"
                    : `Log ${selectedCodes.length || ""} benchmark${selectedCodes.length === 1 ? "" : "s"}`}
                </button>
              </div>
              {saveErr && (
                <div style={{ color: "#b91c1c", fontSize: 12, marginTop: 6 }}>
                  {saveErr}
                </div>
              )}
              {saveOk && (
                <div style={{ color: "#047857", fontSize: 12, marginTop: 6 }}>
                  {saveOk}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* History */}
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
          History ({gradeFilteredHistory.length})
        </div>
        {gradeFilteredHistory.length === 0 ? (
          <div style={{ fontSize: 12, color: "#6b7280" }}>
            No entries yet for this subject
            {selectedGrades.size > 0 &&
              selectedGrades.size < teacherGrades.length
              ? " in the selected grade(s)"
              : ""}
            .
          </div>
        ) : (
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 12,
            }}
          >
            <thead>
              <tr style={{ background: "#f3f4f6", textAlign: "left" }}>
                <th style={{ padding: "6px 8px" }}>Benchmark</th>
                <th style={{ padding: "6px 8px", width: 110 }}>Delivered</th>
                <th style={{ padding: "6px 8px" }}>Notes</th>
                <th style={{ padding: "6px 8px", width: 130 }}></th>
              </tr>
            </thead>
            <tbody>
              {gradeFilteredHistory.map((r) => {
                const isEditing = editId === r.id;
                if (isEditing) {
                  return (
                    <tr
                      key={r.id}
                      style={{
                        borderTop: "1px solid #e5e7eb",
                        background: "#fffbeb",
                      }}
                    >
                      <td style={{ padding: "6px 8px" }}>
                        <input
                          type="text"
                          value={editDraft.benchmarkCode}
                          onChange={(e) =>
                            setEditDraft((d) => ({
                              ...d,
                              benchmarkCode: e.target.value,
                            }))
                          }
                          style={{
                            width: "100%",
                            fontFamily: "monospace",
                            fontSize: 12,
                            padding: "3px 6px",
                            border: "1px solid #d1d5db",
                            borderRadius: 3,
                          }}
                        />
                      </td>
                      <td style={{ padding: "6px 8px" }}>
                        <input
                          type="date"
                          value={editDraft.deliveredOn}
                          onChange={(e) =>
                            setEditDraft((d) => ({
                              ...d,
                              deliveredOn: e.target.value,
                            }))
                          }
                          style={{
                            fontSize: 12,
                            padding: "3px 6px",
                            border: "1px solid #d1d5db",
                            borderRadius: 3,
                          }}
                        />
                      </td>
                      <td style={{ padding: "6px 8px" }}>
                        <input
                          type="text"
                          value={editDraft.notes}
                          onChange={(e) =>
                            setEditDraft((d) => ({
                              ...d,
                              notes: e.target.value,
                            }))
                          }
                          placeholder="Notes (optional)"
                          style={{
                            width: "100%",
                            fontSize: 12,
                            padding: "3px 6px",
                            border: "1px solid #d1d5db",
                            borderRadius: 3,
                          }}
                        />
                      </td>
                      <td
                        style={{
                          padding: "6px 8px",
                          textAlign: "right",
                          whiteSpace: "nowrap",
                        }}
                      >
                        <button
                          onClick={saveEdit}
                          disabled={editSaving}
                          style={{
                            padding: "2px 8px",
                            fontSize: 11,
                            color: "white",
                            border: "1px solid #047857",
                            background: "#059669",
                            borderRadius: 3,
                            cursor: editSaving ? "wait" : "pointer",
                            marginRight: 4,
                          }}
                        >
                          {editSaving ? "Saving…" : "Save"}
                        </button>
                        <button
                          onClick={cancelEdit}
                          disabled={editSaving}
                          style={{
                            padding: "2px 8px",
                            fontSize: 11,
                            color: "#374151",
                            border: "1px solid #d1d5db",
                            background: "white",
                            borderRadius: 3,
                            cursor: editSaving ? "wait" : "pointer",
                          }}
                        >
                          Cancel
                        </button>
                      </td>
                    </tr>
                  );
                }
                return (
                  <tr key={r.id} style={{ borderTop: "1px solid #e5e7eb" }}>
                    <td style={{ padding: "6px 8px", fontFamily: "monospace" }}>
                      {r.benchmarkCode}
                    </td>
                    <td style={{ padding: "6px 8px" }}>{r.deliveredOn}</td>
                    <td style={{ padding: "6px 8px", color: "#374151" }}>
                      {r.notes ?? ""}
                    </td>
                    <td
                      style={{
                        padding: "6px 8px",
                        textAlign: "right",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {ownerCanDelete && (
                        <>
                          <button
                            onClick={() => startEdit(r)}
                            style={{
                              padding: "2px 8px",
                              fontSize: 11,
                              color: "#1d4ed8",
                              border: "1px solid #93c5fd",
                              background: "white",
                              borderRadius: 3,
                              cursor: "pointer",
                              marginRight: 4,
                            }}
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => remove(r.id)}
                            style={{
                              padding: "2px 8px",
                              fontSize: 11,
                              color: "#b91c1c",
                              border: "1px solid #fca5a5",
                              background: "white",
                              borderRadius: 3,
                              cursor: "pointer",
                            }}
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
