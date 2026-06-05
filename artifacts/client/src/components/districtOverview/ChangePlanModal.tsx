// Change-plan modal. SuperUser-only. Lets the operator switch a single
// school's plan post-onboarding without having to drop into the
// SuperUser feature-licensing admin grid. Backed by the existing
// PATCH /api/feature-licensing/schools/:id/plan endpoint (which already
// wraps plan-pointer + super_feature_* rebuild + override overlay in a
// single tx behind lockSchoolForLicensing).

import { useEffect, useState } from "react";
import { authFetch } from "../../lib/authToken";

type Plan = {
  id: number;
  key: string;
  label: string;
  description: string | null;
};

type Props = {
  school: { id: number; name: string; planId: number | null; planLabel: string | null };
  onClose: () => void;
  onSaved: () => void;
};

export default function ChangePlanModal({ school, onClose, onSaved }: Props) {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [selected, setSelected] = useState<number | null>(school.planId);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await authFetch("/api/feature-licensing/plans");
        if (!res.ok) throw new Error(`plans → ${res.status}`);
        const body = (await res.json()) as { plans: Plan[] };
        setPlans(body.plans);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await authFetch(
        `/api/feature-licensing/schools/${school.id}/plan`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ planId: selected }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,0.5)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "3rem 1rem",
        zIndex: 1000,
        overflowY: "auto",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--surface, #fff)",
          borderRadius: 10,
          width: "100%",
          maxWidth: 480,
          padding: "1.25rem 1.5rem",
          boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "0.5rem",
          }}
        >
          <h2 style={{ margin: 0 }}>Change plan</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "transparent",
              border: "none",
              fontSize: "1.5rem",
              cursor: "pointer",
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>
        <p
          style={{
            margin: "0 0 1rem",
            color: "var(--text-subtle)",
            fontSize: "0.85rem",
          }}
        >
          School: <strong>{school.name}</strong>
          <br />
          Current plan: <strong>{school.planLabel ?? "— none —"}</strong>
        </p>

        <form onSubmit={submit}>
          <label style={{ display: "block", marginBottom: "0.5rem" }}>
            <span
              style={{
                display: "block",
                fontSize: "0.8rem",
                fontWeight: 600,
                marginBottom: 4,
              }}
            >
              New plan
            </span>
            <select
              value={selected ?? ""}
              onChange={(e) =>
                setSelected(e.target.value === "" ? null : Number(e.target.value))
              }
              disabled={plans === null}
              style={{
                width: "100%",
                padding: "0.5rem 0.6rem",
                border: "1px solid var(--border, #e2e8f0)",
                borderRadius: 6,
                font: "inherit",
                boxSizing: "border-box",
                background: "var(--surface, #fff)",
              }}
            >
              <option value="">— none (clears all features) —</option>
              {(plans ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} ({p.key})
                </option>
              ))}
            </select>
          </label>
          <p
            style={{
              fontSize: "0.75rem",
              color: "var(--text-subtle)",
              margin: "0.25rem 0 0.5rem",
            }}
          >
            Changing plan rewrites the school's <code>super_feature_*</code>{" "}
            flags from the plan's feature set, then re-applies any
            per-school overrides on top.
          </p>

          {error && (
            <div
              style={{
                marginTop: "0.5rem",
                padding: "0.5rem 0.75rem",
                background: "#fee2e2",
                border: "1px solid #fca5a5",
                borderRadius: 6,
                color: "#991b1b",
                fontSize: "0.85rem",
              }}
            >
              {error}
            </div>
          )}

          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: "0.5rem",
              marginTop: "1rem",
            }}
          >
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              style={{
                padding: "0.55rem 1rem",
                border: "1px solid var(--border, #e2e8f0)",
                borderRadius: 6,
                background: "var(--surface, #fff)",
                cursor: submitting ? "not-allowed" : "pointer",
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || plans === null || selected === school.planId}
              style={{
                padding: "0.55rem 1rem",
                border: "none",
                borderRadius: 6,
                background: "var(--primary, #2563eb)",
                color: "#fff",
                fontWeight: 600,
                cursor: submitting ? "not-allowed" : "pointer",
                opacity:
                  submitting || selected === school.planId ? 0.6 : 1,
              }}
            >
              {submitting ? "Saving…" : "Apply plan"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
