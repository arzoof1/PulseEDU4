import {
  Heart,
  Award,
  Phone,
  AlertCircle,
  BookOpen,
  ShieldCheck,
  MessageSquare,
  Clock,
  TrendingUp,
  TrendingDown,
  CalendarClock,
  Activity,
  Users,
} from "lucide-react";
import { usePolling } from "./usePolling";

// =============================================================================
// StudentTimelineSignage — staff-facing one-student deep dive.
// -----------------------------------------------------------------------------
// Lives at /signage/student?studentId=N.  Unlike the other signage screens
// this REQUIRES a staff session because it surfaces individual student
// behavior detail.  The endpoint enforces auth server-side; if the call
// returns 401 we render a clear "sign in" message.
// =============================================================================

interface PulseEvent {
  id: string;
  kind: "positive" | "negative" | "neutral";
  source: "pbis" | "tardy" | "pullout" | "intervention";
  studentId: string;
  studentInitials: string;
  staffName: string;
  what: string;
  detail: string;
  points: number | null;
  createdAt: string;
}

interface StudentTimelinePayload {
  schoolId: number;
  windowDays: number;
  since: string;
  until: string;
  student: {
    id: number;
    studentId: string;
    localSisId: string | null;
    firstName: string;
    lastName: string;
    grade: number;
    houseId: number | null;
  };
  summary: {
    totalPoints: number;
    weekPoints: number;
    weekPositive: number;
    weekNegative: number;
    weekConcern: number;
    eventCount: number;
  };
  events: PulseEvent[];
}

function studentIdFromUrl(): number {
  if (typeof window === "undefined") return NaN;
  const raw = new URLSearchParams(window.location.search).get("studentId");
  return raw ? Number(raw) : NaN;
}

function ScreenError({ message, hint }: { message: string; hint?: string }) {
  return (
    <div className="min-h-screen w-full bg-slate-50 text-slate-900 grid place-items-center p-8">
      <div className="max-w-lg text-center space-y-3">
        <div className="text-5xl">📋</div>
        <div className="text-2xl font-bold">Student timeline unavailable</div>
        <div className="text-slate-600">{message}</div>
        {hint && <div className="text-xs text-slate-400 mt-3">{hint}</div>}
      </div>
    </div>
  );
}

function iconForEvent(e: PulseEvent) {
  if (e.source === "pbis" && /reading|book/i.test(e.what)) return BookOpen;
  if (e.source === "pbis" && /call|phone/i.test(e.what)) return Phone;
  if (e.source === "pbis" && /email|message/i.test(e.what)) return MessageSquare;
  if (e.source === "intervention" && /circle|group/i.test(e.what)) return ShieldCheck;
  if (e.source === "tardy") return Clock;
  if (e.source === "pullout") return AlertCircle;
  if (e.source === "intervention") return Heart;
  return Award;
}

function timeLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  const t = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (sameDay) return `Today · ${t}`;
  if (isYesterday) return `Yesterday · ${t}`;
  const ago = Math.floor((Date.now() - d.getTime()) / (24 * 60 * 60_000));
  if (ago < 7) return `${ago} days ago`;
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export default function StudentTimelineSignage() {
  const studentId = studentIdFromUrl();
  const valid = Number.isFinite(studentId) && studentId > 0;

  const tl = usePolling<StudentTimelinePayload>(
    valid ? `/api/pulse/student-timeline?studentId=${studentId}&windowDays=14` : null,
    60_000,
  );

  if (!valid) {
    return (
      <ScreenError
        message="No studentId in the URL."
        hint="Append ?studentId=N to load a specific student's timeline."
      />
    );
  }
  if (tl.loading) {
    return (
      <div className="min-h-screen w-full bg-slate-50 text-slate-900 grid place-items-center">
        <div className="flex items-center gap-3 text-slate-500">
          <Activity className="h-5 w-5 animate-pulse" /> Loading student timeline…
        </div>
      </div>
    );
  }
  if (tl.error && !tl.data) {
    if (/401|sign-in|sign in/i.test(tl.error)) {
      return (
        <ScreenError
          message="Sign in as staff to view this timeline."
          hint="The student timeline screen requires an authenticated staff session."
        />
      );
    }
    return <ScreenError message={`Couldn't load timeline (${tl.error}).`} />;
  }

  const data = tl.data!;
  const { student, summary, events } = data;
  const fullName = `${student.firstName} ${student.lastName}`;
  const initials = `${student.firstName.charAt(0) || ""}${student.lastName.charAt(0) || ""}`.toUpperCase();
  const polarized = summary.weekPositive + summary.weekNegative;
  const positivePct = polarized > 0 ? Math.round((summary.weekPositive / polarized) * 100) : 50;
  const negativePct = 100 - positivePct;

  const mood: "great" | "rough" | "steady" =
    summary.weekPoints > 0 || summary.weekPositive > summary.weekNegative
      ? "great"
      : summary.weekPoints < 0 || summary.weekNegative > summary.weekPositive
        ? "rough"
        : "steady";
  const moodLabel = mood === "great" ? "DOING GREAT" : mood === "rough" ? "ROUGH WEEK" : "STEADY";
  const moodColor =
    mood === "great" ? "text-emerald-600" : mood === "rough" ? "text-rose-600" : "text-amber-600";
  const moodGradient =
    mood === "great" ? "from-emerald-50" : mood === "rough" ? "from-rose-50" : "from-amber-50";
  const TrendIcon = summary.weekPoints >= 0 ? TrendingUp : TrendingDown;
  const trendChip =
    summary.weekPoints > 0
      ? "bg-emerald-100 border-emerald-300 text-emerald-700"
      : summary.weekPoints < 0
        ? "bg-rose-100 border-rose-300 text-rose-700"
        : "bg-slate-100 border-slate-300 text-slate-600";
  const trendText =
    summary.weekPoints > 0
      ? "Trending up vs. last week"
      : summary.weekPoints < 0
        ? "Trending down vs. last week"
        : "Holding steady";

  const tone: Record<PulseEvent["kind"], { dot: string; ring: string; chip: string }> = {
    positive: {
      dot: "bg-emerald-500",
      ring: "ring-emerald-200",
      chip: "bg-emerald-50 text-emerald-700 border-emerald-200",
    },
    negative: {
      dot: "bg-rose-500",
      ring: "ring-rose-200",
      chip: "bg-rose-50 text-rose-700 border-rose-200",
    },
    neutral: {
      dot: "bg-sky-500",
      ring: "ring-sky-200",
      chip: "bg-sky-50 text-sky-700 border-sky-200",
    },
  };

  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-slate-50 via-white to-slate-100 text-slate-900">
      {/* HEADER */}
      <header className="px-8 pt-6 pb-5 bg-white border-b border-slate-200">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2 text-xs uppercase tracking-[0.25em] text-slate-400">
            <Heart className="h-3.5 w-3.5 text-rose-500 fill-rose-500" />
            Pulse · Student Timeline
          </div>
          <div className="text-[11px] text-slate-400">
            Visible to assigned staff & linked family · Last {data.windowDays} days
          </div>
        </div>

        <div className="flex items-center gap-5 flex-wrap">
          <div className="h-20 w-20 rounded-2xl bg-gradient-to-br from-blue-500 to-cyan-400 grid place-items-center text-white text-2xl font-black ring-4 ring-blue-200 shadow-lg shrink-0">
            {initials || "?"}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-2xl font-black tracking-tight">{fullName}</div>
            <div className="text-sm text-slate-500">
              Grade {student.grade} · Student ID {student.localSisId ?? "—"}
            </div>
            <div className="mt-2 flex items-center gap-2 flex-wrap">
              <span
                className={`text-[11px] px-2 py-0.5 rounded-md font-semibold ${
                  summary.weekPoints >= 0
                    ? "bg-emerald-100 text-emerald-700"
                    : "bg-rose-100 text-rose-700"
                }`}
              >
                {summary.weekPoints >= 0 ? "+" : ""}
                {summary.weekPoints} pts this week
              </span>
              <span className="text-[11px] px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 font-semibold">
                {summary.eventCount} events tracked
              </span>
              {summary.weekConcern > 0 && (
                <span className="text-[11px] px-2 py-0.5 rounded-md bg-amber-100 text-amber-700 font-semibold">
                  {summary.weekConcern} {summary.weekConcern === 1 ? "concern" : "concerns"} this week
                </span>
              )}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3 text-center">
            {[
              { v: summary.totalPoints, l: "Total pts" },
              { v: summary.weekPositive, l: "Positive" },
              { v: summary.weekNegative + summary.weekConcern, l: "Concerns" },
            ].map((s) => (
              <div
                key={s.l}
                className="px-4 py-3 rounded-xl bg-slate-50 border border-slate-200 min-w-[80px]"
              >
                <div className="text-2xl font-black text-slate-900 tabular-nums">{s.v}</div>
                <div className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold">
                  {s.l}
                </div>
              </div>
            ))}
          </div>
        </div>
      </header>

      {/* MOOD METER — same red(left)/green(right) pattern as everywhere else */}
      <section className={`px-8 py-5 bg-gradient-to-b ${moodGradient} to-white border-b border-slate-200`}>
        <div className="text-[10px] uppercase tracking-[0.3em] text-slate-400 font-bold mb-2">
          How {student.firstName} is doing right now
        </div>
        <div className="flex items-end justify-between mb-3 flex-wrap gap-3">
          <div className="flex items-baseline gap-3">
            <div className={`text-3xl sm:text-4xl font-black ${moodColor}`}>{moodLabel}</div>
            <div className={`text-2xl font-black tabular-nums ${moodColor}`}>
              {summary.weekPoints >= 0 ? "+" : ""}
              {summary.weekPoints}
            </div>
            <div className="text-sm text-slate-500">net points this week</div>
          </div>
          <div
            className={`flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-bold ${trendChip}`}
          >
            <TrendIcon className="h-4 w-4" />
            {trendText}
          </div>
        </div>

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
            {polarized === 0 ? "No PBIS signals this week" : `${positivePct}% positive moments`}
          </div>
        </div>

        <div className="mt-2 flex items-center gap-5 text-sm flex-wrap">
          <div className="flex items-center gap-2">
            <div className="h-3 w-3 rounded-full bg-rose-500" />
            <span className="font-bold text-rose-700 tabular-nums">{summary.weekNegative}</span>
            <span className="text-slate-500">negative</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="h-3 w-3 rounded-full bg-emerald-500" />
            <span className="font-bold text-emerald-700 tabular-nums">{summary.weekPositive}</span>
            <span className="text-slate-500">positive</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="h-3 w-3 rounded-full bg-amber-500" />
            <span className="font-bold text-amber-700 tabular-nums">{summary.weekConcern}</span>
            <span className="text-slate-500">concern</span>
          </div>
        </div>
      </section>

      {/* TIMELINE */}
      <section className="px-8 py-6 max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2 text-xs uppercase tracking-[0.25em] text-slate-400 font-bold">
            <CalendarClock className="h-3.5 w-3.5" /> Timeline · last {data.windowDays} days
          </div>
          <div className="text-[11px] text-slate-400">{events.length} events</div>
        </div>

        {events.length === 0 ? (
          <div className="grid place-items-center py-16 text-slate-400">
            <Users className="h-10 w-10 mb-3 opacity-40" />
            No events recorded in this window.
          </div>
        ) : (
          <ol className="relative border-l-2 border-slate-200 pl-6 space-y-5">
            {events.map((e) => {
              const Icon = iconForEvent(e);
              const t = tone[e.kind];
              return (
                <li key={e.id} className="relative">
                  <span
                    className={`absolute -left-[34px] top-1 grid place-items-center h-6 w-6 rounded-full ring-4 ${t.ring} ${t.dot}`}
                  >
                    <Icon className="h-3 w-3 text-white" />
                  </span>
                  <div className="rounded-xl bg-white border border-slate-200 shadow-sm p-4">
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-bold text-slate-900">{e.what}</span>
                          {typeof e.points === "number" && (
                            <span
                              className={`text-[11px] px-2 py-0.5 rounded-md font-bold border ${t.chip}`}
                            >
                              {e.kind === "negative" ? "−" : "+"}
                              {Math.abs(e.points)} pts
                            </span>
                          )}
                        </div>
                        {e.detail && (
                          <div className="text-sm text-slate-600 mt-1">{e.detail}</div>
                        )}
                        <div className="text-xs text-slate-400 mt-1">
                          {e.staffName ? `Logged by ${e.staffName}` : "Logged by school staff"}
                        </div>
                      </div>
                      <div className="text-xs text-slate-400 tabular-nums shrink-0">
                        {timeLabel(e.createdAt)}
                      </div>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <footer className="px-8 py-3 border-t border-slate-200 bg-white flex items-center justify-between text-xs text-slate-400">
        <div>
          Names + free-text visible only to authenticated staff
          {tl.lastUpdatedAt && (
            <>
              {" "}
              · Updated{" "}
              {tl.lastUpdatedAt.toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
                second: "2-digit",
              })}
            </>
          )}
        </div>
        <div className="font-semibold">PulseEDU · School Operations</div>
      </footer>
    </div>
  );
}
