import { describe, it, expect } from "vitest";
import { geoFromIp } from "../lib/geoipResolve.js";

// Proves the bundled GeoLite database is present and resolves IPs to
// coordinates in this environment (Section 3.4 geo source). No DB / network.
describe("geoFromIp (bundled GeoLite DB)", () => {
  it("resolves a known public IP to valid finite coordinates", () => {
    const g = geoFromIp("8.8.8.8"); // Google public DNS
    expect(g).not.toBeNull();
    if (g) {
      expect(Number.isFinite(g.lat)).toBe(true);
      expect(Number.isFinite(g.lon)).toBe(true);
      expect(Math.abs(g.lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(g.lon)).toBeLessThanOrEqual(180);
    }
  });

  it("returns null for private / invalid / missing IPs (no false geo)", () => {
    expect(geoFromIp("10.0.0.1")).toBeNull();
    expect(geoFromIp("not-an-ip")).toBeNull();
    expect(geoFromIp(null)).toBeNull();
    expect(geoFromIp(undefined)).toBeNull();
  });
});
