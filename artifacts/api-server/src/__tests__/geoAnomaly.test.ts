import { describe, it, expect } from "vitest";
import {
  haversineKm,
  impliedSpeedKmh,
  isImpossibleTravel,
} from "../lib/geoAnomalyMath.js";

// Simulated cases for impossible-travel detection (Section 3.4). No DB needed.
const NYC = { lat: 40.7128, lon: -74.006 };
const TOKYO = { lat: 35.6762, lon: 139.6503 };
const BOSTON = { lat: 42.3601, lon: -71.0589 };
const MIN = 60_000;

describe("geoAnomaly", () => {
  it("computes a sane great-circle distance", () => {
    // NYC↔Tokyo is ~10,800 km; allow a wide tolerance.
    const km = haversineKm(NYC, TOKYO);
    expect(km).toBeGreaterThan(10_000);
    expect(km).toBeLessThan(11_500);
  });

  it("flags NYC→Tokyo 30 minutes apart as impossible travel", () => {
    const prev = { ...NYC, at: 0 };
    const cur = { ...TOKYO, at: 30 * MIN };
    expect(impliedSpeedKmh(prev, cur)).toBeGreaterThan(1000);
    expect(isImpossibleTravel(prev, cur)).toBe(true);
  });

  it("does NOT flag the same city minutes apart (GeoIP jitter)", () => {
    const prev = { ...NYC, at: 0 };
    const cur = { lat: 40.75, lon: -73.99, at: 5 * MIN };
    expect(isImpossibleTravel(prev, cur)).toBe(false);
  });

  it("does NOT flag NYC→Tokyo when the gap is a plausible ~14h flight", () => {
    const prev = { ...NYC, at: 0 };
    const cur = { ...TOKYO, at: 14 * 60 * MIN };
    expect(isImpossibleTravel(prev, cur)).toBe(false);
  });

  it("does NOT flag NYC→Boston (under the min-distance floor)", () => {
    const prev = { ...NYC, at: 0 };
    const cur = { ...BOSTON, at: 1 * MIN }; // ~1 min apart, ~300 km
    expect(isImpossibleTravel(prev, cur)).toBe(false);
  });
});
