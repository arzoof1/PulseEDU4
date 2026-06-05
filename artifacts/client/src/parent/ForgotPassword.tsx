import { useState } from "react";
import { Heart, MailCheck } from "lucide-react";
import { navigate } from "./api";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    setError("");
    try {
      // Always 200 — server intentionally doesn't reveal whether the email
      // matches a registered account. Show the same "check your inbox"
      // screen either way.
      const res = await fetch("/api/parent-auth/request-reset", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      if (!res.ok) {
        setError(`Could not submit request (${res.status})`);
        return;
      }
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  if (submitted) {
    return (
      <Centered>
        <div className="w-full max-w-md bg-white/[0.06] border border-white/10 rounded-2xl p-8 flex flex-col gap-4 backdrop-blur text-center">
          <MailCheck className="h-10 w-10 text-teal-400 mx-auto" />
          <div className="text-xl font-semibold">Check your inbox</div>
          <div className="text-sm text-white/70">
            If <span className="font-medium text-white">{email}</span> matches
            a parent account, we just sent a link to reset your password.
            The link is good for 1 hour.
          </div>
          <div className="text-xs text-white/50 mt-1">
            Didn't get it? Check your spam folder, or ask your school to
            confirm the email on file.
          </div>
          <button
            onClick={() => navigate("/parent/login")}
            className="bg-blue-500 hover:bg-blue-400 text-white font-semibold rounded-lg py-2.5 transition-colors mt-2"
          >
            Back to sign-in
          </button>
        </div>
      </Centered>
    );
  }

  return (
    <Centered>
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md bg-white/[0.06] border border-white/10 rounded-2xl p-8 flex flex-col gap-4 backdrop-blur"
      >
        <div className="flex flex-col items-center gap-2 mb-2">
          <div className="h-12 w-12 rounded-full bg-gradient-to-br from-violet-500 to-teal-500 flex items-center justify-center">
            <Heart className="h-6 w-6 text-white" fill="white" />
          </div>
          <div className="text-2xl font-bold tracking-tight">
            Pulse<span className="text-blue-400">EDU</span>
          </div>
          <div className="text-sm text-white/70">Reset your password</div>
          <div className="text-xs text-white/50 text-center mt-1">
            Enter the email your school has on file. We'll send you a link to
            choose a new password.
          </div>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm text-white/80">Email</span>
          <input
            type="email"
            autoComplete="username"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
            className="bg-slate-900/60 border border-white/20 rounded-lg px-3 py-2.5 text-base outline-none focus:border-blue-400"
          />
        </label>

        {error && (
          <div className="bg-red-500/15 border border-red-500/40 text-red-200 px-3 py-2 rounded-lg text-sm">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={busy || !email.trim()}
          className="bg-blue-500 hover:bg-blue-400 disabled:bg-blue-500/40 disabled:cursor-not-allowed text-white font-semibold rounded-lg py-2.5 transition-colors"
        >
          {busy ? "Sending…" : "Send reset link"}
        </button>

        <button
          type="button"
          onClick={() => navigate("/parent/login")}
          className="text-sm text-white/60 hover:text-white/90 underline-offset-2 hover:underline"
        >
          Back to sign-in
        </button>
      </form>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-slate-900 to-slate-800 text-white p-6">
      {children}
    </div>
  );
}
