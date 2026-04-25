import { useState, type CSSProperties } from "react";

// InsightsHub — Phase 2 launcher for the eduCLIMBER-style whole-child
// platform. Today the only "live" tiles are Plans and Interventions
// (rehomed from the retired MTSS & Plans sidebar group). The other seven
// are placeholder shells that ship full dashboards in Phase 4.
//
// UX rules:
//   • A tile with `targetSection` is a launcher — clicking it calls
//     onNavigate(target) so the caller can setActiveSection().
//   • A tile without `targetSection` is a placeholder. It expands in place
//     to reveal the `body` copy (same accordion pattern as the SuperUser
//     Home / District Overview landing pages — collapsed by default so the
//     hub stays a short skimmable grid).
//   • The phase chip is always visible. "Today" → green, anything else →
//     gray.

export type InsightsTileId =
  | "academics"
  | "attendance"
  | "behavior"
  | "seb"
  | "engagement"
  | "equity"
  | "plans"
  | "interventions"
  | "earlyWarning";

export type InsightsGroupId = "domains" | "actions" | "monitoring";

export interface InsightsTile {
  id: InsightsTileId;
  icon: string;
  title: string;
  subtitle: string;
  phase: string;
  group: InsightsGroupId;
  // When present this tile is a launcher — clicking calls
  // onNavigate(targetSection). When absent the tile is a placeholder and
  // expands in place to reveal `subtitle` as the body.
  targetSection?: string;
  // Caller-side gate; placeholder tiles ignore this.
  available?: boolean;
}

interface Props {
  tiles: InsightsTile[];
  onNavigate: (target: string) => void;
}

const GROUP_ORDER: InsightsGroupId[] = ["domains", "actions", "monitoring"];

const GROUP_LABELS: Record<InsightsGroupId, string> = {
  domains: "Whole-Child Domains",
  actions: "Actions",
  monitoring: "Monitoring",
};

const GROUP_HINTS: Record<InsightsGroupId, string> = {
  domains:
    "Six lenses on every student — academics through equity. Phase 4 turns each tile into a full dashboard.",
  actions: "Day-to-day tools that already work today.",
  monitoring: "At-risk detection and longitudinal tracking. Ships Phase 4–5.",
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
  width: "100%",
  transition: "border-color 120ms, background 120ms",
};

function PhaseChip({ phase }: { phase: string }) {
  const isReady = phase === "Today";
  return (
    <span
      style={{
        fontSize: 10,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        padding: "2px 6px",
        borderRadius: 999,
        background: isReady ? "#dcfce7" : "#f1f5f9",
        color: isReady ? "#166534" : "#475569",
        border: isReady ? "1px solid #86efac" : "1px solid #cbd5e1",
        whiteSpace: "nowrap",
        flex: "0 0 auto",
      }}
    >
      {phase}
    </span>
  );
}

function TileButton({
  tile,
  onNavigate,
}: {
  tile: InsightsTile;
  onNavigate: (target: string) => void;
}) {
  const isLauncher = Boolean(tile.targetSection);
  const [expanded, setExpanded] = useState(false);
  const handleClick = () => {
    if (isLauncher && tile.targetSection) {
      onNavigate(tile.targetSection);
    } else {
      setExpanded((v) => !v);
    }
  };
  return (
    <button
      type="button"
      onClick={handleClick}
      aria-expanded={isLauncher ? undefined : expanded}
      style={{
        ...cardStyle,
        opacity: isLauncher ? 1 : 0.85,
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
        <PhaseChip phase={tile.phase} />
      </div>
      <div style={{ fontWeight: 600, fontSize: "1rem" }}>{tile.title}</div>
      <div
        style={{
          fontSize: 13,
          color: "var(--text-subtle, #94a3b8)",
          lineHeight: 1.4,
        }}
      >
        {expanded || isLauncher
          ? tile.subtitle
          : tile.subtitle.length > 80
            ? tile.subtitle.slice(0, 78) + "…"
            : tile.subtitle}
      </div>
      {!isLauncher && (
        <div
          style={{
            fontSize: 11,
            color: "var(--text-subtle, #94a3b8)",
            opacity: 0.7,
          }}
        >
          {expanded ? "Click to collapse" : "Click to learn more"}
        </div>
      )}
    </button>
  );
}

export default function InsightsHub({ tiles, onNavigate }: Props) {
  const grouped: Record<InsightsGroupId, InsightsTile[]> = {
    domains: [],
    actions: [],
    monitoring: [],
  };
  for (const t of tiles) grouped[t.group].push(t);

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <h2 style={{ marginTop: 0 }}>Insights</h2>
      <p style={{ color: "var(--text-subtle)", marginTop: 0 }}>
        Whole-child platform. Plans and Interventions work today. The six
        domain dashboards and Early Warning ship in Phase 4.
      </p>

      {GROUP_ORDER.map((groupId) => {
        const items = grouped[groupId];
        if (items.length === 0) return null;
        return (
          <section key={groupId} style={{ marginTop: "1.25rem" }}>
            <div
              style={{
                fontSize: 11,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "var(--text-subtle)",
                fontWeight: 700,
                marginBottom: "0.25rem",
              }}
            >
              {GROUP_LABELS[groupId]}
            </div>
            <div
              style={{
                fontSize: 12,
                color: "var(--text-subtle)",
                opacity: 0.8,
                marginBottom: "0.6rem",
              }}
            >
              {GROUP_HINTS[groupId]}
            </div>
            <div
              style={{
                display: "grid",
                gap: "0.75rem",
                gridTemplateColumns:
                  "repeat(auto-fill, minmax(240px, 1fr))",
              }}
            >
              {items.map((tile) => (
                <TileButton
                  key={tile.id}
                  tile={tile}
                  onNavigate={onNavigate}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
