import { useEffect, useRef, useState, useCallback } from "react";

// =============================================================================
// usePolling — small wrapper around fetch() for kiosk/signage screens.
// -----------------------------------------------------------------------------
// Why custom instead of TanStack Query?  Signage runs unauthenticated on
// hallway TVs; we don't want to ship the rest of the app's auth/staff data
// graph just to render two endpoints.  This hook keeps the bundle slim and
// makes the polling cadence + visibility behaviour explicit:
//   - First fetch on mount.
//   - Re-fetch every `intervalMs`.
//   - Pause polling when the tab is hidden (kiosk power saving).
//   - On error keep showing the last good payload (so a transient blip
//     doesn't blank the TV).
// =============================================================================

export interface PollingState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;          // true only on the very first load
  lastUpdatedAt: Date | null;
  refetch: () => void;
}

export function usePolling<T>(
  url: string | null,
  intervalMs: number = 30_000,
): PollingState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const inFlight = useRef<AbortController | null>(null);

  const fetchOnce = useCallback(async () => {
    if (!url) return;
    inFlight.current?.abort();
    const ctrl = new AbortController();
    inFlight.current = ctrl;
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = (await res.json()) as T;
      setData(json);
      setError(null);
      setLastUpdatedAt(new Date());
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") return;
      setError((err as Error).message || "Failed to fetch");
    } finally {
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    if (!url) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void fetchOnce();
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer) return;
      timer = setInterval(() => {
        if (document.visibilityState === "visible") void fetchOnce();
      }, intervalMs);
    };
    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVis = () => {
      if (document.visibilityState === "visible") {
        void fetchOnce();
        start();
      } else {
        stop();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    start();

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVis);
      inFlight.current?.abort();
    };
  }, [url, intervalMs, fetchOnce]);

  return { data, error, loading, lastUpdatedAt, refetch: fetchOnce };
}

// Helper: pull schoolId out of the URL (?schoolId=N).  Returns NaN if missing
// or invalid; callers render a friendly error in that case.
export function schoolIdFromUrl(): number {
  if (typeof window === "undefined") return NaN;
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("schoolId");
  return raw ? Number(raw) : NaN;
}
