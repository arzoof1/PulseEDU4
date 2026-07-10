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
      // Server is enforcing MFA enrollment — let the app raise the blocking
      // modal. Return the 403 unchanged so the calling code still fails; it is
      // the modal, not this request, that unblocks the user.
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
