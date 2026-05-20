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

interface CatalogRow {
  code: string;
  category: string | null;
  label: string | null;
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

export default function TeacherInstructionLogTab({
  teacherId,
  isOwnRoster,
}: Props) {
  const [subject, setSubject] = useState<string>("ela");
  const [catalog, setCatalog] = useState<CatalogRow[]>([]);
  const [counts, setCounts] = useState<Record<string, CountEntry>>({});
  const [filterBenchmark, setFilterBenchmark] = useState<string>("");
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [ownerCanDelete, setOwnerCanDelete] = useState<boolean>(isOwnRoster);
  const [loading, setLoading] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);

  // Add-form state
  const [selectedCodes, setSelectedCodes] = useState<string[]>([]);
  const [deliveredOn, setDeliveredOn] = useState<string>(todayISO());
  const [notes, setNotes] = useState<string>("");
  const [saving, setSaving] = useState<boolean>(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState<string | null>(null);

  const teacherQuery =
    teacherId && !isOwnRoster ? `&teacherId=${teacherId}` : "";

  const loadAll = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const [catRes, cntRes, hisRes] = await Promise.all([
        authFetch(`/api/teacher-roster/benchmark-catalog?subject=${subject}`),
        authFetch(
          `/api/teacher-roster/benchmark-deliveries/counts?subject=${subject}${teacherQuery}`,
        ),
        authFetch(
          `/api/teacher-roster/benchmark-deliveries?subject=${subject}${
            filterBenchmark ? `&benchmark=${encodeURIComponent(filterBenchmark)}` : ""
          }${teacherQuery}`,
        ),
      ]);
      if (!catRes.ok) throw new Error(`catalog ${catRes.status}`);
      if (!cntRes.ok) throw new Error(`counts ${cntRes.status}`);
      if (!hisRes.ok) throw new Error(`history ${hisRes.status}`);
      const catJson = (await catRes.json()) as { benchmarks: CatalogRow[] };
      const cntJson = (await cntRes.json()) as {
        counts: Record<string, CountEntry>;
      };
      const hisJson = (await hisRes.json()) as {
        rows: HistoryRow[];
        ownerCanDelete: boolean;
      };
      setCatalog(catJson.benchmarks ?? []);
      setCounts(cntJson.counts ?? {});
      setHistory(hisJson.rows ?? []);
      setOwnerCanDelete(hisJson.ownerCanDelete);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [subject, filterBenchmark, teacherQuery]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // Group catalog by category for the picker.
  const grouped = useMemo(() => {
    const m = new Map<string, CatalogRow[]>();
    for (const r of catalog) {
      const k = r.category ?? "(uncategorized)";
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    }
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [catalog]);

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
              setFilterBenchmark("");
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
        <label style={{ fontSize: 13 }}>
          Filter history:&nbsp;
          <select
            value={filterBenchmark}
            onChange={(e) => setFilterBenchmark(e.target.value)}
          >
            <option value="">All benchmarks</option>
            {catalog.map((c) => (
              <option key={c.code} value={c.code}>
                {benchmarkLabel(c.code)}
              </option>
            ))}
          </select>
        </label>
        <button onClick={downloadCsv} style={{ padding: "4px 10px" }}>
          Export CSV
        </button>
        {loading && <span style={{ fontSize: 12, color: "#6b7280" }}>Loading…</span>}
        {err && <span style={{ fontSize: 12, color: "#b91c1c" }}>{err}</span>}
      </div>

      {/* Add form — owner only */}
      {isOwnRoster && (
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
          History ({history.length})
        </div>
        {history.length === 0 ? (
          <div style={{ fontSize: 12, color: "#6b7280" }}>
            No entries yet for this subject{filterBenchmark ? " / benchmark" : ""}.
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
                <th style={{ padding: "6px 8px", width: 80 }}></th>
              </tr>
            </thead>
            <tbody>
              {history.map((r) => (
                <tr key={r.id} style={{ borderTop: "1px solid #e5e7eb" }}>
                  <td style={{ padding: "6px 8px", fontFamily: "monospace" }}>
                    {r.benchmarkCode}
                  </td>
                  <td style={{ padding: "6px 8px" }}>{r.deliveredOn}</td>
                  <td style={{ padding: "6px 8px", color: "#374151" }}>
                    {r.notes ?? ""}
                  </td>
                  <td style={{ padding: "6px 8px", textAlign: "right" }}>
                    {ownerCanDelete && (
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
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
