import { CalendarClock, Heart, Phone, MessageSquare, Award, AlertCircle, BookOpen, ShieldCheck } from "lucide-react";

type Event = {
  id: number;
  kind: "positive" | "negative" | "neutral";
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  detail: string;
  staff: string;
  time: string;
  pts?: number;
};

const events: Event[] = [
  { id: 1, kind: "positive", icon: Award,         title: "+8 PBIS · Leadership", detail: "Helped a peer through a hard moment in PE",         staff: "Coach Lee",     time: "Today · 1:42 PM", pts: 8 },
  { id: 2, kind: "neutral",  icon: BookOpen,      title: "Reading conference",   detail: "Level F → G. Strong fluency, working on retell",    staff: "Ms. Patel",     time: "Today · 11:15 AM" },
  { id: 3, kind: "positive", icon: Phone,         title: "Positive call home",   detail: "Shared the leadership moment with mom",             staff: "Coach Lee",     time: "Today · 2:00 PM" },
  { id: 4, kind: "negative", icon: AlertCircle,   title: "Pull-out · Restorative",detail: "Brief conflict at recess — repaired with peer",     staff: "Mr. Ortiz",     time: "Yesterday · 12:40 PM" },
  { id: 5, kind: "positive", icon: ShieldCheck,   title: "Trusted adult check-in",detail: "Asked Mr. Ortiz for help during transition",       staff: "Mr. Ortiz",     time: "Yesterday · 9:10 AM" },
  { id: 6, kind: "positive", icon: Award,         title: "+3 PBIS · On-task",     detail: "Smooth transition into independent work",          staff: "Ms. Patel",     time: "2 days ago", pts: 3 },
  { id: 7, kind: "neutral",  icon: MessageSquare, title: "Email home",            detail: "Weekly snapshot · trending up in math",            staff: "Ms. Patel",     time: "3 days ago" },
];

const tone: Record<Event["kind"], { dot: string; ring: string; chip: string }> = {
  positive: { dot: "bg-emerald-500", ring: "ring-emerald-300/40", chip: "bg-emerald-500/15 text-emerald-300 border-emerald-400/30" },
  negative: { dot: "bg-rose-500",    ring: "ring-rose-300/40",    chip: "bg-rose-500/15 text-rose-300 border-rose-400/30" },
  neutral:  { dot: "bg-sky-500",     ring: "ring-sky-300/40",     chip: "bg-sky-500/15 text-sky-300 border-sky-400/30" },
};

export function StudentTimeline() {
  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-slate-50 via-white to-slate-100 text-slate-900">
      <header className="px-8 pt-6 pb-5 bg-white border-b border-slate-200">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2 text-xs uppercase tracking-[0.25em] text-slate-400">
            <Heart className="h-3.5 w-3.5 text-rose-500 fill-rose-500" /> Pulse · Student Timeline
          </div>
          <div className="text-[11px] text-slate-400">Visible to assigned staff & linked family · Period 4</div>
        </div>

        <div className="flex items-center gap-5">
          <div className="h-20 w-20 rounded-2xl bg-gradient-to-br from-blue-500 to-cyan-400 grid place-items-center text-white text-2xl font-black ring-4 ring-blue-200 shadow-lg shrink-0">TC</div>
          <div className="flex-1 min-w-0">
            <div className="text-2xl font-black tracking-tight">Tomás Castillo</div>
            <div className="text-sm text-slate-500">Grade 3 · Falcon House · Student ID 4128</div>
            <div className="mt-2 flex items-center gap-2 flex-wrap">
              <span className="text-[11px] px-2 py-0.5 rounded-md bg-emerald-100 text-emerald-700 font-semibold">+24 pts this week</span>
              <span className="text-[11px] px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 font-semibold">98% attendance</span>
              <span className="text-[11px] px-2 py-0.5 rounded-md bg-amber-100 text-amber-700 font-semibold">2 interventions</span>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3 text-center">
            {[
              { v: 142, l: "Total pts" },
              { v: 18,  l: "Positive" },
              { v: 2,   l: "Concerns" },
            ].map((s) => (
              <div key={s.l} className="px-4 py-3 rounded-xl bg-slate-50 border border-slate-200 min-w-[80px]">
                <div className="text-2xl font-black text-slate-900 tabular-nums">{s.v}</div>
                <div className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold">{s.l}</div>
              </div>
            ))}
          </div>
        </div>
      </header>

      <div className="px-8 py-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2 text-xs text-slate-400 uppercase tracking-widest">
            <CalendarClock className="h-3.5 w-3.5" /> Activity timeline · Last 7 days
          </div>
          <div className="flex items-center gap-1 text-[11px]">
            <button className="px-3 py-1.5 rounded-lg bg-slate-900 text-white font-semibold">Pulse view</button>
            <button className="px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-500 font-semibold">Inline list</button>
          </div>
        </div>

        <div className="relative pl-6">
          <div className="absolute left-2 top-2 bottom-2 w-px bg-gradient-to-b from-rose-300 via-violet-300 to-emerald-300" />
          <div className="space-y-3">
            {events.map((e) => {
              const Icon = e.icon;
              const t = tone[e.kind];
              return (
                <div key={e.id} className="relative">
                  <div className={`absolute -left-[18px] top-3 h-3 w-3 rounded-full ${t.dot} ring-4 ${t.ring}`} />
                  <div className="rounded-xl bg-white border border-slate-200 px-4 py-3 flex items-start gap-3 hover:shadow-md transition">
                    <div className={`h-9 w-9 rounded-lg grid place-items-center border ${t.chip} shrink-0`}>
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <div className="text-sm font-bold">{e.title}</div>
                        {e.pts !== undefined && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-bold">+{e.pts}</span>
                        )}
                      </div>
                      <div className="text-sm text-slate-600">{e.detail}</div>
                      <div className="text-[11px] text-slate-400 mt-0.5">{e.staff} · {e.time}</div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
