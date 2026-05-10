import { useEffect, useMemo, useState } from "react";
import { HowToUseHelp, HowToSection, RoleSection } from "./HowToUseHelp";

// =============================================================================
// SignageLauncherView — staff-facing landing page that lists the three
// /signage/* kiosk URLs with one-click "Open in new tab" + "Copy link"
// buttons. Lives in the staff sidebar so anyone can grab a hallway-TV URL
// without remembering the path scheme.
// -----------------------------------------------------------------------------
// All URLs are computed against the current origin so they Just Work in
// dev, staging, and the published `.replit.app` domain.
// =============================================================================

type AuthUserLite = {
  schoolId?: number | null;
} | null;

interface SignageScreen {
  id: string;
  title: string;
  blurb: string;
  path: string;
  needsStudentId?: boolean;
  staffOnly?: boolean;
}

function buildScreens(schoolId: number | null): SignageScreen[] {
  const sid = schoolId ?? 1;
  return [
    {
      id: "heartbeat",
      title: "Today's Heartbeat",
      blurb: "Live mood meter + rolling event feed. Safe for hallway TVs — names are masked, free-text notes are hidden.",
      path: `/signage/heartbeat?schoolId=${sid}`,
    },
    {
      id: "houses",
      title: "PBIS House Cup",
      blurb: "Four-house leaderboard with per-house mood meters under each bar. Safe for hallway TVs.",
      path: `/signage/houses?schoolId=${sid}`,
    },
    {
      id: "student",
      title: "Student Timeline",
      blurb: "One-student deep dive for parent conferences and MTSS huddles. Requires staff sign-in on the device — surfaces full names + behavior notes.",
      path: `/signage/student?studentId=`,
      needsStudentId: true,
      staffOnly: true,
    },
  ];
}

export default function SignageLauncherView({ authUser }: { authUser: AuthUserLite }) {
  const schoolId = authUser?.schoolId ?? null;
  const screens = useMemo(() => buildScreens(schoolId), [schoolId]);
  const [studentId, setStudentId] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Auto-clear the "Copied!" pill after a couple seconds.
  useEffect(() => {
    if (!copiedId) return;
    const t = window.setTimeout(() => setCopiedId(null), 1800);
    return () => window.clearTimeout(t);
  }, [copiedId]);

  const origin = typeof window !== "undefined" ? window.location.origin : "";

  function fullUrl(s: SignageScreen): string {
    if (s.needsStudentId) {
      const sid = studentId.trim();
      return `${origin}${s.path}${sid}`;
    }
    return `${origin}${s.path}`;
  }

  function open(s: SignageScreen) {
    const url = fullUrl(s);
    if (s.needsStudentId && !studentId.trim()) return;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  async function copy(s: SignageScreen) {
    if (s.needsStudentId && !studentId.trim()) return;
    const url = fullUrl(s);
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(s.id);
    } catch {
      // Fallback for older browsers / non-secure contexts.
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        setCopiedId(s.id);
      } catch {
        // give up silently
      }
      document.body.removeChild(ta);
    }
  }

  return (
    <div className="signage-launcher" style={{ maxWidth: 880 }}>
      <h2 style={{ marginTop: 0 }}>Signage</h2>
      <p style={{ color: "#475569", marginTop: 0 }}>
        Pulse signage screens for hallway TVs and staff devices. Open one in a
        new tab or copy the link to paste into a kiosk browser.
      </p>
      <HowToUseHelp title="How to use the Signage Launcher">
        <HowToSection title="What this page is">
          A list of every signage screen this school has. Each card
          shows what the screen displays and a one-click "open in new
          tab" button you'd point a TV browser at.
        </HowToSection>
        <RoleSection for={["admin", "coreTeam"]} title="Casting tip">
          Bookmark each TV's URL on the device itself. Most signage
          screens auto-refresh — you only need to refresh manually
          after a major settings change.
        </RoleSection>
      </HowToUseHelp>

      <div
        style={{
          display: "grid",
          gap: 12,
          marginTop: 16,
        }}
      >
        {screens.map((s) => {
          const url = fullUrl(s);
          const disabled = Boolean(s.needsStudentId) && !studentId.trim();
          return (
            <div
              key={s.id}
              style={{
                border: "1px solid #e2e8f0",
                borderRadius: 12,
                padding: 16,
                background: "white",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                  gap: 8,
                }}
              >
                <div style={{ fontSize: 18, fontWeight: 700 }}>{s.title}</div>
                {s.staffOnly && (
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      color: "#9333ea",
                      background: "#f3e8ff",
                      padding: "2px 8px",
                      borderRadius: 6,
                      textTransform: "uppercase",
                      letterSpacing: 0.5,
                    }}
                  >
                    Staff sign-in required
                  </span>
                )}
              </div>
              <div style={{ color: "#64748b", marginTop: 4, fontSize: 14 }}>
                {s.blurb}
              </div>

              {s.needsStudentId && (
                <div style={{ marginTop: 12 }}>
                  <label
                    style={{
                      display: "block",
                      fontSize: 12,
                      fontWeight: 600,
                      color: "#475569",
                      marginBottom: 4,
                    }}
                  >
                    Student row ID
                  </label>
                  <input
                    type="number"
                    inputMode="numeric"
                    placeholder="e.g. 42"
                    value={studentId}
                    onChange={(e) => setStudentId(e.target.value)}
                    style={{
                      width: 160,
                      padding: "6px 10px",
                      border: "1px solid #cbd5e1",
                      borderRadius: 6,
                      fontSize: 14,
                    }}
                  />
                  <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 4 }}>
                    The internal student row ID, not the school's student
                    number. (Pull from the student's family-comm page URL.)
                  </div>
                </div>
              )}

              <div
                style={{
                  marginTop: 12,
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                <button
                  type="button"
                  onClick={() => open(s)}
                  disabled={disabled}
                  className="primary"
                  style={{ opacity: disabled ? 0.5 : 1 }}
                >
                  Open in new tab
                </button>
                <button
                  type="button"
                  onClick={() => copy(s)}
                  disabled={disabled}
                  style={{ opacity: disabled ? 0.5 : 1 }}
                >
                  Copy link
                </button>
                {copiedId === s.id && (
                  <span
                    style={{
                      color: "#16a34a",
                      fontSize: 12,
                      fontWeight: 700,
                    }}
                  >
                    Copied!
                  </span>
                )}
              </div>

              <div
                style={{
                  marginTop: 10,
                  fontFamily:
                    "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace",
                  fontSize: 12,
                  color: "#475569",
                  background: "#f8fafc",
                  padding: "8px 10px",
                  borderRadius: 6,
                  wordBreak: "break-all",
                  border: "1px solid #e2e8f0",
                }}
              >
                {url}
              </div>
            </div>
          );
        })}
      </div>

      <div
        style={{
          marginTop: 20,
          padding: 12,
          borderRadius: 10,
          background: "#fefce8",
          border: "1px solid #fde68a",
          fontSize: 13,
          color: "#713f12",
        }}
      >
        <strong>Kiosk tip:</strong> Heartbeat and Houses are designed to run
        without anyone signed in — just paste the URL into a hallway TV's
        browser. Student Timeline needs a staff member signed in on the
        device first.
      </div>
    </div>
  );
}
