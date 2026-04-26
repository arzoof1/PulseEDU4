import {
  Heart,
  Bookmark,
  PhoneCall,
  MessageSquare,
  Coffee,
  Plus,
  Check,
  X,
  Clock,
  StickyNote,
  ChevronRight,
  Sparkles,
  Pencil,
  Search,
} from "lucide-react";

type Tag = {
  key: string;
  label: string;
  tone: string; // tailwind bg + text tone
};

type LastTouch = {
  by: string;
  what: string;
  when: string;
};

type Followup = {
  text: string;
  due: string;
};

type MyStudent = {
  id: string;
  initials: string;
  name: string;
  grade: number;
  avatarTone: string;
  myNote: string;
  addedOn: string;
  group: string; // self-tagged group key
  lastTouch: LastTouch | null;
  followup: Followup | null;
  alsoOnSystemWatch: boolean;
  needsTouchBase: boolean;
};

const GROUPS: Tag[] = [
  { key: "reading", label: "Reading concerns", tone: "bg-sky-100 text-sky-700 border-sky-200" },
  { key: "behavior", label: "Behavior watch", tone: "bg-rose-100 text-rose-700 border-rose-200" },
  { key: "family", label: "Family things to know", tone: "bg-violet-100 text-violet-700 border-violet-200" },
  { key: "shine", label: "Quiet kids to lift up", tone: "bg-emerald-100 text-emerald-700 border-emerald-200" },
];

const STUDENTS: MyStudent[] = [
  {
    id: "s1",
    initials: "TC",
    name: "Tomás Castillo",
    grade: 3,
    avatarTone: "from-blue-500 to-cyan-400",
    myNote: "Mom's working nights — Tomás has been sleepy in 1st period. Watching for tardies + retell quality.",
    addedOn: "Sep 3",
    group: "family",
    lastTouch: { by: "You", what: "Called home — talked to mom about the schedule", when: "Tue 3:10 PM" },
    followup: { text: "Try a quiet check-in before reading block", due: "Tomorrow" },
    alsoOnSystemWatch: false,
    needsTouchBase: false,
  },
  {
    id: "s2",
    initials: "AT",
    name: "Aaliyah Thompson",
    grade: 5,
    avatarTone: "from-amber-500 to-yellow-400",
    myNote: "She'll *say* she's fine but she's not. Big fluency gap. Wants to please — be careful about overscaffolding in front of peers.",
    addedOn: "Aug 28",
    group: "reading",
    lastTouch: { by: "You", what: "Pulled aside during independent reading", when: "Yesterday 10:40 AM" },
    followup: null,
    alsoOnSystemWatch: true,
    needsTouchBase: false,
  },
  {
    id: "s3",
    initials: "DR",
    name: "Daniela Reyes",
    grade: 4,
    avatarTone: "from-rose-500 to-orange-400",
    myNote: "Last week was rough. Triggered by transitions. Mr. Ortiz is her trusted adult — loop him in before specials.",
    addedOn: "Sep 15",
    group: "behavior",
    lastTouch: { by: "Mr. Ortiz", what: "Trusted adult check-in before PE", when: "Mon 1:20 PM" },
    followup: { text: "Catch her doing something right today", due: "Today" },
    alsoOnSystemWatch: true,
    needsTouchBase: true,
  },
  {
    id: "s4",
    initials: "JM",
    name: "Jamal Morrison",
    grade: 3,
    avatarTone: "from-violet-500 to-fuchsia-400",
    myNote: "New to school in August. Still figuring out routines. Doesn't know I noticed his great work on Friday's writing — should mention it.",
    addedOn: "Sep 22",
    group: "shine",
    lastTouch: null,
    followup: { text: "Mention Friday's writing — make it specific", due: "Today" },
    alsoOnSystemWatch: true,
    needsTouchBase: true,
  },
  {
    id: "s5",
    initials: "SK",
    name: "Saanvi Krishnan",
    grade: 5,
    avatarTone: "from-emerald-500 to-teal-400",
    myNote: "Reading is fine but she rushes. Comprehension drops on anything over a page. Try slower reads with sticky-note checkpoints.",
    addedOn: "Aug 30",
    group: "reading",
    lastTouch: { by: "You", what: "Conferenced about pacing strategies", when: "Wed 11:05 AM" },
    followup: null,
    alsoOnSystemWatch: false,
    needsTouchBase: false,
  },
  {
    id: "s6",
    initials: "MK",
    name: "Marcus King",
    grade: 4,
    avatarTone: "from-red-500 to-rose-400",
    myNote: "Has a younger sibling at home with a chronic illness. Some days he carries it in. Not a behavior kid — a tired kid.",
    addedOn: "Aug 22",
    group: "family",
    lastTouch: null,
    followup: null,
    alsoOnSystemWatch: true,
    needsTouchBase: true,
  },
];

function groupOf(key: string) {
  return GROUPS.find((g) => g.key === key)!;
}

function StudentCard({ s }: { s: MyStudent }) {
  return (
    <div className="relative rounded-2xl bg-white border border-slate-200 shadow-sm hover:shadow-md transition overflow-hidden">
      {s.needsTouchBase && (
        <div className="absolute top-3 right-3 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[10px] font-black uppercase tracking-wider border border-amber-200">
          <Clock className="h-2.5 w-2.5" /> Touch base
        </div>
      )}
      <div className="p-4">
        <div className="flex items-start gap-3">
          <div
            className={`h-12 w-12 rounded-xl bg-gradient-to-br ${s.avatarTone} grid place-items-center text-white text-sm font-black ring-4 ring-white shadow-sm shrink-0`}
          >
            {s.initials}
          </div>
          <div className="flex-1 min-w-0 pr-16">
            <div className="flex items-center gap-2 flex-wrap">
              <div className="text-base font-black tracking-tight text-slate-900 truncate">{s.name}</div>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 font-bold">G{s.grade}</span>
              {s.alsoOnSystemWatch && (
                <span className="inline-flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded bg-rose-50 text-rose-600 font-bold border border-rose-200" title="Also flagged on the school's system Watch List">
                  <Heart className="h-2 w-2 fill-rose-500" /> System
                </span>
              )}
            </div>
            <div className="text-[11px] text-slate-400 mt-0.5">Added {s.addedOn}</div>
          </div>
        </div>

        {/* Personal note */}
        <div className="mt-3 rounded-xl bg-amber-50 border border-amber-200 p-3 relative">
          <StickyNote className="h-3.5 w-3.5 text-amber-500 absolute top-2 right-2" />
          <div className="text-[10px] uppercase tracking-wider font-bold text-amber-700 mb-1">Why I'm watching</div>
          <div className="text-sm text-slate-700 leading-snug pr-4">{s.myNote}</div>
        </div>

        {/* Last touch */}
        {s.lastTouch ? (
          <div className="mt-3 flex items-start gap-2 text-xs">
            <div className="h-5 w-5 rounded-full bg-emerald-100 grid place-items-center mt-0.5 shrink-0">
              <Check className="h-3 w-3 text-emerald-600" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-slate-700">
                <span className="font-bold">{s.lastTouch.by}</span> · {s.lastTouch.what}
              </div>
              <div className="text-[11px] text-slate-400">{s.lastTouch.when}</div>
            </div>
          </div>
        ) : (
          <div className="mt-3 flex items-center gap-2 text-xs text-slate-400 italic">
            <div className="h-5 w-5 rounded-full bg-slate-100 grid place-items-center shrink-0">
              <X className="h-3 w-3 text-slate-400" />
            </div>
            No recent touch logged
          </div>
        )}

        {/* Followup */}
        {s.followup && (
          <div className="mt-2 flex items-start gap-2 text-xs rounded-lg bg-sky-50 border border-sky-200 p-2">
            <Sparkles className="h-3.5 w-3.5 text-sky-600 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-slate-700">{s.followup.text}</div>
              <div className="text-[11px] text-sky-600 font-bold">{s.followup.due}</div>
            </div>
          </div>
        )}

        {/* Quick actions */}
        <div className="mt-3 pt-3 border-t border-slate-100 flex items-center gap-1 flex-wrap">
          <button className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-emerald-50 text-emerald-700 text-[11px] font-bold border border-emerald-200 hover:bg-emerald-100">
            <Check className="h-3 w-3" /> Touched base
          </button>
          <button className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-white text-slate-600 text-[11px] font-semibold border border-slate-200 hover:border-slate-300 hover:text-slate-900">
            <PhoneCall className="h-3 w-3" /> Called home
          </button>
          <button className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-white text-slate-600 text-[11px] font-semibold border border-slate-200 hover:border-slate-300 hover:text-slate-900">
            <Coffee className="h-3 w-3" /> Pulled aside
          </button>
          <button className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-white text-slate-600 text-[11px] font-semibold border border-slate-200 hover:border-slate-300 hover:text-slate-900">
            <Pencil className="h-3 w-3" /> Edit note
          </button>
          <div className="ml-auto flex items-center gap-1 text-[11px] text-slate-500 font-semibold hover:text-slate-900 cursor-pointer">
            Profile <ChevronRight className="h-3 w-3" />
          </div>
        </div>
      </div>
    </div>
  );
}

function GroupSection({ groupKey }: { groupKey: string }) {
  const g = groupOf(groupKey);
  const kids = STUDENTS.filter((s) => s.group === groupKey);
  if (kids.length === 0) return null;
  return (
    <section className="px-8 py-5">
      <div className="flex items-center gap-2 mb-3">
        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-black border ${g.tone}`}>
          {g.label}
        </span>
        <span className="text-xs text-slate-400 font-semibold tabular-nums">{kids.length}</span>
        <div className="flex-1 h-px bg-slate-200 ml-2" />
        <button className="text-[11px] text-slate-400 hover:text-slate-700 font-semibold">+ Add to this group</button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {kids.map((s) => (
          <StudentCard key={s.id} s={s} />
        ))}
      </div>
    </section>
  );
}

export function MyWatchList() {
  const total = STUDENTS.length;
  const touchedThisWeek = STUDENTS.filter((s) => s.lastTouch && s.lastTouch.when.match(/(today|yesterday|mon|tue|wed|thu|fri)/i)).length;
  const needsTouch = STUDENTS.filter((s) => s.needsTouchBase).length;
  const followupsToday = STUDENTS.filter((s) => s.followup?.due === "Today").length;

  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-slate-50 via-white to-slate-100 text-slate-900">
      {/* HEADER */}
      <header className="px-8 pt-6 pb-5 bg-white border-b border-slate-200">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2 text-xs uppercase tracking-[0.25em] text-slate-400">
            <Heart className="h-3.5 w-3.5 text-rose-500 fill-rose-500" /> Pulse · My Watch List
          </div>
          <div className="text-[11px] text-slate-400">Private to you · Not shared with admins</div>
        </div>

        <div className="flex items-end justify-between gap-6 flex-wrap">
          <div>
            <div className="text-3xl font-black tracking-tight flex items-center gap-2">
              <Bookmark className="h-7 w-7 text-rose-500 fill-rose-100" />
              Kids on my mind
            </div>
            <div className="text-sm text-slate-500 mt-0.5">Ms. Patel · The students <em>you</em> are paying special attention to</div>
          </div>

          {/* Personal stat strip */}
          <div className="flex items-stretch gap-2">
            {[
              { label: "Watching", value: total, tone: "bg-slate-50 text-slate-900 border-slate-200" },
              { label: "Touched this wk", value: touchedThisWeek, tone: "bg-emerald-50 text-emerald-700 border-emerald-200" },
              { label: "Needs touch", value: needsTouch, tone: "bg-amber-50 text-amber-700 border-amber-200" },
              { label: "Today's follow-ups", value: followupsToday, tone: "bg-sky-50 text-sky-700 border-sky-200" },
            ].map((k) => (
              <div key={k.label} className={`px-4 py-2.5 rounded-xl border ${k.tone} min-w-[80px]`}>
                <div className="text-2xl font-black tabular-nums leading-none">{k.value}</div>
                <div className="text-[9px] uppercase tracking-wider font-bold mt-1 opacity-80">{k.label}</div>
              </div>
            ))}
          </div>
        </div>
      </header>

      {/* TOOLBAR */}
      <div className="px-8 py-3 bg-slate-50 border-b border-slate-200 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-sm">
          <Search className="h-3.5 w-3.5 text-slate-400" />
          <input
            placeholder="Search my list…"
            className="bg-transparent outline-none text-slate-700 placeholder-slate-400 w-44"
          />
        </div>
        <div className="flex items-center gap-1 px-2 py-1 rounded-lg bg-white border border-slate-200">
          {["All", "Needs touch", "Today's follow-ups"].map((label, i) => (
            <button
              key={label}
              className={`px-2 py-1 rounded text-xs font-semibold ${
                i === 0 ? "bg-slate-900 text-white" : "text-slate-500 hover:text-slate-900"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <button className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-500 text-white text-xs font-bold hover:bg-rose-600 ml-auto shadow-sm">
          <Plus className="h-3.5 w-3.5" /> Add a student
        </button>
      </div>

      {/* GROUPS */}
      {GROUPS.map((g) => (
        <GroupSection key={g.key} groupKey={g.key} />
      ))}

      {/* EMPTY-NESS NUDGE */}
      <div className="px-8 pt-2 pb-10">
        <div className="rounded-2xl border-2 border-dashed border-slate-200 p-6 text-center bg-white/60">
          <MessageSquare className="h-6 w-6 text-slate-300 mx-auto mb-2" />
          <div className="text-sm font-bold text-slate-600">Need a new group?</div>
          <div className="text-xs text-slate-400 mt-1">Make your own — anything you'd jot in a planner. "Tier 2 readers", "Mid-day check-ins", "Mom requested updates", whatever helps.</div>
          <button className="mt-3 inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-bold">
            <Plus className="h-3 w-3" /> Create a group
          </button>
        </div>
      </div>
    </div>
  );
}
