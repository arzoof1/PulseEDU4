// Mounts BEFORE the staff <App /> and holds it back while we find out whether
// this session owes a password change.
//
// Why this cannot live inside App.tsx: App has ~55 effects keyed on
// authUser?.id that fire dozens of API calls the moment login resolves. React
// runs effects after the first render, so an early return inside App stops the
// dashboard from being drawn but NOT the requests it already scheduled — the
// server 403s every one of them (password_setup_required) and some views crash
// rendering the error body, which surfaced as "something went wrong" plus a
// console full of 403s. Gating one level up means App never mounts at all, so
// there is nothing to fire.
//
// Anonymous visitors fall straight through to App, which renders the login
// screen; the flag is only knowable once a session exists. After a successful
// change we hard-reload rather than flipping state, so App boots clean.

import { useEffect, useState } from "react";
import { authFetch } from "../lib/authToken";
import ForcedPasswordChange from "./ForcedPasswordChange";

type Status =
  | { phase: "checking" }
  | { phase: "clear" }
  | { phase: "blocked"; displayName: string | null };

export default function PasswordSetupBoundary({
  children,
}: {
  children: React.ReactNode;
}) {
  const [status, setStatus] = useState<Status>({ phase: "checking" });

  useEffect(() => {
    let cancelled = false;
    authFetch("/api/auth/me")
      .then((res) => (res.ok ? res.json() : null))
      .then((me: { mustSetPassword?: boolean; displayName?: string } | null) => {
        if (cancelled) return;
        // No session (401 → null) is "clear": App shows the login screen, and
        // the check re-runs on the next load after signing in.
        setStatus(
          me?.mustSetPassword
            ? { phase: "blocked", displayName: me.displayName ?? null }
            : { phase: "clear" },
        );
      })
      .catch(() => {
        // Never wedge the app on a network blip — fall through and let the
        // server's own 403s govern. Matches the fail-open stance of the MFA
        // status check.
        if (!cancelled) setStatus({ phase: "clear" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (status.phase === "checking") {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-subtle, #64748b)",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        Loading…
      </div>
    );
  }

  if (status.phase === "blocked") {
    return (
      <ForcedPasswordChange
        displayName={status.displayName}
        onDone={() => window.location.reload()}
      />
    );
  }

  return <>{children}</>;
}
