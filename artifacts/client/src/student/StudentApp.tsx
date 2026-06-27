import { useCallback, useEffect, useState } from "react";
import StudentLogin from "./StudentLogin";
import Dashboard from "./Dashboard";
import { studentFetch, setStudentToken, type StudentMe } from "./api";

type Route =
  | { kind: "loading" }
  | { kind: "login" }
  | { kind: "dashboard"; me: StudentMe };

function consumeSsoErrorFromQuery(): string | undefined {
  try {
    const params = new URLSearchParams(window.location.search);
    const err = params.get("ssoError");
    if (err) {
      params.delete("ssoError");
      const qs = params.toString();
      window.history.replaceState(
        {},
        "",
        window.location.pathname + (qs ? `?${qs}` : ""),
      );
      return err;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

export default function StudentApp() {
  const [route, setRoute] = useState<Route>({ kind: "loading" });
  const [loginError] = useState<string | undefined>(consumeSsoErrorFromQuery());

  const tryLoadMe = useCallback(async (): Promise<StudentMe | null> => {
    try {
      const res = await studentFetch("/api/student-auth/me");
      if (!res.ok) return null;
      const body = (await res.json()) as StudentMe;
      if (body.authToken) setStudentToken(body.authToken);
      return body;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const me = await tryLoadMe();
      if (cancelled) return;
      setRoute(me ? { kind: "dashboard", me } : { kind: "login" });
    })();
    return () => {
      cancelled = true;
    };
  }, [tryLoadMe]);

  if (route.kind === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-900 text-white/70 text-sm">
        Loading…
      </div>
    );
  }

  if (route.kind === "login") {
    return (
      <StudentLogin
        initialError={loginError}
        onLoggedIn={(me) => setRoute({ kind: "dashboard", me })}
      />
    );
  }

  return (
    <Dashboard
      me={route.me}
      onLoggedOut={() => setRoute({ kind: "login" })}
    />
  );
}
