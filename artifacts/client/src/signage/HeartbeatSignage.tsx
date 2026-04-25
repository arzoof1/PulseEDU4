import {
  Heart,
  TrendingUp,
  TrendingDown,
  Phone,
  AlertCircle,
  Award,
  BookOpen,
  Users,
  Clock,
  Activity,
} from "lucide-react";
import { usePolling, schoolIdFromUrl } from "./usePolling";

// =============================================================================
// HeartbeatSignage — live "Today's Heartbeat" TV/kiosk screen.
// -----------------------------------------------------------------------------
// Mirrors the visual language of the SchoolTrunk mockup but driven entirely
// by /api/pulse/heartbeat + /api/pulse/events.  Polls every 30s, reads
// schoolId from `?schoolId=N`, fails loudly if missing.  Names are already
// masked server-side (first name + last initial).
// =============================================================================

interface PulseEvent {
  id: string;
  kind: "positive" | "negative" | "neutral";
  source: "pbis" | "tardy" | "pullout" | "intervention";
  studentId: string;          // already masked server-side
  studentInitials: string;
  staffName: string;          // "Staff" placeholder when called publicly
  what: string;
  detail: string;             // "" when called publicly
  points: number | null;
  createdAt: string;
}

interface Heartbeat {
  schoolId: number;
  windowMinutes: number;
  since: string;
  until: string;
  mood: "positive" | "neutral" | "negative";
  today: { positive: number; negative: number; concern: number; total: number; netPoints: number; positivePct: number };
  yesterday: { positive: number; negative: number; concern: number; total: number; netPoints: number; positivePct: number };
  trendDelta: number;
  trendDirection: "up" | "down" | "flat";
}

interface EventsPayload {
  windowMinutes: number;
  since: string;
  until: string;
  events: PulseEvent[];
}

const ICON_FOR_SOURCE: Record<PulseEvent["source"], typeof Phone> = {
  pbis: Award,
  tardy: Clock,
  pullout: AlertCircle,
  intervention: Heart,
};

// A tiny helper to choose a fancier icon for a few common positive PBIS
// reasons; falls back to the source default.
function iconForEvent(e: PulseEvent) {
  if (e.source === "pbis" && /reading/i.test(e.what)) return BookOpen;
  if (e.source === "pbis" && /call|phone/i.test(e.what)) return Phone;
  if (e.source === "intervention" && /circle|group/i.test(e.what)) return Users;
  return ICON_FOR_SOURCE[e.source];
}

function relativeTime(iso: string, now: number): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const sec = Math.max(0, Math.floor((now - t) / 1000));
  if (sec < 30) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

function ScreenError({ message }: { message: string }) {
  return (
    <div className="min-h-screen w-full bg-slate-950 text-white grid place-items-center p-8">
      <div className="max-w-lg text-center space-y-3">
        <div className="text-6xl">📺</div>
        <div className="text-2xl font-bold">Pulse signage paused</div>
        <div className="text-white/60">{message}</div>
        <div className="text-xs text-white/40 mt-4">
          Pass <code className="px-1 py-0.5 bg-white/10 rounded">?schoolId=N</code> in the URL to point this display at a school.
        </div>
      </div>
    </div>
  );
}

export default function HeartbeatSignage() {
  const schoolId = schoolIdFromUrl();
  const validSchool = Number.isFinite(schoolId) && schoolId > 0;

  const heartbeat = usePolling<Heartbeat>(
    validSchool ? `/api/pulse/heartbeat?schoolId=${schoolId}&windowMinutes=35` : null,
    30_000,
  );
  const events = usePolling<EventsPayload>(
    validSchool ? `/api/pulse/events?schoolId=${schoolId}&windowMinutes=35&limit=20` : null,
    30_000,
  );

  if (!validSchool) {
    return <ScreenError message="No schoolId in the URL." />;
  }
  if (heartbeat.loading || events.loading) {
    return (
      <div className="min-h-screen w-full bg-slate-950 text-white grid place-items-center">
        <div className="flex items-center gap-3 text-white/60">
          <Activity className="h-5 w-5 animate-pulse" />
          Loading school pulse…
        </div>
      </div>
    );
  }
  if (heartbeat.error && !heartbeat.data) {
    return <ScreenError message={`Couldn't load heartbeat (${heartbeat.error}).`} />;
  }

  const hb = heartbeat.data;
  const evs = events.data?.events ?? [];
  const now = Date.now();

  const moodLabel =
    hb?.mood === "positive" ? "POSITIVE" :
    hb?.mood === "negative" ? "TENSE" : "STEADY";
  const moodColor =
    hb?.mood === "positive" ? "text-emerald-400" :
    hb?.mood === "negative" ? "text-rose-400" : "text-amber-300";
  const moodGradient =
    hb?.mood === "positive" ? "from-emerald-950/30" :
    hb?.mood === "negative" ? "from-rose-950/30" : "from-amber-950/30";

  // Resting state = 50/50 (steady) when we have no data yet or when the
  // server reports a quiet day. The server already emits 50 when polarized
  // counts are zero, but we also fall back to 50 while the first poll is
  // in flight so the bar never flashes all-red on load.
  const positivePct = hb?.today.positivePct ?? 50;
  const negativePct = 100 - positivePct;

  const TrendIcon = hb?.trendDirection === "down" ? TrendingDown : TrendingUp;
  const trendChipColor =
    hb?.trendDirection === "up" ? "bg-emerald-500/15 border-emerald-400/40 text-emerald-300" :
    hb?.trendDirection === "down" ? "bg-rose-500/15 border-rose-400/40 text-rose-300" :
    "bg-white/10 border-white/20 text-white/70";
  const trendLabel =
    hb?.trendDirection === "up" ? "Trending up vs. yesterday" :
    hb?.trendDirection === "down" ? "Trending down vs. yesterday" :
    "Holding steady vs. yesterday";

  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-white overflow-hidden flex flex-col">
      {/* HEADER */}
      <header className="flex items-center justify-between px-8 py-5 border-b border-white/10">
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-rose-500 to-violet-500 grid place-items-center shadow-lg">
            <Heart className="h-6 w-6 text-white fill-white" strokeWidth={2.5} />
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.25em] text-white/50 font-semibold">
              School Pulse · Live signage
            </div>
            <div className="text-2xl font-black tracking-tight">Today's Heartbeat</div>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
            </span>
            <span className="text-emerald-300 font-bold text-sm">LIVE</span>
          </div>
          <div className="text-white/50 text-sm tabular-nums">
            {new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
          </div>
        </div>
      </header>

      {/* MOOD METER */}
      <section className={`px-8 py-6 border-b border-white/10 bg-gradient-to-b ${moodGradient} to-transparent`}>
        <div className="text-[10px] uppercase tracking-[0.3em] text-white/40 font-bold mb-2">
          School mood right now · last {hb?.windowMinutes ?? 35} min
        </div>
        <div className="flex items-end justify-between mb-4 gap-4 flex-wrap">
          <div className="flex items-baseline gap-3">
            <div className={`text-5xl font-black ${moodColor}`}>{moodLabel}</div>
            <div className={`text-3xl font-black ${moodColor} tabular-nums`}>
              {(hb?.today.netPoints ?? 0) >= 0 ? "+" : ""}{hb?.today.netPoints ?? 0}
            </div>
            <div className="text-base text-white/60">net points today</div>
          </div>
          <div className={`flex items-center gap-2 px-4 py-2 rounded-full border ${trendChipColor}`}>
            <TrendIcon className="h-5 w-5" />
            <span className="font-bold">{trendLabel}</span>
          </div>
        </div>

        {/* Big gradient bar — RED on left, GREEN on right (per design) */}
        <div className="relative h-6 rounded-full bg-white/5 overflow-hidden border border-white/10">
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-rose-600 via-rose-500 to-rose-400 shadow-[0_0_30px_rgba(244,63,94,0.5)]"
            style={{ width: `${negativePct}%` }}
          />
          <div
            className="absolute inset-y-0 right-0 rounded-full bg-gradient-to-l from-emerald-600 via-emerald-400 to-emerald-300 shadow-[0_0_30px_rgba(16,185,129,0.6)]"
            style={{ width: `${positivePct}%` }}
          />
          <div className="absolute inset-0 flex items-center justify-center text-xs font-black text-white/90 mix-blend-overlay">
            {Math.round(positivePct)}% positive
          </div>
        </div>

        <div className="mt-3 flex items-center gap-6 text-sm flex-wrap">
          <div className="flex items-center gap-2">
            <div className="h-3 w-3 rounded-full bg-rose-500" />
            <span className="font-bold text-rose-300 tabular-nums">{hb?.today.negative ?? 0}</span>
            <span className="text-white/60">negative</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="h-3 w-3 rounded-full bg-emerald-500" />
            <span className="font-bold text-emerald-300 tabular-nums">{hb?.today.positive ?? 0}</span>
            <span className="text-white/60">positive</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="h-3 w-3 rounded-full bg-amber-500" />
            <span className="font-bold text-amber-300 tabular-nums">{hb?.today.concern ?? 0}</span>
            <span className="text-white/60">concern</span>
          </div>
        </div>
      </section>

      {/* LIVE FEED */}
      <section className="flex-1 px-8 py-5 overflow-hidden">
        <div className="flex items-center justify-between mb-4">
          <div className="text-[10px] uppercase tracking-[0.3em] text-white/40 font-bold">
            Live event feed · most recent first
          </div>
          <div className="text-[11px] text-white/40">
            Last {hb?.windowMinutes ?? 35} minutes · {evs.length} events
          </div>
        </div>

        {evs.length === 0 ? (
          <div className="grid place-items-center py-12 text-white/40 text-sm">
            <div className="text-3xl mb-2">🌙</div>
            All quiet on campus.
          </div>
        ) : (
          <div className="space-y-2 max-h-[calc(100vh-360px)] overflow-y-auto pr-1">
            {evs.map((e) => {
              const Icon = iconForEvent(e);
              const tone =
                e.kind === "positive" ? { bg: "from-emerald-600/30 to-emerald-500/10", border: "border-emerald-400/40", pts: "text-emerald-300", iconBg: "bg-emerald-500/20", avatar: "bg-emerald-500" } :
                e.kind === "negative" ? { bg: "from-rose-600/30 to-rose-500/10",       border: "border-rose-400/40",    pts: "text-rose-300",    iconBg: "bg-rose-500/20",   avatar: "bg-rose-500"   } :
                                        { bg: "from-amber-600/30 to-amber-500/10",     border: "border-amber-400/40",   pts: "text-amber-300",   iconBg: "bg-amber-500/20",  avatar: "bg-amber-500"  };
              return (
                <div
                  key={e.id}
                  className={`rounded-2xl bg-gradient-to-r ${tone.bg} border ${tone.border} backdrop-blur px-4 py-3 flex items-center gap-4`}
                >
                  <div className={`h-12 w-12 rounded-full ${tone.avatar} grid place-items-center font-black text-sm ring-2 ring-white/30 shrink-0`}>
                    {e.studentInitials}
                  </div>
                  <div className={`h-9 w-9 rounded-lg ${tone.iconBg} grid place-items-center shrink-0`}>
                    <Icon className="h-4 w-4 text-white" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-base font-bold">{e.studentId}</span>
                      <span className="text-white/40">·</span>
                      <span className="text-base text-white/90">{e.what}</span>
                    </div>
                    <div className="text-sm text-white/60 truncate">
                      {e.detail || (e.staffName && e.staffName !== "Staff" ? `Logged by ${e.staffName}` : "Logged by school staff")}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    {typeof e.points === "number" && (
                      <div className={`text-2xl font-black tabular-nums ${tone.pts}`}>
                        {e.kind === "negative" ? "-" : e.points > 0 ? "+" : ""}
                        {Math.abs(e.points)}
                      </div>
                    )}
                    <div className="text-[10px] text-white/40 uppercase tracking-wider">
                      {relativeTime(e.createdAt, now)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <footer className="px-8 py-3 border-t border-white/10 bg-black/30 flex items-center justify-between text-xs text-white/45">
        <div>
          School-wide pulse · Names masked to first + last initial
          {heartbeat.lastUpdatedAt && (
            <> · Updated {heartbeat.lastUpdatedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}</>
          )}
        </div>
        <div className="font-semibold">PulseEDU · School Operations</div>
      </footer>
    </div>
  );
}
