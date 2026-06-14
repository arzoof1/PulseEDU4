import { useEffect, useMemo, useState } from "react";
import {
  Heart,
  Award,
  Footprints,
  Clock,
  GraduationCap,
  ChevronDown,
  Calendar,
  Activity,
  LogOut,
  Star,
  CheckCircle2,
  TrendingUp,
  TrendingDown,
  BookOpen,
  Target,
  HandHelping,
  SlidersHorizontal,
  Download,
  ShieldAlert,
} from "lucide-react";
import Preferences from "./Preferences";
import { Card, CardContent } from "@/components/ui/card";
import { useSchoolBranding } from "../lib/branding";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import QRCode from "qrcode";
import { Ticket } from "lucide-react";
import { parentFetch, setParentToken, navigate, type ParentMe } from "./api";

interface Snapshot {
  parent: { displayName: string; email: string };
  student: {
    id: number;
    studentId: string;
    firstName: string;
    lastName: string;
    grade: number;
    // Grades the student was retained in (ascending). Empty when none.
    // Drives the small "R" indicator next to the grade label.
    retainedGrades: number[];
  };
  sectionsAvailable: Record<string, boolean>;
  pbis: {
    total: number;
    thisWeek: number;
    // Full-week counts (server-side) — preferred over filtering `recent`
    // because recent is capped at 10 entries.
    weeklyCounts?: { positive: number; negative: number };
    sparkline: number[];
    recent: Array<{
      id: number;
      reason: string;
      points: number;
      polarity: string;
      staffName: string;
      createdAt: string;
      note: string | null;
    }>;
  };
  hallPasses: {
    thisWeekCount: number;
    recent: Array<{
      id: number;
      destination: string;
      originRoom: string;
      teacherName: string;
      status: string;
      createdAt: string;
      endedAt: string | null;
      // One-way lifecycle: when a non-restroom pass is checked in at the
      // destination the server stamps WHEN (`arrivedAt`) and WHO received
      // them (`endedBy`, a staff displayName or "(origin)"/"(system)").
      // Restroom passes stay round-trip and leave these null.
      arrivedAt?: string | null;
      endedBy?: string | null;
      // True for one-way (non-restroom) passes. Restroom passes are
      // round-trip and must never show an "in route" state.
      oneWay?: boolean;
    }>;
  };
  lostInstruction: {
    hallPasses: { count: number; minutes: number };
    tardies: { count: number; minutes: number };
    absences: { count: number; minutes: number };
    totalMinutes: number;
  };
  attendance: {
    tardiesThisWeek: number;
    checkInsThisWeek: number;
    pct: {
      ytd: { presentDays: number; totalDays: number; pct: number } | null;
      last30: { presentDays: number; totalDays: number; pct: number } | null;
    };
    onTimeStreak: {
      current: number;
      longestYtd: number;
      pctYtd: number | null;
      countedPeriods: number;
    } | null;
    recent: Array<{
      id: number;
      entryType: string;
      period: string;
      teacherName: string;
      reason: string;
      createdAt: string;
    }>;
  };
  accommodations: Array<{ id: number; name: string; category: string }>;
  staffNotes: Array<{
    id: number;
    noteType: string;
    noteText: string;
    staffName: string;
    createdAt: string;
  }>;
  // Insights v2 — gated parent-facing pillars added in T13. Optional
  // here so an older API server (which doesn't return these keys) still
  // type-checks; the body uses `?? []` / `?? {tier:1, plans:[]}` to
  // handle the missing case gracefully.
  fastScores?: Array<{
    subject: "ela" | "math";
    pm1: number | null;
    pm2: number | null;
    pm3: number | null;
    priorYearScore: number | null;
    priorYearBq: boolean;
  }>;
  interventions?: Array<{
    interventionType: string;
    note: string | null;
    staffName: string;
    createdAt: string;
  }>;
  mtss?: {
    tier: number;
    plans: Array<{
      id: number;
      title: string;
      tier: number;
      openedAt: string;
      goals: string | null;
    }>;
  };
  // OSS section — optional so older API servers without the field still
  // type-check. `reason` / `notes` are only populated when the school
  // also enabled the separate `showOssReason` policy flag.
  oss?: {
    daysThisYear: number;
    recent: Array<{
      day: string;
      reason: string | null;
      notes: string | null;
    }>;
  };
  // Reteach activity — gated by sec.reteach. Counts-only rollup; no
  // teacher notes or strategy ever leave the server. Optional so
  // older API servers without the field still type-check.
  reteach?: {
    items: Array<{
      benchmarkCode: string;
      oneOnOne: number;
      smallGroup: number;
      total: number;
      lastAt: string;
    }>;
  };
  // PBIS house affiliation. Optional so older API servers still
  // type-check. Null when the student isn't on a house (or the
  // school doesn't run houses). `totalPoints` is the school-wide
  // house total — same number kids see on the hallway TVs.
  house?: {
    id: number;
    name: string;
    color: string;
    motto: string | null;
    iconKey: string | null;
    iconObjectKey: string | null;
    totalPoints: number;
  } | null;
}

const EkgDivider = () => (
  <div className="flex items-center justify-center my-8 opacity-20">
    <div className="h-px bg-red-500 flex-1" />
    <svg
      width="120"
      height="24"
      viewBox="0 0 120 24"
      fill="none"
      className="text-red-500 mx-4"
    >
      <path
        d="M0 12H30L35 4L45 20L50 12H70L75 8L85 16L90 12H120"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
    <div className="h-px bg-red-500 flex-1" />
  </div>
);

// Pulls the suggested filename out of a Content-Disposition header so
// downloaded files keep the server-chosen name instead of an opaque
// blob:UUID. Handles both quoted and unquoted forms; returns null when
// the header is missing or unparseable.
function parseFilenameFromCD(cd: string | null): string | null {
  if (!cd) return null;
  const match = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  return match?.[1] ?? null;
}

function initials(first: string, last: string): string {
  return (first.charAt(0) + last.charAt(0)).toUpperCase();
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export default function Dashboard({ me }: { me: ParentMe }) {
  // Pull the active child's school branding into CSS vars; the snapshot
  // header below uses var(--brand-header-bg) when set.
  useSchoolBranding({ mode: "parent" });
  const [activeStudentId, setActiveStudentId] = useState<number | null>(
    me.students[0]?.id ?? null,
  );
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Set when the server returns 403 parent_portal_disabled — the school
  // has turned off the parent-portal license. We render a dedicated
  // friendly screen rather than the raw error string.
  const [portalDisabled, setPortalDisabled] = useState(false);
  const [view, setView] = useState<"snapshot" | "prefs">("snapshot");
  // Bumping this nonce forces the snapshot effect to re-run even when
  // activeStudentId is unchanged — used after returning from the
  // Preferences panel so toggles take effect immediately.
  const [snapshotNonce, setSnapshotNonce] = useState(0);
  // Tracks whether a PDF download is in flight so we can disable the
  // button + show a "Downloading…" label and avoid double-clicks
  // hitting the server twice.
  const [pdfDownloading, setPdfDownloading] = useState(false);
  const [pdfError, setPdfError] = useState("");

  useEffect(() => {
    if (activeStudentId === null) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    setPortalDisabled(false);
    (async () => {
      try {
        const res = await parentFetch(
          `/api/parent/snapshot?studentId=${activeStudentId}`,
        );
        if (cancelled) return;
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          if (res.status === 403 && body.error === "parent_portal_disabled") {
            setPortalDisabled(true);
          } else {
            setError(body.error ?? `Could not load snapshot (${res.status})`);
          }
        } else {
          setSnapshot((await res.json()) as Snapshot);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Network error");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeStudentId, snapshotNonce]);

  async function handleSignOut() {
    try {
      await fetch("/api/parent-auth/logout", {
        method: "POST",
        credentials: "include",
      });
    } catch {
      /* swallow */
    }
    setParentToken(null);
    navigate("/parent/login");
  }

  // Triggers the server-rendered PDF for the active student. We fetch
  // the file as a blob (so parentFetch can attach the Bearer token if
  // the cookie session has expired) and then synthesize an invisible
  // <a download> click. Object URL is revoked on the next tick so we
  // don't leak memory after a long parent session with many downloads.
  async function handleDownloadPdf() {
    if (!activeStudentId) return;
    // Early-return guard against rapid double-clicks. The button has
    // `disabled={pdfDownloading}`, but React only applies that on the
    // next render tick — two clicks in the same frame would otherwise
    // fire two server requests.
    if (pdfDownloading) return;
    setPdfDownloading(true);
    setPdfError("");
    try {
      const res = await parentFetch(
        `/api/parent/snapshot.pdf?studentId=${activeStudentId}`,
      );
      if (!res.ok) {
        const msg =
          (await res.json().catch(() => null))?.error ??
          `Could not download report (${res.status})`;
        setPdfError(msg);
        return;
      }
      const blob = await res.blob();
      const filename =
        parseFilenameFromCD(res.headers.get("Content-Disposition")) ??
        "HeartBEAT-Snapshot.pdf";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (e) {
      setPdfError(e instanceof Error ? e.message : "Could not download report");
    } finally {
      setPdfDownloading(false);
    }
  }

  if (portalDisabled) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
        <div className="max-w-md w-full bg-white border border-slate-200 rounded-2xl p-8 text-center shadow-sm">
          <div className="mx-auto mb-4 h-12 w-12 rounded-full bg-amber-100 flex items-center justify-center">
            <ShieldAlert className="h-6 w-6 text-amber-600" />
          </div>
          <div className="text-lg font-semibold mb-2">
            Parent portal paused
          </div>
          <p className="text-sm text-slate-600 mb-6">
            Your school has paused the parent portal. Please contact the
            school office for an update, or check back later.
          </p>
          <Button variant="outline" onClick={handleSignOut}>
            Sign out
          </Button>
        </div>
      </div>
    );
  }

  if (me.students.length === 0) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
        <div className="max-w-md w-full bg-white border border-slate-200 rounded-2xl p-8 text-center shadow-sm">
          <div className="text-lg font-semibold mb-2">No students linked</div>
          <p className="text-sm text-slate-600 mb-4">
            Your account isn't linked to any students yet. Please contact your
            school office and ask them to send you an invite.
          </p>
          <Button variant="outline" onClick={handleSignOut}>
            Sign out
          </Button>
        </div>
      </div>
    );
  }

  const activeStudent =
    me.students.find((s) => s.id === activeStudentId) ?? me.students[0];

  if (view === "prefs" && activeStudent) {
    return (
      <Preferences
        studentId={activeStudent.id}
        studentName={activeStudent.firstName}
        onBack={() => {
          setView("snapshot");
          // Force a snapshot refetch so any toggle changes show up
          // right away. Bumping a separate nonce (rather than re-setting
          // activeStudentId to itself) is necessary because React bails
          // out of state updates that produce the same value.
          setSnapshotNonce((n) => n + 1);
        }}
      />
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 font-sans pb-24">
      <div className="h-1.5 w-full bg-gradient-to-r from-violet-600 via-teal-600 to-green-600" />

      <main className="max-w-6xl mx-auto px-6 pt-8 space-y-8">
        {/* Identity strip */}
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6 bg-white p-6 rounded-3xl shadow-sm border border-slate-100">
          <div className="flex items-center gap-5 min-w-0">
            <Avatar className="h-20 w-20 border-4 border-slate-50 shadow-sm ring-1 ring-slate-100">
              <AvatarFallback className="bg-gradient-to-br from-violet-100 to-teal-100 text-violet-700 text-2xl font-bold">
                {initials(activeStudent.firstName, activeStudent.lastName)}
              </AvatarFallback>
            </Avatar>
            <div className="space-y-1 min-w-0">
              <div className="flex items-center gap-3 flex-wrap">
                {me.students.length > 1 ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button className="flex items-center gap-2 hover:opacity-80 transition-opacity">
                        <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
                          {activeStudent.firstName} {activeStudent.lastName}
                        </h1>
                        <ChevronDown className="h-5 w-5 text-slate-400" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-64">
                      {me.students.map((s) => (
                        <DropdownMenuItem
                          key={s.id}
                          className={
                            s.id === activeStudent.id
                              ? "font-medium bg-slate-50"
                              : ""
                          }
                          onSelect={() => setActiveStudentId(s.id)}
                        >
                          {s.firstName} {s.lastName} ({gradeLabel(s.grade)})
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : (
                  <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
                    {activeStudent.firstName} {activeStudent.lastName}
                  </h1>
                )}
              </div>
              <p className="text-slate-500 font-medium flex items-center gap-2">
                <span>
                  {gradeLabel(activeStudent.grade)} · ID {activeStudent.localSisId ?? "—"}
                </span>
                {snapshot?.student.retainedGrades &&
                  snapshot.student.retainedGrades.length > 0 && (
                    <span
                      title={`Retained: ${snapshot.student.retainedGrades
                        .map((g: number) => `Grade ${g}`)
                        .join(", ")}`}
                      aria-label={`Retained at ${snapshot.student.retainedGrades
                        .map((g: number) => `Grade ${g}`)
                        .join(", ")}`}
                      className="inline-flex items-center justify-center rounded-full bg-slate-900 text-white text-[11px] font-extrabold leading-none cursor-help"
                      style={{ width: 18, height: 18 }}
                    >
                      R
                    </span>
                  )}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="text-right hidden sm:block">
              <p className="text-xs text-slate-400 uppercase tracking-wider">
                Signed in
              </p>
              <p className="text-sm font-medium text-slate-700">
                {me.displayName}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleDownloadPdf}
              disabled={pdfDownloading || !snapshot}
              className="gap-2"
              title="Download a PDF copy of this report"
            >
              <Download className="h-4 w-4" />
              <span className="hidden sm:inline">
                {pdfDownloading ? "Preparing…" : "Download PDF"}
              </span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setView("prefs")}
              className="gap-2"
            >
              <SlidersHorizontal className="h-4 w-4" />
              <span className="hidden sm:inline">What I see</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleSignOut}
              className="gap-2"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </Button>
          </div>
        </div>

        {pdfError && (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-3 text-sm">
            {pdfError}
          </div>
        )}

        {loading && (
          <div className="text-sm text-slate-500 text-center py-12">
            Loading snapshot…
          </div>
        )}

        {error && !loading && (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-4 text-sm">
            {error}
          </div>
        )}

        {snapshot && !loading && (
          <SnapshotBody snapshot={snapshot} />
        )}
      </main>
    </div>
  );
}

function SnapshotBody({ snapshot }: { snapshot: Snapshot }) {
  const { sectionsAvailable: sec } = snapshot;
  const onTrack = useMemo(() => {
    if (snapshot.pbis.thisWeek >= 5) return true;
    if (snapshot.attendance.tardiesThisWeek >= 3) return false;
    return true;
  }, [snapshot.pbis.thisWeek, snapshot.attendance.tardiesThisWeek]);

  return (
    <>
      {/* Status badge */}
      <div className="flex items-center gap-2">
        <Badge
          variant="secondary"
          className={
            onTrack
              ? "bg-green-100 text-green-700 hover:bg-green-100"
              : "bg-amber-100 text-amber-700 hover:bg-amber-100"
          }
        >
          {onTrack ? "On track this week" : "Needs attention this week"}
        </Badge>
      </div>

      {/* Event tickets — QR codes for published school events (8th-grade
          promotion, graduation, etc.). Fetched separately from the snapshot;
          the section renders only when the student actually has tickets, so
          it stays invisible until a school issues them. */}
      <TicketsSection studentId={snapshot.student.id} />

      {/* House affiliation tile — shows the student's PBIS house, its
          custom logo (or letter-bubble fallback), and the current
          school-wide house total. Same number families see on the
          hallway signage. Gated under `recognition` like everything
          PBIS. */}
      {sec.recognition && snapshot.house && (
        <HouseTile house={snapshot.house} />
      )}

      {/* Parent-facing weekly mood meter — same red(left)/green(right)
          pattern as the signage screens so families learn to read it once.
          Counts come from the snapshot we already have, no extra fetch. */}
      {sec.recognition && <ParentMoodMeter snapshot={snapshot} />}

      {/* Pulse cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {sec.recognition && (
          <PulseCard
            label="PBIS Points"
            value={snapshot.pbis.total}
            delta={
              snapshot.pbis.thisWeek > 0
                ? `+${snapshot.pbis.thisWeek} this wk`
                : "0 this wk"
            }
            deltaPositive={snapshot.pbis.thisWeek > 0}
            icon={<Award className="h-4 w-4 text-violet-500" />}
            accent="from-violet-500 to-green-500"
            sparkline={snapshot.pbis.sparkline}
          />
        )}
        {sec.hallPasses && (
          <PulseCard
            label="Hall Passes"
            value={snapshot.hallPasses.thisWeekCount}
            delta="this week"
            deltaPositive
            icon={<Footprints className="h-4 w-4 text-teal-500" />}
            accent="from-teal-500 to-blue-500"
          />
        )}
        {sec.attendance && (
          <PulseCard
            label="Tardies"
            value={snapshot.attendance.tardiesThisWeek}
            delta="this week"
            deltaPositive={snapshot.attendance.tardiesThisWeek === 0}
            icon={<Clock className="h-4 w-4 text-orange-500" />}
            accent="from-orange-500 to-amber-500"
          />
        )}
        {sec.accommodations && (
          <PulseCard
            label="Accommodations"
            value={snapshot.accommodations.length}
            delta="active"
            deltaPositive
            icon={<GraduationCap className="h-4 w-4 text-blue-500" />}
            accent="from-blue-500 to-violet-500"
          />
        )}
      </div>

      {/* Lost Instructional Time — pinned to the top. Grand total plus a
          per-source breakdown (hall passes / tardies / absences), all
          school-year-to-date. Each row respects its own section toggle:
          hall passes hide with the Hall Passes section, tardies + absences
          with the Attendance section, and the grand total only sums the
          rows that are visible. Absences are KIOSK-DERIVED (periods with no
          door-kiosk check-in), not official daily attendance. */}
      {(sec.hallPasses || sec.attendance) && (
        <Section
          title="Lost Instructional Time"
          icon={<Clock className="h-4 w-4 text-rose-600" />}
        >
          <div className="rounded-lg border border-rose-100 bg-rose-50/60 p-4 mb-3">
            <div className="text-[10px] uppercase tracking-wide text-rose-700/80">
              Total this school year
            </div>
            <div className="text-3xl font-bold tabular-nums text-rose-700">
              {snapshot.lostInstruction.totalMinutes} min
            </div>
            <div className="text-[11px] text-slate-500">
              estimated instruction missed
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {sec.hallPasses && (
              <AttendanceTile
                label="Hall passes"
                value={`${snapshot.lostInstruction.hallPasses.minutes} min`}
                sub={`${snapshot.lostInstruction.hallPasses.count} ${
                  snapshot.lostInstruction.hallPasses.count === 1
                    ? "pass"
                    : "passes"
                }`}
              />
            )}
            {sec.attendance && (
              <AttendanceTile
                label="Tardies"
                value={`${snapshot.lostInstruction.tardies.minutes} min`}
                sub={`${snapshot.lostInstruction.tardies.count} ${
                  snapshot.lostInstruction.tardies.count === 1
                    ? "tardy"
                    : "tardies"
                }`}
              />
            )}
            {sec.attendance && (
              <AttendanceTile
                label="Absences"
                value={`${snapshot.lostInstruction.absences.minutes} min`}
                sub={`${snapshot.lostInstruction.absences.count} ${
                  snapshot.lostInstruction.absences.count === 1
                    ? "period missed"
                    : "periods missed"
                }`}
              />
            )}
          </div>
          {sec.attendance && (
            <p className="text-[11px] text-slate-400 mt-2">
              Absences are estimated from class periods with no door-kiosk
              check-in, not official daily attendance.
            </p>
          )}
        </Section>
      )}

      {/* Recognition */}
      {sec.recognition && (
        <Section
          title="Recognition"
          icon={<Star className="h-4 w-4 text-violet-600" />}
        >
          {snapshot.pbis.recent.length === 0 ? (
            <Empty text="No PBIS points recorded yet." />
          ) : (
            <ul className="divide-y divide-slate-100">
              {snapshot.pbis.recent.map((r) => (
                <li
                  key={r.id}
                  className="flex items-center justify-between py-3 gap-4"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-800">
                      {r.reason}
                    </div>
                    <div className="text-xs text-slate-500">
                      {r.staffName} · {fmtDate(r.createdAt)}
                    </div>
                    {r.note && (
                      <div className="text-xs text-slate-600 mt-1 italic">
                        "{r.note}"
                      </div>
                    )}
                  </div>
                  <Badge
                    className={
                      r.polarity === "negative"
                        ? "bg-red-100 text-red-700 hover:bg-red-100"
                        : "bg-violet-100 text-violet-700 hover:bg-violet-100"
                    }
                  >
                    {r.polarity === "negative" ? "" : "+"}
                    {r.points}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {/* Attendance */}
      {sec.attendance && (
        <Section
          title="Attendance"
          icon={<Calendar className="h-4 w-4 text-orange-600" />}
        >
          {/* Aggregate tiles. Attendance % (YTD + 30d) shows whenever
              any attendance-day data exists. On-time streak tiles only
              appear when the school has a default bell schedule with
              at least one counted period AND the student has logged
              attendance days to back the calculation. Hides cleanly
              when nothing has been recorded yet so a new SIS feed
              doesn't render placeholder tiles. */}
          {(snapshot.attendance.pct.ytd ||
            snapshot.attendance.pct.last30 ||
            snapshot.attendance.onTimeStreak) && (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 mb-4">
              <AttendanceTile
                label="Attendance · YTD"
                value={
                  snapshot.attendance.pct.ytd
                    ? `${snapshot.attendance.pct.ytd.pct}%`
                    : "—"
                }
                sub={
                  snapshot.attendance.pct.ytd
                    ? `${snapshot.attendance.pct.ytd.presentDays} / ${snapshot.attendance.pct.ytd.totalDays} days`
                    : "no data yet"
                }
              />
              <AttendanceTile
                label="Attendance · 30d"
                value={
                  snapshot.attendance.pct.last30
                    ? `${snapshot.attendance.pct.last30.pct}%`
                    : "—"
                }
                sub={
                  snapshot.attendance.pct.last30
                    ? `${snapshot.attendance.pct.last30.presentDays} / ${snapshot.attendance.pct.last30.totalDays} days`
                    : "no data yet"
                }
              />
              {snapshot.attendance.onTimeStreak && (
                <>
                  <AttendanceTile
                    label="On-time streak"
                    value={`${snapshot.attendance.onTimeStreak.current}`}
                    sub={
                      snapshot.attendance.onTimeStreak.current === 1
                        ? "period in a row"
                        : "periods in a row"
                    }
                    accent="emerald"
                  />
                  <AttendanceTile
                    label="Longest streak · YTD"
                    value={`${snapshot.attendance.onTimeStreak.longestYtd}`}
                    sub={
                      snapshot.attendance.onTimeStreak.longestYtd === 1
                        ? "period"
                        : "periods"
                    }
                    accent="emerald"
                  />
                  <AttendanceTile
                    label="On-time · YTD"
                    value={
                      snapshot.attendance.onTimeStreak.pctYtd != null
                        ? `${snapshot.attendance.onTimeStreak.pctYtd}%`
                        : "—"
                    }
                    sub={`${snapshot.attendance.onTimeStreak.countedPeriods} periods`}
                    accent="emerald"
                  />
                </>
              )}
            </div>
          )}
          {snapshot.attendance.recent.length === 0 ? (
            <Empty text="No tardies or check-ins recorded." />
          ) : (
            <ul className="divide-y divide-slate-100">
              {snapshot.attendance.recent.map((r) => (
                <li
                  key={r.id}
                  className="flex items-center justify-between py-3 gap-4"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-800 capitalize">
                      {r.entryType.replace(/_/g, " ")}
                      {r.period ? ` · ${r.period}` : ""}
                    </div>
                    <div className="text-xs text-slate-500">
                      {r.teacherName}
                      {r.reason ? ` · ${r.reason}` : ""}
                    </div>
                  </div>
                  <div className="text-xs text-slate-500 text-right shrink-0">
                    <div>{fmtDate(r.createdAt)}</div>
                    <div>{fmtTime(r.createdAt)}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {/* Hall passes */}
      {sec.hallPasses && (
        <Section
          title="Hall Passes"
          icon={<Footprints className="h-4 w-4 text-teal-600" />}
        >
          {snapshot.hallPasses.recent.length === 0 ? (
            <Empty text="No hall passes used." />
          ) : (
            <ul className="divide-y divide-slate-100">
              {snapshot.hallPasses.recent.map((r) => {
                // One-way lifecycle states (restroom passes stay round-trip
                // and leave arrivedAt/endedBy null, so they fall through to
                // the existing departure-only display):
                //   • arrived  → checked in at the destination
                //   • in route → active, non-restroom, not yet checked in
                const arrived = Boolean(r.arrivedAt);
                // Only one-way (non-restroom) passes have an "in route" state.
                // Active restroom passes are round-trip and must fall through
                // to the plain departure-only display.
                const inRoute =
                  r.oneWay !== false && !arrived && r.status === "active";
                // Hide the "(origin)"/"(system)" sentinels — only surface a
                // real staff name as the receiver to families.
                const receivedBy =
                  r.endedBy && !r.endedBy.startsWith("(") ? r.endedBy : null;
                return (
                  <li
                    key={r.id}
                    className="flex items-center justify-between py-3 gap-4"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-slate-800">
                          {r.destination}
                        </span>
                        {arrived && (
                          <Badge
                            variant="secondary"
                            className="bg-green-100 text-green-700 hover:bg-green-100 text-[10px] px-2 py-0"
                          >
                            Arrived
                          </Badge>
                        )}
                        {inRoute && (
                          <Badge
                            variant="secondary"
                            className="bg-amber-100 text-amber-700 hover:bg-amber-100 text-[10px] px-2 py-0"
                          >
                            In route
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-slate-500">
                        {r.originRoom} · {r.teacherName}
                      </div>
                      {arrived && receivedBy && (
                        <div className="text-xs text-slate-400 mt-0.5">
                          Received by {receivedBy}
                        </div>
                      )}
                    </div>
                    <div className="text-xs text-slate-500 text-right shrink-0">
                      <div>{fmtDate(r.createdAt)}</div>
                      <div>Left {fmtTime(r.createdAt)}</div>
                      {arrived && r.arrivedAt && (
                        <div className="text-green-600">
                          Arrived {fmtTime(r.arrivedAt)}
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      )}

      {/* Staff notes (only if school enabled) */}
      {sec.staffNotes && snapshot.staffNotes.length > 0 && (
        <Section
          title="Staff Notes"
          icon={<Activity className="h-4 w-4 text-slate-600" />}
        >
          <ul className="divide-y divide-slate-100">
            {snapshot.staffNotes.map((n) => (
              <li key={n.id} className="py-3">
                <div className="flex items-center justify-between gap-4">
                  <div className="text-sm font-medium text-slate-800">
                    {n.noteType}
                  </div>
                  <div className="text-xs text-slate-500">
                    {fmtDate(n.createdAt)}
                  </div>
                </div>
                <div className="text-sm text-slate-600 mt-1">{n.noteText}</div>
                <div className="text-xs text-slate-400 mt-1">{n.staffName}</div>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* Academics — FAST progress monitoring scores. Each subject is a
          separate tile so families can read ELA and Math independently;
          we always show all three PMs (PM1=fall, PM2=winter, PM3=spring)
          even when later ones are null, so the year-long arc is visible.
          Section is hidden entirely when the school disables it OR when
          there are simply no rows for this student. */}
      {sec.fastScores && (snapshot.fastScores ?? []).length > 0 && (
        <Section
          title="Academics — FAST Scores"
          icon={<BookOpen className="h-4 w-4 text-blue-600" />}
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {(snapshot.fastScores ?? []).map((s) => (
              <FastScoreCard key={s.subject} score={s} />
            ))}
          </div>
        </Section>
      )}

      {/* Support Plan — active MTSS plans.
          INTENTIONAL EXEMPTION from the "flag + presence of data" rule
          that gates the other new sections. Unlike FAST and
          interventions (where empty = no information), an empty MTSS
          state is itself meaningful: it tells the parent the school is
          tracking MTSS for their child AND there is currently no
          active intervention plan. Hiding the section in that case
          would create the worse outcome of the parent wondering whether
          the school disabled visibility or whether their child simply
          has no plan. So: render whenever sec.mtss is true, regardless
          of plan count, and let MtssBlock render the "Tier 1 — no
          active plan" chip. Goals are intentionally surfaced because
          the school chose to enable this section. */}
      {sec.mtss && (
        <Section
          title="Support Plan"
          icon={<Target className="h-4 w-4 text-emerald-600" />}
        >
          <MtssBlock mtss={snapshot.mtss ?? { tier: 1, plans: [] }} />
        </Section>
      )}

      {/* Extra Support — Focused Reteach. Counts-only rollup of
          benchmark_reteach_log rows for the current school year, gated by
          BOTH the school-wide showReteach flag, the parent's pref, AND
          the per-student reteach_logs_parent_visible toggle. Teacher
          notes / strategy are NEVER in the payload — see
          lib/parentSnapshot.ts. Section hides when there are zero rows
          so the page doesn't end with an empty block. */}
      {sec.reteach && (snapshot.reteach?.items ?? []).length > 0 && (
        <Section
          title="Extra Support — Focused Reteach"
          icon={<Target className="h-4 w-4 text-indigo-600" />}
        >
          <p className="text-sm text-slate-600 mb-3">
            In addition to the regular classroom lessons every student
            receives, your child's teachers have provided focused extra
            practice on the standards below this school year.
          </p>
          <ul className="divide-y divide-slate-100">
            {(snapshot.reteach?.items ?? []).map((r) => (
              <li
                key={r.benchmarkCode}
                className="py-3 flex items-center justify-between gap-4"
              >
                <div className="min-w-0">
                  <div className="text-sm font-mono font-semibold text-slate-800">
                    {r.benchmarkCode}
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    Most recent {fmtDate(r.lastAt)}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {r.oneOnOne > 0 && (
                    <Badge
                      variant="outline"
                      className="bg-indigo-50 text-indigo-700 border-indigo-200 tabular-nums"
                    >
                      1:1 × {r.oneOnOne}
                    </Badge>
                  )}
                  {r.smallGroup > 0 && (
                    <Badge
                      variant="outline"
                      className="bg-teal-50 text-teal-700 border-teal-200 tabular-nums"
                    >
                      Small group × {r.smallGroup}
                    </Badge>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* Recent Support — last 10 redacted intervention entries. Hidden
          when there's nothing to show so the page doesn't end with an
          empty block. */}
      {sec.interventions && (snapshot.interventions ?? []).length > 0 && (
        <Section
          title="Recent Support"
          icon={<HandHelping className="h-4 w-4 text-violet-600" />}
        >
          <ul className="divide-y divide-slate-100">
            {(snapshot.interventions ?? []).map((iv, idx) => (
              <li key={`${iv.createdAt}-${idx}`} className="py-3">
                <div className="flex items-center justify-between gap-4">
                  <div className="text-sm font-medium text-slate-800">
                    {iv.interventionType}
                  </div>
                  <div className="text-xs text-slate-500">
                    {fmtDate(iv.createdAt)}
                  </div>
                </div>
                {iv.note && (
                  <div className="text-sm text-slate-600 mt-1">
                    {iv.note}
                  </div>
                )}
                <div className="text-xs text-slate-400 mt-1">
                  {iv.staffName}
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* OSS — out-of-school suspension. Always rendered when sec.oss is
          true (a "0 days this year" tile is itself meaningful — it tells
          parents the school is sharing OSS info AND there's nothing on
          file). Reason / notes only appear when the school separately
          enabled showOssReason; the server already nulls those fields
          out otherwise so we just render whatever's present. */}
      {sec.oss && (
        <Section
          title="Out-of-School Suspension"
          icon={<ShieldAlert className="h-4 w-4 text-rose-600" />}
        >
          <div className="mb-4 flex items-center gap-3">
            <div
              className={
                "flex items-baseline gap-2 px-3 py-2 rounded-lg border " +
                ((snapshot.oss?.daysThisYear ?? 0) === 0
                  ? "bg-emerald-50 border-emerald-200"
                  : "bg-rose-50 border-rose-200")
              }
            >
              <span
                className={
                  "text-2xl font-bold tabular-nums " +
                  ((snapshot.oss?.daysThisYear ?? 0) === 0
                    ? "text-emerald-700"
                    : "text-rose-700")
                }
              >
                {snapshot.oss?.daysThisYear ?? 0}
              </span>
              <span className="text-xs text-slate-600 font-medium">
                day{(snapshot.oss?.daysThisYear ?? 0) === 1 ? "" : "s"} this
                school year
              </span>
            </div>
          </div>
          {(snapshot.oss?.recent ?? []).length === 0 ? (
            <Empty text="No OSS days on file this school year." />
          ) : (
            <ul className="divide-y divide-slate-100">
              {(snapshot.oss?.recent ?? []).map((r) => (
                <li
                  key={r.day}
                  className="flex items-start justify-between py-3 gap-4"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-800">
                      {fmtDate(r.day)}
                    </div>
                    {r.reason && (
                      <div className="text-xs text-slate-600 mt-0.5">
                        {r.reason}
                      </div>
                    )}
                    {r.notes && (
                      <div className="text-xs text-slate-500 mt-1 italic">
                        {r.notes}
                      </div>
                    )}
                  </div>
                  <Badge className="bg-rose-100 text-rose-700 hover:bg-rose-100 shrink-0">
                    OSS
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {/* Accommodations — pinned to the bottom of the stack. */}
      {sec.accommodations && (
        <Section
          title="Accommodations"
          icon={<GraduationCap className="h-4 w-4 text-blue-600" />}
        >
          {snapshot.accommodations.length === 0 ? (
            <Empty text="No accommodations on file." />
          ) : (
            <div className="flex flex-wrap gap-2">
              {snapshot.accommodations.map((a) => (
                <div
                  key={a.id}
                  className="flex items-center gap-2 bg-blue-50 border border-blue-100 text-blue-800 rounded-full px-3 py-1.5 text-xs"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  <span className="font-medium">{a.name}</span>
                  <span className="text-blue-600/70">· {a.category}</span>
                </div>
              ))}
            </div>
          )}
        </Section>
      )}

      <EkgDivider />
      <div className="text-center text-xs text-slate-400 flex items-center justify-center gap-1.5">
        <Heart className="h-3 w-3" fill="currentColor" />
        Pulse<span className="font-semibold">EDU</span> HeartBEAT Snapshot
      </div>
    </>
  );
}

// -----------------------------------------------------------------------------
// ParentMoodMeter — week-at-a-glance for a single student.
//
// Counts come straight from the snapshot we already loaded:
//   - positive / negative: from snapshot.pbis.recent (filtered to last 7 days)
//   - concern: snapshot.attendance.tardiesThisWeek
//   - net points: snapshot.pbis.thisWeek (already a signed weekly total)
// We deliberately don't fire a second fetch — the parent dashboard's first
// paint should remain a single round-trip.
// -----------------------------------------------------------------------------
function ParentMoodMeter({ snapshot }: { snapshot: Snapshot }) {
  // Prefer the server-computed weekly counts (full week, no truncation).
  // Fall back to filtering `recent` only if an older API server hasn't
  // shipped the field yet — in that case the ratio will be approximate.
  const weeklyCounts = snapshot.pbis.weeklyCounts;
  let positiveCount: number;
  let negativeCount: number;
  if (weeklyCounts) {
    positiveCount = weeklyCounts.positive;
    negativeCount = weeklyCounts.negative;
  } else {
    const weekAgo = Date.now() - 7 * 24 * 60 * 60_000;
    const weekRecent = snapshot.pbis.recent.filter((r) => {
      const t = new Date(r.createdAt).getTime();
      return Number.isFinite(t) && t >= weekAgo;
    });
    positiveCount = weekRecent.filter((r) => r.polarity === "positive").length;
    negativeCount = weekRecent.filter((r) => r.polarity === "negative").length;
  }
  const concernCount = snapshot.attendance.tardiesThisWeek;

  const net = snapshot.pbis.thisWeek;
  const totalSignals = positiveCount + negativeCount;
  const positivePct = totalSignals > 0 ? Math.round((positiveCount / totalSignals) * 100) : 50;
  const negativePct = 100 - positivePct;

  const mood =
    net > 0 || (positiveCount > negativeCount && positiveCount > 0)
      ? "great"
      : net < 0 || negativeCount > positiveCount
        ? "rough"
        : "steady";
  const moodLabel = mood === "great" ? "DOING GREAT" : mood === "rough" ? "ROUGH WEEK" : "STEADY";
  const moodColor =
    mood === "great" ? "text-emerald-600" : mood === "rough" ? "text-rose-600" : "text-amber-600";
  const bgGradient =
    mood === "great" ? "from-emerald-50" : mood === "rough" ? "from-rose-50" : "from-amber-50";
  const TrendIcon = net >= 0 ? TrendingUp : TrendingDown;
  const trendChip =
    net > 0
      ? "bg-emerald-100 border-emerald-300 text-emerald-700"
      : net < 0
        ? "bg-rose-100 border-rose-300 text-rose-700"
        : "bg-slate-100 border-slate-300 text-slate-600";
  const trendText =
    net > 0 ? "Trending up this week" : net < 0 ? "Trending down this week" : "Even week so far";

  return (
    <Card className={`bg-gradient-to-b ${bgGradient} to-white border-slate-200`}>
      <CardContent className="p-5 space-y-3">
        <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500 font-bold">
          How {snapshot.student.firstName} is doing this week
        </div>
        <div className="flex items-end justify-between gap-3 flex-wrap">
          <div className="flex items-baseline gap-3 flex-wrap">
            <div className={`text-3xl sm:text-4xl font-black ${moodColor}`}>{moodLabel}</div>
            <div className={`text-2xl font-black tabular-nums ${moodColor}`}>
              {net >= 0 ? "+" : ""}
              {net}
            </div>
            <div className="text-sm text-slate-500">net points this week</div>
          </div>
          <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-bold ${trendChip}`}>
            <TrendIcon className="h-3.5 w-3.5" />
            {trendText}
          </div>
        </div>

        {/* RED on left, GREEN on right — matches signage screens. */}
        <div className="relative h-5 rounded-full bg-slate-100 overflow-hidden border border-slate-200">
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-rose-500 to-rose-400 shadow-[0_0_20px_rgba(244,63,94,0.3)]"
            style={{ width: `${negativePct}%` }}
          />
          <div
            className="absolute inset-y-0 right-0 rounded-full bg-gradient-to-l from-emerald-500 to-emerald-300 shadow-[0_0_20px_rgba(16,185,129,0.4)]"
            style={{ width: `${positivePct}%` }}
          />
          <div className="absolute inset-0 flex items-center justify-center text-[11px] font-black text-white mix-blend-difference">
            {totalSignals === 0 ? "No PBIS signals this week" : `${positivePct}% positive moments`}
          </div>
        </div>

        <div className="flex items-center gap-5 text-sm flex-wrap">
          <div className="flex items-center gap-2">
            <div className="h-3 w-3 rounded-full bg-rose-500" />
            <span className="font-bold text-rose-700 tabular-nums">{negativeCount}</span>
            <span className="text-slate-500">negative</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="h-3 w-3 rounded-full bg-emerald-500" />
            <span className="font-bold text-emerald-700 tabular-nums">{positiveCount}</span>
            <span className="text-slate-500">positive</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="h-3 w-3 rounded-full bg-amber-500" />
            <span className="font-bold text-amber-700 tabular-nums">{concernCount}</span>
            <span className="text-slate-500">tardies</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// House affiliation tile. Mirrors the staff-facing HousesPanel logo
// treatment (custom uploaded PNG on a colored backdrop, letter-bubble
// fallback when no logo is set) so the parent's view matches the
// poster on the hallway wall. The house's accent color is used for
// the backdrop + the points pill so each house looks distinct without
// us having to think about a palette.
function HouseTile({
  house,
}: {
  house: NonNullable<Snapshot["house"]>;
}) {
  const accent = house.color || "#6366f1";
  return (
    <Card className="border-slate-100 overflow-hidden">
      <div className="h-1 w-full" style={{ background: accent }} />
      <CardContent className="p-5">
        <div className="flex items-center gap-4">
          <div
            className="flex items-center justify-center rounded-xl overflow-hidden shrink-0"
            style={{
              background: accent,
              width: 72,
              height: 72,
            }}
          >
            {house.iconObjectKey ? (
              <img
                src={`/api/houses/${house.id}/logo.png?v=${encodeURIComponent(
                  house.iconObjectKey,
                )}`}
                alt={`${house.name} logo`}
                style={{
                  maxHeight: 60,
                  maxWidth: "85%",
                  background: "#fff",
                  borderRadius: 6,
                  padding: 4,
                }}
              />
            ) : (
              <span
                style={{
                  color: "#fff",
                  fontWeight: 700,
                  fontSize: 32,
                  opacity: 0.9,
                }}
              >
                {(house.name.charAt(0) || "H").toUpperCase()}
              </span>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs uppercase tracking-wider text-slate-500 font-medium">
              House
            </div>
            <div className="text-xl font-bold text-slate-900 truncate">
              {house.name}
            </div>
            {house.motto && (
              <div className="text-sm text-slate-600 italic truncate mt-0.5">
                "{house.motto}"
              </div>
            )}
          </div>
          <div className="text-right shrink-0">
            <div
              className="text-3xl font-bold tabular-nums"
              style={{ color: accent }}
            >
              {house.totalPoints.toLocaleString()}
            </div>
            <div className="text-[11px] uppercase tracking-wider text-slate-500 font-medium">
              House points
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function PulseCard({
  label,
  value,
  delta,
  deltaPositive,
  icon,
  accent,
  sparkline,
}: {
  label: string;
  value: number;
  delta: string;
  deltaPositive: boolean;
  icon: React.ReactNode;
  accent: string;
  sparkline?: number[];
}) {
  const max = sparkline ? Math.max(1, ...sparkline) : 1;
  return (
    <Card className="hover:shadow-md transition-shadow border-slate-100 overflow-hidden">
      <div className={`h-1 w-full bg-gradient-to-r ${accent}`} />
      <CardContent className="p-5">
        <div className="flex justify-between items-start mb-2">
          <p className="text-sm font-medium text-slate-500">{label}</p>
          {icon}
        </div>
        <div className="flex items-baseline gap-2">
          <h3 className="text-3xl font-bold text-slate-800">{value}</h3>
          <span
            className={`text-xs font-medium px-1.5 py-0.5 rounded-full ${
              deltaPositive
                ? "text-green-600 bg-green-50"
                : "text-amber-700 bg-amber-50"
            }`}
          >
            {delta}
          </span>
        </div>
        {sparkline && (
          <div className="mt-4 h-8 flex items-end gap-1 opacity-70">
            {sparkline.map((h, i) => (
              <div
                key={i}
                className="w-full bg-violet-200 rounded-t-sm"
                style={{ height: `${Math.max(2, (h / max) * 32)}px` }}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// -----------------------------------------------------------------------------
// TicketsSection — event tickets for a single student. Fetches from
// /parent/tickets?studentId= (published events only; the family's own tickets,
// ownership enforced server-side). Renders one QR per ticket with a short code,
// the same responsibility verbiage families see on the email + PDF, and a
// "Download tickets (PDF)" button per event. Used tickets are greyed out.
// Renders nothing when the student has no tickets, so it stays invisible until
// a school issues them.
// -----------------------------------------------------------------------------
interface TicketItem {
  token: string;
  seq: number;
  total: number;
  status: string;
  shortCode: string;
}
interface TicketEventRow {
  grantId: number;
  eventId: number;
  eventName: string;
  eventDate: string | null;
  startTime: string | null;
  location: string | null;
  tickets: TicketItem[];
}
interface TicketsResponse {
  responsibility: { headline: string; lines: string[] };
  events: TicketEventRow[];
}

function TicketsSection({ studentId }: { studentId: number }) {
  const [data, setData] = useState<TicketsResponse | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await parentFetch(
          `/parent/tickets?studentId=${studentId}`,
        );
        if (!res.ok) return;
        const json = (await res.json()) as TicketsResponse;
        if (!cancelled) setData(json);
      } catch {
        /* portal stays quiet if tickets can't load */
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [studentId]);

  if (!loaded || !data || data.events.length === 0) return null;

  const downloadPdf = async (grantId: number) => {
    const res = await parentFetch(`/parent/tickets/${grantId}.pdf`);
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "tickets.pdf";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <Section
      title="Event Tickets"
      icon={<Ticket className="h-4 w-4 text-violet-600" />}
    >
      {/* Responsibility verbiage — identical wording to the email + PDF. */}
      <div className="mb-4 rounded-lg border border-violet-200 bg-violet-50 p-3">
        <div className="text-sm font-semibold text-violet-800">
          {data.responsibility.headline}
        </div>
        <ul className="mt-1 list-disc pl-5 text-xs text-violet-900/80 space-y-0.5">
          {data.responsibility.lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      </div>

      <div className="space-y-6">
        {data.events.map((ev) => (
          <div key={ev.grantId}>
            <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
              <div>
                <div className="text-sm font-semibold text-slate-800">
                  {ev.eventName}
                </div>
                <div className="text-xs text-slate-500">
                  {ev.eventDate ? fmtDate(ev.eventDate) : "Date TBA"}
                  {ev.startTime ? ` · ${ev.startTime}` : ""}
                  {ev.location ? ` · ${ev.location}` : ""}
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => downloadPdf(ev.grantId)}
              >
                <Download className="h-4 w-4 mr-1.5" />
                Download tickets (PDF)
              </Button>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {ev.tickets.map((t) => (
                <TicketCard key={t.token} ticket={t} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

function TicketCard({ ticket }: { ticket: TicketItem }) {
  const [qr, setQr] = useState<string | null>(null);
  const used = ticket.status === "used";

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(ticket.token, { margin: 1, width: 240 })
      .then((url) => {
        if (!cancelled) setQr(url);
      })
      .catch(() => {
        /* leave placeholder */
      });
    return () => {
      cancelled = true;
    };
  }, [ticket.token]);

  return (
    <div
      className={
        "rounded-lg border p-3 flex flex-col items-center text-center " +
        (used
          ? "border-slate-200 bg-slate-50 opacity-60"
          : "border-slate-200 bg-white")
      }
    >
      <div className="relative">
        {qr ? (
          <img
            src={qr}
            alt={`Ticket ${ticket.shortCode}`}
            className="w-full max-w-[140px] aspect-square"
          />
        ) : (
          <div className="w-[140px] h-[140px] bg-slate-100 rounded" />
        )}
        {used && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="bg-slate-800 text-white text-[10px] font-bold uppercase tracking-wide px-2 py-1 rounded -rotate-12">
              Already used
            </span>
          </div>
        )}
      </div>
      <div className="mt-2 text-xs font-mono font-semibold text-slate-700">
        {ticket.shortCode}
      </div>
      <div className="text-[11px] text-slate-500">
        Ticket {ticket.seq} of {ticket.total}
      </div>
    </div>
  );
}

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="border-slate-100">
      <CardContent className="p-6">
        <div className="flex items-center gap-2 mb-4">
          {icon}
          <h2 className="text-base font-semibold text-slate-800">{title}</h2>
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="text-sm text-slate-400 italic">{text}</p>;
}

// Small stat tile used by the Attendance section to surface attendance
// % (YTD + last 30) and on-time streak (current + longest). Two
// accents: default slate for attendance %, emerald for streaks so the
// "good news" metric pops visually.
function AttendanceTile({
  label,
  value,
  sub,
  accent = "slate",
}: {
  label: string;
  value: string;
  sub: string;
  accent?: "slate" | "emerald";
}) {
  const valueClass =
    accent === "emerald" ? "text-emerald-700" : "text-slate-800";
  return (
    <div className="bg-slate-50 rounded-lg border border-slate-100 p-3">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div className={`text-xl font-bold tabular-nums ${valueClass}`}>
        {value}
      </div>
      <div className="text-[11px] text-slate-500">{sub}</div>
    </div>
  );
}

// FastScoreCard — one tile per subject (ELA / Math). Renders the three
// progress monitoring scores horizontally so the year-long arc is
// readable at a glance, with a small "needs support" pill when the
// student was Bottom Quartile last year. We deliberately do NOT show
// percentile bands or "level" text here — that's eduCLIMBER staff-side
// terminology and the parent surface stays plain-language.
function FastScoreCard({
  score,
}: {
  score: {
    subject: "ela" | "math";
    pm1: number | null;
    pm2: number | null;
    pm3: number | null;
    priorYearScore: number | null;
    priorYearBq: boolean;
  };
}) {
  const subjectLabel = score.subject === "ela" ? "Reading (ELA)" : "Math";
  const accent = score.subject === "ela" ? "text-blue-700" : "text-amber-700";
  const accentBg = score.subject === "ela" ? "bg-blue-50" : "bg-amber-50";
  const pms: Array<{ label: string; value: number | null }> = [
    { label: "Fall (PM1)", value: score.pm1 },
    { label: "Winter (PM2)", value: score.pm2 },
    { label: "Spring (PM3)", value: score.pm3 },
  ];
  return (
    <div className={`rounded-xl border border-slate-200 ${accentBg} p-4`}>
      <div className="flex items-center justify-between mb-3">
        <div className={`text-sm font-semibold ${accent}`}>
          {subjectLabel}
        </div>
        {score.priorYearBq && (
          <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100 text-[10px]">
            Needs support
          </Badge>
        )}
      </div>
      <div className="grid grid-cols-3 gap-2 mb-3">
        {pms.map((pm) => (
          <div
            key={pm.label}
            className="bg-white rounded-lg border border-slate-100 p-2 text-center"
          >
            <div className="text-[10px] uppercase tracking-wide text-slate-400">
              {pm.label}
            </div>
            <div
              className={`text-lg font-bold tabular-nums ${
                pm.value == null ? "text-slate-300" : "text-slate-800"
              }`}
            >
              {pm.value ?? "—"}
            </div>
          </div>
        ))}
      </div>
      {score.priorYearScore != null && (
        <div className="text-xs text-slate-500">
          Last year's final: {" "}
          <span className="font-semibold text-slate-700 tabular-nums">
            {score.priorYearScore}
          </span>
        </div>
      )}
    </div>
  );
}

// MtssBlock — header tier chip + active plan list. The tier chip uses
// the same color semantics as the staff-side StudentProfile (Tier 2
// amber, Tier 3 rose) so a parent comparing notes with a teacher sees
// matching language.
function MtssBlock({
  mtss,
}: {
  mtss: {
    tier: number;
    plans: Array<{
      id: number;
      title: string;
      tier: number;
      openedAt: string;
      goals: string | null;
    }>;
  };
}) {
  const tierChip =
    mtss.tier === 1
      ? "bg-slate-100 text-slate-600"
      : mtss.tier === 2
        ? "bg-amber-100 text-amber-800"
        : "bg-rose-100 text-rose-800";
  const tierLabel =
    mtss.tier === 1 ? "Tier 1 — no active plan" : `Active Tier ${mtss.tier}`;
  return (
    <>
      <div className="mb-3">
        <Badge className={`${tierChip} hover:${tierChip}`}>
          {tierLabel}
        </Badge>
      </div>
      {mtss.plans.length === 0 ? (
        <Empty text="No active support plans." />
      ) : (
        <ul className="divide-y divide-slate-100">
          {mtss.plans.map((p) => (
            <li key={p.id} className="py-3">
              <div className="flex items-center justify-between gap-4">
                <div className="text-sm font-medium text-slate-800">
                  {p.title}
                </div>
                <Badge
                  className={
                    p.tier === 3
                      ? "bg-rose-100 text-rose-700 hover:bg-rose-100"
                      : "bg-amber-100 text-amber-700 hover:bg-amber-100"
                  }
                >
                  Tier {p.tier}
                </Badge>
              </div>
              <div className="text-xs text-slate-500 mt-0.5">
                Opened {fmtDate(p.openedAt)}
              </div>
              {p.goals && (
                <div className="text-sm text-slate-600 mt-2 whitespace-pre-line">
                  {p.goals}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function gradeLabel(grade: number): string {
  if (grade === 0) return "Kindergarten";
  if (grade === 1) return "1st Grade";
  if (grade === 2) return "2nd Grade";
  if (grade === 3) return "3rd Grade";
  return `${grade}th Grade`;
}
