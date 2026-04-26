// HowToUseHelp — shared collapsible help shell used at the top of every
// insights dashboard.
//
// Why a shared component: each dashboard (Academics, Behavior,
// Engagement, Equity, SEB/SEL, Early Warning) needs an in-page
// orientation panel for staff, but only the *content* of the panel
// differs per dashboard. The button / chevron / open-state behavior /
// styling is identical. Centralising the shell keeps the five panels
// visually consistent and means a future style tweak (e.g. adding
// keyboard shortcut) only needs to be made in one place.
//
// Usage:
//   <HowToUseHelp title="How to use Behavior">
//     <HowToSection title="What this dashboard is">…</HowToSection>
//     <HowToSection title="How to read it">…</HowToSection>
//     …
//   </HowToUseHelp>
//
// Open state is intentionally NOT persisted across visits. Staff who
// close the panel almost always want it closed again next time, and
// adding per-user persistence would just cost a ui_prefs round-trip
// for a one-time read.

import { useState } from "react";

export function HowToUseHelp({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // ariaId is derived from the title so multiple panels on the same
  // page (defensive — not currently expected) don't collide on the
  // aria-controls reference.
  const ariaId =
    "howto-" +
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

  return (
    <div
      style={{
        marginTop: "0.75rem",
        border: "1px solid #e2e8f0",
        borderRadius: 8,
        background: "#f8fafc",
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={ariaId}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.75rem",
          padding: "0.75rem 1rem",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
          font: "inherit",
          color: "#0f172a",
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <span
            aria-hidden
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 22,
              height: 22,
              borderRadius: "50%",
              background: "#0f172a",
              color: "white",
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            ?
          </span>
          <span style={{ fontWeight: 600, fontSize: 14 }}>{title}</span>
          <span
            style={{
              fontSize: 12,
              color: "#64748b",
              fontWeight: 400,
            }}
          >
            {open ? "Click to close" : "Click to open"}
          </span>
        </span>
        <span
          aria-hidden
          style={{
            display: "inline-block",
            transform: open ? "rotate(90deg)" : "rotate(0deg)",
            transition: "transform 120ms ease",
            color: "#64748b",
            fontSize: 14,
            lineHeight: 1,
          }}
        >
          ▶
        </span>
      </button>

      {open && (
        <div
          id={ariaId}
          style={{
            padding: "0.25rem 1rem 1rem",
            borderTop: "1px solid #e2e8f0",
            background: "white",
            color: "#334155",
            fontSize: 13,
            lineHeight: 1.55,
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

// HowToSection — small subhead wrapper used inside HowToUseHelp so
// every "How to use" panel uses the same heading typography and
// spacing. Title is bolded, slightly larger, with consistent top
// space; body is just the children passed in.

export function HowToSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginTop: "0.85rem" }}>
      <div
        style={{
          fontWeight: 700,
          fontSize: 13,
          color: "#0f172a",
          marginBottom: "0.35rem",
          letterSpacing: "0.01em",
        }}
      >
        {title}
      </div>
      <div>{children}</div>
    </div>
  );
}

// Shared list style — used by every panel for the bullet lists in
// "How to use it day-to-day" sections. Keeps the bullets visually
// consistent across dashboards.
export const howtoListStyle: React.CSSProperties = {
  margin: 0,
  paddingLeft: "1.1rem",
  display: "grid",
  gap: "0.4rem",
};
