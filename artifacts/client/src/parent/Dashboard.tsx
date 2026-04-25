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
} from "lucide-react";
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
import { parentFetch, setParentToken, navigate, type ParentMe } from "./api";

interface Snapshot {
  parent: { displayName: string; email: string };
  student: {
    id: number;
    studentId: string;
    firstName: string;
    lastName: string;
    grade: number;
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
    }>;
  };
  attendance: {
    tardiesThisWeek: number;
    checkInsThisWeek: number;
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

  useEffect(() => {
    if (activeStudentId === null) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    (async () => {
      try {
        const res = await parentFetch(
          `/api/parent/snapshot?studentId=${activeStudentId}`,
        );
        if (cancelled) return;
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(body.error ?? `Could not load snapshot (${res.status})`);
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
  }, [activeStudentId]);

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
              <p className="text-slate-500 font-medium">
                {gradeLabel(activeStudent.grade)} · ID {activeStudent.studentId}
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
              onClick={handleSignOut}
              className="gap-2"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </Button>
          </div>
        </div>

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
              {snapshot.hallPasses.recent.map((r) => (
                <li
                  key={r.id}
                  className="flex items-center justify-between py-3 gap-4"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-800">
                      {r.destination}
                    </div>
                    <div className="text-xs text-slate-500">
                      {r.originRoom} · {r.teacherName}
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

      {/* Accommodations */}
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

function gradeLabel(grade: number): string {
  if (grade === 0) return "Kindergarten";
  if (grade === 1) return "1st Grade";
  if (grade === 2) return "2nd Grade";
  if (grade === 3) return "3rd Grade";
  return `${grade}th Grade`;
}
