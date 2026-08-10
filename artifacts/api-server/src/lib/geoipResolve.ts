import geoip from "geoip-lite";
import type { GeoPoint } from "./geoAnomalyMath.js";

// Server-side IP → coordinates via the bundled MaxMind GeoLite database
// (Section 3.4). This is the trustworthy geo source: it derives from the
// connection IP resolved by the app, not a client-supplied header, so it can't
// be spoofed by the caller, and it runs fully in-process — no third-party API
// call and therefore no new subprocessor for the district to vet.
//
// Best-effort: private/unknown IPs (or a lookup miss) simply return null, and
// the impossible-travel detector treats "no geo" as "no baseline / no signal".
export function geoFromIp(ip: string | null | undefined): GeoPoint | null {
  if (!ip) return null;
  try {
    const g = geoip.lookup(ip);
    if (g && Array.isArray(g.ll) && g.ll.length === 2) {
      const [lat, lon] = g.ll;
      if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
    }
  } catch {
    // best-effort — never throw into the login path
  }
  return null;
}
