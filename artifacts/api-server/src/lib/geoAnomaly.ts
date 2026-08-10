import type { Request } from "express";
import { raiseSecurityAlert } from "./securityAlerts.js";
import { logger } from "./logger.js";
import {
  type GeoPoint,
  haversineKm,
  impliedSpeedKmh,
  isImpossibleTravel,
  geoFromRequest,
} from "./geoAnomalyMath.js";
import { geoFromIp } from "./geoipResolve.js";

// Impossible-travel / geo-anomaly detection on login (Section 3.4). If the same
// account signs in from two locations whose separation could not be covered in
// the elapsed time by any commercial flight, that is a strong account-takeover
// signal. The detection math lives in geoAnomalyMath.ts (pure + unit-tested);
// the geo itself comes from CDN edge headers when present (CloudFront /
// Cloudflare / Vercel add viewer lat/long), so no third-party IP-geo lookup
// (and no extra subprocessor) is introduced. When the edge provides no geo,
// detection is dormant — the logic is in place and demonstrated by the test.

export type LoginLocation = GeoPoint & { at: number; ip: string | null };

// Per-process memory of each account's last login location. Best-effort: on a
// restart the first login simply establishes a fresh baseline (no false flag).
const lastLoginByStaff = new Map<number, LoginLocation>();

export async function detectImpossibleTravelOnLogin(
  req: Request,
  staff: { id: number; schoolId: number | null },
): Promise<void> {
  try {
    const ip =
      (typeof req.headers["x-forwarded-for"] === "string"
        ? req.headers["x-forwarded-for"].split(",")[0].trim()
        : req.ip) ?? null;
    // Edge geo headers (CloudFront/Cloudflare/Vercel) are only trustworthy when
    // the app actually sits behind that edge — the edge sets them and strips any
    // client-supplied copies. On a bare origin they are client-spoofable, so we
    // trust them ONLY when the operator opts in (TRUST_EDGE_GEO_HEADERS=1, set
    // when a geo-CDN is deployed). By default we use non-spoofable server-side
    // IP geolocation, which cannot be forged by the caller.
    const edgeGeo =
      process.env.TRUST_EDGE_GEO_HEADERS === "1" ? geoFromRequest(req) : null;
    const cur = edgeGeo ?? geoFromIp(ip);
    const now = Date.now();
    const prev = lastLoginByStaff.get(staff.id);

    if (cur && prev && isImpossibleTravel(prev, { ...cur, at: now })) {
      const km = Math.round(haversineKm(prev, cur));
      const speed = Math.round(impliedSpeedKmh(prev, { ...cur, at: now }));
      const minutes = Math.round((now - prev.at) / 60000);
      await raiseSecurityAlert({
        schoolId: staff.schoolId,
        type: "security_impossible_travel",
        payload: {
          fromIp: prev.ip,
          toIp: ip,
          distanceKm: km,
          minutesApart: minutes,
          impliedKmh: speed,
        },
      });
    }

    // Record this login as the new baseline (only when we have coordinates).
    if (cur) lastLoginByStaff.set(staff.id, { ...cur, at: now, ip });
  } catch (err) {
    logger.warn({ err, staffId: staff.id }, "[geoAnomaly] detection failed");
  }
}
