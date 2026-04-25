import { Heart, TrendingUp, Phone, AlertCircle, Award, BookOpen, Users, Clock } from "lucide-react";

type EventKind = "positive" | "negative" | "neutral";

type Event = {
  id: number;
  kind: EventKind;
  initials: string;
  avatarColor: string;
  who: string;
  what: string;
  detail: string;
  points: number;
  time: string;
  icon: React.ComponentType<{ className?: string }>;
};

const events: Event[] = [
  { id: 1, kind: "positive", initials: "MS", avatarColor: "bg-emerald-500", who: "Ms. Patel",   what: "Positive call home",      detail: "Shared Riya B.'s reading growth with mom", points:  5, time: "just now",  icon: Phone },
  { id: 2, kind: "positive", initials: "TC", avatarColor: "bg-emerald-500", who: "Tomás C.",    what: "+5 PBIS · Leadership",    detail: "Helped a peer through a hard moment in PE", points:  5, time: "2 min",     icon: Award },
  { id: 3, kind: "positive", initials: "AR", avatarColor: "bg-emerald-500", who: "Aliyah R.",   what: "Trusted adult check-in",  detail: "Asked counselor for help with anxiety",     points:  3, time: "8 min",     icon: Heart },
  { id: 4, kind: "negative", initials: "DK", avatarColor: "bg-rose-500",    who: "Devon K.",    what: "Pulled out · Restorative", detail: "Disruption in math · ESE referral filed",  points: -4, time: "12 min",    icon: AlertCircle },
  { id: 5, kind: "positive", initials: "MS", avatarColor: "bg-emerald-500", who: "Maya S.",     what: "Reading growth email",    detail: "Level F → G · family notified",            points:  3, time: "18 min",    icon: BookOpen },
  { id: 6, kind: "neutral",  initials: "JM", avatarColor: "bg-amber-500",   who: "Jordan M.",   what: "Bathroom pass · 14 min",  detail: "Out of class longer than expected",        points: -1, time: "24 min",    icon: Clock },
  { id: 7, kind: "positive", initials: "EL", avatarColor: "bg-emerald-500", who: "Mr. Lopez",   what: "Restorative circle",      detail: "5 students · conflict resolved",           points:  4, time: "35 min",    icon: Users },
];

const positiveCount = events.filter((e) => e.kind === "positive").length;
const negativeCount = events.filter((e) => e.kind === "negative").length;
const neutralCount  = events.filter((e) => e.kind === "neutral").length;
const netPoints     = events.reduce((sum, e) => sum + e.points, 0);
const positivePct   = (positiveCount / events.length) * 100;

export function TrunkSegmented() {
  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-white overflow-hidden flex flex-col">
      {/* HEADER */}
      <header className="flex items-center justify-between px-8 py-5 border-b border-white/10">
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-rose-500 to-violet-500 grid place-items-center shadow-lg">
            <Heart className="h-6 w-6 text-white fill-white" strokeWidth={2.5} />
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.25em] text-white/50 font-semibold">School Pulse · Live signage</div>
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
          <div className="text-white/50 text-sm tabular-nums">2:14 PM · Tue</div>
        </div>
      </header>

      {/* MOOD METER — the headline */}
      <section className="px-8 py-6 border-b border-white/10 bg-gradient-to-b from-emerald-950/30 to-transparent">
        <div className="text-[10px] uppercase tracking-[0.3em] text-white/40 font-bold mb-2">School mood right now</div>
        <div className="flex items-end justify-between mb-4">
          <div className="flex items-baseline gap-3">
            <div className="text-5xl font-black text-emerald-400">POSITIVE</div>
            <div className="text-3xl font-black text-emerald-400 tabular-nums">+{netPoints}</div>
            <div className="text-base text-white/60">net points today</div>
          </div>
          <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-emerald-500/15 border border-emerald-400/40">
            <TrendingUp className="h-5 w-5 text-emerald-300" />
            <span className="text-emerald-300 font-bold">Trending up vs. yesterday</span>
          </div>
        </div>

        {/* Big gradient bar */}
        <div className="relative h-6 rounded-full bg-white/5 overflow-hidden border border-white/10">
          <div className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-emerald-600 via-emerald-400 to-emerald-300 shadow-[0_0_30px_rgba(16,185,129,0.6)]" style={{ width: `${positivePct}%` }} />
          <div className="absolute inset-y-0 right-0 rounded-full bg-gradient-to-l from-rose-600 via-rose-500 to-rose-400 shadow-[0_0_30px_rgba(244,63,94,0.5)]" style={{ width: `${100 - positivePct}%` }} />
          <div className="absolute inset-0 flex items-center justify-center text-xs font-black text-white/90 mix-blend-overlay">
            {Math.round(positivePct)}% positive
          </div>
        </div>

        <div className="mt-3 flex items-center gap-6 text-sm">
          <div className="flex items-center gap-2">
            <div className="h-3 w-3 rounded-full bg-emerald-500" />
            <span className="font-bold text-emerald-300 tabular-nums">{positiveCount}</span>
            <span className="text-white/60">positive</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="h-3 w-3 rounded-full bg-rose-500" />
            <span className="font-bold text-rose-300 tabular-nums">{negativeCount}</span>
            <span className="text-white/60">negative</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="h-3 w-3 rounded-full bg-amber-500" />
            <span className="font-bold text-amber-300 tabular-nums">{neutralCount}</span>
            <span className="text-white/60">concern</span>
          </div>
        </div>
      </section>

      {/* LIVE FEED */}
      <section className="flex-1 px-8 py-5 overflow-hidden">
        <div className="flex items-center justify-between mb-4">
          <div className="text-[10px] uppercase tracking-[0.3em] text-white/40 font-bold">Live event feed · most recent first</div>
          <div className="text-[11px] text-white/40">Last 35 minutes</div>
        </div>

        <div className="space-y-2">
          {events.map((e) => {
            const Icon = e.icon;
            const tone =
              e.kind === "positive" ? { bg: "from-emerald-600/30 to-emerald-500/10", border: "border-emerald-400/40", pts: "text-emerald-300", iconBg: "bg-emerald-500/20" } :
              e.kind === "negative" ? { bg: "from-rose-600/30 to-rose-500/10",       border: "border-rose-400/40",    pts: "text-rose-300",    iconBg: "bg-rose-500/20" } :
                                      { bg: "from-amber-600/30 to-amber-500/10",     border: "border-amber-400/40",  pts: "text-amber-300",   iconBg: "bg-amber-500/20" };
            return (
              <div key={e.id} className={`rounded-2xl bg-gradient-to-r ${tone.bg} border ${tone.border} backdrop-blur px-4 py-3 flex items-center gap-4`}>
                <div className={`h-12 w-12 rounded-full ${e.avatarColor} grid place-items-center font-black text-sm ring-2 ring-white/30 shrink-0`}>{e.initials}</div>
                <div className={`h-9 w-9 rounded-lg ${tone.iconBg} grid place-items-center shrink-0`}>
                  <Icon className="h-4 w-4 text-white" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-base font-bold">{e.who}</span>
                    <span className="text-white/40">·</span>
                    <span className="text-base text-white/90">{e.what}</span>
                  </div>
                  <div className="text-sm text-white/60 truncate">{e.detail}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className={`text-2xl font-black tabular-nums ${tone.pts}`}>{e.points > 0 ? "+" : ""}{e.points}</div>
                  <div className="text-[10px] text-white/40 uppercase tracking-wider">{e.time}</div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* FOOTER */}
      <footer className="px-8 py-3 border-t border-white/10 bg-black/30 flex items-center justify-between text-xs text-white/45">
        <div>School-wide pulse · No student PII shown · Names visible to staff only</div>
        <div className="font-semibold">PulseEDU · School Operations</div>
      </footer>
    </div>
  );
}
