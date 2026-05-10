import { useEffect, useState, useMemo } from "react";
import { authFetch } from "../../lib/authToken";
import { WL_COLORS as C } from "./colors";

// Tiny inline dot rendered next to source rows (witness statements,
// case notes, incidents) on the case detail page when the AI
// consistency check has open findings citing that row.
//
// Color rule (worst-finding-wins, since one red dot is more useful
// than averaging colors a user has to interpret):
//   any high-severity contradiction → red
//   any med-severity contradiction or any high gap → amber
//   only corroborations or low gaps → green
//   not cited → render nothing
//
// The dot does NOT itself open the panel — clicks bubble up to the
// row's existing handler. The pill in the header is the canonical
// entry point. The dot is just a "this row has been flagged" marker
// so investigators reading top-to-bottom can see at a glance which
// statements are in dispute.

export type ConsistencyKind = "contradiction" | "gap" | "corroboration";
export type ConsistencySeverity = "high" | "med" | "low";

export interface ConsistencyFindingLite {
  kind: ConsistencyKind;
  severity: ConsistencySeverity;
  citedSourceRefs: Array<{ kind: string; id: number }>;
}

export interface ConsistencyRefMap {
  // key format: `${refKind}:${id}` → tally
  [key: string]: {
    high: number;
    med: number;
    low: number;
    contradictions: number;
    gaps: number;
    corroborations: number;
    total: number;
  };
}

export function buildConsistencyRefMap(
  findings: ConsistencyFindingLite[],
): ConsistencyRefMap {
  const map: ConsistencyRefMap = {};
  for (const f of findings) {
    for (const r of f.citedSourceRefs ?? []) {
      const key = `${r.kind}:${r.id}`;
      const m =
        map[key] ??
        (map[key] = {
          high: 0,
          med: 0,
          low: 0,
          contradictions: 0,
          gaps: 0,
          corroborations: 0,
          total: 0,
        });
      m[f.severity] += 1;
      if (f.kind === "contradiction") m.contradictions += 1;
      else if (f.kind === "gap") m.gaps += 1;
      else m.corroborations += 1;
      m.total += 1;
    }
  }
  return map;
}

interface DotProps {
  refMap: ConsistencyRefMap;
  refKind: "witness_statement" | "interaction" | "video_clip" | "case_note";
  refId: number;
}

export function ConsistencyDot({ refMap, refKind, refId }: DotProps) {
  const meta = refMap[`${refKind}:${refId}`];
  if (!meta || meta.total === 0) return null;
  let color = C.ok;
  let tier: "red" | "amber" | "green" = "green";
  if (meta.contradictions > 0 && meta.high > 0) {
    color = C.alert;
    tier = "red";
  } else if (meta.contradictions > 0 || meta.high > 0) {
    color = C.warn;
    tier = "amber";
  }
  const tip =
    `${meta.total} consistency finding${meta.total === 1 ? "" : "s"} on this row` +
    ` (${meta.contradictions} contradiction${meta.contradictions === 1 ? "" : "s"},` +
    ` ${meta.gaps} gap${meta.gaps === 1 ? "" : "s"},` +
    ` ${meta.corroborations} corroboration${meta.corroborations === 1 ? "" : "s"}).` +
    ` Open the AI consistency panel in the case header to review.`;
  return (
    <span
      className="inline-block h-2 w-2 rounded-full align-middle"
      style={{ background: color }}
      title={tip}
      aria-label={`Consistency: ${tier}`}
    />
  );
}

// Hook used by WatchlistCaseDetail to share findings between the
// header pill and the per-row dots. Polls every 30s while mounted.
// Silently swallows 403 (non-admin viewers) — dots simply don't
// appear, matching the gating on the pill.
export function useConsistencyFindings(caseId: number) {
  const [findings, setFindings] = useState<ConsistencyFindingLite[]>([]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await authFetch(
          `/api/watchlist/cases/${caseId}/consistency`,
        );
        if (!alive || !r.ok) return;
        const j = await r.json();
        const open = ((j.findings ?? []) as Array<ConsistencyFindingLite & {
          status: string;
        }>).filter((f) => f.status === "open");
        setFindings(open);
      } catch {
        /* network blip */
      }
    };
    void load();
    const t = window.setInterval(load, 30_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [caseId, tick]);

  const refMap = useMemo(() => buildConsistencyRefMap(findings), [findings]);
  const refresh = () => setTick((n) => n + 1);
  return { findings, refMap, refresh };
}
