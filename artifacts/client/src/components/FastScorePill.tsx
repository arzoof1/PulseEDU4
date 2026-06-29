// Shared FAST achievement-level pill — the single visual source of truth
// for "score as a colored level pill" across the Teacher Roster and the
// Insights drill-downs (Academic Trajectories + Academics band drawer).
//
// The pill front face is driven by a surface-wide `PillView` toggle
// ("Show: Level | Scale score") via PillViewContext; an individual pill can
// be clicked to flip locally, but the next change to the global toggle
// clears every local override so the surface never gets stuck half-flipped.
//
// Keeping the LEVEL palette here (and importing it everywhere) guarantees
// the level colors can never silently diverge between surfaces.

import { createContext, useContext, useEffect, useState } from "react";

// Level → background color. Per product preference:
// L1 red, L2 orange, L3 green, L4 blue, L5 purple.
export const LEVEL_BG: Record<1 | 2 | 3 | 4 | 5, string> = {
  1: "#dc2626", // red
  2: "#f59e0b", // orange
  3: "#16a34a", // green
  4: "#2563eb", // blue
  5: "#7c3aed", // purple
};
// All chosen backgrounds are dark enough to take white text legibly.
export const LEVEL_FG: Record<1 | 2 | 3 | 4 | 5, string> = {
  1: "#fff",
  2: "#fff",
  3: "#fff",
  4: "#fff",
  5: "#fff",
};

export type PillView = "level" | "score";

// Default face for every pill under this provider. The toggle at the top of
// a surface flips this for the whole surface; pills can still be clicked to
// override individually.
export const PillViewContext = createContext<PillView>("level");

// Optional gain/decline marker rendered just below the pill. "up" = green
// ▲, "down" = red ▼. Used by the Insights drill-downs to keep a momentum
// cue on PM2 / PM3 relative to the PM1 baseline even though the pill itself
// now encodes the achievement level rather than movement.
export type PillMarker = "up" | "down" | null;

const MARKER_SLOT_HEIGHT = 12;

export function FastScorePill({
  score,
  level,
  subLevel,
  pmLabel,
  marker = null,
}: {
  score: number | null | undefined;
  level: 1 | 2 | 3 | 4 | 5 | null | undefined;
  subLevel: string | null | undefined;
  pmLabel: string;
  marker?: PillMarker;
}) {
  const view = useContext(PillViewContext);
  const [override, setOverride] = useState<PillView | null>(null);
  // When the surface-wide view flips, drop any local override so this pill
  // snaps back to the new default.
  useEffect(() => {
    setOverride(null);
  }, [view]);
  const effective: PillView = override ?? view;
  const flipped = effective === "score";

  // No score / no chart placement → neutral grey pill (still reserves the
  // marker slot so rows stay vertically aligned).
  if (score == null || level == null || subLevel == null) {
    return (
      <span style={wrapStyle}>
        <span title={`${pmLabel}: no score`} style={emptyPillStyle}>
          —
        </span>
        <span aria-hidden style={{ height: MARKER_SLOT_HEIGHT }} />
      </span>
    );
  }

  const tooltip = `${pmLabel} • Level ${subLevel} • Scale score ${score} (click to flip)`;
  const markerGlyph =
    marker === "up" ? "▲" : marker === "down" ? "▼" : "\u00A0";
  const markerColor =
    marker === "up" ? "#16a34a" : marker === "down" ? "#dc2626" : "transparent";

  return (
    <span style={wrapStyle}>
      <button
        type="button"
        title={tooltip}
        aria-label={tooltip}
        aria-pressed={flipped}
        onClick={() => setOverride(effective === "level" ? "score" : "level")}
        style={{
          ...pillButtonStyle,
          background: LEVEL_BG[level],
          color: LEVEL_FG[level],
        }}
      >
        {flipped ? score : subLevel}
      </button>
      <span
        aria-hidden={marker ? undefined : true}
        style={{
          minHeight: MARKER_SLOT_HEIGHT,
          fontSize: 10,
          fontWeight: 700,
          color: markerColor,
          lineHeight: 1.1,
        }}
      >
        {markerGlyph}
      </span>
    </span>
  );
}

// Compact segmented "Show: Level | Scale score" toggle for a surface
// header. Controlled — the surface owns the PillView state and wraps its
// pills in PillViewContext.Provider with the same value.
export function PillViewToggle({
  value,
  onChange,
}: {
  value: PillView;
  onChange: (v: PillView) => void;
}) {
  return (
    <span style={toggleWrapStyle}>
      <span style={toggleLabelStyle}>Show:</span>
      {(["level", "score"] as const).map((v) => {
        const active = value === v;
        return (
          <button
            key={v}
            type="button"
            onClick={() => onChange(v)}
            aria-pressed={active}
            style={{
              ...toggleBtnStyle,
              background: active ? "#2563eb" : "transparent",
              color: active ? "#fff" : "var(--text-subtle, #94a3b8)",
              fontWeight: active ? 700 : 600,
            }}
          >
            {v === "level" ? "Level" : "Scale score"}
          </button>
        );
      })}
    </span>
  );
}

const wrapStyle: React.CSSProperties = {
  display: "inline-flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 2,
};

const pillButtonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 40,
  height: 32,
  padding: "0 9px",
  borderRadius: 8,
  border: "none",
  fontSize: 15,
  fontWeight: 700,
  textAlign: "center",
  cursor: "pointer",
  fontFamily: "inherit",
  lineHeight: 1,
};

const emptyPillStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 40,
  height: 32,
  padding: "0 9px",
  borderRadius: 8,
  background: "#e5e7eb",
  color: "#6b7280",
  fontSize: 14,
  textAlign: "center",
};

const toggleWrapStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 2,
  padding: 2,
  borderRadius: 999,
  border: "1px solid var(--border, #334155)",
};

const toggleLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "var(--text-subtle, #94a3b8)",
  padding: "0 6px",
};

const toggleBtnStyle: React.CSSProperties = {
  border: "none",
  borderRadius: 999,
  padding: "3px 10px",
  fontSize: 12,
  cursor: "pointer",
  fontFamily: "inherit",
  lineHeight: 1.2,
};
