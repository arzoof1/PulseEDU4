// Class Composer — Phase A scheduler-facing suggestion report.
// Admin / Core Team only. Read-only on top of FAST item responses.

import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/authToken";
import { HowToUseHelp, HowToSection, howtoListStyle } from "./HowToUseHelp";

interface WindowOpt {
  schoolYear: string;
  window: string;
  label: string;
}
interface LevelMix {
  l1: number;
  l2: number;
  l3: number;
  l4: number;
  l5: number;
  unknown: number;
}
interface Profile {
  studentId: string;
  localSisId: string | null;
  firstName: string | null;
  lastName: string | null;
  grade: number | null;
  categories: Array<{
    category: string;
    pct: number;
    responseCount: number;
    benchmarkCodes: string[];
  }>;
  topGaps: string[];
  overallPct: number | null;
  fastLevel: 1 | 2 | 3 | 4 | 5 | null;
}
interface Group {
  index: number;
  dominantCategory: string | null;
  students: Profile[];
  avgDominantPct: number | null;
  cohesionPct: number;
  levelMix: LevelMix;
}
type Mode = "intensive" | "regular";
type Arrangement = "homogeneous" | "balanced";
interface SuggestResponse {
  subject: string;
  grade: number;
  schoolYear: string;
  window: string;
  available: WindowOpt[];
  mode: Mode;
  arrangement: Arrangement | null;
  eligibilityMaxPct: number;
  requested: { sections: number; seats: number };
  candidatePool: {
    totalAtGrade: number;
    eligible: number;
    unscored: number;
    levelMix: LevelMix;
  };
  groups: Group[];
  overflow: Array<{
    studentId: string;
    localSisId: string | null;
    firstName: string | null;
    lastName: string | null;
    grade: number | null;
    overallPct: number | null;
    fastLevel: 1 | 2 | 3 | 4 | 5 | null;
    topGaps: string[];
  }>;
  unscored: Array<{
    studentId: string;
    localSisId: string | null;
    firstName: string | null;
    lastName: string | null;
    grade: number | null;
  }>;
}

const LEVEL_PALETTE: Record<1 | 2 | 3 | 4 | 5, string> = {
  1: "#fee2e2", // red — L1
  2: "#ffedd5", // orange — L2
  3: "#dcfce7", // green — L3
  4: "#dbeafe", // blue — L4
  5: "#ede9fe", // purple — L5
};
const LEVEL_TEXT: Record<1 | 2 | 3 | 4 | 5, string> = {
  1: "#991b1b",
  2: "#9a3412",
  3: "#166534",
  4: "#1e40af",
  5: "#5b21b6",
};

function LevelMixChips({ mix }: { mix: LevelMix }) {
  const items: Array<[label: string, count: number, bg: string, color: string]> = [];
  ([1, 2, 3, 4, 5] as const).forEach((lvl) => {
    const key = `l${lvl}` as keyof LevelMix;
    const n = mix[key];
    if (n > 0) items.push([`L${lvl}`, n, LEVEL_PALETTE[lvl], LEVEL_TEXT[lvl]]);
  });
  if (mix.unknown > 0) items.push(["No PM", mix.unknown, "#f3f4f6", "#6b7280"]);
  if (items.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
      {items.map(([label, n, bg, color]) => (
        <span
          key={label}
          style={{
            fontSize: 11,
            padding: "1px 6px",
            borderRadius: 10,
            background: bg,
            color,
            fontWeight: 600,
          }}
        >
          {label} × {n}
        </span>
      ))}
    </div>
  );
}

const SUBJECT_OPTIONS = [
  { value: "ela", label: "ELA" },
  { value: "math", label: "Math" },
  { value: "algebra1", label: "Algebra 1" },
  { value: "geometry", label: "Geometry" },
];

const fullName = (
  s: { firstName: string | null; lastName: string | null },
): string =>
  [s.lastName, s.firstName].filter(Boolean).join(", ") || "—";

function csvEscape(v: string | number | null | undefined): string {
  const s = v == null ? "" : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadCsv(filename: string, rows: string[][]): void {
  const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function IntensiveGroupComposerPage({
  onBack,
}: {
  onBack: () => void;
}) {
  const [mode, setMode] = useState<Mode>("intensive");
  const [arrangement, setArrangement] = useState<Arrangement>("homogeneous");
  const [subject, setSubject] = useState("ela");
  const [grade, setGrade] = useState(6);
  const [sections, setSections] = useState(4);
  const [seats, setSeats] = useState(22);
  const [eligibilityMaxPct, setEligibilityMaxPct] = useState(70);

  useEffect(() => {
    setEligibilityMaxPct(mode === "intensive" ? 70 : 100);
  }, [mode]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [windowOpts, setWindowOpts] = useState<WindowOpt[]>([]);
  const [selectedWindow, setSelectedWindow] = useState<string>("");
  const [result, setResult] = useState<SuggestResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load available windows when subject changes.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    authFetch(`/api/intensive-groups/windows?subject=${subject}`)
      .then((r) => {
        if (!r.ok) throw new Error("Failed to load windows");
        return r.json();
      })
      .then((d: { available: WindowOpt[] }) => {
        if (cancelled) return;
        setWindowOpts(d.available);
        if (d.available.length > 0) {
          setSelectedWindow(`${d.available[0].schoolYear}|${d.available[0].window}`);
        } else {
          setSelectedWindow("");
        }
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [subject]);

  const generate = async () => {
    setError(null);
    setLoading(true);
    setResult(null);
    try {
      const params = new URLSearchParams({
        mode,
        subject,
        grade: String(grade),
        sections: String(sections),
        seats: String(seats),
      });
      if (mode === "regular") {
        params.set("arrangement", arrangement);
      }
      // Only send the % cap when the user has touched the advanced
      // section — otherwise let the server pick the mode default
      // (70 intensive / 100 regular).
      if (showAdvanced) {
        params.set("eligibilityMaxPct", String(eligibilityMaxPct));
      }
      if (selectedWindow) {
        const [sy, w] = selectedWindow.split("|");
        params.set("schoolYear", sy);
        params.set("window", w);
      }
      const r = await authFetch(`/api/intensive-groups/suggest?${params.toString()}`);
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      const data = (await r.json()) as SuggestResponse;
      setResult(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const exportCsv = () => {
    if (!result) return;
    const rows: string[][] = [
      [
        "Group",
        "Dominant Skill",
        "Cohesion %",
        "Avg Skill %",
        "Student",
        "Student ID",
        "Grade",
        "FAST Level",
        "Overall %",
        "Top Gap 1",
        "Top Gap 2",
        "Top Gap 3",
      ],
    ];
    for (const g of result.groups) {
      for (const s of g.students) {
        rows.push([
          `Group ${g.index}`,
          g.dominantCategory ?? "Mixed",
          String(g.cohesionPct),
          g.avgDominantPct == null ? "" : String(g.avgDominantPct),
          fullName(s),
          s.localSisId ?? "",
          s.grade == null ? "" : String(s.grade),
          s.fastLevel == null ? "" : `L${s.fastLevel}`,
          s.overallPct == null ? "" : String(s.overallPct),
          s.topGaps[0] ?? "",
          s.topGaps[1] ?? "",
          s.topGaps[2] ?? "",
        ]);
      }
    }
    for (const u of result.unscored) {
      rows.push([
        "Unscored",
        "",
        "",
        "",
        fullName(u),
        u.localSisId ?? "",
        u.grade == null ? "" : String(u.grade),
        "",
        "",
        "",
        "",
        "",
      ]);
    }
    downloadCsv(
      `class-composer-${subject}-g${grade}-${result.schoolYear}-${result.window}.csv`,
      rows,
    );
  };

  const printReport = () => {
    window.print();
  };

  const headerSummary = useMemo(() => {
    if (!result) return null;
    const modeLabel =
      result.mode === "intensive"
        ? "Intensive (Levels 1–2)"
        : result.arrangement === "balanced"
          ? "Regular · Balanced (Levels 1–5)"
          : "Regular · Homogeneous (Levels 1–5)";
    return (
      <div style={{ color: "#374151", fontSize: 13, marginTop: 6 }}>
        <strong>{modeLabel}</strong> · Subject{" "}
        <strong>{result.subject.toUpperCase()}</strong> · Grade{" "}
        <strong>{result.grade}</strong> · Window{" "}
        <strong>
          {result.schoolYear} {result.window.toUpperCase()}
        </strong>
        {result.eligibilityMaxPct < 100 && (
          <>
            {" "}
            · Mastery cap ≤ <strong>{result.eligibilityMaxPct}%</strong>
          </>
        )}
      </div>
    );
  }, [result]);

  return (
    <div style={{ padding: 16, maxWidth: 1100 }}>
      <style>{`
        @media print {
          .composer-no-print { display: none !important; }
          .composer-group-card { break-inside: avoid; }
        }
      `}</style>

      <div className="composer-no-print" style={{ marginBottom: 12 }}>
        <button
          onClick={onBack}
          style={{
            padding: "6px 12px",
            border: "1px solid #d1d5db",
            background: "white",
            borderRadius: 6,
            cursor: "pointer",
          }}
        >
          ← Back to Insights
        </button>
      </div>

      <h1 style={{ fontSize: 24, margin: "0 0 4px 0" }}>Class Composer</h1>
      <p style={{ color: "#6b7280", marginTop: 0 }}>
        Suggest intensive-group sections from the latest FAST results. Read-only —
        Skyward / RosterOne stays the source of truth.
      </p>

      <div className="composer-no-print">
        <HowToUseHelp title="How to use Class Composer">
          <HowToSection title="What this page is">
            A scheduler-facing suggestion tool that groups students
            into sections using their most recent FAST scores. It is
            <strong> read-only</strong> — nothing is written to Skyward,
            RosterOne, your master schedule, or your rosters. The output
            is a printable / exportable proposal you take back to the
            scheduler.
          </HowToSection>

          <HowToSection title="Class type — Intensive vs Regular">
            <ul style={howtoListStyle}>
              <li>
                <strong>Intensive</strong> (default) — pool restricted to
                students at FAST <strong>Level 1 or 2</strong> in the chosen
                subject. Use this when you're staffing Intensive Reading
                / Intensive Math / Reading Lab / Math 180 sections.
              </li>
              <li>
                <strong>Regular</strong> — pool opens to <strong>all levels
                1–5</strong>. Use this when you're proposing a master-schedule
                split of an entire grade into N regular ELA / Math sections.
              </li>
              <li>
                FAST level comes from the PM scale score for the chosen
                window, placed on the official Florida cut-score chart.
                Students with no PM score appear in <em>Unscored</em>.
              </li>
            </ul>
          </HowToSection>

          <HowToSection title="Arrangement (Regular only)">
            <ul style={howtoListStyle}>
              <li>
                <strong>Homogeneous (skill-focused)</strong> — same
                algorithm as Intensive: each section is concentrated
                around one weak-skill area. Best when teachers want to
                attack a specific gap in each class.
              </li>
              <li>
                <strong>Balanced (mixed levels + skills)</strong> —
                round-robin distribution so each section ends up with a
                similar level mix (some L1s, some L3s, some L5s) and a
                similar skill mix. Best for typical "fair distribution"
                master scheduling.
              </li>
            </ul>
          </HowToSection>

          <HowToSection title="What the controls mean">
            <ul style={howtoListStyle}>
              <li>
                <strong>Subject</strong> — which FAST assessment to read
                (ELA, Math, Algebra 1, Geometry).
              </li>
              <li>
                <strong>Grade</strong> — only students currently enrolled
                in this grade at your school are considered.
              </li>
              <li>
                <strong>Window</strong> — which FAST progress-monitoring
                snapshot to use. Each window (PM1 / PM2 / PM3) is a
                two-week testing snapshot, not a date range — Florida's
                official term. The dropdown defaults to the most recent
                window your school has uploaded and lists earlier
                windows below it so you can compare. PM3 is typically
                the most actionable because it's the latest read on
                where each kid is right now.
              </li>
              <li>
                <strong># Sections</strong> — how many sections you
                intend to staff. Composer will split the eligible pool
                across that many groups.
              </li>
              <li>
                <strong>Seats / section</strong> — target class size.
                The tool will warn (via overflow list) when the
                eligible pool exceeds <em>sections × seats</em>.
              </li>
              <li>
                <strong>Advanced → Overall mastery cap</strong> — an
                optional second filter on top of FAST level. Defaults
                to 70% in Intensive (the traditional "struggling"
                floor) and 100% in Regular (no cap). Open the
                Advanced expander to change it.
              </li>
            </ul>
          </HowToSection>

          <HowToSection title="How to use it day-to-day">
            <ul style={howtoListStyle}>
              <li>
                Pick subject + grade, confirm the window shows the
                latest PM, set sections/seats to what you can actually
                staff, then click <strong>Build groups</strong>.
              </li>
              <li>
                Each group card shows its dominant skill focus, average
                mastery on that focus, a cohesion % (how alike the
                students in the group are), and the roster.
              </li>
              <li>
                <strong>Overflow</strong> lists eligible kids who
                didn't fit in <em>sections × seats</em> — use it to
                decide whether to add a section or raise seat count.
                <strong> Unscored</strong> lists eligible-by-grade
                students who don't have FAST results for the chosen
                window yet (e.g. transfers, absent for testing) —
                the scheduler still has to place them by hand.
              </li>
              <li>
                Use <strong>Print</strong> for a meeting handout or
                <strong> Export CSV</strong> to drop into Skyward
                import templates.
              </li>
            </ul>
          </HowToSection>

          <HowToSection title="Re-running after new data">
            Build groups reads live from FAST item responses every
            time you click it — nothing is cached. If a makeup score
            (or any new data) gets uploaded after you've already
            built groups, just click <strong>Build groups</strong>
            again and the suggestions will include the new score.
            Switching window / subject / grade also forces a fresh
            read.
          </HowToSection>

          <HowToSection title="Important caveats">
            <ul style={howtoListStyle}>
              <li>
                These are <strong>suggestions, not assignments</strong>.
                Nothing is written back to your rosters or master
                schedule — you'll still recreate the sections in
                Skyward / RosterOne.
              </li>
              <li>
                The tool can only group what it can see — students
                without a FAST score for the chosen window won't be
                placed (they'll appear in <em>Unscored</em>).
              </li>
              <li>
                Group cohesion drops when the eligible pool is small
                or skill-diverse. Treat low-cohesion groups as a
                signal to widen the eligibility cap or merge two
                sections into one mixed-focus section.
              </li>
            </ul>
          </HowToSection>
        </HowToUseHelp>
      </div>

      <section
        className="composer-no-print"
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 8,
          padding: 14,
          marginBottom: 14,
          background: "#f9fafb",
        }}
      >
        {/* Class type + arrangement toggles — primary decisions, shown
            above the rest so they frame everything else. */}
        <div style={{ marginBottom: 10 }}>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 16,
              fontSize: 13,
            }}
          >
            <div>
              <span style={{ fontWeight: 600, marginRight: 8 }}>Class type</span>
              <label style={{ marginRight: 12 }}>
                <input
                  type="radio"
                  name="composer-mode"
                  checked={mode === "intensive"}
                  onChange={() => setMode("intensive")}
                />{" "}
                Intensive (Levels 1–2)
              </label>
              <label>
                <input
                  type="radio"
                  name="composer-mode"
                  checked={mode === "regular"}
                  onChange={() => setMode("regular")}
                />{" "}
                Regular (Levels 1–5)
              </label>
            </div>
            {mode === "regular" && (
              <div>
                <span style={{ fontWeight: 600, marginRight: 8 }}>Arrangement</span>
                <label style={{ marginRight: 12 }}>
                  <input
                    type="radio"
                    name="composer-arrangement"
                    checked={arrangement === "homogeneous"}
                    onChange={() => setArrangement("homogeneous")}
                  />{" "}
                  Homogeneous (skill-focused)
                </label>
                <label>
                  <input
                    type="radio"
                    name="composer-arrangement"
                    checked={arrangement === "balanced"}
                    onChange={() => setArrangement("balanced")}
                  />{" "}
                  Balanced (mixed levels + skills)
                </label>
              </div>
            )}
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
            gap: 10,
          }}
        >
          <label style={{ display: "flex", flexDirection: "column", fontSize: 13 }}>
            Subject
            <select
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              style={{ padding: 6, marginTop: 4 }}
            >
              {SUBJECT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: "flex", flexDirection: "column", fontSize: 13 }}>
            Grade
            <select
              value={grade}
              onChange={(e) => setGrade(Number(e.target.value))}
              style={{ padding: 6, marginTop: 4 }}
            >
              {[5, 6, 7, 8, 9, 10, 11, 12].map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: "flex", flexDirection: "column", fontSize: 13 }}>
            Window
            <select
              value={selectedWindow}
              onChange={(e) => setSelectedWindow(e.target.value)}
              style={{ padding: 6, marginTop: 4 }}
              disabled={windowOpts.length === 0}
            >
              {windowOpts.length === 0 && <option value="">— No data —</option>}
              {windowOpts.map((w) => (
                <option key={`${w.schoolYear}|${w.window}`} value={`${w.schoolYear}|${w.window}`}>
                  {w.label}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: "flex", flexDirection: "column", fontSize: 13 }}>
            # Sections
            <input
              type="number"
              min={1}
              max={20}
              value={sections}
              onChange={(e) => setSections(Number(e.target.value))}
              style={{ padding: 6, marginTop: 4 }}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", fontSize: 13 }}>
            Seats / section
            <input
              type="number"
              min={2}
              max={35}
              value={seats}
              onChange={(e) => setSeats(Number(e.target.value))}
              style={{ padding: 6, marginTop: 4 }}
            />
          </label>
        </div>
        <div style={{ marginTop: 8, fontSize: 12 }}>
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            style={{
              background: "transparent",
              border: "none",
              color: "#2563eb",
              cursor: "pointer",
              padding: 0,
              fontSize: 12,
            }}
          >
            {showAdvanced ? "▾ Hide advanced" : "▸ Advanced (overall mastery cap)"}
          </button>
          {showAdvanced && (
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginTop: 6,
                color: "#374151",
              }}
            >
              Overall mastery ≤
              <input
                type="number"
                min={0}
                max={100}
                value={eligibilityMaxPct}
                onChange={(e) => setEligibilityMaxPct(Number(e.target.value))}
                style={{ padding: 4, width: 70 }}
              />
              %
              <span style={{ color: "#6b7280" }}>
                (defaults: 70% intensive, 100% regular)
              </span>
            </label>
          )}
        </div>
        <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
          <button
            onClick={generate}
            disabled={loading || !selectedWindow}
            style={{
              padding: "8px 16px",
              border: "1px solid #2563eb",
              background: "#2563eb",
              color: "white",
              borderRadius: 6,
              cursor: loading ? "wait" : "pointer",
              fontWeight: 600,
            }}
          >
            {loading ? "Building…" : "Build groups"}
          </button>
          {result && (
            <>
              <button
                onClick={printReport}
                style={{
                  padding: "8px 14px",
                  border: "1px solid #d1d5db",
                  background: "white",
                  borderRadius: 6,
                  cursor: "pointer",
                }}
              >
                Print
              </button>
              <button
                onClick={exportCsv}
                style={{
                  padding: "8px 14px",
                  border: "1px solid #d1d5db",
                  background: "white",
                  borderRadius: 6,
                  cursor: "pointer",
                }}
              >
                Export CSV
              </button>
            </>
          )}
        </div>
        {error && (
          <div style={{ color: "#b91c1c", marginTop: 10, fontSize: 13 }}>{error}</div>
        )}
      </section>

      {result && (
        <>
          <div style={{ marginBottom: 14 }}>
            <h2 style={{ fontSize: 18, marginBottom: 4 }}>Proposed groupings</h2>
            {headerSummary}
            <div style={{ fontSize: 13, color: "#374151", marginTop: 4 }}>
              Candidate pool: {result.candidatePool.totalAtGrade} students in grade{" "}
              {result.grade} · {result.candidatePool.eligible} eligible ·{" "}
              {result.candidatePool.unscored} without data
            </div>
            <LevelMixChips mix={result.candidatePool.levelMix} />
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
              gap: 12,
            }}
          >
            {result.groups.map((g) => (
              <div
                key={g.index}
                className="composer-group-card"
                style={{
                  border: "1px solid #e5e7eb",
                  borderRadius: 8,
                  padding: 12,
                  background: "white",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <h3 style={{ margin: 0, fontSize: 16 }}>Group {g.index}</h3>
                  <span style={{ fontSize: 12, color: "#6b7280" }}>
                    {g.students.length} students
                  </span>
                </div>
                <div style={{ fontSize: 13, color: "#374151", marginTop: 4 }}>
                  Skill focus:{" "}
                  <strong>{g.dominantCategory ?? "Mixed"}</strong>
                </div>
                <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
                  {g.dominantCategory
                    ? `Cohesion ${g.cohesionPct}%`
                    : `Spread cohesion ${g.cohesionPct}% (lower = more varied)`}
                  {g.avgDominantPct != null
                    ? ` · Avg ${g.avgDominantPct}% in focus skill`
                    : ""}
                </div>
                <LevelMixChips mix={g.levelMix} />
                <ol style={{ marginTop: 8, paddingLeft: 18, fontSize: 13 }}>
                  {g.students.map((s) => (
                    <li key={s.studentId} style={{ marginBottom: 3 }}>
                      <span>{fullName(s)}</span>
                      {s.fastLevel != null && (
                        <span
                          style={{
                            marginLeft: 6,
                            fontSize: 10,
                            padding: "0 5px",
                            borderRadius: 8,
                            background: LEVEL_PALETTE[s.fastLevel],
                            color: LEVEL_TEXT[s.fastLevel],
                            fontWeight: 700,
                          }}
                        >
                          L{s.fastLevel}
                        </span>
                      )}
                      <span style={{ color: "#6b7280", marginLeft: 6 }}>
                        ({s.localSisId ?? "—"}
                        {s.overallPct != null ? ` · ${s.overallPct}%` : ""})
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>

          {result.overflow.length > 0 && (
            <div
              style={{
                marginTop: 18,
                border: "1px solid #fca5a5",
                borderRadius: 8,
                padding: 12,
                background: "#fef2f2",
              }}
            >
              <h3 style={{ margin: 0, fontSize: 15, color: "#991b1b" }}>
                Over capacity ({result.overflow.length})
              </h3>
              <p style={{ margin: "4px 0 8px 0", fontSize: 12, color: "#7f1d1d" }}>
                Eligible students who didn't fit in the requested{" "}
                {result.requested.sections} sections × {result.requested.seats}{" "}
                seats. Add another section or raise seats / section to absorb
                them.
              </p>
              <ul style={{ paddingLeft: 18, fontSize: 13, columns: 2 }}>
                {result.overflow.map((u) => (
                  <li key={u.studentId}>
                    {fullName(u)}
                    {u.fastLevel != null && (
                      <span
                        style={{
                          marginLeft: 6,
                          fontSize: 10,
                          padding: "0 5px",
                          borderRadius: 8,
                          background: LEVEL_PALETTE[u.fastLevel],
                          color: LEVEL_TEXT[u.fastLevel],
                          fontWeight: 700,
                        }}
                      >
                        L{u.fastLevel}
                      </span>
                    )}{" "}
                    <span style={{ color: "#6b7280" }}>
                      ({u.localSisId ?? "—"}
                      {u.overallPct != null ? ` · ${u.overallPct}%` : ""})
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result.unscored.length > 0 && (
            <div
              style={{
                marginTop: 18,
                border: "1px dashed #d1d5db",
                borderRadius: 8,
                padding: 12,
                background: "#fefce8",
              }}
            >
              <h3 style={{ margin: 0, fontSize: 15 }}>
                Unscored ({result.unscored.length})
              </h3>
              <p style={{ margin: "4px 0 8px 0", fontSize: 12, color: "#713f12" }}>
                These students have no FAST item responses for the chosen window
                and weren't auto-placed. Review and place manually.
              </p>
              <ul style={{ paddingLeft: 18, fontSize: 13, columns: 2 }}>
                {result.unscored.map((u) => (
                  <li key={u.studentId}>
                    {fullName(u)}{" "}
                    <span style={{ color: "#6b7280" }}>
                      ({u.localSisId ?? "—"})
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
