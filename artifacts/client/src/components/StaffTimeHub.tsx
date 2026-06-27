import { useState, type CSSProperties } from "react";
import { FeatureGate } from "../lib/features";
import AdminAstQueuePage from "./ast/AdminAstQueuePage";
import AstInsightsPage from "./ast/AstInsightsPage";
import AdminCompQueuePage from "./comp/AdminCompQueuePage";
import CompInsightsPage from "./comp/CompInsightsPage";

// =============================================================================
// StaffTimeHub — single Admin & Settings entry point ("Staff Time") that
// consolidates the four former sidebar items (AST Approvals, AST Insights,
// Comp Time Approvals, Comp Time Insights) into one tabbed page.
//
// Layout: primary tabs Approvals · Insights (the mode the admin is in), with a
// secondary AST · Comp Time toggle. The toggle only renders the banks the user
// can actually approve (canApproveAst / canApproveCompTime), so permission
// boundaries are preserved — a Comp-only approver never sees AST data.
//
// Pending counts are passed in from App (the same 15s-polled values that drove
// the old per-item badges): the Approvals tab carries the combined total and
// each sub-toggle carries its own count.
// =============================================================================

type Mode = "approvals" | "insights";
type Feature = "ast" | "comp";

export default function StaffTimeHub({
  canApproveAst,
  canApproveCompTime,
  astPending,
  compPending,
}: {
  canApproveAst: boolean;
  canApproveCompTime: boolean;
  astPending: number;
  compPending: number;
}) {
  const availableFeatures: Feature[] = [
    ...(canApproveAst ? (["ast"] as const) : []),
    ...(canApproveCompTime ? (["comp"] as const) : []),
  ];

  const [mode, setMode] = useState<Mode>("approvals");
  const [feature, setFeature] = useState<Feature>(
    availableFeatures[0] ?? "ast",
  );

  // Clamp to an allowed bank in case the user only has one permission.
  const activeFeature: Feature = availableFeatures.includes(feature)
    ? feature
    : (availableFeatures[0] ?? "ast");

  const totalPending = astPending + compPending;

  const tabBar: CSSProperties = {
    display: "flex",
    gap: 4,
    borderBottom: "1px solid var(--border, #e5e7eb)",
    marginBottom: "1rem",
  };
  const tab = (active: boolean): CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    padding: "0.6rem 1.1rem",
    border: "none",
    borderBottom: active
      ? "2px solid var(--accent, #2563eb)"
      : "2px solid transparent",
    background: "transparent",
    color: active ? "var(--accent, #2563eb)" : "var(--text-subtle, #64748b)",
    fontWeight: active ? 700 : 500,
    fontSize: "1rem",
    cursor: "pointer",
  });
  const segWrap: CSSProperties = {
    display: "inline-flex",
    gap: 4,
    padding: 4,
    background: "var(--surface-muted, #f1f5f9)",
    borderRadius: 10,
    marginBottom: "1.25rem",
  };
  const seg = (active: boolean): CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "0.4rem 0.9rem",
    border: "none",
    borderRadius: 8,
    background: active ? "var(--surface, #ffffff)" : "transparent",
    color: active ? "var(--text, #0f172a)" : "var(--text-subtle, #64748b)",
    fontWeight: active ? 700 : 500,
    fontSize: "0.9rem",
    cursor: "pointer",
    boxShadow: active ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
  });
  const badge: CSSProperties = {
    background: "#dc2626",
    color: "#ffffff",
    borderRadius: 999,
    padding: "0 7px",
    marginLeft: 8,
    fontSize: "0.72rem",
    fontWeight: 700,
    lineHeight: "18px",
  };

  return (
    <div style={{ padding: "1.25rem", maxWidth: 1100, margin: "0 auto" }}>
      <h1 style={{ margin: "0 0 0.25rem" }}>Staff Time</h1>
      <p
        style={{
          color: "var(--text-subtle, #64748b)",
          margin: "0 0 1.25rem",
        }}
      >
        Approve and analyze Alternate Schedule Time (AST) and Comp Time in one
        place.
      </p>

      <div style={tabBar}>
        <button
          type="button"
          style={tab(mode === "approvals")}
          onClick={() => setMode("approvals")}
        >
          Approvals
          {totalPending > 0 && <span style={badge}>{totalPending}</span>}
        </button>
        <button
          type="button"
          style={tab(mode === "insights")}
          onClick={() => setMode("insights")}
        >
          Insights
        </button>
      </div>

      {availableFeatures.length > 1 && (
        <div style={segWrap}>
          <button
            type="button"
            style={seg(activeFeature === "ast")}
            onClick={() => setFeature("ast")}
          >
            AST
            {mode === "approvals" && astPending > 0 && (
              <span style={badge}>{astPending}</span>
            )}
          </button>
          <button
            type="button"
            style={seg(activeFeature === "comp")}
            onClick={() => setFeature("comp")}
          >
            Comp Time
            {mode === "approvals" && compPending > 0 && (
              <span style={badge}>{compPending}</span>
            )}
          </button>
        </div>
      )}

      {mode === "approvals" && activeFeature === "ast" && (
        <FeatureGate feature="ast" label="AST">
          <AdminAstQueuePage />
        </FeatureGate>
      )}
      {mode === "approvals" && activeFeature === "comp" && (
        <FeatureGate feature="compTime" label="Comp Time">
          <AdminCompQueuePage />
        </FeatureGate>
      )}
      {mode === "insights" && activeFeature === "ast" && (
        <FeatureGate feature="ast" label="AST">
          <AstInsightsPage />
        </FeatureGate>
      )}
      {mode === "insights" && activeFeature === "comp" && (
        <FeatureGate feature="compTime" label="Comp Time">
          <CompInsightsPage />
        </FeatureGate>
      )}
    </div>
  );
}
