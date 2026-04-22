import type { CSSProperties } from "react";

export type SettingsTileId =
  | "notifications"
  | "kiosks-active"
  | "kiosk-setup"
  | "allowlist"
  | "locations"
  | "staff-defaults"
  | "school"
  | "bell-schedule"
  | "pbis-thresholds";

export interface SettingsTile {
  id: SettingsTileId;
  icon: string;
  title: string;
  subtitle: string;
  badge?: number;
  legacy?: boolean;
}

interface Props {
  tiles: SettingsTile[];
  onSelect: (id: SettingsTileId) => void;
}

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

export default function SettingsHub({ tiles, onSelect }: Props) {
  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <h2 style={{ marginTop: 0 }}>Settings</h2>
      <p style={{ color: "var(--text-subtle)", marginTop: 0 }}>
        Choose an area to configure.
      </p>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
          gap: "0.75rem",
        }}
      >
        {tiles.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onSelect(t.id)}
            style={{
              ...cardStyle,
              opacity: t.legacy ? 0.7 : 1,
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
              <div style={{ fontSize: "1.5rem", lineHeight: 1 }}>{t.icon}</div>
              {typeof t.badge === "number" && t.badge > 0 && (
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
                  {t.badge}
                </span>
              )}
            </div>
            <div style={{ fontWeight: 600 }}>
              {t.title}
              {t.legacy && (
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
              {t.subtitle}
            </div>
          </button>
        ))}
      </div>
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
