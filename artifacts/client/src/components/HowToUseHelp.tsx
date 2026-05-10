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

import { createContext, useContext, useEffect, useState } from "react";

// Global "help mode" toggle. Default ON; persisted in localStorage so
// once a user dismisses the help shells they stay dismissed across
// reloads. The toggle button (HelpToggleButton) lives in the app
// header. When OFF, every <HowToUseHelp> renders nothing.
const HELP_ENABLED_KEY = "pulseedu.helpEnabled.v1";
type HelpEnabledListener = (enabled: boolean) => void;
const helpEnabledListeners = new Set<HelpEnabledListener>();

function readStoredHelpEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.localStorage.getItem(HELP_ENABLED_KEY);
    if (raw === null) return true; // default ON
    return raw === "1";
  } catch {
    return true;
  }
}

export function useHelpEnabled(): [boolean, (next: boolean) => void] {
  const [enabled, setEnabled] = useState<boolean>(readStoredHelpEnabled);
  useEffect(() => {
    const listener: HelpEnabledListener = (v) => setEnabled(v);
    helpEnabledListeners.add(listener);
    return () => {
      helpEnabledListeners.delete(listener);
    };
  }, []);
  const update = (next: boolean) => {
    try {
      window.localStorage.setItem(HELP_ENABLED_KEY, next ? "1" : "0");
    } catch {
      /* ignore */
    }
    helpEnabledListeners.forEach((l) => l(next));
  };
  return [enabled, update];
}

// Role context lets a help panel hide/show sections based on the
// current viewer's role(s). Pages that wrap their tree with
// <RoleProvider value={[...]}> let any nested <RoleSection for="admin">
// auto-filter. If no provider is mounted, RoleSection falls back to
// rendering the section for everyone (so old call sites keep working).
export type HelpRole =
  | "teacher"
  | "admin"
  | "districtAdmin"
  | "superUser"
  | "coreTeam"
  | "behaviorSpecialist"
  | "mtssCoordinator"
  | "schoolPsychologist"
  | "guidanceCounselor"
  | "pbisCoordinator"
  | "eseCoordinator"
  | "issTeacher"
  | "dean"
  | "counselor"
  | "socialWorker";

const RoleContext = createContext<HelpRole[] | null>(null);
export const RoleProvider = RoleContext.Provider;
export function useHelpRoles(): HelpRole[] | null {
  return useContext(RoleContext);
}

// Derive the active role list from an authUser-shaped object. Used by
// App.tsx to feed RoleProvider once at the top of the page tree.
export function rolesFromAuthUser(
  u:
    | {
        isAdmin?: boolean;
        isSuperUser?: boolean;
        isDistrictAdmin?: boolean;
        isBehaviorSpecialist?: boolean;
        isMtssCoordinator?: boolean;
        isSchoolPsychologist?: boolean;
        isGuidanceCounselor?: boolean;
        isPbisCoordinator?: boolean;
        isEseCoordinator?: boolean;
        isIssTeacher?: boolean;
        isDean?: boolean;
        isCounselor?: boolean;
        isSocialWorker?: boolean;
      }
    | null
    | undefined,
): HelpRole[] {
  if (!u) return [];
  const roles: HelpRole[] = ["teacher"];
  if (u.isAdmin) roles.push("admin");
  if (u.isSuperUser) roles.push("superUser", "admin");
  if (u.isDistrictAdmin) roles.push("districtAdmin", "admin");
  if (u.isBehaviorSpecialist) roles.push("behaviorSpecialist", "coreTeam");
  if (u.isMtssCoordinator) roles.push("mtssCoordinator", "coreTeam");
  if (u.isSchoolPsychologist) roles.push("schoolPsychologist", "coreTeam");
  if (u.isAdmin || u.isSuperUser || u.isDistrictAdmin) roles.push("coreTeam");
  if (u.isGuidanceCounselor) roles.push("guidanceCounselor");
  if (u.isPbisCoordinator) roles.push("pbisCoordinator");
  if (u.isEseCoordinator) roles.push("eseCoordinator");
  if (u.isIssTeacher) roles.push("issTeacher");
  if (u.isDean) roles.push("dean");
  if (u.isCounselor) roles.push("counselor");
  if (u.isSocialWorker) roles.push("socialWorker");
  return Array.from(new Set(roles));
}

export function HowToUseHelp({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [enabled] = useHelpEnabled();
  // When help mode is off (toggle in header), render nothing — the
  // user explicitly opted out of in-page guidance.
  if (!enabled) return null;
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

// HelpToggleButton — small "?" circle that toggles the global help
// mode. Mounted once in the app header. Color-coded so the user can
// see at a glance whether help shells are currently visible (filled
// blue when ON, outlined gray when OFF).
export function HelpToggleButton() {
  const [enabled, setEnabled] = useHelpEnabled();
  return (
    <button
      type="button"
      onClick={() => setEnabled(!enabled)}
      aria-pressed={enabled}
      title={
        enabled
          ? "Help panels are on. Click to hide them on every page."
          : "Help panels are off. Click to show the 'How to use this page' panels again."
      }
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 28,
        height: 28,
        borderRadius: "50%",
        border: enabled ? "1px solid #0f172a" : "1px solid #cbd5e1",
        background: enabled ? "#0f172a" : "transparent",
        color: enabled ? "white" : "#64748b",
        fontSize: 14,
        fontWeight: 700,
        cursor: "pointer",
        padding: 0,
        lineHeight: 1,
      }}
    >
      ?
    </button>
  );
}

// RoleSection — a HowToSection that only renders when the current
// viewer's roles overlap with `for`. If RoleProvider isn't mounted,
// the section renders unconditionally (back-compat). Adds a small role
// chip in the header so users always know "this is the admin-only
// part" even when they have multiple roles.
const ROLE_LABELS: Record<HelpRole, string> = {
  teacher: "Teachers",
  admin: "Admins",
  districtAdmin: "District Admins",
  superUser: "SuperUsers",
  coreTeam: "Core Team",
  behaviorSpecialist: "Behavior Specialists",
  mtssCoordinator: "MTSS Coordinators",
  schoolPsychologist: "School Psychologists",
  guidanceCounselor: "Guidance Counselors",
  pbisCoordinator: "PBIS Coordinators",
  eseCoordinator: "ESE Coordinators",
  issTeacher: "ISS Teachers",
  dean: "Deans",
  counselor: "Counselors",
  socialWorker: "Social Workers",
};

export function RoleSection({
  for: forRoles,
  title,
  children,
}: {
  for: HelpRole | HelpRole[];
  title: string;
  children: React.ReactNode;
}) {
  const current = useHelpRoles();
  const target = Array.isArray(forRoles) ? forRoles : [forRoles];
  if (current && !current.some((r) => target.includes(r))) return null;
  const chipText = target.map((r) => ROLE_LABELS[r]).join(" · ");
  return (
    <div style={{ marginTop: "0.85rem" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          marginBottom: "0.35rem",
        }}
      >
        <span
          style={{
            fontWeight: 700,
            fontSize: 13,
            color: "#0f172a",
            letterSpacing: "0.01em",
          }}
        >
          {title}
        </span>
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            padding: "1px 6px",
            borderRadius: 999,
            background: "#e0f2fe",
            color: "#075985",
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}
        >
          For {chipText}
        </span>
      </div>
      <div>{children}</div>
    </div>
  );
}
