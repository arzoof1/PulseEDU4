// School Branding — fetches the current school's branding once on mount
// and pushes it into CSS custom properties on <html> so any component (or
// print stylesheet) can opt in via `var(--brand-header-bg)` and friends.
//
// Defaults to the PulseEDU palette when a school hasn't set anything.
import { useEffect, useState } from "react";
import { authFetch } from "./authToken";

export type BrandingPayload = {
  schoolId: number;
  gradientColors: string[];
  gradientAngle: number;
  primaryColor: string | null;
  accentColor: string | null;
  logoObjectPath: string | null;
  displayNameOverride: string | null;
  // Brandable primary-action button. Empty bgColors[] means "not
  // customized" — the app keeps its default var(--primary)/white look.
  buttonRestBgColors: string[];
  buttonRestBgAngle: number;
  buttonRestText: string | null;
  buttonHoverBgColors: string[];
  buttonHoverBgAngle: number;
  buttonHoverText: string | null;
};

// PulseEDU defaults — preserved for any school that hasn't customized.
export const DEFAULT_BRANDING_GRADIENT =
  "linear-gradient(135deg, #0f766e 0%, #0e7490 60%, #7c3aed 100%)";
export const DEFAULT_BRANDING_PRIMARY = "#0e7490";
export const DEFAULT_BRANDING_ACCENT = "#7c3aed";

// Build the CSS background value from a gradient color list.
//   0 colors  → fall back to the PulseEDU default
//   1 color   → solid background
//   2-4 cols  → linear-gradient with evenly spaced stops at the given angle
export function buildHeaderBackground(
  colors: string[],
  angle: number,
): string {
  if (!colors || colors.length === 0) return DEFAULT_BRANDING_GRADIENT;
  if (colors.length === 1) return colors[0]!;
  const stops = colors
    .map((c, i) => {
      const pct = Math.round((i / (colors.length - 1)) * 100);
      return `${c} ${pct}%`;
    })
    .join(", ");
  const safeAngle = Math.max(0, Math.min(360, Math.round(angle ?? 90)));
  return `linear-gradient(${safeAngle}deg, ${stops})`;
}

// Resolve the logo URL from an object-storage path. Returns null when no
// logo is set so consumers can hide their <img>.
export function resolveLogoUrl(objectPath: string | null): string | null {
  if (!objectPath) return null;
  if (objectPath.startsWith("/objects/")) {
    return `/api/storage${objectPath}`;
  }
  return objectPath;
}

// Apply the resolved values to the document root. Print stylesheets pick
// these up the same way as on-screen rules.
export function applyBrandingToRoot(b: BrandingPayload | null): void {
  const root = document.documentElement;
  const colors = b?.gradientColors ?? [];
  const angle = b?.gradientAngle ?? 90;
  const headerBg = buildHeaderBackground(colors, angle);
  const primary =
    b?.primaryColor ?? colors[0] ?? DEFAULT_BRANDING_PRIMARY;
  const accent =
    b?.accentColor ?? colors[colors.length - 1] ?? DEFAULT_BRANDING_ACCENT;
  const logoUrl = resolveLogoUrl(b?.logoObjectPath ?? null);

  root.style.setProperty("--brand-header-bg", headerBg);
  root.style.setProperty("--brand-primary", primary);
  root.style.setProperty("--brand-accent", accent);
  if (logoUrl) {
    root.style.setProperty("--brand-logo-url", `url("${logoUrl}")`);
    root.style.setProperty("--brand-has-logo", "1");
  } else {
    root.style.removeProperty("--brand-logo-url");
    root.style.setProperty("--brand-has-logo", "0");
  }

  // Branded primary-action button. We only set the CSS vars when the admin
  // has actually customized that side — otherwise we clear them so the
  // :root defaults (which point at --primary) take over and the button
  // keeps its original look. Hover falls back to rest-side values when the
  // admin has only set one side, so a single solid color "just works".
  const restBg =
    (b?.buttonRestBgColors?.length ?? 0) > 0
      ? buildHeaderBackground(b!.buttonRestBgColors, b!.buttonRestBgAngle)
      : null;
  const hoverBg =
    (b?.buttonHoverBgColors?.length ?? 0) > 0
      ? buildHeaderBackground(b!.buttonHoverBgColors, b!.buttonHoverBgAngle)
      : null;
  const restText = b?.buttonRestText ?? null;
  const hoverText = b?.buttonHoverText ?? null;

  setOrClear(root, "--brand-btn-bg", restBg);
  setOrClear(root, "--brand-btn-text", restText);
  // Hover falls back to rest values when not separately customized.
  setOrClear(root, "--brand-btn-hover-bg", hoverBg ?? restBg);
  setOrClear(root, "--brand-btn-hover-text", hoverText ?? restText);
}

function setOrClear(
  root: HTMLElement,
  prop: string,
  value: string | null,
): void {
  if (value) root.style.setProperty(prop, value);
  else root.style.removeProperty(prop);
}

// Cross-component change notifier. The Branding settings tile fires this
// after a successful save so the rest of the app retints without a reload.
const BRAND_EVENT = "pulseed:branding-updated";

export function emitBrandingUpdated(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(BRAND_EVENT));
}

// Hook: fetches the appropriate branding endpoint for the calling context
// (staff app, parent portal, kiosk), applies it to <html>, and re-fetches
// whenever emitBrandingUpdated() fires. Safe to call multiple times — the
// request is cheap and the result is idempotent.
//
// Why per-context: each surface has its own auth token shape:
//   - Staff app:    pulseed.authToken (Bearer)  → /api/school-branding
//   - Parent portal: pulseed.parentToken         → /api/parent-auth/branding
//   - Kiosk:        activation token in URL     → /api/kiosk/branding/<token>
// We don't tunnel them through one endpoint because each path is gated by
// its own session middleware.
export type BrandingContext =
  | { mode: "staff" }
  | { mode: "parent" }
  | { mode: "kiosk"; token: string | null };

export function useSchoolBranding(
  context: BrandingContext = { mode: "staff" },
): {
  branding: BrandingPayload | null;
  refresh: () => void;
} {
  const [branding, setBranding] = useState<BrandingPayload | null>(null);

  // Dependency key — refetch only when the meaningful identity changes.
  // For kiosk this is the token; for the others, just the mode.
  const ctxKey =
    context.mode === "kiosk" ? `kiosk:${context.token ?? ""}` : context.mode;

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        let res: Response | null = null;
        if (context.mode === "staff") {
          res = await authFetch("/api/school-branding");
        } else if (context.mode === "parent") {
          // Parent token lives in sessionStorage (see parent/api.ts ->
          // setParentToken). We read it directly here instead of importing
          // parentFetch to keep this hook usable from both staff and parent
          // surfaces without circular imports.
          let parentToken: string | null = null;
          try {
            parentToken =
              typeof window !== "undefined"
                ? window.sessionStorage.getItem("pulseed.parentToken")
                : null;
          } catch {
            // sessionStorage may be unavailable in some embedded contexts.
          }
          res = await fetch("/api/parent-auth/branding", {
            credentials: "include",
            headers: parentToken
              ? { Authorization: `Bearer ${parentToken}` }
              : {},
          });
        } else if (context.mode === "kiosk" && context.token) {
          res = await fetch(
            `/api/kiosk/branding/${encodeURIComponent(context.token)}`,
          );
        }
        if (!res || !res.ok) {
          if (!cancelled) {
            setBranding(null);
            applyBrandingToRoot(null);
          }
          return;
        }
        const data = (await res.json()) as BrandingPayload;
        if (!cancelled) {
          setBranding(data);
          applyBrandingToRoot(data);
        }
      } catch {
        if (!cancelled) {
          setBranding(null);
          applyBrandingToRoot(null);
        }
      }
    };
    load();
    const onUpdate = () => load();
    window.addEventListener(BRAND_EVENT, onUpdate);
    return () => {
      cancelled = true;
      window.removeEventListener(BRAND_EVENT, onUpdate);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxKey]);

  return {
    branding,
    refresh: emitBrandingUpdated,
  };
}
