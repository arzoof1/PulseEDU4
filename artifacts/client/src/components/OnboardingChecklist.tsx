import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { authFetch } from "../lib/authToken";
import {
  HowToUseHelp,
  HowToSection,
  RoleSection,
  howtoListStyle,
} from "./HowToUseHelp";

// =============================================================================
// Onboarding Checklist
// =============================================================================
// Per-school setup tracker. Lists every configuration step a brand-new
// school must complete (grouped into 5 phases), shows auto-detected
// status, lets admins override with a manual checkbox, hyperlinks each
// row to the matching settings/section, and renders a printable PDF.
//
// Navigation: clicking "Open" calls onNavigate({kind, target}) — the
// parent (App.tsx) translates that into setActiveSection / setSettingsTile
// AND records that the user came from the checklist, so a "← Back to
// Onboarding" floating banner appears on the destination page.
// =============================================================================

type AutoStatus = "complete" | "partial" | "empty";

type StepRoute = {
  kind: "settings" | "section";
  target: string;
};

type ChecklistRole = "admin" | "tech" | "pbis" | "core-team";

type ChecklistStep = {
  key: string;
  phase: string;
  role: ChecklistRole;
  label: string;
  hint: string;
  route: StepRoute;
  autoStatus: AutoStatus;
  manualChecked: boolean;
  complete: boolean;
  completedByStaffId: number | null;
  completedAt: string | null;
};

// Visible chip + readable label for each role. Order matches the
// rendering order inside a phase: admin steps first (most users),
// tech next, PBIS coordinator, then Core Team-only guardrails.
const ROLE_ORDER: ChecklistRole[] = ["admin", "tech", "pbis", "core-team"];
const ROLE_LABEL: Record<ChecklistRole, string> = {
  admin: "School Admin",
  tech: "Tech Coordinator",
  pbis: "PBIS Coordinator",
  "core-team": "Core Team",
};
const ROLE_COLOR: Record<ChecklistRole, string> = {
  admin: "#2563eb",
  tech: "#0891b2",
  pbis: "#c026d3",
  "core-team": "#b45309",
};

type StatusResponse = {
  steps: ChecklistStep[];
  progress: { complete: number; total: number };
};

interface Props {
  onNavigate: (route: StepRoute) => void;
}

const PHASE_BLURB: Record<string, string> = {
  "Identity & Access":
    "Who can sign in, what your school looks like, and where everything is.",
  "Schedule & Operations":
    "The bell schedule that drives periods, signage URLs, and your roster import.",
  "Behavior & PBIS":
    "PBIS reasons, alert tuning, milestone emails, store catalog, and ISS settings.",
  "Interventions & MTSS":
    "School-wide expectations, Tier 3 strategies, MTSS templates, and separation tags.",
  "Family & Outreach":
    "Heartbeat section visibility and Parent Portal access.",
};

const ROW: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "auto 1fr auto auto",
  gap: "0.6rem",
  alignItems: "center",
  padding: "0.7rem 0.8rem",
  borderTop: "1px solid var(--border, #2a3447)",
};

const PILL: CSSProperties = {
  fontSize: "0.7rem",
  padding: "0.15rem 0.5rem",
  borderRadius: 999,
  fontWeight: 600,
  whiteSpace: "nowrap",
};

const OPEN_BTN: CSSProperties = {
  fontSize: "0.78rem",
  padding: "0.3rem 0.65rem",
  borderRadius: 6,
  border: "1px solid var(--border, #2a3447)",
  background: "var(--card-bg, rgba(255,255,255,0.04))",
  color: "inherit",
  cursor: "pointer",
};

function statusPill(s: AutoStatus, manual: boolean) {
  if (manual)
    return { label: "✓ Marked done", bg: "#16a34a", color: "#fff" };
  if (s === "complete")
    return { label: "✓ Detected", bg: "#16a34a", color: "#fff" };
  if (s === "partial")
    return { label: "Partial", bg: "#b45309", color: "#fff" };
  return { label: "Needs setup", bg: "#475569", color: "#fff" };
}

export default function OnboardingChecklist({ onNavigate }: Props) {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [openHint, setOpenHint] = useState<Set<string>>(new Set());
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set());

  async function refresh() {
    try {
      setErr(null);
      const r = await authFetch("/api/onboarding/status", {
        credentials: "include",
      });
      if (!r.ok) {
        setErr(`Failed to load (${r.status})`);
        return;
      }
      const json = (await r.json()) as StatusResponse;
      setData(json);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function toggleManual(key: string, next: boolean) {
    if (busyKeys.has(key)) return;
    setBusyKeys((prev) => new Set(prev).add(key));
    // Optimistic update.
    setData((prev) =>
      prev
        ? {
            ...prev,
            steps: prev.steps.map((s) =>
              s.key === key
                ? {
                    ...s,
                    manualChecked: next,
                    complete: next || s.autoStatus === "complete",
                  }
                : s,
            ),
            progress: {
              ...prev.progress,
              complete: prev.steps.filter((s) =>
                s.key === key
                  ? next || s.autoStatus === "complete"
                  : s.complete,
              ).length,
            },
          }
        : prev,
    );
    try {
      const r = await authFetch("/api/onboarding/state", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, manualChecked: next }),
      });
      if (!r.ok) {
        await refresh();
      } else {
        // Re-pull so completedAt/completedBy refresh.
        await refresh();
      }
    } catch {
      await refresh();
    } finally {
      setBusyKeys((prev) => {
        const n = new Set(prev);
        n.delete(key);
        return n;
      });
    }
  }

  const phases = useMemo(() => {
    if (!data) return [];
    const order: string[] = [];
    const seen = new Set<string>();
    for (const s of data.steps) {
      if (!seen.has(s.phase)) {
        seen.add(s.phase);
        order.push(s.phase);
      }
    }
    return order.map((p) => {
      const phaseSteps = data.steps.filter((s) => s.phase === p);
      // Within a phase, bucket steps by role so admins can scan
      // "what's mine vs what I need to delegate" at a glance.
      // Empty role buckets are omitted from the render.
      const byRole = ROLE_ORDER.map((role) => ({
        role,
        steps: phaseSteps.filter((s) => s.role === role),
      })).filter((g) => g.steps.length > 0);
      return { phase: p, steps: phaseSteps, byRole };
    });
  }, [data]);

  return (
    <div style={{ maxWidth: 980, margin: "0 auto", padding: "1rem" }}>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "1rem",
          marginBottom: "0.6rem",
          flexWrap: "wrap",
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: "1.5rem" }}>Onboarding Checklist</h1>
          <p
            style={{
              margin: "0.25rem 0 0",
              color: "var(--muted, #94a3b8)",
              fontSize: "0.9rem",
              maxWidth: 620,
            }}
          >
            Walk through every per-school configuration needed before staff
            can fully operate PulseEDU. Auto-detected items turn green when
            the data is in place; tick the box yourself for steps that
            don't have a clean signal.
          </p>
        </div>
        <a
          href="/api/onboarding/pdf"
          target="_blank"
          rel="noreferrer"
          style={{
            ...OPEN_BTN,
            textDecoration: "none",
            display: "inline-block",
          }}
        >
          📄 Download PDF
        </a>
      </div>

      <HowToUseHelp title="How to use this page">
        <HowToSection title="What this is">
          <p>
            A live, per-school setup tracker. Each row is one configuration
            step. Click the row's <strong>Open</strong> button to jump into
            that page, fill in your data, and use the floating
            <em> "← Back to Onboarding"</em> banner at the top of the
            destination to return here for the next step.
          </p>
          <p>
            Toggle the disclosure arrow on any row to read a short
            "how this works" explanation of the dropdowns and tables on the
            target page.
          </p>
        </HowToSection>
        <RoleSection
          for={["admin", "superUser"]}
          title="What admins should know"
        >
          <ul style={howtoListStyle}>
            <li>
              <strong>Auto-detected</strong> rows turn green automatically
              when data exists in the underlying table — no need to tick the
              box.
            </li>
            <li>
              <strong>Manual</strong> rows (e.g. School Features, MTSS
              Templates) don't have a clean signal — tick them yourself once
              you've finished the work.
            </li>
            <li>
              The <strong>printable PDF</strong> mirrors this checklist for
              offline review with your leadership team.
            </li>
          </ul>
        </RoleSection>
      </HowToUseHelp>

      {/* Progress bar */}
      {data && (
        <div style={{ margin: "1rem 0 1.2rem" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: "0.85rem",
              color: "var(--muted, #94a3b8)",
              marginBottom: 4,
            }}
          >
            <span>Progress</span>
            <span>
              <strong style={{ color: "var(--text, #f1f5f9)" }}>
                {data.progress.complete}
              </strong>{" "}
              of {data.progress.total} complete
            </span>
          </div>
          <div
            style={{
              height: 8,
              borderRadius: 4,
              background: "var(--card-bg, rgba(255,255,255,0.05))",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${(data.progress.complete / Math.max(1, data.progress.total)) * 100}%`,
                height: "100%",
                background:
                  "linear-gradient(90deg, #7c3aed 0%, #0d9488 50%, #16a34a 100%)",
                transition: "width 0.4s ease",
              }}
            />
          </div>
        </div>
      )}

      {loading && <p>Loading…</p>}
      {err && (
        <p role="alert" style={{ color: "#dc2626" }}>
          {err}
        </p>
      )}

      {phases.map(({ phase, byRole }) => (
        <section key={phase} style={{ marginBottom: "1.4rem" }}>
          <h2
            style={{
              fontSize: "1.05rem",
              margin: "0 0 0.2rem",
              color: "var(--text, #f1f5f9)",
            }}
          >
            {phase}
          </h2>
          {PHASE_BLURB[phase] && (
            <p
              style={{
                margin: "0 0 0.5rem",
                color: "var(--muted, #94a3b8)",
                fontSize: "0.85rem",
              }}
            >
              {PHASE_BLURB[phase]}
            </p>
          )}
          {byRole.map(({ role, steps }) => (
          <div
            key={role}
            style={{
              border: "1px solid var(--border, #2a3447)",
              borderRadius: 10,
              overflow: "hidden",
              background: "var(--card-bg, rgba(255,255,255,0.02))",
              marginBottom: "0.55rem",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                padding: "0.45rem 0.8rem",
                background: "rgba(255,255,255,0.03)",
                borderBottom: "1px solid var(--border, #2a3447)",
              }}
            >
              <span
                aria-label={`Role: ${ROLE_LABEL[role]}`}
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: "#fff",
                  background: ROLE_COLOR[role],
                  borderRadius: 4,
                  padding: "0.15rem 0.45rem",
                }}
              >
                {ROLE_LABEL[role]}
              </span>
              <span
                style={{
                  fontSize: 11,
                  color: "var(--muted, #94a3b8)",
                }}
              >
                {steps.filter((s) => s.complete).length} / {steps.length} done
              </span>
            </div>
            {steps.map((s, i) => {
              const pill = statusPill(s.autoStatus, s.manualChecked);
              const hintOpen = openHint.has(s.key);
              return (
                <div
                  key={s.key}
                  style={{
                    ...ROW,
                    borderTop: i === 0 ? "none" : ROW.borderTop,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={s.manualChecked || s.autoStatus === "complete"}
                    disabled={busyKeys.has(s.key)}
                    onChange={(e) => {
                      // Only the manual flag is writable here. If the
                      // auto-check is already green, the checkbox shows as
                      // ticked but un-checking it just clears the manual
                      // override (the auto signal stays).
                      void toggleManual(s.key, e.target.checked);
                    }}
                    aria-label={`Mark ${s.label} complete`}
                    style={{ width: 18, height: 18, cursor: "pointer" }}
                  />
                  <div>
                    <button
                      type="button"
                      onClick={() =>
                        setOpenHint((prev) => {
                          const n = new Set(prev);
                          if (n.has(s.key)) n.delete(s.key);
                          else n.add(s.key);
                          return n;
                        })
                      }
                      aria-expanded={hintOpen}
                      style={{
                        background: "none",
                        border: "none",
                        color: "inherit",
                        cursor: "pointer",
                        padding: 0,
                        font: "inherit",
                        textAlign: "left",
                        display: "flex",
                        alignItems: "center",
                        gap: "0.4rem",
                      }}
                    >
                      <span
                        style={{
                          display: "inline-block",
                          transform: hintOpen ? "rotate(90deg)" : "none",
                          transition: "transform 0.15s",
                          opacity: 0.7,
                        }}
                      >
                        ▸
                      </span>
                      <strong>{s.label}</strong>
                    </button>
                    {hintOpen && (
                      <p
                        style={{
                          margin: "0.4rem 0 0 1.3rem",
                          fontSize: "0.85rem",
                          color: "var(--muted, #94a3b8)",
                          maxWidth: 620,
                          lineHeight: 1.45,
                        }}
                      >
                        {s.hint}
                      </p>
                    )}
                  </div>
                  <span
                    style={{
                      ...PILL,
                      background: pill.bg,
                      color: pill.color,
                    }}
                  >
                    {pill.label}
                  </span>
                  <button
                    type="button"
                    onClick={() => onNavigate(s.route)}
                    style={OPEN_BTN}
                  >
                    Open →
                  </button>
                </div>
              );
            })}
          </div>
          ))}
        </section>
      ))}
    </div>
  );
}
