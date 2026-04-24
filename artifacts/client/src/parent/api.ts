// Parent-side fetch helper. Mirrors the staff `authToken.ts` but uses a
// SEPARATE storage key so that a parent and a staff user can be signed in
// in two tabs of the same browser without stomping on each other.
const KEY = "pulseed.parentToken";

export function setParentToken(token: string | null | undefined) {
  try {
    if (token) sessionStorage.setItem(KEY, token);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* sessionStorage may be unavailable */
  }
}

export function getParentToken(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function buildHeaders(init: RequestInit): Headers {
  const headers = new Headers(init.headers ?? {});
  const t = getParentToken();
  if (t && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${t}`);
  }
  return headers;
}

let refreshInFlight: Promise<string | null> | null = null;

async function refreshParentToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const headers = new Headers();
      const t = getParentToken();
      if (t) headers.set("Authorization", `Bearer ${t}`);
      const res = await fetch("/api/parent-auth/me", {
        credentials: "include",
        headers,
      });
      if (!res.ok) return null;
      const data = (await res.json().catch(() => null)) as
        | { authToken?: string }
        | null;
      const fresh = data?.authToken;
      if (typeof fresh === "string" && fresh.length > 0) {
        setParentToken(fresh);
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

export async function parentFetch(
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

  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.pathname
        : (input as Request).url;
  if (url.includes("/api/parent-auth/")) return res;

  const fresh = await refreshParentToken();
  if (!fresh) return res;
  const retryHeaders = new Headers(init.headers ?? {});
  retryHeaders.set("Authorization", `Bearer ${fresh}`);
  return fetch(input, {
    credentials: "include",
    ...init,
    headers: retryHeaders,
  });
}

export interface ParentMe {
  id: number;
  email: string;
  displayName: string;
  schoolId: number;
  active: boolean;
  hasPassword: boolean;
  authToken?: string;
  students: Array<{
    id: number;
    studentId: string;
    firstName: string;
    lastName: string;
    grade: number;
  }>;
}

// Helpers for the in-app router. We keep a single source of truth for the
// app's base path (Vite injects BASE_URL with a trailing slash) and a tiny
// path-based router so we don't have to add react-router for ~3 screens.
export function appBase(): string {
  return import.meta.env.BASE_URL || "/";
}

export function logicalPath(): string {
  const base = appBase();
  const p = window.location.pathname;
  if (base !== "/" && p.startsWith(base)) {
    return "/" + p.slice(base.length);
  }
  return p;
}

export function navigate(logical: string) {
  const base = appBase();
  const target =
    base === "/"
      ? logical
      : base.replace(/\/$/, "") + logical;
  window.history.pushState({}, "", target);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
