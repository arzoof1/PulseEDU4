// "My Interventions" — every Tier 2, Tier 3, legacy Trusted-Adult, and
// Quick Check-in entry the signed-in teacher has logged. Date presets
// (All / Today / 7d / 15d / 30d / Custom), student picker, tier filter,
// summary counts, and print with optional date-range narrowing.
//
// Backed by GET /api/interventions/my-history. The server already
// applies the staff filter (the teacher's own staff_id), date range,
// student id, and tier; this page just renders the result and adds
// presentation-only sorting/print.

import { useEffect, useMemo, useRef, useState } from "react";
import { authFetch } from "../lib/authToken";
import { HowToUseHelp, HowToSection, RoleSection, howtoListStyle } from "./HowToUseHelp";

export type InterventionHistoryRow = {
  source: "tier2" | "tier3" | "legacy" | "checkInOut";
  sourceId: number;
  studentId: string;
  staffId: number | null;
  staffName: string | null;
  occurredAt: string;
  date: string;
  tier: "t2" | "t3" | "legacy" | "quick";
  typeLabel: string;
  detail: string | null;
};

type ApiResponse = {
  staffId: number;
  staffName: string;
  counts: { t2: number; t3: number; legacy: number; quick: number };
  rows: InterventionHistoryRow[];
};

type StudentLite = { studentId: string; firstName: string; lastName: string };

type Preset = "all" | "today" | "7d" | "15d" | "30d" | "custom";

const PRESETS: Array<{ key: Preset; label: string }> = [
  { key: "all", label: "All" },
  { key: "today", label: "Today" },
  { key: "7d", label: "7 days" },
  { key: "15d", label: "15 days" },
  { key: "30d", label: "30 days" },
  { key: "custom", label: "Custom…" },
];

const TIER_OPTIONS = [
  { key: "all", label: "All tiers" },
  { key: "t2", label: "Tier 2" },
  { key: "t3", label: "Tier 3" },
  { key: "quick", label: "Quick Check-in" },
  { key: "legacy", label: "Trusted Adult (legacy)" },
] as const;

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function daysAgoIso(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function presetRange(preset: Preset): { from?: string; to?: string } {
  switch (preset) {
    case "all":
    case "custom":
      return {};
    case "today":
      return { from: todayIso(), to: todayIso() };
    case "7d":
      return { from: daysAgoIso(6), to: todayIso() };
    case "15d":
      return { from: daysAgoIso(14), to: todayIso() };
    case "30d":
      return { from: daysAgoIso(29), to: todayIso() };
  }
}

function tierBadgeStyle(tier: InterventionHistoryRow["tier"]): {
  background: string;
  color: string;
  border: string;
} {
  switch (tier) {
    case "t2":
      return {
        background: "#fef3c7",
        color: "#92400e",
        border: "1px solid #fde68a",
      };
    case "t3":
      return {
        background: "#ede9fe",
        color: "#5b21b6",
        border: "1px solid #c4b5fd",
      };
    case "quick":
      return {
        background: "#dbeafe",
        color: "#1e40af",
        border: "1px solid #93c5fd",
      };
    case "legacy":
      return {
        background: "#f1f5f9",
        color: "#475569",
        border: "1px solid #cbd5e1",
      };
  }
}

export default function MyInterventionsPage({
  onBack,
}: {
  onBack?: () => void;
}) {
  const [preset, setPreset] = useState<Preset>("30d");
  const [customFrom, setCustomFrom] = useState<string>(daysAgoIso(29));
  const [customTo, setCustomTo] = useState<string>(todayIso());
  const [studentQuery, setStudentQuery] = useState<string>("");
  const [studentId, setStudentId] = useState<string>("");
  const [tier, setTier] = useState<string>("all");
  const [students, setStudents] = useState<StudentLite[]>([]);
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showPrintPicker, setShowPrintPicker] = useState(false);
  const [printFrom, setPrintFrom] = useState<string>("");
  const [printTo, setPrintTo] = useState<string>("");
  const tableRef = useRef<HTMLDivElement>(null);

  // School roster for the student picker. Loaded once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await authFetch("/api/students");
        if (!r.ok) return;
        const arr = (await r.json()) as Array<
          StudentLite & { firstName: string; lastName: string }
        >;
        if (!cancelled) setStudents(arr);
      } catch {
        // Non-fatal — picker just won't autocomplete.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const range = useMemo(() => {
    if (preset === "custom") {
      return { from: customFrom || undefined, to: customTo || undefined };
    }
    return presetRange(preset);
  }, [preset, customFrom, customTo]);

  // Resolve the typed studentQuery to a studentId if it matches one in
  // the roster. Empty input → no filter.
  useEffect(() => {
    const q = studentQuery.trim();
    if (!q) {
      setStudentId("");
      return;
    }
    // If the input matches a student exactly (by id or "Last, First"
    // / "First Last"), pin to that id.
    const match = students.find((s) => {
      const last = `${s.lastName}, ${s.firstName}`.toLowerCase();
      const first = `${s.firstName} ${s.lastName}`.toLowerCase();
      return (
        s.studentId.toLowerCase() === q.toLowerCase() ||
        last === q.toLowerCase() ||
        first === q.toLowerCase()
      );
    });
    setStudentId(match ? match.studentId : "");
  }, [studentQuery, students]);

  // Fetch on filter changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    const params = new URLSearchParams();
    if (range.from) params.set("from", range.from);
    if (range.to) params.set("to", range.to);
    if (studentId) params.set("studentId", studentId);
    if (tier && tier !== "all") params.set("tier", tier);
    (async () => {
      try {
        const r = await authFetch(
          `/api/interventions/my-history?${params.toString()}`,
        );
        const body = await r.json();
        if (cancelled) return;
        if (!r.ok) {
          setErr(body?.error || "Failed to load");
          setData(null);
        } else {
          setData(body);
        }
      } catch (e) {
        if (!cancelled) {
          setErr(String((e as Error)?.message || e));
          setData(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [range.from, range.to, studentId, tier]);

  const studentNameLookup = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of students) m.set(s.studentId, `${s.lastName}, ${s.firstName}`);
    return m;
  }, [students]);

  const rows = data?.rows ?? [];
  const counts = data?.counts ?? { t2: 0, t3: 0, legacy: 0, quick: 0 };

  // "Long enough to need a print range picker" heuristic: ~25 rows fits
  // on one page in our default print stylesheet. Above that, offer the
  // narrowing picker so a teacher doesn't print 10 pages by accident.
  const longEnoughForPrintPicker = rows.length > 25;

  const filterSummary = useMemo(() => {
    const parts: string[] = [];
    parts.push(
      preset === "all"
        ? "All dates"
        : preset === "custom"
          ? `Custom ${customFrom || "(any)"} → ${customTo || "(any)"}`
          : PRESETS.find((p) => p.key === preset)?.label || preset,
    );
    if (studentId) {
      const name = studentNameLookup.get(studentId) || studentId;
      parts.push(`Student: ${name}`);
    } else {
      parts.push("All students");
    }
    if (tier !== "all")
      parts.push(`Tier: ${TIER_OPTIONS.find((t) => t.key === tier)?.label}`);
    return parts.join(" · ");
  }, [preset, customFrom, customTo, studentId, tier, studentNameLookup]);

  function doPrint(rangeFrom?: string, rangeTo?: string) {
    setShowPrintPicker(false);
    // Stash a print mode marker on the document so our print CSS hides
    // the page chrome and shows only the printable region.
    const root = document.documentElement;
    root.classList.add("intervention-print-active");
    // Optionally restrict printed rows by the picker range (purely
    // visual — we don't re-fetch).
    const filteredRows =
      rangeFrom || rangeTo
        ? rows.filter((r) => {
            const d = r.occurredAt.slice(0, 10);
            if (rangeFrom && d < rangeFrom) return false;
            if (rangeTo && d > rangeTo) return false;
            return true;
          })
        : rows;
    // Render a temporary print-only block at the bottom of the page
    // and let window.print() pick it up. We restore on afterprint.
    const block = document.createElement("div");
    block.id = "intervention-print-block";
    block.innerHTML = renderPrintHtml({
      staffName: data?.staffName || "Me",
      filterSummary:
        filterSummary +
        (rangeFrom || rangeTo
          ? ` · Print range ${rangeFrom || "(any)"} → ${rangeTo || "(any)"}`
          : ""),
      generatedAt: new Date().toLocaleString(),
      rows: filteredRows,
      studentNameLookup,
    });
    document.body.appendChild(block);
    const cleanup = () => {
      root.classList.remove("intervention-print-active");
      block.remove();
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);
    // Slight delay so the DOM paints the print block before the dialog.
    window.setTimeout(() => window.print(), 50);
  }

  return (
    <div>
      <PrintStyles />
      {onBack && (
        <button
          type="button"
          className="back-button-purple"
          onClick={onBack}
          style={{ marginBottom: "0.75rem" }}
        >
          ← Back
        </button>
      )}
      <HowToUseHelp title="How to use My Interventions">
        <HowToSection title="What this page is">
          Every intervention you've personally logged — Tier 2 weekly
          check-ins, Tier 3 day-of-week scoring, legacy Trusted-Adult
          touches, and Quick Check-ins — in one filterable list. The
          server only returns rows where you are the listed staff
          member, so your view never includes someone else's work.
        </HowToSection>
        <HowToSection title="Filtering and printing">
          <ul style={howtoListStyle}>
            <li>Use the date presets (Today / 7d / 15d / 30d / Custom) to narrow the window.</li>
            <li>Type a student name or ID to pin to one kid.</li>
            <li>Tier filter limits to T2, T3, or legacy entries.</li>
            <li>Print produces a parent/admin-friendly PDF with the visible rows only.</li>
          </ul>
        </HowToSection>
        <RoleSection for="teacher" title="Why this matters for teachers">
          When admin or Core Team asks "what have you tried with this
          student?", this page is the answer. Filter to the kid, set the
          window to "this year," print, hand it over.
        </RoleSection>
        <RoleSection for={["admin", "coreTeam"]} title="If you're checking on a teacher">
          You're seeing your own log here, not theirs. To see someone
          else's interventions, open MTSS Reports and filter by staff
          member, or open the student profile and read the unified
          intervention history.
        </RoleSection>
      </HowToUseHelp>

      <section className="card">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "1rem",
            flexWrap: "wrap",
          }}
        >
          <h2 style={{ margin: 0, color: "#7c3aed" }}>My Interventions</h2>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              type="button"
              onClick={() => {
                if (longEnoughForPrintPicker) {
                  setPrintFrom(range.from || "");
                  setPrintTo(range.to || "");
                  setShowPrintPicker(true);
                } else {
                  doPrint();
                }
              }}
              style={{
                padding: "0.4rem 0.9rem",
                background: "#7c3aed",
                color: "white",
                border: "none",
                borderRadius: 6,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              🖨 Print…
            </button>
          </div>
        </div>
        <p style={{ color: "var(--text-subtle, #64748b)", marginTop: "0.25rem" }}>
          Every Tier 2, Tier 3, Trusted-Adult, and Quick Check-in entry you've
          logged. Filter by date, student, or tier; print the visible list or
          narrow it further on the way to the printer.
        </p>

        {/* Filters row */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: "0.75rem",
            marginTop: "0.75rem",
          }}
        >
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: "0.78rem", color: "#64748b" }}>Date</span>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {PRESETS.map((p) => {
                const active = preset === p.key;
                return (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => setPreset(p.key)}
                    style={{
                      padding: "0.3rem 0.6rem",
                      borderRadius: 999,
                      border: active
                        ? "1px solid #7c3aed"
                        : "1px solid #cbd5e1",
                      background: active ? "#ede9fe" : "white",
                      color: active ? "#5b21b6" : "#475569",
                      fontWeight: active ? 700 : 500,
                      cursor: "pointer",
                      fontSize: "0.8rem",
                    }}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
            {preset === "custom" && (
              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <input
                  type="date"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                />
                <span style={{ alignSelf: "center" }}>→</span>
                <input
                  type="date"
                  value={customTo}
                  onChange={(e) => setCustomTo(e.target.value)}
                />
              </div>
            )}
          </label>

          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: "0.78rem", color: "#64748b" }}>
              Student
            </span>
            <input
              type="text"
              list="my-interventions-student-list"
              placeholder="All students (type a name to filter)"
              value={studentQuery}
              onChange={(e) => setStudentQuery(e.target.value)}
            />
            <datalist id="my-interventions-student-list">
              {students.slice(0, 500).map((s) => (
                <option
                  key={s.studentId}
                  value={`${s.lastName}, ${s.firstName}`}
                />
              ))}
            </datalist>
            {studentQuery && !studentId && (
              <span style={{ fontSize: "0.72rem", color: "#b45309" }}>
                No exact match — showing all students.
              </span>
            )}
          </label>

          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: "0.78rem", color: "#64748b" }}>Tier</span>
            <select value={tier} onChange={(e) => setTier(e.target.value)}>
              {TIER_OPTIONS.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* Summary counts */}
        <div
          style={{
            marginTop: "0.75rem",
            display: "flex",
            gap: "0.75rem",
            flexWrap: "wrap",
            fontSize: "0.85rem",
            color: "#475569",
          }}
        >
          <strong>{rows.length}</strong>
          <span>showing</span>
          <span>·</span>
          <span>{counts.t2} Tier 2</span>
          <span>·</span>
          <span>{counts.t3} Tier 3</span>
          <span>·</span>
          <span>{counts.quick} Quick Check-in</span>
          <span>·</span>
          <span>{counts.legacy} Trusted Adult</span>
        </div>

        {err && (
          <div
            style={{
              marginTop: "0.75rem",
              padding: "0.5rem 0.75rem",
              background: "#fef2f2",
              border: "1px solid #fecaca",
              color: "#b91c1c",
              borderRadius: 6,
            }}
          >
            {err}
          </div>
        )}

        {/* Results table */}
        <div ref={tableRef} style={{ marginTop: "0.75rem" }}>
          {loading ? (
            <div style={{ color: "#64748b" }}>Loading…</div>
          ) : rows.length === 0 ? (
            <p style={{ color: "var(--text-subtle, #64748b)" }}>
              No interventions match these filters.
            </p>
          ) : (
            <table className="pulse-table"
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "0.9rem",
              }}
            >
              <thead>
                <tr
                  style={{
                    textAlign: "left",
                    borderBottom: "2px solid #cbd5e1",
                    background: "#f8fafc",
                  }}
                >
                  <Th>Date</Th>
                  <Th>Student</Th>
                  <Th>Type</Th>
                  <Th>Detail</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const studentLabel =
                    studentNameLookup.get(r.studentId) || "—";
                  const badge = tierBadgeStyle(r.tier);
                  return (
                    <tr
                      key={`${r.source}-${r.sourceId}`}
                      style={{ borderBottom: "1px solid #f1f5f9" }}
                    >
                      <Td style={{ whiteSpace: "nowrap" }}>{r.date}</Td>
                      <Td>{studentLabel}</Td>
                      <Td>
                        <span
                          style={{
                            padding: "2px 8px",
                            borderRadius: 999,
                            fontWeight: 600,
                            fontSize: "0.75rem",
                            ...badge,
                          }}
                        >
                          {r.typeLabel}
                        </span>
                      </Td>
                      <Td
                        style={{
                          color: r.detail ? "#0f172a" : "#cbd5e1",
                          whiteSpace: "pre-wrap",
                        }}
                      >
                        {r.detail || "—"}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {/* Print range picker (only shown when result is "long") */}
      {showPrintPicker && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15,23,42,0.55)",
            zIndex: 60,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          onClick={() => setShowPrintPicker(false)}
        >
          <div
            style={{
              background: "white",
              borderRadius: 10,
              padding: "1rem 1.25rem",
              minWidth: 320,
              maxWidth: "90vw",
              boxShadow: "0 12px 40px rgba(0,0,0,0.25)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginTop: 0 }}>Print range</h3>
            <p style={{ fontSize: "0.85rem", color: "#475569" }}>
              The current list has {rows.length} entries — that's likely
              several pages. Print everything, or narrow the printout to a
              date range first.
            </p>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 8,
                marginTop: "0.5rem",
              }}
            >
              <label style={{ display: "grid", gap: 4 }}>
                <span style={{ fontSize: "0.78rem", color: "#64748b" }}>
                  From
                </span>
                <input
                  type="date"
                  value={printFrom}
                  onChange={(e) => setPrintFrom(e.target.value)}
                />
              </label>
              <label style={{ display: "grid", gap: 4 }}>
                <span style={{ fontSize: "0.78rem", color: "#64748b" }}>
                  To
                </span>
                <input
                  type="date"
                  value={printTo}
                  onChange={(e) => setPrintTo(e.target.value)}
                />
              </label>
            </div>
            <div
              style={{
                display: "flex",
                gap: 8,
                marginTop: "1rem",
                justifyContent: "flex-end",
              }}
            >
              <button
                type="button"
                onClick={() => setShowPrintPicker(false)}
                style={{
                  padding: "0.4rem 0.9rem",
                  borderRadius: 6,
                  border: "1px solid #cbd5e1",
                  background: "white",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => doPrint()}
                style={{
                  padding: "0.4rem 0.9rem",
                  borderRadius: 6,
                  border: "1px solid #cbd5e1",
                  background: "white",
                  cursor: "pointer",
                }}
              >
                Print all {rows.length}
              </button>
              <button
                type="button"
                onClick={() => doPrint(printFrom || undefined, printTo || undefined)}
                style={{
                  padding: "0.4rem 0.9rem",
                  borderRadius: 6,
                  background: "#7c3aed",
                  color: "white",
                  border: "none",
                  cursor: "pointer",
                  fontWeight: 600,
                }}
              >
                Print this range
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      style={{
        padding: "0.5rem 0.5rem",
        fontSize: "0.78rem",
        color: "#64748b",
        textTransform: "uppercase",
        letterSpacing: 0.5,
      }}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <td style={{ padding: "0.5rem 0.5rem", ...style }}>{children}</td>
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderPrintHtml(opts: {
  staffName: string;
  filterSummary: string;
  generatedAt: string;
  rows: InterventionHistoryRow[];
  studentNameLookup: Map<string, string>;
}) {
  const rowsHtml = opts.rows
    .map((r) => {
      const student = escapeHtml(
        opts.studentNameLookup.get(r.studentId) || "—",
      );
      const detail = escapeHtml(r.detail || "—");
      return `<tr>
        <td>${escapeHtml(r.date)}</td>
        <td>${student}</td>
        <td>${escapeHtml(r.typeLabel)}</td>
        <td>${detail}</td>
      </tr>`;
    })
    .join("");
  return `
    <div class="print-doc">
      <h1>My Interventions — ${escapeHtml(opts.staffName)}</h1>
      <div class="print-meta">${escapeHtml(opts.filterSummary)}</div>
      <div class="print-meta">Generated ${escapeHtml(opts.generatedAt)}</div>
      <table class="print-table">
        <thead>
          <tr>
            <th>Date</th><th>Student</th><th>Type</th><th>Detail</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `;
}

function PrintStyles() {
  return (
    <style>{`
      @media print {
        body * { visibility: hidden !important; }
        #intervention-print-block, #intervention-print-block * {
          visibility: visible !important;
        }
        #intervention-print-block {
          position: absolute; left: 0; top: 0; width: 100%;
          padding: 0.5in;
        }
      }
      #intervention-print-block { display: none; }
      @media print {
        #intervention-print-block { display: block; }
        .print-doc h1 { font-size: 18pt; margin: 0 0 0.5rem; }
        .print-meta { font-size: 9pt; color: #475569; margin-bottom: 0.25rem; }
        .print-table { width: 100%; border-collapse: collapse; font-size: 10pt; margin-top: 0.5rem; }
        .print-table th, .print-table td {
          border: 1px solid #cbd5e1; padding: 4pt 6pt; text-align: left; vertical-align: top;
        }
        .print-table thead { background: #f1f5f9; }
        .print-table tr { page-break-inside: avoid; }
      }
    `}</style>
  );
}
