import { useCallback, useEffect, useState } from "react";
import {
  studentFetch,
  setStudentToken,
  type StudentMe,
  type StudentSnapshot,
} from "./api";
import StoreTab from "./StoreTab";

type Tab = "home" | "store";

function relativeDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export default function Dashboard({
  me,
  onLoggedOut,
}: {
  me: StudentMe;
  onLoggedOut: () => void;
}) {
  const [tab, setTab] = useState<Tab>("home");
  const [snap, setSnap] = useState<StudentSnapshot | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await studentFetch("/api/student/snapshot");
      if (res.ok) setSnap((await res.json()) as StudentSnapshot);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function logout() {
    try {
      await studentFetch("/api/student-auth/logout", { method: "POST" });
    } catch {
      /* ignore */
    }
    setStudentToken(null);
    onLoggedOut();
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="bg-gradient-to-r from-indigo-600 to-violet-600 text-white">
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center justify-between">
          <div>
            <div className="text-xs opacity-80">My HeartBEAT</div>
            <div className="text-lg font-bold">
              Hi, {me.firstName}! 👋
            </div>
          </div>
          <button
            onClick={logout}
            className="text-xs font-semibold bg-white/15 hover:bg-white/25 rounded-lg px-3 py-1.5 transition"
          >
            Sign out
          </button>
        </div>
        {/* Tabs */}
        <div className="max-w-2xl mx-auto px-4 flex gap-1">
          {(["home", "store"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2.5 text-sm font-semibold rounded-t-lg transition ${
                tab === t
                  ? "bg-slate-50 text-indigo-700"
                  : "text-white/80 hover:text-white"
              }`}
            >
              {t === "home" ? "Home" : "School Store"}
            </button>
          ))}
        </div>
      </header>

      <main className="max-w-2xl mx-auto">
        {tab === "store" ? (
          <StoreTab />
        ) : loading ? (
          <div className="p-6 text-slate-400 text-sm">Loading…</div>
        ) : !snap ? (
          <div className="p-6 text-rose-600">Could not load your HeartBEAT.</div>
        ) : (
          <div className="p-4 sm:p-6 space-y-5">
            {/* Points hero */}
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-2xl bg-gradient-to-br from-violet-600 to-indigo-600 text-white p-5 shadow-lg">
                <div className="text-xs opacity-80">Points to spend</div>
                <div className="text-4xl font-extrabold">
                  {snap.points.available}
                </div>
                <div className="text-[11px] opacity-75 mt-1">
                  {snap.points.lifetimeEarned} earned all-time
                </div>
              </div>
              <div className="rounded-2xl bg-white border border-slate-200 p-5">
                <div className="text-xs text-slate-400">This week</div>
                <div className="text-4xl font-extrabold text-slate-800">
                  {snap.points.thisWeek}
                </div>
                <div className="text-[11px] text-slate-400 mt-1">
                  {snap.points.positiveCount} positive ·{" "}
                  {snap.points.negativeCount} reminders
                </div>
              </div>
            </div>

            {snap.house && (
              <div
                className="rounded-2xl p-4 text-white shadow"
                style={{ backgroundColor: snap.house.color }}
              >
                <div className="text-xs opacity-90">Your house</div>
                <div className="text-xl font-bold">{snap.house.name}</div>
              </div>
            )}

            {/* Attendance */}
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-2xl bg-white border border-slate-200 p-4 text-center">
                <div className="text-2xl font-extrabold text-emerald-600">
                  {snap.attendance.pct === null ? "—" : `${snap.attendance.pct}%`}
                </div>
                <div className="text-[11px] text-slate-400">Attendance</div>
              </div>
              <div className="rounded-2xl bg-white border border-slate-200 p-4 text-center">
                <div className="text-2xl font-extrabold text-amber-600">
                  {snap.attendance.tardiesYtd}
                </div>
                <div className="text-[11px] text-slate-400">Tardies</div>
              </div>
              <div className="rounded-2xl bg-white border border-slate-200 p-4 text-center">
                <div className="text-2xl font-extrabold text-rose-600">
                  {snap.attendance.absences}
                </div>
                <div className="text-[11px] text-slate-400">Absences</div>
              </div>
            </div>

            {/* Points by teacher */}
            <div>
              <h2 className="text-sm font-bold text-slate-700 mb-2">
                Points by teacher
              </h2>
              {snap.points.byTeacher.length === 0 ? (
                <p className="text-sm text-slate-400">No points yet.</p>
              ) : (
                <div className="space-y-1.5">
                  {snap.points.byTeacher.map((t) => (
                    <div
                      key={t.staffName}
                      className="flex items-center justify-between rounded-xl bg-white border border-slate-200 px-4 py-2.5"
                    >
                      <span className="text-sm text-slate-700">
                        {t.staffName}
                      </span>
                      <span
                        className={`text-sm font-bold ${
                          t.points >= 0 ? "text-violet-700" : "text-rose-600"
                        }`}
                      >
                        {t.points > 0 ? "+" : ""}
                        {t.points}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Recent recognitions */}
            <div>
              <h2 className="text-sm font-bold text-slate-700 mb-2">
                Recent recognitions
              </h2>
              {snap.recentRecognitions.length === 0 ? (
                <p className="text-sm text-slate-400">Nothing yet.</p>
              ) : (
                <div className="space-y-1.5">
                  {snap.recentRecognitions.map((r, i) => (
                    <div
                      key={i}
                      className="rounded-xl bg-white border border-slate-200 px-4 py-2.5 flex items-start justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-slate-800">
                          {r.reason}
                        </div>
                        <div className="text-[11px] text-slate-400">
                          {r.staffName} · {relativeDay(r.createdAt)}
                        </div>
                      </div>
                      <span
                        className={`text-sm font-bold flex-shrink-0 ${
                          r.polarity === "negative"
                            ? "text-rose-600"
                            : "text-emerald-600"
                        }`}
                      >
                        {r.points > 0 ? "+" : ""}
                        {r.points}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
