import { useEffect, useState, useCallback } from "react";
import ParentLogin from "./ParentLogin";
import AcceptInvite from "./AcceptInvite";
import ForgotPassword from "./ForgotPassword";
import ResetPassword from "./ResetPassword";
import Dashboard from "./Dashboard";
import {
  parentFetch,
  setParentToken,
  navigate,
  logicalPath,
  type ParentMe,
} from "./api";

type Route =
  | { kind: "loading" }
  | { kind: "login"; initialError?: string }
  | { kind: "accept"; token: string }
  | { kind: "forgot" }
  | { kind: "reset"; token: string }
  | { kind: "dashboard"; me: ParentMe };

function parseAcceptToken(p: string): string | null {
  // Match /parent/accept-invite/<token>
  const m = p.match(/^\/parent\/accept-invite\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function parseResetToken(p: string): string | null {
  // Match /parent/reset-password/<token>
  const m = p.match(/^\/parent\/reset-password\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

export default function ParentApp() {
  const [route, setRoute] = useState<Route>({ kind: "loading" });
  const [me, setMe] = useState<ParentMe | null>(null);
  const [path, setPath] = useState<string>(() => logicalPath());

  // React to back/forward and to navigate() calls.
  useEffect(() => {
    const onPop = () => setPath(logicalPath());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const tryLoadMe = useCallback(async (): Promise<ParentMe | null> => {
    try {
      const res = await parentFetch("/api/parent-auth/me");
      if (!res.ok) return null;
      const body = (await res.json()) as ParentMe;
      if (body.authToken) setParentToken(body.authToken);
      return body;
    } catch {
      return null;
    }
  }, []);

  // Recompute the route whenever the URL changes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const acceptToken = parseAcceptToken(path);
      if (acceptToken) {
        if (!cancelled) setRoute({ kind: "accept", token: acceptToken });
        return;
      }

      const resetToken = parseResetToken(path);
      if (resetToken) {
        if (!cancelled) setRoute({ kind: "reset", token: resetToken });
        return;
      }

      if (path.startsWith("/parent/forgot-password")) {
        if (!cancelled) setRoute({ kind: "forgot" });
        return;
      }

      if (path.startsWith("/parent/login")) {
        if (!cancelled) setRoute({ kind: "login" });
        return;
      }

      // Anything else under /parent → dashboard if authed, else login.
      const fresh = await tryLoadMe();
      if (cancelled) return;
      if (fresh) {
        setMe(fresh);
        setRoute({ kind: "dashboard", me: fresh });
      } else {
        setRoute({ kind: "login" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, tryLoadMe]);

  if (route.kind === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-900 text-white/70 text-sm">
        Loading…
      </div>
    );
  }

  if (route.kind === "accept") {
    return (
      <AcceptInvite
        token={route.token}
        onAccepted={(fresh) => {
          setMe(fresh);
          setRoute({ kind: "dashboard", me: fresh });
        }}
      />
    );
  }

  if (route.kind === "forgot") {
    return <ForgotPassword />;
  }

  if (route.kind === "reset") {
    return (
      <ResetPassword
        token={route.token}
        onReset={(fresh) => {
          setMe(fresh);
          setRoute({ kind: "dashboard", me: fresh });
        }}
      />
    );
  }

  if (route.kind === "login") {
    return (
      <ParentLogin
        initialError={route.initialError}
        onLoggedIn={(fresh) => {
          setMe(fresh);
          setRoute({ kind: "dashboard", me: fresh });
        }}
      />
    );
  }

  return <Dashboard me={me ?? route.me} />;
}

// Suppress an unused-variable warning for `navigate` re-export consumers.
void navigate;
