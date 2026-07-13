import type { Request } from "express";

// Pure geo-anomaly math + header parsing (Section 3.4), split out from
// geoAnomaly.ts so it is unit-testable without pulling in the DB layer (which
// throws at import when DATABASE_URL is unset).

export type GeoPoint = { lat: number; lon: number };

// Fastest sensible commercial travel incl. connections/margin (a jetliner
// cruises ~900 km/h). Above this between two logins ⇒ implausible.
export const MAX_PLAUSIBLE_KMH = Number(
  process.env.GEO_MAX_PLAUSIBLE_KMH ?? 1000,
);
// Ignore tiny hops (same metro / GeoIP jitter) — only flag real distance.
export const MIN_FLAG_KM = 500;

export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Implied average speed (km/h) to get from prev to cur in the elapsed time.
export function impliedSpeedKmh(
  prev: { at: number } & GeoPoint,
  cur: { at: number } & GeoPoint,
): number {
  const km = haversineKm(prev, cur);
  const hours = Math.abs(cur.at - prev.at) / 3_600_000;
  if (hours <= 0) return Infinity;
  return km / hours;
}

// True when travelling prev→cur in the elapsed time is physically implausible.
export function isImpossibleTravel(
  prev: { at: number } & GeoPoint,
  cur: { at: number } & GeoPoint,
  maxKmh: number = MAX_PLAUSIBLE_KMH,
): boolean {
  if (haversineKm(prev, cur) < MIN_FLAG_KM) return false;
  return impliedSpeedKmh(prev, cur) > maxKmh;
}

function num(v: unknown): number | null {
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Best-effort viewer geo from CDN edge headers. Returns null if the edge did
// not attach coordinates (detection then stays dormant for that login).
export function geoFromRequest(req: Request): GeoPoint | null {
  const h = req.headers;
  const pairs: Array<[unknown, unknown]> = [
    [h["cloudfront-viewer-latitude"], h["cloudfront-viewer-longitude"]],
    [h["cf-iplatitude"], h["cf-iplongitude"]],
    [h["x-vercel-ip-latitude"], h["x-vercel-ip-longitude"]],
    [h["x-geo-latitude"], h["x-geo-longitude"]],
  ];
  for (const [rawLat, rawLon] of pairs) {
    const lat = num(rawLat);
    const lon = num(rawLon);
    if (lat != null && lon != null) return { lat, lon };
  }
  return null;
}
