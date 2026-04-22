const KEY = "pulseed.authToken";

export function setAuthToken(token: string | null | undefined) {
  try {
    if (token) sessionStorage.setItem(KEY, token);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* sessionStorage may be unavailable in some contexts */
  }
}

export function getAuthToken(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function authHeader(): Record<string, string> {
  const t = getAuthToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

function buildHeaders(init: RequestInit): Headers {
  const headers = new Headers(init.headers ?? {});
  const t = getAuthToken();
  if (t && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${t}`);
  }
  return headers;
}

let refreshInFlight: Promise<string | null> | null = null;

async function refreshAuthToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const headers = new Headers();
      const t = getAuthToken();
      if (t) headers.set("Authorization", `Bearer ${t}`);
      const res = await fetch("/api/auth/me", {
        credentials: "include",
        headers,
      });
      if (!res.ok) return null;
      const data = (await res.json().catch(() => null)) as
        | { authToken?: string }
        | null;
      const fresh = data?.authToken;
      if (typeof fresh === "string" && fresh.length > 0) {
        setAuthToken(fresh);
        return fresh;
      }
      return null;
    } catch {
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

export async function authFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const headers = buildHeaders(init);
  const res = await fetch(input, {
    credentials: "include",
    ...init,
    headers,
  });
  if (res.status !== 401) return res;

  // Avoid recursion: never retry the refresh endpoint itself.
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.pathname
        : (input as Request).url;
  if (url.includes("/api/auth/")) return res;

  const fresh = await refreshAuthToken();
  if (!fresh) return res;

  const retryHeaders = new Headers(init.headers ?? {});
  retryHeaders.set("Authorization", `Bearer ${fresh}`);
  return fetch(input, {
    credentials: "include",
    ...init,
    headers: retryHeaders,
  });
}
