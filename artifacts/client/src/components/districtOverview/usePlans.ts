// Shared loader for GET /api/feature-licensing/plans. Used by the two
// onboarding modals so they share a single read against the (tiny)
// plans catalog and a consistent loading/error contract.

import { useEffect, useState } from "react";
import { authFetch } from "../../lib/authToken";

export type Plan = {
  id: number;
  key: string;
  label: string;
  description: string | null;
};

export function usePlans(): {
  plans: Plan[] | null;
  error: string | null;
} {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  return { plans, error };
}
