import type { CSSProperties } from "react";
import { HowToUseHelp, HowToSection, RoleSection, howtoListStyle } from "./HowToUseHelp";

export type SettingsTileId =
  | "notifications"
  | "kiosk-setup"
  | "allowlist"
  | "restroom-access"
  | "locations"
  | "staff-defaults"
  | "school"
  | "bell-schedule"
  | "pbis-thresholds"
  | "pbis-reasons"
  | "schoolFeatures"
  | "branding"
  | "signage"
  | "tenancy"
  | "logo-generator"
  | "school-plans"
  | "data-management"
  | "parent-portal-sections"
  | "school-wide-expectations"
  | "intervention-strategies"
  | "house-logos"
  | "iss-settings"
  | "pickup"
  | "school-tours"
  | "event-tickets"
  | "e-sign"
  | "school-grade"
  | "staff-preview"
  | "separation-tags"
  | "staff-directory"
  | "cameras"
  | "case-outcomes"
  | "fast-coverage"
  | "kiosk-welcome"
  | "student-id-badges"
  | "class-signins-today"
  | "class-photo-day"
  | "time-tracking"
  | "onboarding";

export type SettingsGroupId =
  | "getting-started"
  | "school-identity"
  | "people-access"
  | "hall-pass-locations"
  | "behavior-pbis"
  | "family-signage"
  | "admin-tenancy";

export interface SettingsTile {
  id: SettingsTileId;
  icon: string;
  title: string;
  subtitle: string;
  badge?: number;
  legacy?: boolean;
  /**
   * When true the tile renders disabled with a "Coming soon" pill and does
   * not fire onSelect. Used to gate a feature whose code ships but whose UI
   * isn't ready for users yet (e.g. School Grade Calculator while its
   * calculation is being finalized).
   */
  comingSoon?: boolean;
  group?: SettingsGroupId;
}

/**
 * Optional onboarding progress payload, used to decorate the
 * "Getting Started" section header with a live X/N counter and a
 * progress bar. Fetched in App.tsx from /api/onboarding/status and
 * passed in. When omitted, the section header renders without the
 * counter (used for non-admin viewers who can't see onboarding).
 */
export interface OnboardingProgress {
  complete: number;
  total: number;
}

/**
 * Compact "do this next" card payload. The hub renders up to three of
 * these inside the Getting Started section. Each card deep-links via
 * the same onSelect-style handler so clicking jumps the admin to the
 * exact settings tile or top-level section that owns the step.
 *
 * `route.kind === "settings"` -> target is a SettingsTileId
 * `route.kind === "section"`  -> target is an activeSection key
 * (the parent handler is responsible for routing both kinds).
 */
export interface OnboardingNextStep {
  key: string;
  label: string;
  hint: string;
  route: { kind: "settings" | "section"; target: string };
}

interface Props {
  tiles: SettingsTile[];
  onSelect: (id: SettingsTileId) => void;
  onboardingProgress?: OnboardingProgress;
  onboardingNextSteps?: OnboardingNextStep[];
  onNavigateNextStep?: (route: OnboardingNextStep["route"]) => void;
}

const GROUP_ORDER: SettingsGroupId[] = [
  "getting-started",
  "school-identity",
  "people-access",
  "hall-pass-locations",
  "behavior-pbis",
  "family-signage",
  "admin-tenancy",
];

const GROUP_LABELS: Record<SettingsGroupId, string> = {
  "getting-started": "Getting Started",
  "school-identity": "School Identity",
  "people-access": "People & Access",
  "hall-pass-locations": "Hall Pass & Locations",
  "behavior-pbis": "Behavior & PBIS",
  "family-signage": "Family & Signage",
  "admin-tenancy": "Admin & Tenancy",
};

const GROUP_HINTS: Record<SettingsGroupId, string> = {
  "getting-started":
    "Run the onboarding checklist and choose which major features this school uses.",
  "school-identity":
    "Branding, school details, expectations acronym, and the bell schedule that drives periods.",
  "people-access":
    "Sign-in allowlists, staff defaults, the directory, and which sections parents can see.",
  "hall-pass-locations":
    "Kiosks, rooms, badges, and the camera registry that backs case-file video evidence.",
  "behavior-pbis":
    "PBIS reasons & tuning, ISS rules, intervention strategies, and case closure outcomes.",
  "family-signage":
    "Hallway-TV playlists and the Parent Pick-Up curb/walker module.",
  "admin-tenancy":
    "Notifications, imports/exports, tenancy (SuperUser), and admin QA tooling.",
};

// Per-section gradient. Bold white text on a saturated gradient gives
// each section its own visual identity without depending on the school's
// branding colors (which we want to keep room for elsewhere).
const GROUP_GRADIENTS: Record<SettingsGroupId, string> = {
  "getting-started":
    "linear-gradient(90deg, #4338ca 0%, #0891b2 100%)",
  "school-identity":
    "linear-gradient(90deg, #0f766e 0%, #059669 100%)",
  "people-access":
    "linear-gradient(90deg, #1e3a8a 0%, #2563eb 100%)",
  "hall-pass-locations":
    "linear-gradient(90deg, #b45309 0%, #ea580c 100%)",
  "behavior-pbis":
    "linear-gradient(90deg, #be123c 0%, #c026d3 100%)",
  "family-signage":
    "linear-gradient(90deg, #6d28d9 0%, #db2777 100%)",
  "admin-tenancy":
    "linear-gradient(90deg, #334155 0%, #64748b 100%)",
};

const cardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.35rem",
  padding: "1rem 1.1rem",
  border: "1px solid var(--border, #2a3447)",
  borderRadius: 10,
  background: "var(--card-bg, rgba(255,255,255,0.03))",
  cursor: "pointer",
  textAlign: "left",
  color: "inherit",
  font: "inherit",
  transition: "border-color 120ms, background 120ms",
};

function TileButton({
  tile,
  onSelect,
}: {
  tile: SettingsTile;
  onSelect: (id: SettingsTileId) => void;
}) {
  const comingSoon = !!tile.comingSoon;
  return (
    <button
      key={tile.id}
      type="button"
      onClick={() => {
        if (comingSoon) return;
        onSelect(tile.id);
      }}
      disabled={comingSoon}
      aria-disabled={comingSoon}
      style={{
        ...cardStyle,
        opacity: comingSoon ? 0.55 : tile.legacy ? 0.7 : 1,
        cursor: comingSoon ? "not-allowed" : "pointer",
      }}
      onMouseEnter={(e) => {
        if (comingSoon) return;
        (e.currentTarget as HTMLButtonElement).style.borderColor =
          "var(--accent, #3b82f6)";
      }}
      onMouseLeave={(e) => {
        if (comingSoon) return;
        (e.currentTarget as HTMLButtonElement).style.borderColor =
          "var(--border, #2a3447)";
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.5rem",
        }}
      >
        <div style={{ fontSize: "1.5rem", lineHeight: 1 }}>{tile.icon}</div>
        {comingSoon ? (
          <span
            style={{
              background: "rgba(148,163,184,0.25)",
              color: "var(--text-subtle)",
              borderRadius: 999,
              padding: "0.1rem 0.5rem",
              fontSize: 11,
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
          >
            Coming soon
          </span>
        ) : (
          typeof tile.badge === "number" &&
          tile.badge > 0 && (
            <span
              style={{
                background: "var(--accent, #3b82f6)",
                color: "white",
                borderRadius: 999,
                padding: "0.1rem 0.5rem",
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              {tile.badge}
            </span>
          )
        )}
      </div>
      <div style={{ fontWeight: 600 }}>
        {tile.title}
        {tile.legacy && (
          <span
            style={{
              marginLeft: 6,
              fontSize: 11,
              fontWeight: 400,
              color: "var(--text-subtle)",
            }}
          >
            (legacy)
          </span>
        )}
      </div>
      <div style={{ fontSize: 12, color: "var(--text-subtle)" }}>
        {tile.subtitle}
      </div>
    </button>
  );
}

// Gradient bar with bold white title, optional sub-hint, and (for the
// Getting Started section) a live X/N onboarding progress bar.
function SectionHeader({
  group,
  onboardingProgress,
}: {
  group: SettingsGroupId;
  onboardingProgress?: OnboardingProgress;
}) {
  const showProgress =
    group === "getting-started" &&
    onboardingProgress &&
    onboardingProgress.total > 0;
  const pct = showProgress
    ? Math.round(
        (onboardingProgress.complete / onboardingProgress.total) * 100,
      )
    : 0;
  return (
    <div
      style={{
        background: GROUP_GRADIENTS[group],
        borderRadius: 8,
        padding: "0.7rem 0.95rem",
        marginBottom: "0.65rem",
        color: "#fff",
        boxShadow: "0 1px 0 rgba(255,255,255,0.06) inset",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.75rem",
          flexWrap: "wrap",
        }}
      >
        <div
          style={{
            fontWeight: 800,
            fontSize: "0.95rem",
            letterSpacing: "0.02em",
            textShadow: "0 1px 1px rgba(0,0,0,0.25)",
          }}
        >
          {GROUP_LABELS[group]}
        </div>
        {showProgress && (
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              opacity: 0.95,
              whiteSpace: "nowrap",
            }}
          >
            {onboardingProgress.complete} / {onboardingProgress.total} steps
            complete ({pct}%)
          </div>
        )}
      </div>
      <div
        style={{
          fontSize: 12,
          opacity: 0.9,
          marginTop: 3,
        }}
      >
        {GROUP_HINTS[group]}
      </div>
      {showProgress && (
        <div
          style={{
            marginTop: 8,
            height: 5,
            borderRadius: 3,
            background: "rgba(255,255,255,0.22)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${pct}%`,
              height: "100%",
              background: "rgba(255,255,255,0.92)",
              transition: "width 0.4s ease",
            }}
          />
        </div>
      )}
    </div>
  );
}

export default function SettingsHub({
  tiles,
  onSelect,
  onboardingProgress,
  onboardingNextSteps,
  onNavigateNextStep,
}: Props) {
  // Bucket the tiles by `group`. Tiles with no `group` fall into an
  // "ungrouped" bucket rendered first so we never accidentally hide a tile
  // someone forgot to label. Inside each bucket, original tile order is
  // preserved so callers stay in control of layout.
  const buckets = new Map<SettingsGroupId | "__ungrouped__", SettingsTile[]>();
  for (const t of tiles) {
    const key = t.group ?? "__ungrouped__";
    const list = buckets.get(key) ?? [];
    list.push(t);
    buckets.set(key, list);
  }
  const orderedGroups: (SettingsGroupId | "__ungrouped__")[] = [
    "__ungrouped__",
    ...GROUP_ORDER,
  ];
  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <h2 style={{ marginTop: 0 }}>Settings</h2>
      <p style={{ color: "var(--text-subtle)", marginTop: 0 }}>
        Choose an area to configure.
      </p>
      <HowToUseHelp title="How to use Settings">
        <HowToSection title="What this hub is">
          Every per-school configuration tile in one launcher, grouped
          by domain. Each gradient bar marks the start of a section.
          Tiles you don't have permission to open are hidden, so the
          visible set is your toolbox.
        </HowToSection>
        <HowToSection title="Tips before you change something">
          <ul style={howtoListStyle}>
            <li>Start with <strong>Getting Started</strong> — the Onboarding Checklist tells you what still needs setup before staff can fully operate.</li>
            <li>Most settings are scoped to your school only — changes don't bleed to other schools in the district.</li>
            <li>Test parent-facing changes (sections, branding) by opening the Parent Portal in a private window after saving.</li>
            <li>Bell schedules drive the Hall Pass Queue's period reset — set a default before enabling the queue.</li>
          </ul>
        </HowToSection>
        <RoleSection for={["admin", "superUser"]} title="Admin-only tiles">
          Tenancy, allowlist, staff defaults, and data imports are
          here. Tenancy is the place to add or rename schools (SuperUser
          only); allowlist controls who can sign in.
        </RoleSection>
        <RoleSection for="districtAdmin" title="District-wide settings">
          District Admins see every school's settings side-by-side from
          the District Overview, not from this per-school launcher.
        </RoleSection>
      </HowToUseHelp>
      {orderedGroups.map((g) => {
        const list = buckets.get(g);
        if (!list || list.length === 0) return null;
        const isUngrouped = g === "__ungrouped__";
        return (
          <div key={g} style={{ marginTop: isUngrouped ? 0 : "1.25rem" }}>
            {!isUngrouped && (
              <SectionHeader
                group={g as SettingsGroupId}
                onboardingProgress={onboardingProgress}
              />
            )}
            {!isUngrouped &&
              g === "getting-started" &&
              onboardingNextSteps &&
              onboardingNextSteps.length > 0 &&
              onNavigateNextStep && (
                <NextStepsStrip
                  steps={onboardingNextSteps}
                  onNavigate={onNavigateNextStep}
                />
              )}
            <div
              style={{
                display: "grid",
                gridTemplateColumns:
                  "repeat(auto-fill, minmax(220px, 1fr))",
                gap: "0.75rem",
              }}
            >
              {list.map((t) => (
                <TileButton key={t.id} tile={t} onSelect={onSelect} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Up-to-three "what to do next" cards. Rendered between the Getting
// Started gradient header and the rest of that section's tiles, so
// the most relevant action is one click away without scrolling. The
// parent decides what counts as "next" (currently: first three steps
// where complete === false in /api/onboarding/status order).
function NextStepsStrip({
  steps,
  onNavigate,
}: {
  steps: OnboardingNextStep[];
  onNavigate: (route: OnboardingNextStep["route"]) => void;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        gap: "0.55rem",
        marginBottom: "0.75rem",
      }}
    >
      {steps.map((s, i) => (
        <button
          key={s.key}
          type="button"
          onClick={() => onNavigate(s.route)}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            padding: "0.6rem 0.75rem",
            border: "1px solid var(--border, #2a3447)",
            borderLeft: "3px solid #4338ca",
            borderRadius: 8,
            background:
              "linear-gradient(90deg, rgba(67,56,202,0.08) 0%, transparent 60%)",
            color: "inherit",
            font: "inherit",
            textAlign: "left",
            cursor: "pointer",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.borderColor =
              "#4338ca";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.borderColor =
              "var(--border, #2a3447)";
            (e.currentTarget as HTMLButtonElement).style.borderLeftColor =
              "#4338ca";
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "0.05em",
              color: "var(--text-subtle)",
              textTransform: "uppercase",
            }}
          >
            Next · {i + 1}
          </div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{s.label}</div>
          <div
            style={{
              fontSize: 11,
              color: "var(--text-subtle)",
              lineHeight: 1.35,
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {s.hint}
          </div>
          <div
            style={{
              marginTop: 2,
              fontSize: 11,
              fontWeight: 600,
              color: "#6366f1",
            }}
          >
            Open →
          </div>
        </button>
      ))}
    </div>
  );
}

export function SettingsBackBar({ onBack }: { onBack: () => void }) {
  return (
    <div style={{ marginBottom: "0.75rem" }}>
      <button
        type="button"
        onClick={onBack}
        style={{
          background: "transparent",
          border: "1px solid var(--border, #2a3447)",
          color: "inherit",
          padding: "0.35rem 0.7rem",
          borderRadius: 6,
          cursor: "pointer",
          font: "inherit",
        }}
      >
        ← All settings
      </button>
    </div>
  );
}
