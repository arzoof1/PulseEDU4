// Generic keyed TTL memoizer for async resolvers. Deliberately PURE (no I/O,
// no DB import) so the caching/expiry logic is unit-testable without a
// database — mirroring the staffMfa (pure) vs staffMfaStore (DB) split.
// The clock is injectable via the `now` argument so tests can advance time
// deterministically instead of sleeping.

type Entry<V> = { value: V; expires: number };

export type TtlAsyncCache<V> = {
  /** Return the cached value for `key` if still fresh, else run `load`,
   *  cache the result for `ttlMs`, and return it. `now` defaults to the wall
   *  clock; pass an explicit value in tests. */
  get(key: string, load: () => Promise<V>, now?: number): Promise<V>;
  /** Drop every cached entry. */
  clear(): void;
};

export function createTtlAsyncCache<V>(ttlMs: number): TtlAsyncCache<V> {
  const store = new Map<string, Entry<V>>();
  return {
    async get(key, load, now = Date.now()): Promise<V> {
      const hit = store.get(key);
      if (hit && hit.expires > now) return hit.value;
      const value = await load();
      store.set(key, { value, expires: now + ttlMs });
      return value;
    },
    clear(): void {
      store.clear();
    },
  };
}
