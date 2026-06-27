import { useEffect, useState } from "react";
import { studentFetch, setStudentToken, type StudentMe } from "./api";

interface DemoStudent {
  id: number;
  localSisId: string | null;
  firstName: string;
  lastName: string;
  grade: number;
}

export default function StudentLogin({
  initialError,
  onLoggedIn,
}: {
  initialError?: string;
  onLoggedIn: (me: StudentMe) => void;
}) {
  const [error, setError] = useState<string | undefined>(initialError);
  const [ssoConfigured, setSsoConfigured] = useState(false);
  const [demoAllowed, setDemoAllowed] = useState(false);
  const [demoStudents, setDemoStudents] = useState<DemoStudent[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/student-auth/sso/available", {
          credentials: "include",
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          ssoConfigured: boolean;
          demoLoginAllowed: boolean;
        };
        setSsoConfigured(data.ssoConfigured);
        setDemoAllowed(data.demoLoginAllowed);
        if (data.demoLoginAllowed) {
          const ds = await fetch("/api/student-auth/demo-students?schoolId=1", {
            credentials: "include",
          });
          if (ds.ok) {
            const body = (await ds.json()) as { students: DemoStudent[] };
            setDemoStudents(body.students);
          }
        }
      } catch {
        /* ignore */
      }
    })();
  }, []);

  async function startSso() {
    setBusy(true);
    setError(undefined);
    try {
      const res = await fetch("/api/student-auth/sso/start?schoolId=1", {
        credentials: "include",
      });
      const data = (await res.json().catch(() => null)) as
        | { url?: string; message?: string }
        | null;
      if (!res.ok || !data?.url) {
        setError(
          data?.message ??
            "Sign-in with ClassLink isn't available yet. Ask your school.",
        );
        return;
      }
      window.location.href = data.url;
    } catch {
      setError("Could not start sign-in. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function demoLogin(studentRowId: number) {
    setBusy(true);
    setError(undefined);
    try {
      const res = await studentFetch("/api/student-auth/demo-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentRowId }),
      });
      const body = (await res.json().catch(() => null)) as
        | (StudentMe & { error?: string })
        | null;
      if (!res.ok || !body) {
        setError(body?.error ?? "Could not sign in.");
        return;
      }
      if (body.authToken) setStudentToken(body.authToken);
      onLoggedIn(body);
    } catch {
      setError("Could not sign in. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-indigo-600 via-violet-600 to-fuchsia-600 p-6">
      <div className="w-full max-w-md rounded-3xl bg-white shadow-2xl p-8">
        <div className="text-center mb-6">
          <div className="text-4xl mb-2">💜</div>
          <h1 className="text-2xl font-bold text-slate-800">My HeartBEAT</h1>
          <p className="text-sm text-slate-500 mt-1">
            Sign in to see your points and shop the School Store.
          </p>
        </div>

        {error && (
          <div className="mb-4 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-sm px-4 py-3">
            {error}
          </div>
        )}

        <button
          onClick={startSso}
          disabled={busy}
          className="w-full rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-semibold py-3 transition"
        >
          Sign in with ClassLink
        </button>
        {!ssoConfigured && (
          <p className="text-xs text-slate-400 mt-2 text-center">
            ClassLink single sign-on is set up by your district.
          </p>
        )}

        {demoAllowed && (
          <div className="mt-8 border-t border-slate-100 pt-6">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-3">
              Demo sign-in (preview only)
            </p>
            {demoStudents.length === 0 ? (
              <p className="text-sm text-slate-400">No demo students found.</p>
            ) : (
              <div className="max-h-64 overflow-y-auto space-y-1">
                {demoStudents.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => demoLogin(s.id)}
                    disabled={busy}
                    className="w-full text-left rounded-lg px-3 py-2 text-sm hover:bg-indigo-50 disabled:opacity-50 transition flex items-center justify-between"
                  >
                    <span className="font-medium text-slate-700">
                      {s.firstName} {s.lastName}
                    </span>
                    <span className="text-xs text-slate-400">
                      Grade {s.grade}
                      {s.localSisId ? ` · ${s.localSisId}` : ""}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
