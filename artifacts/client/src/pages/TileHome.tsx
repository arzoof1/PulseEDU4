import React from "react";

export type TileGroup =
  | "quick"
  | "insights"
  | "recognition"
  | "support"
  | "family"
  | "admin";

export type Tile = {
  key: string;
  label: string;
  description: string;
  group: TileGroup;
  emoji: string;
  accent: string;
};

const GROUP_ORDER: TileGroup[] = [
  "quick",
  "insights",
  "recognition",
  "support",
  "family",
  "admin",
];

const GROUP_META: Record<TileGroup, { label: string; hint: string }> = {
  quick: {
    label: "Quick Access",
    hint: "Day-of teacher actions",
  },
  insights: {
    label: "Insights",
    hint: "Who needs attention right now",
  },
  recognition: {
    label: "Recognition",
    hint: "PBIS points, houses, store",
  },
  support: {
    label: "Behavior & Support",
    hint: "Plans, interventions, pullouts",
  },
  family: {
    label: "Family",
    hint: "Parent communication & portal",
  },
  admin: {
    label: "School Admin",
    hint: "Staff, schedules, displays",
  },
};

export function TileHome({
  tiles,
  onPick,
  userName,
  schoolName,
}: {
  tiles: Tile[];
  onPick: (key: string) => void;
  userName?: string;
  schoolName?: string;
}) {
  const grouped: Record<TileGroup, Tile[]> = {
    quick: [],
    insights: [],
    recognition: [],
    support: [],
    family: [],
    admin: [],
  };
  for (const t of tiles) grouped[t.group].push(t);

  return (
    <div
      style={{
        minHeight: "100vh",
        width: "100%",
        background:
          "linear-gradient(180deg, #0f172a 0%, #1e293b 40%, #0f172a 100%)",
        color: "white",
        padding: "48px 56px 96px",
        boxSizing: "border-box",
      }}
    >
      <div style={{ maxWidth: 1400, margin: "0 auto" }}>
        <div style={{ marginBottom: 32 }}>
          <div
            style={{
              fontSize: 11,
              letterSpacing: "0.25em",
              textTransform: "uppercase",
              color: "rgba(255,255,255,0.5)",
              fontWeight: 700,
              marginBottom: 8,
            }}
          >
            PulseEDU · Home
          </div>
          <h1
            style={{
              fontSize: 38,
              fontWeight: 800,
              margin: 0,
              letterSpacing: "-0.02em",
            }}
          >
            {userName ? `Welcome back, ${userName}.` : "Welcome back."}
          </h1>
          <div
            style={{
              fontSize: 16,
              color: "rgba(255,255,255,0.65)",
              marginTop: 6,
            }}
          >
            {schoolName ? `${schoolName} · ` : ""}Pick where you want to go.
          </div>
        </div>

        {GROUP_ORDER.map((g) => {
          const items = grouped[g];
          if (items.length === 0) return null;
          const meta = GROUP_META[g];
          return (
            <section key={g} style={{ marginBottom: 36 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 12,
                  marginBottom: 14,
                  paddingBottom: 8,
                  borderBottom: "1px solid rgba(255,255,255,0.08)",
                }}
              >
                <h2
                  style={{
                    fontSize: 18,
                    fontWeight: 700,
                    margin: 0,
                    letterSpacing: "-0.01em",
                  }}
                >
                  {meta.label}
                </h2>
                <span
                  style={{
                    fontSize: 12,
                    color: "rgba(255,255,255,0.45)",
                  }}
                >
                  {meta.hint}
                </span>
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns:
                    "repeat(auto-fill, minmax(260px, 1fr))",
                  gap: 16,
                }}
              >
                {items.map((t) => (
                  <TileCard key={t.key} tile={t} onPick={onPick} />
                ))}
              </div>
            </section>
          );
        })}

        {tiles.length === 0 && (
          <div
            style={{
              padding: 48,
              textAlign: "center",
              color: "rgba(255,255,255,0.55)",
              border: "1px dashed rgba(255,255,255,0.15)",
              borderRadius: 16,
            }}
          >
            No tiles available for your role yet — use the sidebar to navigate.
          </div>
        )}
      </div>
    </div>
  );
}

function TileCard({
  tile,
  onPick,
}: {
  tile: Tile;
  onPick: (key: string) => void;
}) {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      type="button"
      onClick={() => onPick(tile.key)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: "relative",
        textAlign: "left",
        background: hover
          ? "linear-gradient(135deg, rgba(255,255,255,0.08), rgba(255,255,255,0.03))"
          : "rgba(255,255,255,0.04)",
        border: `1px solid ${hover ? tile.accent : "rgba(255,255,255,0.08)"}`,
        borderLeft: `4px solid ${tile.accent}`,
        borderRadius: 14,
        padding: "18px 18px 18px 20px",
        color: "white",
        cursor: "pointer",
        transition:
          "transform 160ms ease, box-shadow 160ms ease, background 160ms ease, border-color 160ms ease",
        transform: hover ? "translateY(-3px)" : "translateY(0)",
        boxShadow: hover
          ? `0 12px 32px -12px ${tile.accent}66, 0 4px 12px -4px rgba(0,0,0,0.5)`
          : "0 2px 8px -2px rgba(0,0,0,0.3)",
        minHeight: 112,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        outline: "none",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 4,
        }}
      >
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 10,
            background: `${tile.accent}22`,
            border: `1px solid ${tile.accent}55`,
            display: "grid",
            placeItems: "center",
            fontSize: 22,
            flexShrink: 0,
          }}
          aria-hidden="true"
        >
          {tile.emoji}
        </div>
        <div
          style={{
            fontSize: 16,
            fontWeight: 700,
            letterSpacing: "-0.01em",
          }}
        >
          {tile.label}
        </div>
      </div>
      <div
        style={{
          fontSize: 13,
          color: "rgba(255,255,255,0.65)",
          lineHeight: 1.4,
        }}
      >
        {tile.description}
      </div>
    </button>
  );
}
