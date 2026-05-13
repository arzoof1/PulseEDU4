import { useState } from "react";
import type { CSSProperties } from "react";
import DataImports from "./DataImports";
import DataExportPanel from "./DataExportPanel";

// ---------------------------------------------------------------------------
// DataManagementHub — Settings → Data Management. Two sub-tiles:
//   - Import: the existing 5-step CSV wizard (DataImports).
//   - Export: full-page filter + column picker (DataExportPanel).
// We keep the import/export choice in local state instead of polluting
// the global SettingsTileId union — the parent SettingsHub treats this
// whole hub as one tile.
// ---------------------------------------------------------------------------
type Mode = null | "import" | "export";

const cardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.4rem",
  padding: "1.25rem 1.4rem",
  border: "1px solid var(--border, #2a3447)",
  borderRadius: 12,
  background: "var(--card-bg, rgba(255,255,255,0.03))",
  cursor: "pointer",
  textAlign: "left",
  color: "inherit",
  font: "inherit",
  transition: "border-color 120ms, background 120ms",
};

function HubTile({
  icon,
  title,
  subtitle,
  onClick,
}: {
  icon: string;
  title: string;
  subtitle: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={cardStyle}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.borderColor =
          "var(--accent, #3b82f6)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.borderColor =
          "var(--border, #2a3447)";
      }}
    >
      <div style={{ fontSize: "1.6rem", lineHeight: 1 }}>{icon}</div>
      <div style={{ fontWeight: 600, fontSize: 15 }}>{title}</div>
      <div style={{ fontSize: 13, color: "var(--text-subtle)" }}>
        {subtitle}
      </div>
    </button>
  );
}

export default function DataManagementHub({
  canActAsDistrict,
}: {
  canActAsDistrict: boolean;
}) {
  const [mode, setMode] = useState<Mode>(null);

  if (mode === "import") {
    return (
      <div>
        <BackToHub onBack={() => setMode(null)} />
        <DataImports canActAsDistrict={canActAsDistrict} />
      </div>
    );
  }
  if (mode === "export") {
    return (
      <div>
        <BackToHub onBack={() => setMode(null)} />
        <DataExportPanel canActAsDistrict={canActAsDistrict} />
      </div>
    );
  }

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <h2 style={{ marginTop: 0 }}>Data Management</h2>
      <p style={{ color: "var(--text-subtle)", marginTop: 0 }}>
        Move data in and out of PulseEDU. Choose what you want to do.
      </p>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
          gap: "1rem",
          marginTop: "1rem",
        }}
      >
        <HubTile
          icon="📥"
          title="Import data"
          subtitle="Upload CSVs (FAST, iReady, MAP, rosters, behavior) with auto-mapping, preview, and one-click rollback."
          onClick={() => setMode("import")}
        />
        <HubTile
          icon="📤"
          title="Export data"
          subtitle="Download your school's current data as a CSV. Filter by grade, date, subject and pick which columns to include."
          onClick={() => setMode("export")}
        />
      </div>
    </div>
  );
}

function BackToHub({ onBack }: { onBack: () => void }) {
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
        ← Data Management
      </button>
    </div>
  );
}
