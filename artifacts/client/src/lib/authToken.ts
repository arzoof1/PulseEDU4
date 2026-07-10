// Staff API auth: HttpOnly session cookie is the primary mechanism.
// Bearer tokens are only stored in memory when the server opts in
// (STAFF_BEARER_AUTH_ENABLED) — never in sessionStorage (XSS-safe default).

import {
  clearCsrfToken,
  csrfHeadersForMethod,
  setCsrfToken,
} from "./csrf";

let inMemoryAuthToken: string | null = null;

// Notified when any API call is rejected with 403 { error:
// "mfa_enrollment_required" } — i.e. the server is forcing this user to set up
// two-factor before they can use the app. App.tsx registers a handler that
// surfaces the blocking enrollment modal. Kept here (the single fetch choke
// point) so EVERY request path triggers it, including for users who were
// already signed in when an admin flipped the policy on.
let mfaEnrollmentRequiredHandler: (() => void) | null = null;

export function setMfaEnrollmentRequiredHandler(
  handler: (() => void) | null,
): void {
  mfaEnrollmentRequiredHandler = handler;
}

// Sticky, authoritative "this user is being blocked pending MFA enrollment"
// flag. Set the moment ANY request comes back 403 mfa_enrollment_required —
// i.e. driven by what the server actually enforces, not by a separate status
// lookup that could disagree. The MfaEnrollmentBoundary reads it: if a render
// crashes while this is set (e.g. a view choked on a 403 body before the
// enrollment wall could take over), the boundary shows the enrollment screen
// instead of a white screen.
let mfaEnrollmentBlocked = false;

export function isMfaEnrollmentBlocked(): boolean {
  return mfaEnrollmentBlocked;
}

// Reset on auth change so a stale block from a previous session can't
// false-trigger the enrollment fallback for the next user.
export function clearMfaEnrollmentBlocked(): void {
  mfaEnrollmentBlocked = false;
}

export function setAuthToken(token: string | null | undefined) {
  inMemoryAuthToken = token && token.length > 0 ? token : null;
}

export function clearAuthToken() {
  inMemoryAuthToken = null;
  clearCsrfToken();
}

export function getAuthToken(): string | null {
  return inMemoryAuthToken;
}

export function authHeader(): Record<string, string> {
  const t = inMemoryAuthToken;
  return t ? { Authorization: `Bearer ${t}` } : {};
}

function applyAuthMePayload(data: {
  authToken?: string;
  csrfToken?: string;
} | null) {
  if (typeof data?.authToken === "string" && data.authToken.length > 0) {
    setAuthToken(data.authToken);
  }
  if (typeof data?.csrfToken === "string" && data.csrfToken.length > 0) {
    setCsrfToken(data.csrfToken);
  }
}

function buildHeaders(init: RequestInit): Headers {
  const headers = new Headers(init.headers ?? {});
  const t = inMemoryAuthToken;
  if (t && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${t}`);
  }
  for (const [key, value] of Object.entries(csrfHeadersForMethod(init.method))) {
    if (!headers.has(key)) headers.set(key, value);
  }
  return headers;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.pathname;
  return (input as Request).url;
}

async function refreshStaffSession(): Promise<boolean> {
  const meRes = await fetch("/api/auth/me", { credentials: "include" });
  if (!meRes.ok) return false;
  const data = (await meRes.json().catch(() => null)) as {
    authToken?: string;
    csrfToken?: string;
  } | null;
  applyAuthMePayload(data);
  return !!(data?.csrfToken || data?.authToken);
}

export async function authFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const doFetch = () =>
    fetch(input, {
      credentials: "include",
      ...init,
      headers: buildHeaders(init),
    });

  let res = await doFetch();
  const url = requestUrl(input);

  if (res.status === 403) {
    const body = (await res.clone().json().catch(() => null)) as {
      error?: string;
    } | null;
    if (
      body?.error === "csrf_token_required" ||
      body?.error === "csrf_token_invalid"
    ) {
      if (await refreshStaffSession()) {
        res = await doFetch();
      }
    } else if (body?.error === "mfa_enrollment_required") {
      // Server is enforcing MFA enrollment — record it authoritatively and let
      // the app raise the blocking modal. Return the 403 unchanged so the
      // calling code still fails; it is the modal, not this request, that
      // unblocks the user.
      mfaEnrollmentBlocked = true;
      mfaEnrollmentRequiredHandler?.();
    }
  }

  if (res.status !== 401) return res;

  if (url.includes("/api/auth/")) return res;

  if (await refreshStaffSession()) {
    return doFetch();
  }

  return res;
}
