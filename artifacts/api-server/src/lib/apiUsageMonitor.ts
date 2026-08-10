import type { Request, Response, NextFunction } from "express";
import { raiseSecurityAlert } from "./securityAlerts.js";

// Excessive API-usage alerting (Section 3.3). A cheap in-memory sliding counter
// per account (or per IP for unauthenticated traffic) over a fixed window. When
// a key crosses the threshold, ONE alert fires for that window (dedup via an
// `alerted` flag) so a burst doesn't spam. In-memory by design: this is a
// per-process abuse heuristic, not a billing meter — it must add ~zero latency
// to the hot path, so it never touches the DB except to raise the (rare) alert.

const WINDOW_MS = Number(process.env.API_USAGE_WINDOW_MS ?? 60_000);
// Sustained > this many requests/min from one account (or IP) is abnormal for
// interactive use; tuned high enough to not trip on normal SPA bursts.
export const API_USAGE_THRESHOLD = Number(
  process.env.API_USAGE_ALERT_THRESHOLD ?? 300,
);
// Safety cap on distinct keys tracked, so a flood of unique IPs can't grow the
// map without bound; stale buckets are swept lazily below.
const MAX_KEYS = 20_000;

type Bucket = {
  count: number;
  windowStart: number;
  alerted: boolean;
  schoolId: number | null;
};

const buckets = new Map<string, Bucket>();

function sweepIfNeeded(now: number): void {
  if (buckets.size < MAX_KEYS) return;
  for (const [k, b] of buckets) {
    if (now - b.windowStart > WINDOW_MS) buckets.delete(k);
  }
}

export function apiUsageAlertMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  try {
    const staffId = (req as Request & { staffId?: number | null }).staffId;
    const schoolId =
      (req as Request & { schoolId?: number | null }).schoolId ??
      (req as Request & { homeSchoolId?: number | null }).homeSchoolId ??
      null;
    const key = staffId ? `staff:${staffId}` : `ip:${req.ip ?? "unknown"}`;
    const now = Date.now();

    let b = buckets.get(key);
    if (!b || now - b.windowStart > WINDOW_MS) {
      b = { count: 0, windowStart: now, alerted: false, schoolId };
      buckets.set(key, b);
      sweepIfNeeded(now);
    }
    b.count += 1;
    if (b.schoolId == null && schoolId != null) b.schoolId = schoolId;

    if (b.count === API_USAGE_THRESHOLD && !b.alerted) {
      b.alerted = true;
      // Fire-and-forget: alerting must not delay the request.
      void raiseSecurityAlert({
        schoolId: b.schoolId,
        type: "security_api_volume",
        payload: {
          scope: staffId ? "account" : "ip",
          staffId: staffId ?? null,
          ip: req.ip ?? null,
          count: b.count,
          threshold: API_USAGE_THRESHOLD,
          windowMinutes: Math.round(WINDOW_MS / 60000),
        },
      });
    }
  } catch {
    // Monitoring must never break a request.
  }
  next();
}
