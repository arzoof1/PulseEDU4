import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { authFetch } from "../../lib/authToken";
import { WL_COLORS as C } from "./colors";
import ConsistencyPanel, { type ConsistencyState } from "./ConsistencyPanel";

// Compact AI-consistency pill that lives in the case header next to
// the severity chip. Reads the per-case state row (cheap denormalised
// snapshot — one read), polls every 30s while the case is open so the
// score reflects new evidence without a manual refresh, and opens the
// full ConsistencyPanel on click.
//
// "—" placeholder when no run has happened yet — admins shouldn't
// confuse "no data" with "perfect score 100".
//
// Color thresholds (matched in the panel):
//   ≥ 80 → ok (green)
//   50–79 → warn (amber)
//   < 50 → alert (red)
//
// All this surface is gated upstream — the API endpoint is behind
// `adminGate`, so non-admins receive a 403 and we render nothing.

type FetchPayload = {
  state: ConsistencyState | null;
  latestRun: {
    id: number;
    createdAt: string;
    triggeredByName: string | null;
    triggerReason: string;
    model: string;
    errorText: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
  } | null;
  findings: Array<unknown>;
};

interface Props {
  caseId: number;
  onAnyChange?: () => void;
}

export default function ConsistencyPill({ caseId, onAnyChange }: Props) {
  const [state, setState] = useState<ConsistencyState | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [open, setOpen] = useState(false);

  const load = async () => {
    try {
      const r = await authFetch(`/api/watchlist/cases/${caseId}/consistency`);
      if (r.status === 403) {
        setForbidden(true);
        return;
      }
      if (!r.ok) return;
      const j = (await r.json()) as FetchPayload;
      setState(j.state);
    } catch {
      /* network blip — let the next poll retry */
    }
  };

  useEffect(() => {
    void load();
    const t = window.setInterval(load, 30_000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId]);

  if (forbidden) return null;

  const score = state?.score ?? null;
  const openCount = state?.openFindingCount ?? 0;
  const hiCount = state?.highSeverityCount ?? 0;

  // Color tiers — we only style the dot/text accent. The pill itself
  // uses panel-soft so it doesn't compete with the case-severity chip
  // visually but is still findable as an interactive control.
  const tier =
    score == null
      ? "neutral"
      : score >= 80
        ? "ok"
        : score >= 50
          ? "warn"
          : "alert";
  const dotColor =
    tier === "ok"
      ? C.ok
      : tier === "warn"
        ? C.warn
        : tier === "alert"
          ? C.alert
          : C.inkSoft;
  const label =
    score == null ? "AI consistency: —" : `AI consistency: ${score}`;
  const tip =
    score == null
      ? "AI consistency check has not run yet for this case. Open to run it."
      : `${openCount} open finding${openCount === 1 ? "" : "s"}${
          hiCount ? ` · ${hiCount} high` : ""
        }. Click to review. AI suggestion — verify before acting.`;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold transition-colors hover:bg-black/5"
        style={{
          borderColor: C.line,
          background: C.panel,
          color: C.ink,
        }}
        title={tip}
      >
        <Sparkles className="h-3 w-3" style={{ color: C.inkSoft }} />
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ background: dotColor }}
          aria-hidden
        />
        <span>{label}</span>
        {openCount > 0 && (
          <span
            className="ml-0.5 inline-flex min-w-[16px] items-center justify-center rounded-full px-1 text-[10px] font-bold"
            style={{
              background: tier === "alert" ? C.alertSoft : C.warnSoft,
              color: tier === "alert" ? C.alert : C.warn,
            }}
          >
            {openCount}
          </span>
        )}
      </button>
      {open && (
        <ConsistencyPanel
          caseId={caseId}
          onClose={() => {
            setOpen(false);
            void load();
            onAnyChange?.();
          }}
          onChanged={() => {
            void load();
            onAnyChange?.();
          }}
        />
      )}
    </>
  );
}
