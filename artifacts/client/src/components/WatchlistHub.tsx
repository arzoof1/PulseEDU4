import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Bell,
  ChevronRight,
  Clock,
  Eye,
  FileText,
  Filter,
  Flame,
  GitBranch,
  Megaphone,
  MessageSquareWarning,
  Plus,
  Search,
  Shield,
  Sparkles,
  TrendingDown,
  TrendingUp,
  UserPlus,
  Users,
} from "lucide-react";
import { authFetch } from "../lib/authToken";
import { formatCaseNumber } from "../lib/caseNumber";
import LogInteractionModal from "./watchlist/LogInteractionModal";
import NewCaseModal from "./watchlist/NewCaseModal";
import {
  HowToUseHelp,
  HowToSection,
  howtoListStyle,
} from "./HowToUseHelp";
import PromoteToCaseModal from "./watchlist/PromoteToCaseModal";
import StatementDetailsModal from "./watchlist/StatementDetailsModal";
import {
  WL_COLORS as C,
  initialsOf,
  severityChipStyle,
  statusPillStyle,
} from "./watchlist/colors";

interface Summary {
  activeCases: number;
  pendingStatements: number;
  staleStatements: number;
  recentInteractions: number;
  looseInteractions: number;
  windowDays: number;
}

interface Alert {
  id: string;
  ruleKind:
    | "frequency"
    | "always-peripheral"
    | "co-occurrence"
    | "stale-statement"
    | "loose-escalation";
  severity: "info" | "warn" | "alert";
  subjectStudentId: string;
  subjectKey: string;
  title: string;
  body: string;
  meta: Record<string, unknown>;
}

interface OrbitItem {
  studentId: string;
  firstName: string;
  lastName: string;
  grade: string | null;
  total: number;
  nonDirect: number;
  peripheral: number;
  direct: number;
  nonDirectPct: number;
}

interface CaseRow {
  id: number;
  caseNumber: number;
  schoolYearLabel?: string;
  title: string;
  status: string;
  leadStaffName: string | null;
  counts: { incidents: number; students: number; lastActivity: string | null };
}

interface InteractionRow {
  id: number;
  occurredAt: string;
  occurredDate: string;
  kind: string;
  severity: number;
  location: string | null;
  summary: string;
  caseId: number | null;
  status?: string;
  dismissedAt?: string | null;
  dismissedReason?: string | null;
  dismissedByName?: string | null;
  participants: Array<{
    studentId: string;
    firstName: string;
    lastName: string;
    role: string;
  }>;
}

interface StatementRow {
  id: number;
  studentId: string;
  firstName: string;
  lastName: string;
  grade: string | null;
  interactionId: number;
  status: string;
  requestedAt: string;
  ageDays: number;
}

interface Props {
  onOpenNetwork?: () => void;
  onOpenCase?: (caseId: number) => void;
  onOpenStudentGraph?: (studentId?: string | null) => void;
}

function ruleIconFor(k: Alert["ruleKind"]) {
  if (k === "frequency") return Flame;
  if (k === "always-peripheral") return Eye;
  if (k === "co-occurrence") return GitBranch;
  if (k === "stale-statement") return Clock;
  return TrendingUp;
}

function colorFor(k: Alert["ruleKind"]): string {
  if (k === "frequency" || k === "always-peripheral") return C.alert;
  if (k === "stale-statement") return C.cool;
  return C.warn;
}

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  const ms = Date.now() - t;
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function WatchlistHub({ onOpenNetwork, onOpenCase, onOpenStudentGraph }: Props) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [orbit, setOrbit] = useState<OrbitItem[]>([]);
  const [cases, setCases] = useState<CaseRow[]>([]);
  const [interactions, setInteractions] = useState<InteractionRow[]>([]);
  const [statements, setStatements] = useState<StatementRow[]>([]);
  const [windowDays, setWindowDays] = useState(14);
  // Custom date range. When both ends are set, we send `from`/`to` to the
  // API instead of the rolling-window `windowDays` preset. `from` alone is
  // also accepted (treated as "from this date through today").
  const [customFrom, setCustomFrom] = useState<string>("");
  const [customTo, setCustomTo] = useState<string>("");
  const [showRange, setShowRange] = useState(false);
  // Pending picker values — let the user type both dates before applying,
  // so the page doesn't refetch on every keystroke.
  const [draftFrom, setDraftFrom] = useState<string>("");
  const [draftTo, setDraftTo] = useState<string>("");
  const customActive = Boolean(customFrom);
  const rangeQS = customActive
    ? `from=${customFrom}${customTo ? `&to=${customTo}` : ""}`
    : `windowDays=${windowDays}`;
  const [showLog, setShowLog] = useState(false);
  const [showNewCase, setShowNewCase] = useState(false);
  const [promoteStmt, setPromoteStmt] = useState<InteractionRow | null>(null);
  // ID of the statement whose full-detail modal is open. The modal is a
  // pure overlay — closing returns the user to the same intake position
  // they were on (no nav, no scroll reset, no reload).
  const [detailsStmtId, setDetailsStmtId] = useState<number | null>(null);
  const [intakeTab, setIntakeTab] = useState<"pending" | "dismissed">("pending");
  // Active-cases search & filter. caseStatusFilter === "active" hides
  // closed cases (the historical default); explicit statuses narrow
  // further. The 6-case slice only applies when no search/filter is
  // active so the panel stays compact at rest but acts as a full
  // browser the moment the user starts looking for something.
  const [caseSearch, setCaseSearch] = useState("");
  const [caseStatusFilter, setCaseStatusFilter] = useState<
    "active" | "open" | "monitoring" | "escalated" | "closed" | "all"
  >("active");
  const [busyStmtId, setBusyStmtId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyAlert, setBusyAlert] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [r1, r2, r3, r4, r5, r6] = await Promise.all([
        authFetch(`/api/watchlist/summary`),
        authFetch(`/api/watchlist/alerts?${rangeQS}`),
        authFetch(`/api/watchlist/orbit?${rangeQS}`),
        authFetch(`/api/watchlist/cases`),
        authFetch(
          `/api/watchlist/interactions?${rangeQS}&limit=20${
            intakeTab === "dismissed" ? "&onlyDismissed=1&includeDismissed=1" : ""
          }`,
        ),
        authFetch(`/api/watchlist/statements`),
      ]);
      if (!r1.ok || !r2.ok || !r3.ok || !r4.ok || !r5.ok || !r6.ok) {
        throw new Error("Failed to load Incident Investigations data");
      }
      const [d1, d2, d3, d4, d5, d6] = await Promise.all([
        r1.json() as Promise<Summary>,
        r2.json() as Promise<{ alerts: Alert[] }>,
        r3.json() as Promise<{ items: OrbitItem[] }>,
        r4.json() as Promise<{ cases: CaseRow[] }>,
        r5.json() as Promise<{ interactions: InteractionRow[] }>,
        r6.json() as Promise<{ statements: StatementRow[] }>,
      ]);
      setSummary(d1);
      setAlerts(d2.alerts);
      setOrbit(d3.items);
      setCases(d4.cases);
      setInteractions(d5.interactions);
      setStatements(d6.statements);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, [windowDays, intakeTab, customFrom, customTo, rangeQS]);

  // Triage actions on a single statement (intake row).
  const dismissStmt = async (s: InteractionRow) => {
    const reason = window.prompt(
      "Why are you dismissing this statement? (audit-logged, min 5 chars)",
      "",
    );
    if (reason === null) return;
    if (reason.trim().length < 5) {
      window.alert("Reason must be at least 5 characters.");
      return;
    }
    setBusyStmtId(s.id);
    try {
      const r = await authFetch(`/api/watchlist/interactions/${s.id}/dismiss`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || "Failed to dismiss");
      }
      await reload();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Failed to dismiss");
    } finally {
      setBusyStmtId(null);
    }
  };
  const restoreStmt = async (s: InteractionRow) => {
    setBusyStmtId(s.id);
    try {
      const r = await authFetch(`/api/watchlist/interactions/${s.id}/restore`, {
        method: "POST",
      });
      if (!r.ok) throw new Error("Failed to restore");
      await reload();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Failed to restore");
    } finally {
      setBusyStmtId(null);
    }
  };

  useEffect(() => {
    void reload();
  }, [reload]);

  const dismissAlert = async (a: Alert, snoozeDays: number | null) => {
    setBusyAlert(a.id);
    try {
      await authFetch("/api/watchlist/alerts/dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ruleKind: a.ruleKind,
          subjectStudentId: a.subjectStudentId,
          subjectKey: a.subjectKey,
          snoozeDays,
        }),
      });
      setAlerts((prev) => prev.filter((x) => x.id !== a.id));
    } finally {
      setBusyAlert(null);
    }
  };

  const checkIn = async (a: Alert) => {
    setBusyAlert(a.id);
    try {
      const r = await authFetch("/api/watchlist/alerts/check-in", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId: a.subjectStudentId,
          ruleKind: a.ruleKind,
          ruleSummary: a.title,
        }),
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(t || `Failed (${r.status})`);
      }
      const d = (await r.json()) as { assignedTo?: { name: string }; createdPlan?: boolean };
      const who = d.assignedTo?.name || "Behavior Specialist";
      const planNote = d.createdPlan ? " (new MTSS plan opened)" : "";
      window.alert(`Check-in scheduled with ${who}${planNote}.`);
      void reload();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Failed to schedule check-in");
    } finally {
      setBusyAlert(null);
    }
  };

  const remindStatement = async (id: number) => {
    await authFetch(`/api/watchlist/statements/${id}/remind`, { method: "POST" });
    void reload();
  };

  const completeStatement = async (id: number) => {
    await authFetch(`/api/watchlist/statements/${id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "" }),
    });
    void reload();
  };

  const stats = useMemo(() => {
    return [
      {
        label: "Active alerts",
        value: alerts.length,
        delta: alerts.length === 0 ? "All clear" : `${alerts.length} surfaced this window`,
        icon: Bell,
        tone: C.alert,
      },
      {
        label: "Open cases",
        value: summary?.activeCases ?? 0,
        delta:
          (summary?.activeCases ?? 0) === 0
            ? "No open cases"
            : `${summary?.activeCases} tracked`,
        icon: FileText,
        tone: C.brand,
      },
      {
        label: "Pending statements",
        value: summary?.pendingStatements ?? 0,
        delta:
          (summary?.staleStatements ?? 0) > 0
            ? `${summary?.staleStatements} stale > 7 days`
            : "All within SLA",
        icon: MessageSquareWarning,
        tone: C.warn,
      },
      {
        label: `Logged this ${windowDays}d`,
        value: summary?.recentInteractions ?? 0,
        delta: `${summary?.looseInteractions ?? 0} loose / no case`,
        icon: Sparkles,
        tone: C.cool,
      },
    ];
  }, [alerts, summary, windowDays]);

  return (
    <div className="min-h-screen" style={{ background: C.bg, color: C.ink }}>
      <div className="mx-auto max-w-[1320px] px-8 py-8">
        {/* Header */}
        <div className="flex flex-wrap items-end justify-between gap-4 pb-6">
          <div>
            <div
              className="inline-flex items-center gap-2 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider"
              style={{ borderColor: C.line, background: C.panel, color: C.brand }}
            >
              <Shield className="h-3.5 w-3.5" /> Core Team Only
            </div>
            <h1 className="mt-2 text-3xl font-bold tracking-tight">
              Incident Investigations
            </h1>
            <p className="mt-1 max-w-2xl text-sm" style={{ color: C.inkSoft }}>
              Students surfacing across the Interaction Log — the ones showing up{" "}
              <span className="font-semibold" style={{ color: C.brand }}>
                from a distance
              </span>{" "}
              but never quite in the middle. Triage alerts, open cases, request statements.
            </p>

            <HowToUseHelp title="How to use Investigations">
              <HowToSection title="What this is">
                The control room for incident investigations. Every
                statement logged by a teacher or admin lands here first;
                the Hub turns that stream into a triage queue (alerts),
                an awareness chart (top of orbit), and the open case
                book. Use it to decide who needs a check-in today, what
                cases need movement, and which statements still need to
                come in.
              </HowToSection>
              <HowToSection title="Reading the page">
                <ul style={howtoListStyle}>
                  <li>
                    <strong>Stats row</strong> — open cases, active
                    alerts, statements in flight, and students surfacing
                    in the selected window.
                  </li>
                  <li>
                    <strong>Window filter</strong> — 7 / 14 / 30 / 90
                    days, or a custom range. Every panel below respects
                    it, so you can compare "this week" vs. "this month"
                    without leaving the page.
                  </li>
                  <li>
                    <strong>Alerts</strong> — automatic flags from five
                    rules (rumor cluster, repeat target, escalating
                    severity, missing statement, dormant case). Each
                    alert has triage actions; dismissed alerts come
                    back if the underlying pattern repeats.
                  </li>
                  <li>
                    <strong>Top of orbit</strong> — students appearing
                    most often across the log. Bubble size = total
                    appearances; color = primary role.
                  </li>
                  <li>
                    <strong>Open cases</strong> — chronological list of
                    cases with severity, lead, last activity, and
                    statement progress.
                  </li>
                </ul>
              </HowToSection>
              <HowToSection title="Day-to-day actions">
                <ul style={howtoListStyle}>
                  <li>
                    <strong>Log new statement</strong> (top right) —
                    capture an incident or witness statement and tag the
                    students involved with their role.
                  </li>
                  <li>
                    <strong>New case</strong> — open a case file when a
                    pattern is forming and you need a place to gather
                    notes, players, and statements over time.
                  </li>
                  <li>
                    <strong>Schedule check-in</strong> on any student
                    card or alert — auto-creates a Tier 2 CICO entry,
                    routes the student to a Behavior Specialist, and
                    notifies the MTSS coordinator. Use this when you're
                    moving from "watch" to "act".
                  </li>
                  <li>
                    <strong>Student spider</strong> — search one
                    student to see every case they're tied to and who
                    else is in those cases.
                  </li>
                  <li>
                    <strong>Network view</strong> — zoom out to the
                    whole school's incident graph for the selected
                    window.
                  </li>
                </ul>
              </HowToSection>
              <HowToSection title="Privacy & access">
                The Investigations Hub is core-team-only (admin,
                guidance, behavior specialist, MTSS coordinator).
                Teachers can log statements through the standard
                Behavior tools; what they file shows up here for the
                core team to triage. Students never see this page.
              </HowToSection>
            </HowToUseHelp>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onOpenStudentGraph?.(null)}
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-semibold"
              style={{ borderColor: C.line, color: C.ink, background: C.panel }}
            >
              <Sparkles className="h-4 w-4" /> Student spider
            </button>
            <button
              type="button"
              onClick={() => onOpenNetwork?.()}
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-semibold"
              style={{ borderColor: C.line, color: C.ink, background: C.panel }}
            >
              <GitBranch className="h-4 w-4" /> Network view
            </button>
            <button
              type="button"
              onClick={() => setShowNewCase(true)}
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-bold"
              style={{ borderColor: C.brand, color: C.brand, background: C.brandSoft }}
            >
              <Plus className="h-4 w-4" /> New case
            </button>
            <button
              type="button"
              onClick={() => setShowLog(true)}
              className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-bold shadow-sm"
              style={{ background: C.brand, color: "#FFFFFF" }}
            >
              <Plus className="h-4 w-4" /> Log new statement
            </button>
          </div>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-4 gap-4">
          {stats.map((t) => {
            const Icon = t.icon;
            return (
              <div
                key={t.label}
                className="flex flex-col gap-2 rounded-xl border p-4"
                style={{ borderColor: C.line, background: C.panel }}
              >
                <div className="flex items-center justify-between">
                  <span
                    className="text-[11px] font-semibold uppercase tracking-wider"
                    style={{ color: C.inkSoft }}
                  >
                    {t.label}
                  </span>
                  <Icon className="h-4 w-4" style={{ color: t.tone }} />
                </div>
                <div className="text-3xl font-bold tabular-nums" style={{ color: C.ink }}>
                  {t.value}
                </div>
                <div className="text-[11px]" style={{ color: C.inkSoft }}>
                  {t.delta}
                </div>
              </div>
            );
          })}
        </div>

        {/* Filters */}
        <div
          className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border p-3"
          style={{ borderColor: C.line, background: C.panel }}
        >
          <Filter className="h-4 w-4" style={{ color: C.inkSoft }} />
          <span
            className="text-[11px] font-semibold uppercase tracking-wider"
            style={{ color: C.inkSoft }}
          >
            Window
          </span>
          {[7, 14, 30, 90].map((w) => {
            const active = !customActive && w === windowDays;
            return (
              <button
                key={w}
                type="button"
                onClick={() => {
                  // Picking a preset clears any custom range so the two
                  // controls can't get out of sync.
                  setCustomFrom("");
                  setCustomTo("");
                  setShowRange(false);
                  setWindowDays(w);
                }}
                className="rounded-md px-2.5 py-1 text-xs font-semibold"
                style={{
                  background: active ? C.ink : "transparent",
                  color: active ? "#fff" : C.ink,
                  border: `1px solid ${active ? C.ink : C.line}`,
                }}
              >
                {w === 90 ? "Term" : `${w} days`}
              </button>
            );
          })}
          {/* Custom date range. Toggling open seeds the draft fields with
              the current selection (or sensible defaults), and Apply commits
              them — keeps fetches debounced behind a single user gesture. */}
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setDraftFrom(
                  customFrom ||
                    new Date(Date.now() - windowDays * 24 * 3600 * 1000)
                      .toISOString()
                      .slice(0, 10),
                );
                setDraftTo(customTo || new Date().toISOString().slice(0, 10));
                setShowRange((s) => !s);
              }}
              className="rounded-md px-2.5 py-1 text-xs font-semibold"
              style={{
                background: customActive ? C.ink : "transparent",
                color: customActive ? "#fff" : C.ink,
                border: `1px solid ${customActive ? C.ink : C.line}`,
              }}
              title="Pick a custom date range."
            >
              {customActive
                ? `${customFrom}${customTo ? ` → ${customTo}` : " → today"}`
                : "Custom…"}
            </button>
            {showRange && (
              <div
                className="absolute left-0 top-full z-20 mt-1 w-72 rounded-md border p-3 shadow-lg"
                style={{ borderColor: C.line, background: C.panel }}
              >
                <div
                  className="mb-1 text-[11px] font-semibold uppercase tracking-wider"
                  style={{ color: C.inkSoft }}
                >
                  From
                </div>
                <input
                  type="date"
                  value={draftFrom}
                  onChange={(e) => setDraftFrom(e.target.value)}
                  className="w-full rounded-md border px-2 py-1 text-sm"
                  style={{ borderColor: C.line, background: C.bg }}
                />
                <div
                  className="mb-1 mt-2 text-[11px] font-semibold uppercase tracking-wider"
                  style={{ color: C.inkSoft }}
                >
                  To
                </div>
                <input
                  type="date"
                  value={draftTo}
                  onChange={(e) => setDraftTo(e.target.value)}
                  className="w-full rounded-md border px-2 py-1 text-sm"
                  style={{ borderColor: C.line, background: C.bg }}
                />
                <div className="mt-3 flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setCustomFrom("");
                      setCustomTo("");
                      setShowRange(false);
                    }}
                    className="rounded-md border px-2 py-1 text-[11px] font-semibold"
                    style={{ borderColor: C.line, color: C.inkSoft, background: C.panel }}
                  >
                    Clear
                  </button>
                  <button
                    type="button"
                    disabled={
                      !draftFrom ||
                      Boolean(draftTo && draftTo < draftFrom)
                    }
                    onClick={() => {
                      setCustomFrom(draftFrom);
                      setCustomTo(draftTo);
                      setShowRange(false);
                    }}
                    className="rounded-md px-3 py-1 text-[11px] font-bold disabled:opacity-50"
                    style={{ background: C.brand, color: "#FFFFFF" }}
                  >
                    Apply
                  </button>
                </div>
                {draftTo && draftFrom && draftTo < draftFrom ? (
                  <div className="mt-2 text-[11px]" style={{ color: C.alert }}>
                    "To" must be on or after "From".
                  </div>
                ) : null}
              </div>
            )}
          </div>
          <div
            className="ml-auto flex items-center gap-2 rounded-md border px-2.5 py-1.5"
            style={{ borderColor: C.line, background: C.bg }}
          >
            <Search className="h-4 w-4" style={{ color: C.inkSoft }} />
            <span className="text-[11px]" style={{ color: C.inkSoft }}>
              Use Network view for graph search
            </span>
          </div>
        </div>

        {error && (
          <div
            className="mt-4 rounded-md px-3 py-2 text-sm font-semibold"
            style={{ background: C.alert, color: "#FFFFFF" }}
          >
            {error}
          </div>
        )}

        {/* Alerts strip */}
        <div className="mt-6 flex items-baseline justify-between">
          <h2 className="text-lg font-bold tracking-tight">Alerts requiring eyes</h2>
          <span className="text-xs" style={{ color: C.inkSoft }}>
            {alerts.length} active · 5 rule types
          </span>
        </div>
        {alerts.length === 0 ? (
          <div
            className="mt-3 rounded-xl border p-6 text-center text-sm"
            style={{ borderColor: C.line, background: C.panel, color: C.inkSoft }}
          >
            No alerts in this window. Good — or no data yet.
          </div>
        ) : (
          <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {alerts.slice(0, 10).map((a) => {
              const Icon = ruleIconFor(a.ruleKind);
              const ruleColor = colorFor(a.ruleKind);
              const total = (a.meta?.["total"] as number | undefined) ?? null;
              const grade = (a.meta?.["grade"] as string | undefined) ?? null;
              const initials =
                a.title.split(" ").slice(0, 2).map((w) => w.charAt(0)).join("").toUpperCase() ||
                "??";
              return (
                <div
                  key={a.id}
                  className="flex flex-col gap-3 rounded-xl border p-4"
                  style={{ borderColor: C.line, background: C.panel }}
                >
                  <div className="flex items-start gap-3">
                    <div
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white"
                      style={{ background: ruleColor }}
                    >
                      {initials}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold" style={{ color: C.ink }}>
                        {a.title}
                      </div>
                      <div
                        className="mt-0.5 flex items-center gap-1.5 text-[12px] font-medium"
                        style={{ color: ruleColor }}
                      >
                        <Icon className="h-3.5 w-3.5" />
                        {a.ruleKind.replace("-", " ")}
                        {grade ? <span style={{ color: C.inkSoft }}>· Gr {grade}</span> : null}
                      </div>
                    </div>
                    <span
                      className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold"
                      style={{
                        background: a.severity === "alert" ? C.alertSoft : C.warnSoft,
                        color: a.severity === "alert" ? C.alert : C.warn,
                      }}
                    >
                      <TrendingUp className="h-3 w-3" /> {a.severity}
                    </span>
                  </div>
                  {total != null && (
                    <div className="flex items-baseline gap-2">
                      <div className="text-3xl font-bold tabular-nums" style={{ color: C.ink }}>
                        {total}
                      </div>
                      <div className="text-[11px]" style={{ color: C.inkSoft }}>
                        in {windowDays}d
                      </div>
                    </div>
                  )}
                  <div
                    className="rounded-md px-2.5 py-1.5 text-[12px] leading-snug"
                    style={{ background: C.bg, color: C.inkSoft }}
                  >
                    {a.body}
                  </div>
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    <button
                      type="button"
                      onClick={() => checkIn(a)}
                      disabled={busyAlert === a.id}
                      className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-bold disabled:opacity-50"
                      style={{ background: C.brand, color: "#FFFFFF" }}
                      title="Routes to Behavior Specialist + opens an MTSS Tier 2 plan"
                    >
                      Schedule check-in <ChevronRight className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onOpenNetwork?.()}
                      className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11px] font-semibold"
                      style={{ borderColor: C.line, color: C.ink }}
                    >
                      <GitBranch className="h-3 w-3" /> View graph
                    </button>
                    <button
                      type="button"
                      onClick={() => dismissAlert(a, 7)}
                      disabled={busyAlert === a.id}
                      className="inline-flex items-center rounded-md px-2 py-1 text-[11px] font-semibold disabled:opacity-50"
                      style={{ color: C.inkSoft }}
                    >
                      Snooze 7d
                    </button>
                    <button
                      type="button"
                      onClick={() => dismissAlert(a, null)}
                      disabled={busyAlert === a.id}
                      className="inline-flex items-center rounded-md px-2 py-1 text-[11px] font-semibold disabled:opacity-50"
                      style={{ color: C.inkSoft }}
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Two-column: orbit + cases */}
        <div className="mt-8 grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div
            className="rounded-xl border p-5 lg:col-span-2"
            style={{ borderColor: C.line, background: C.panel }}
          >
            <div className="flex items-baseline justify-between">
              <div>
                <h2 className="text-lg font-bold tracking-tight">Top of orbit</h2>
                <p className="text-xs" style={{ color: C.inkSoft }}>
                  Students with 2+ involvements in {windowDays}d, sorted by total. % shows
                  non-direct ratio.
                </p>
              </div>
              <span className="text-[11px]" style={{ color: C.inkSoft }}>
                {orbit.length} on the radar
              </span>
            </div>
            <div className="mt-3 overflow-hidden rounded-lg border" style={{ borderColor: C.line }}>
              <table className="w-full text-sm">
                <thead style={{ background: C.bg, color: C.inkSoft }}>
                  <tr>
                    <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider">
                      #
                    </th>
                    <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider">
                      Student
                    </th>
                    <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider">
                      Periph.
                    </th>
                    <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider">
                      Direct
                    </th>
                    <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider">
                      Total
                    </th>
                    <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider">
                      Pattern
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {orbit.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-6 text-center text-sm" style={{ color: C.inkSoft }}>
                        No students with multiple involvements in this window.
                      </td>
                    </tr>
                  ) : (
                    orbit.slice(0, 10).map((o, i) => {
                      const flag =
                        o.total >= 3 && o.direct === 0
                          ? { label: "Always peripheral", bg: C.alert, fg: "#FFFFFF" }
                          : o.nonDirectPct >= 75
                            ? { label: `${o.nonDirectPct}% non-direct`, bg: C.warnSoft, fg: C.warn }
                            : { label: `${o.nonDirectPct}% non-direct`, bg: C.bg, fg: C.inkSoft };
                      return (
                        <tr key={o.studentId} className="border-t" style={{ borderColor: C.line }}>
                          <td className="px-3 py-2 text-xs tabular-nums" style={{ color: C.inkSoft }}>
                            {i + 1}
                          </td>
                          <td className="px-3 py-2 text-sm font-semibold">
                            {o.firstName} {o.lastName}{" "}
                            <span className="text-[11px] font-normal" style={{ color: C.inkSoft }}>
                              · Gr {o.grade ?? "?"}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">{o.peripheral}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{o.direct}</td>
                          <td className="px-3 py-2 text-right tabular-nums font-bold">{o.total}</td>
                          <td className="px-3 py-2 text-xs">
                            <span
                              className="inline-flex items-center rounded-full px-2 py-0.5 font-semibold"
                              style={{ background: flag.bg, color: flag.fg }}
                            >
                              {flag.label}
                            </span>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Active cases */}
          <div className="rounded-xl border p-5" style={{ borderColor: C.line, background: C.panel }}>
            <div className="flex items-baseline justify-between">
              <h2 className="text-lg font-bold tracking-tight">Active cases</h2>
              <button
                type="button"
                onClick={() => setShowNewCase(true)}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold"
                style={{ background: C.bg, color: C.ink }}
              >
                <Plus className="h-3 w-3" /> New
              </button>
            </div>
            {/* Search + status filter. The list below applies both
                client-side against the already-loaded cases array, and
                drops the 6-case slice whenever the user has typed a
                search or picked a non-default filter. */}
            <div className="mt-3 flex flex-col gap-2">
              <div
                className="flex items-center gap-2 rounded-md border px-2 py-1.5"
                style={{ borderColor: C.line, background: C.bg }}
              >
                <Search className="h-3.5 w-3.5 flex-none" style={{ color: C.inkSoft }} />
                <input
                  type="text"
                  value={caseSearch}
                  onChange={(e) => setCaseSearch(e.target.value)}
                  placeholder="Search by title, case #, or lead…"
                  className="w-full bg-transparent text-sm outline-none"
                  style={{ color: C.ink }}
                />
                {caseSearch && (
                  <button
                    type="button"
                    onClick={() => setCaseSearch("")}
                    className="text-[11px] font-semibold"
                    style={{ color: C.inkSoft }}
                  >
                    Clear
                  </button>
                )}
              </div>
              <div className="flex flex-wrap gap-1">
                {(
                  [
                    ["active", "Active"],
                    ["open", "Open"],
                    ["monitoring", "Monitoring"],
                    ["escalated", "Escalated"],
                    ["closed", "Closed"],
                    ["all", "All"],
                  ] as const
                ).map(([k, label]) => {
                  const on = caseStatusFilter === k;
                  return (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setCaseStatusFilter(k)}
                      className="rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition-colors"
                      style={{
                        borderColor: on ? C.brand : C.line,
                        background: on ? C.brand : C.bg,
                        color: on ? "#FFFFFF" : C.ink,
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="mt-3 flex flex-col gap-2">
              {cases.length === 0 ? (
                <div className="text-sm" style={{ color: C.inkSoft }}>
                  No cases yet. Open one when a pattern needs a thread.
                </div>
              ) : (
                (() => {
                  const q = caseSearch.trim().toLowerCase();
                  const matches = cases.filter((c) => {
                    if (caseStatusFilter === "active") {
                      if (c.status === "closed") return false;
                    } else if (caseStatusFilter !== "all") {
                      if (c.status !== caseStatusFilter) return false;
                    }
                    if (q) {
                      const num = formatCaseNumber(c).toLowerCase();
                      const hay = [
                        c.title?.toLowerCase() ?? "",
                        num,
                        // Bare digits too so "42" matches "25-26-0042".
                        String(c.caseNumber),
                        c.leadStaffName?.toLowerCase() ?? "",
                      ];
                      if (!hay.some((s) => s.includes(q))) return false;
                    }
                    return true;
                  });
                  // Compact panel at rest — full browser when the user
                  // narrows. "Active" is the historical default, so we
                  // keep the slice there too unless they're searching.
                  const sliced =
                    !q && caseStatusFilter === "active" ? matches.slice(0, 6) : matches;
                  if (sliced.length === 0) {
                    return (
                      <div className="text-sm" style={{ color: C.inkSoft }}>
                        No cases match this search.
                      </div>
                    );
                  }
                  return sliced.map((c) => {
                    const sp = statusPillStyle(c.status);
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => onOpenCase?.(c.id)}
                        className="rounded-lg border p-3 text-left transition-shadow hover:shadow-sm"
                        style={{ borderColor: C.line, background: C.bg }}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-[11px] font-semibold" style={{ color: C.inkSoft }}>
                              Case {formatCaseNumber(c)}
                            </div>
                            <div className="truncate text-sm font-semibold">{c.title}</div>
                          </div>
                          <span
                            className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold"
                            style={{ background: sp.bg, color: sp.fg }}
                          >
                            {sp.label}
                          </span>
                        </div>
                        <div
                          className="mt-2 flex items-center justify-between text-[11px]"
                          style={{ color: C.inkSoft }}
                        >
                          <span className="inline-flex items-center gap-3">
                            <span className="inline-flex items-center gap-1">
                              <FileText className="h-3 w-3" /> {c.counts.incidents} inc.
                            </span>
                            <span className="inline-flex items-center gap-1">
                              <Users className="h-3 w-3" /> {c.counts.students} students
                            </span>
                          </span>
                          <span>
                            {c.counts.lastActivity
                              ? `Last: ${relTime(c.counts.lastActivity)}`
                              : "no activity"}
                          </span>
                        </div>
                        <div className="mt-1.5 flex items-center justify-between text-[11px]">
                          <span style={{ color: C.inkSoft }}>
                            Lead: {c.leadStaffName || "—"}
                          </span>
                          <span className="font-semibold" style={{ color: C.brand }}>
                            Open →
                          </span>
                        </div>
                      </button>
                    );
                  });
                })()
              )}
            </div>
          </div>
        </div>

        {/* Two-column: incidents + statements */}
        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div
            className="rounded-xl border p-5 lg:col-span-2"
            style={{ borderColor: C.line, background: C.panel }}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h2 className="text-lg font-bold tracking-tight">
                  Statements — intake
                </h2>
                <div className="text-[11px]" style={{ color: C.inkSoft }}>
                  {intakeTab === "pending"
                    ? "New witness statements awaiting triage. Promote to a case, attach to an open one, or dismiss with a reason."
                    : "Statements that were dismissed during triage. Restore if it turns out to be relevant."}
                </div>
              </div>
              <div
                className="inline-flex rounded-md border p-0.5"
                style={{ borderColor: C.line, background: C.bg }}
              >
                {(["pending", "dismissed"] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setIntakeTab(tab)}
                    className="rounded px-2.5 py-1 text-[11px] font-semibold capitalize"
                    style={{
                      background: intakeTab === tab ? C.ink : "transparent",
                      color: intakeTab === tab ? "#fff" : C.ink,
                    }}
                  >
                    {tab}
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-3 divide-y" style={{ borderColor: C.line }}>
              {interactions.length === 0 ? (
                <div className="py-6 text-center text-sm" style={{ color: C.inkSoft }}>
                  {intakeTab === "pending"
                    ? "No new statements waiting on triage."
                    : "Nothing has been dismissed in this window."}
                </div>
              ) : (
                interactions.map((i) => {
                  const sev = severityChipStyle(i.severity);
                  const Icon =
                    i.kind === "fight"
                      ? AlertTriangle
                      : i.kind === "rumor"
                        ? Megaphone
                        : i.kind === "property"
                          ? Shield
                          : i.kind === "peripheral_note"
                            ? Eye
                            : MessageSquareWarning;
                  return (
                    <div key={i.id} className="flex items-start gap-3 py-3">
                      <div
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md"
                        style={{ background: C.bg, color: C.brand }}
                      >
                        <Icon className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className="text-[11px] font-semibold uppercase tracking-wider"
                            style={{ color: C.inkSoft }}
                          >
                            {relTime(i.occurredAt)}
                          </span>
                          <span className="text-sm font-semibold">{i.kind}</span>
                          <span
                            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
                            style={{ background: sev.bg, color: sev.fg }}
                          >
                            {sev.label}
                          </span>
                          {i.caseId ? (
                            <button
                              type="button"
                              onClick={() => onOpenCase?.(i.caseId!)}
                              className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold"
                              style={{ background: C.brandSoft, color: C.brand }}
                            >
                              Case #{i.caseId}
                            </button>
                          ) : intakeTab === "dismissed" ? (
                            <span
                              className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold"
                              style={{ background: C.alertSoft, color: C.alert }}
                              title={i.dismissedReason || ""}
                            >
                              Dismissed
                            </span>
                          ) : (
                            <span
                              className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold"
                              style={{ background: C.bg, color: C.inkSoft }}
                            >
                              Awaiting triage
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 truncate text-sm" style={{ color: C.ink }}>
                          {i.summary}
                        </div>
                        <div
                          className="mt-1 flex items-center gap-3 text-[11px]"
                          style={{ color: C.inkSoft }}
                        >
                          <span className="inline-flex items-center gap-1">
                            <Users className="h-3 w-3" /> {i.participants.length} tagged
                          </span>
                          {i.location ? <span>· {i.location}</span> : null}
                          {intakeTab === "dismissed" && i.dismissedByName ? (
                            <span>
                              · dismissed by {i.dismissedByName}
                              {i.dismissedReason ? ` — "${i.dismissedReason}"` : ""}
                            </span>
                          ) : null}
                        </div>
                      </div>
                      {/* Triage rail. Pending statements get the full
                          Promote/Dismiss treatment; the Attach-to-existing
                          flow lives on the Case Detail page (which has
                          the case context to pick the right thread).
                          Already-attached statements just show a chevron. */}
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        {/* View details is available on every row regardless
                            of triage state — investigators frequently need
                            to read the full statement body before promoting
                            or dismissing, and reviewers want to read
                            already-attached entries in context. */}
                        <button
                          type="button"
                          onClick={() => setDetailsStmtId(i.id)}
                          className="rounded-md border px-2 py-1 text-[11px] font-semibold"
                          style={{ borderColor: C.line, color: C.ink, background: C.panel }}
                          title="Read the full student statement and tagged participants."
                        >
                          View details
                        </button>
                        {i.caseId ? (
                          <ChevronRight
                            className="mt-1 h-4 w-4"
                            style={{ color: C.inkSoft }}
                          />
                        ) : intakeTab === "dismissed" ? (
                          <button
                            type="button"
                            onClick={() => void restoreStmt(i)}
                            disabled={busyStmtId === i.id}
                            className="rounded-md border px-2 py-1 text-[11px] font-semibold disabled:opacity-50"
                            style={{ borderColor: C.line, color: C.ink, background: C.panel }}
                          >
                            {busyStmtId === i.id ? "…" : "Restore"}
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => setPromoteStmt(i)}
                              disabled={busyStmtId === i.id}
                              className="rounded-md px-2 py-1 text-[11px] font-bold disabled:opacity-50"
                              style={{ background: C.brand, color: "#FFFFFF" }}
                              title="Open a new case with this as its lead statement."
                            >
                              Promote
                            </button>
                            <button
                              type="button"
                              onClick={() => void dismissStmt(i)}
                              disabled={busyStmtId === i.id}
                              className="rounded-md border px-2 py-1 text-[11px] font-semibold disabled:opacity-50"
                              style={{ borderColor: C.line, color: C.inkSoft, background: C.panel }}
                              title="Audit-logged. Restore later from the Dismissed tab."
                            >
                              Dismiss
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Statements */}
          <div className="rounded-xl border p-5" style={{ borderColor: C.line, background: C.panel }}>
            <div className="flex items-baseline justify-between">
              <h2 className="text-lg font-bold tracking-tight">Witness statements</h2>
              <span
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold"
                style={{ background: C.bg, color: C.inkSoft }}
              >
                <UserPlus className="h-3 w-3" /> {statements.length}
              </span>
            </div>
            <div className="mt-3 flex flex-col gap-2">
              {statements.length === 0 ? (
                <div className="text-sm" style={{ color: C.inkSoft }}>
                  No outstanding statements.
                </div>
              ) : (
                statements.slice(0, 8).map((s) => {
                  const stale = s.ageDays >= 7;
                  const pill = stale
                    ? { bg: C.alert, fg: "#FFFFFF", label: "Stale" }
                    : s.status === "reminded"
                      ? { bg: C.warnSoft, fg: C.warn, label: "Reminded" }
                      : { bg: C.coolSoft, fg: C.cool, label: "Requested" };
                  return (
                    <div
                      key={s.id}
                      className="rounded-lg border p-3"
                      style={{ borderColor: C.line, background: C.bg }}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold">
                            {s.firstName} {s.lastName}{" "}
                            <span className="text-[11px] font-normal" style={{ color: C.inkSoft }}>
                              · Gr {s.grade ?? "?"}
                            </span>
                          </div>
                          <div className="text-[11px]" style={{ color: C.inkSoft }}>
                            #{s.interactionId} · req. {new Date(s.requestedAt).toLocaleDateString()}
                          </div>
                        </div>
                        <span
                          className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold"
                          style={{ background: pill.bg, color: pill.fg }}
                        >
                          {pill.label}
                        </span>
                      </div>
                      <div className="mt-2 flex items-center justify-between">
                        <span
                          className="text-[11px] font-semibold"
                          style={{ color: stale ? C.alert : C.inkSoft }}
                        >
                          {s.ageDays === 0 ? "today" : `${s.ageDays}d outstanding`}
                        </span>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => remindStatement(s.id)}
                            className="rounded-md border px-2 py-0.5 text-[11px] font-semibold"
                            style={{ borderColor: C.line, color: C.ink }}
                          >
                            Remind
                          </button>
                          <button
                            type="button"
                            onClick={() => completeStatement(s.id)}
                            className="rounded-md px-2 py-0.5 text-[11px] font-bold"
                            style={{ background: C.ink, color: "#FFFFFF" }}
                          >
                            Complete
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        <div className="mt-6 text-center text-[11px]" style={{ color: C.inkSoft }}>
          Incident Investigations · {initialsOf("Pulse", "EDU")}
        </div>
      </div>

      {showLog && (
        <LogInteractionModal
          onClose={() => setShowLog(false)}
          onCreated={() => void reload()}
        />
      )}
      {showNewCase && (
        <NewCaseModal
          onClose={() => setShowNewCase(false)}
          onCreated={(caseId) => {
            setShowNewCase(false);
            void reload();
            onOpenCase?.(caseId);
          }}
        />
      )}
      {detailsStmtId !== null && (
        <StatementDetailsModal
          interactionId={detailsStmtId}
          onClose={() => setDetailsStmtId(null)}
          onOpenCase={onOpenCase}
        />
      )}
      {promoteStmt && (
        <PromoteToCaseModal
          statement={{
            id: promoteStmt.id,
            summary: promoteStmt.summary,
            kind: promoteStmt.kind,
            occurredAt: promoteStmt.occurredAt,
            participants: promoteStmt.participants.map((p) => ({
              studentId: p.studentId,
              firstName: p.firstName,
              lastName: p.lastName,
            })),
          }}
          onClose={() => setPromoteStmt(null)}
          onPromoted={(caseId) => {
            setPromoteStmt(null);
            void reload();
            onOpenCase?.(caseId);
          }}
        />
      )}
    </div>
  );
}
