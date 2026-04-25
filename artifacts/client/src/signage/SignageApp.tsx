import HeartbeatSignage from "./HeartbeatSignage";
import HousesSignage from "./HousesSignage";
import StudentTimelineSignage from "./StudentTimelineSignage";

// =============================================================================
// SignageApp — top-level dispatch for the "/signage/*" path family.
// -----------------------------------------------------------------------------
// We deliberately don't pull in react-router for three screens; the rest of
// the app uses internal `view` state so we keep the same convention here.
// Pulse signage runs on hallway TVs / staff iPads that never navigate after
// page load anyway.
// =============================================================================

export default function SignageApp() {
  const path = window.location.pathname;
  if (path.includes("/signage/houses")) return <HousesSignage />;
  if (path.includes("/signage/heartbeat")) return <HeartbeatSignage />;
  if (path.includes("/signage/student")) return <StudentTimelineSignage />;

  // Default landing: a tiny menu so somebody loading just /signage knows
  // which screens exist.
  return (
    <div className="min-h-screen w-full bg-slate-950 text-white grid place-items-center p-8">
      <div className="max-w-md w-full space-y-4 text-center">
        <div className="text-3xl font-black tracking-tight">PulseEDU Signage</div>
        <div className="text-white/60 text-sm">Pick a screen to display:</div>
        <div className="grid gap-3">
          <a
            href={`signage/heartbeat${window.location.search}`}
            className="block rounded-2xl border border-white/10 bg-white/5 hover:bg-white/10 transition px-5 py-4 text-left"
          >
            <div className="text-lg font-bold">Today's Heartbeat</div>
            <div className="text-xs text-white/50">Live mood meter + event feed (kiosk OK)</div>
          </a>
          <a
            href={`signage/houses${window.location.search}`}
            className="block rounded-2xl border border-white/10 bg-white/5 hover:bg-white/10 transition px-5 py-4 text-left"
          >
            <div className="text-lg font-bold">PBIS House Cup</div>
            <div className="text-xs text-white/50">Live house standings + per-house mini-meters (kiosk OK)</div>
          </a>
          <a
            href={`signage/student${window.location.search}`}
            className="block rounded-2xl border border-white/10 bg-white/5 hover:bg-white/10 transition px-5 py-4 text-left"
          >
            <div className="text-lg font-bold">Student Timeline</div>
            <div className="text-xs text-white/50">One-student deep dive · staff sign-in required</div>
          </a>
        </div>
        <div className="text-[11px] text-white/40 pt-2">
          Append <code className="px-1 py-0.5 bg-white/10 rounded">?schoolId=N</code> (heartbeat/houses)
          or <code className="px-1 py-0.5 bg-white/10 rounded">?studentId=N</code> (student) to the URL.
        </div>
      </div>
    </div>
  );
}
