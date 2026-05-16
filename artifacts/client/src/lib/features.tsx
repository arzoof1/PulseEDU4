// Feature licensing — client-side singleton + hooks.
//
// We deliberately skip a Context provider here because App.tsx is a
// 21k-line module that already owns auth state directly. Instead, the
// hook is backed by a module-level store + `useSyncExternalStore`, and
// App.tsx kicks off `initFeatures()` once after auth lands.

import React, { useSyncExternalStore } from "react";
import { authFetch } from "./authToken";

export type EffectiveFeature = {
  enabled: boolean;
  showUpsell: boolean;
  quotas: Record<string, number | string[]>;
};

type FeatureMap = Record<string, EffectiveFeature>;

type State = {
  status: "idle" | "loading" | "ready" | "error";
  map: FeatureMap;
};

let state: State = { status: "idle", map: {} };
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function getSnapshot() {
  return state;
}

let inflight: Promise<void> | null = null;

// Idempotent. Safe to call repeatedly — only one fetch in flight.
// Re-call with `force=true` to invalidate (e.g. after the SuperUser
// admin UI flips a flag and wants to see the effect immediately).
export async function refreshFeatures(force = false): Promise<void> {
  if (inflight && !force) return inflight;
  inflight = (async () => {
    state = { ...state, status: "loading" };
    emit();
    try {
      const res = await authFetch("/api/me/features");
      if (!res.ok) {
        // Treat as "no licensing context" — every gate falls closed.
        state = { status: "error", map: {} };
        emit();
        return;
      }
      const json = (await res.json()) as { features?: FeatureMap };
      state = { status: "ready", map: json.features ?? {} };
      emit();
    } catch {
      state = { status: "error", map: {} };
      emit();
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

// Called by App.tsx after auth lands. No-op when called pre-auth.
export function initFeatures(): void {
  if (state.status === "idle") {
    void refreshFeatures();
  }
}

export function clearFeatures(): void {
  state = { status: "idle", map: {} };
  inflight = null;
  emit();
}

export function useFeatures() {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return React.useMemo(
    () => ({
      ready: snap.status === "ready",
      // Gate is closed-by-default while loading so we don't briefly
      // flash gated content before licensing arrives.
      has(key: string): boolean {
        return snap.map[key]?.enabled === true;
      },
      showUpsell(key: string): boolean {
        return snap.map[key]?.showUpsell === true;
      },
      quota(
        key: string,
        name: string,
      ): number | string[] | undefined {
        return snap.map[key]?.quotas?.[name];
      },
      raw: snap.map,
    }),
    [snap],
  );
}

// -----------------------------------------------------------------------------
// UI primitives
// -----------------------------------------------------------------------------

export function LockedBadge(): React.ReactElement {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "1px 6px",
        marginLeft: 6,
        fontSize: "0.7rem",
        fontWeight: 600,
        color: "var(--text-subtle, #666)",
        background: "var(--bg-subtle, #f1f1f4)",
        border: "1px solid var(--border, #ddd)",
        borderRadius: 10,
        lineHeight: 1.2,
      }}
      title="This feature requires an upgrade"
    >
      🔒 Upgrade
    </span>
  );
}

export function UpsellCard({
  feature,
  label,
}: {
  feature: string;
  label?: string;
}): React.ReactElement {
  const pretty = label ?? feature;
  return (
    <div
      className="card"
      style={{
        maxWidth: 560,
        margin: "2rem auto",
        textAlign: "center",
        padding: "2rem",
      }}
    >
      <div style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>🔒</div>
      <h2 style={{ marginTop: 0 }}>{pretty} isn't included in your plan</h2>
      <p style={{ color: "var(--text-subtle, #555)" }}>
        Contact your district administrator to add this feature to your
        school. We can turn it on the same day.
      </p>
    </div>
  );
}

// FeatureGate — renders children when `has`, the upsell card (or a
// custom `fallback`) when `showUpsell` only, and `null` otherwise. The
// `null` branch matches the Hybrid visibility decision: hidden by
// default unless the SuperUser explicitly opts the school in to the
// upsell surface.
export function FeatureGate({
  feature,
  label,
  fallback,
  children,
}: {
  feature: string;
  label?: string;
  fallback?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement | null {
  const f = useFeatures();
  if (f.has(feature)) return <>{children}</>;
  if (f.showUpsell(feature)) {
    return <>{fallback ?? <UpsellCard feature={feature} label={label} />}</>;
  }
  return null;
}

// Small helper used in nav lists: returns `true` when the item should
// appear in the sidebar at all (enabled OR opted-in to upsell).
export function useFeatureVisible(feature: string): {
  visible: boolean;
  locked: boolean;
} {
  const f = useFeatures();
  const enabled = f.has(feature);
  const upsell = f.showUpsell(feature);
  return { visible: enabled || upsell, locked: !enabled && upsell };
}
