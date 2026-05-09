import type { CSSProperties } from "react";

export type SettingsTileId =
  | "notifications"
  | "kiosk-setup"
  | "allowlist"
  | "locations"
  | "staff-defaults"
  | "school"
  | "bell-schedule"
  | "pbis-thresholds"
  | "schoolFeatures"
  | "branding"
  | "signage"
  | "tenancy"
  | "logo-generator"
  | "school-plans"
  | "data-imports"
  | "parent-portal-sections"
  | "school-wide-expectations"
  | "intervention-strategies"
  | "iss-settings"
  | "staff-preview"
  | "separation-tags"
  | "staff-directory";

export type SettingsGroupId =
  | "hall-pass-ops"
  | "school-identity"
  | "family-signage"
  | "feature-config"
  | "admin-tenancy";

export interface SettingsTile {
  id: SettingsTileId;
  icon: string;
  title: string;
  subtitle: string;
  badge?: number;
  legacy?: boolean;
  group?: SettingsGroupId;
}

interface Props {
  tiles: SettingsTile[];
  onSelect: (id: SettingsTileId) => void;
}

const GROUP_ORDER: SettingsGroupId[] = [
  "hall-pass-ops",
  "school-identity",
  "family-signage",
  "feature-config",
  "admin-tenancy",
];

const GROUP_LABELS: Record<SettingsGroupId, string> = {
  "hall-pass-ops": "Hall Pass Operations",
  "school-identity": "School Identity & Schedule",
  "family-signage": "Family & Signage",
  "feature-config": "Feature Configuration",
  "admin-tenancy": "Admin & Tenancy",
};

const GROUP_HINTS: Record<SettingsGroupId, string> = {
  "hall-pass-ops":
    "Kiosks, locations, and per-teacher allowlists for the daily pass flow.",
  "school-identity":
    "Branding, school details, and the bell schedule that drives periods.",
  "family-signage":
    "Parent access portal and the hallway-TV signage URLs.",
  "feature-config":
    "Toggle major features on/off and tune behavior thresholds.",
  "admin-tenancy":
    "Pending alerts and (SuperUser only) district / school assignment.",
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
  return (
    <button
      key={tile.id}
      type="button"
      onClick={() => onSelect(tile.id)}
      style={{
        ...cardStyle,
        opacity: tile.legacy ? 0.7 : 1,
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.borderColor =
          "var(--accent, #3b82f6)";
      }}
      onMouseLeave={(e) => {
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
        {typeof tile.badge === "number" && tile.badge > 0 && (
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

export default function SettingsHub({ tiles, onSelect }: Props) {
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
      {orderedGroups.map((g) => {
        const list = buckets.get(g);
        if (!list || list.length === 0) return null;
        const isUngrouped = g === "__ungrouped__";
        return (
          <div key={g} style={{ marginTop: isUngrouped ? 0 : "1.25rem" }}>
            {!isUngrouped && (
              <div style={{ marginBottom: "0.5rem" }}>
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    color: "var(--text-subtle)",
                  }}
                >
                  {GROUP_LABELS[g as SettingsGroupId]}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--text-subtle)",
                    opacity: 0.85,
                  }}
                >
                  {GROUP_HINTS[g as SettingsGroupId]}
                </div>
              </div>
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
