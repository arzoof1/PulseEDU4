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
import LogInteractionModal from "./watchlist/LogInteractionModal";
import NewCaseModal from "./watchlist/NewCaseModal";
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
  const [showLog, setShowLog] = useState(false);
  const [showNewCase, setShowNewCase] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyAlert, setBusyAlert] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [r1, r2, r3, r4, r5, r6] = await Promise.all([
        authFetch(`/api/watchlist/summary`),
        authFetch(`/api/watchlist/alerts?windowDays=${windowDays}`),
        authFetch(`/api/watchlist/orbit?windowDays=${windowDays}`),
        authFetch(`/api/watchlist/cases`),
        authFetch(`/api/watchlist/interactions?windowDays=${windowDays}&limit=12`),
        authFetch(`/api/watchlist/statements`),
      ]);
      if (!r1.ok || !r2.ok || !r3.ok || !r4.ok || !r5.ok || !r6.ok) {
        throw new Error("Failed to load Watchlist Hub data");
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
  }, [windowDays]);

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
              Watchlist Hub
            </h1>
            <p className="mt-1 max-w-2xl text-sm" style={{ color: C.inkSoft }}>
              Students surfacing across the Interaction Log — the ones showing up{" "}
              <span className="font-semibold" style={{ color: C.brand }}>
                from a distance
              </span>{" "}
              but never quite in the middle. Triage alerts, open cases, request statements.
            </p>
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
              <Plus className="h-4 w-4" /> Log interaction
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
          {[7, 14, 30, 90].map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setWindowDays(w)}
              className="rounded-md px-2.5 py-1 text-xs font-semibold"
              style={{
                background: w === windowDays ? C.ink : "transparent",
                color: w === windowDays ? "#fff" : C.ink,
                border: `1px solid ${w === windowDays ? C.ink : C.line}`,
              }}
            >
              {w === 90 ? "Term" : `${w} days`}
            </button>
          ))}
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
            style={{ background: C.alertSoft, color: C.alert }}
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
                          ? { label: "Always peripheral", bg: C.alertSoft, fg: C.alert }
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
            <div className="mt-3 flex flex-col gap-2">
              {cases.length === 0 ? (
                <div className="text-sm" style={{ color: C.inkSoft }}>
                  No cases yet. Open one when a pattern needs a thread.
                </div>
              ) : (
                cases
                  .filter((c) => c.status !== "closed")
                  .slice(0, 6)
                  .map((c) => {
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
                              Case #{c.caseNumber}
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
                  })
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
            <div className="flex items-baseline justify-between">
              <h2 className="text-lg font-bold tracking-tight">Recent incidents</h2>
            </div>
            <div className="mt-3 divide-y" style={{ borderColor: C.line }}>
              {interactions.length === 0 ? (
                <div className="py-6 text-center text-sm" style={{ color: C.inkSoft }}>
                  Nothing logged in this window.
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
                          ) : (
                            <span
                              className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold"
                              style={{ background: C.bg, color: C.inkSoft }}
                            >
                              Loose
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
                        </div>
                      </div>
                      <ChevronRight className="mt-2 h-4 w-4" style={{ color: C.inkSoft }} />
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
                    ? { bg: C.alertSoft, fg: C.alert, label: "Stale" }
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
          Watchlist Hub · {initialsOf("Pulse", "EDU")}
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
    </div>
  );
}
