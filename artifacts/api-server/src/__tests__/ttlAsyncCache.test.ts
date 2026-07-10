import { describe, expect, it, vi } from "vitest";
import { createTtlAsyncCache } from "../lib/ttlAsyncCache";

// The MFA enrollment gate relies on this cache to (a) stay off the DB hot path
// and (b) let a policy flip take effect within TTL — a security-relevant
// staleness bound. These tests pin both behaviors using an injected clock so
// no real time passes.
describe("createTtlAsyncCache", () => {
  it("memoizes within the TTL window (loader runs once)", async () => {
    const cache = createTtlAsyncCache<boolean>(30_000);
    const load = vi.fn().mockResolvedValue(true);

    expect(await cache.get("k", load, 1_000)).toBe(true);
    expect(await cache.get("k", load, 5_000)).toBe(true);
    expect(await cache.get("k", load, 30_999)).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("re-resolves once the entry expires", async () => {
    const cache = createTtlAsyncCache<boolean>(30_000);
    const load = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    expect(await cache.get("k", load, 1_000)).toBe(false);
    // 1_000 + 30_000 = 31_000 expiry; 31_001 is stale.
    expect(await cache.get("k", load, 31_001)).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("clear() forces the next call to re-resolve", async () => {
    const cache = createTtlAsyncCache<boolean>(30_000);
    const load = vi.fn().mockResolvedValue(true);

    await cache.get("k", load, 1_000);
    cache.clear();
    await cache.get("k", load, 1_001);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keys entries independently", async () => {
    const cache = createTtlAsyncCache<boolean>(30_000);
    const load = vi.fn().mockResolvedValue(true);

    await cache.get("1:p", load, 1_000);
    await cache.get("1:s", load, 1_000);
    await cache.get("2:p", load, 1_000);
    expect(load).toHaveBeenCalledTimes(3);
  });
});
