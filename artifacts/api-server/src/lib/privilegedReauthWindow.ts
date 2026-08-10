// Pure step-up reauth window logic (Section 1.15), split out from
// privilegedReauth.ts so it can be unit-tested without pulling in the DB
// layer (which throws at import when DATABASE_URL is unset).

// How long a single step-up covers before a sensitive action prompts again.
// Long enough that viewing several Safety Plans / running an export doesn't
// re-prompt on every click; short enough to bound an unattended session.
export const PRIVILEGED_REAUTH_WINDOW_MS = 5 * 60 * 1000;

// True when the session did a successful privileged step-up within the window.
// `now` is injectable for tests. A negative age (future timestamp / clock skew)
// is treated as not-fresh rather than trusting a timestamp ahead of now.
export function hasFreshPrivilegedReauth(
  session: { privilegedReauthAt?: number } | null | undefined,
  now: number = Date.now(),
  windowMs: number = PRIVILEGED_REAUTH_WINDOW_MS,
): boolean {
  const at = session?.privilegedReauthAt;
  if (typeof at !== "number") return false;
  const age = now - at;
  return age >= 0 && age < windowMs;
}
