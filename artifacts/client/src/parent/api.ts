// Parent-side fetch helper. Mirrors the staff `authToken.ts` but uses a
// SEPARATE storage key so that a parent and a staff user can be signed in
// in two tabs of the same browser without stomping on each other.
import {
  clearCsrfToken,
  csrfHeadersForMethod,
  setCsrfToken,
} from "../lib/csrf";

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

export function clearParentSession() {
  setParentToken(null);
  clearCsrfToken();
}

function applyParentMePayload(data: {
  authToken?: string;
  csrfToken?: string;
} | null) {
  if (typeof data?.authToken === "string" && data.authToken.length > 0) {
    setParentToken(data.authToken);
  }
  if (typeof data?.csrfToken === "string" && data.csrfToken.length > 0) {
    setCsrfToken(data.csrfToken);
  }
}

function buildHeaders(init: RequestInit): Headers {
  const headers = new Headers(init.headers ?? {});
  const t = getParentToken();
  if (t && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${t}`);
  }
  for (const [key, value] of Object.entries(csrfHeadersForMethod(init.method))) {
    if (!headers.has(key)) headers.set(key, value);
  }
  return headers;
}

let refreshInFlight: Promise<boolean> | null = null;

async function refreshParentSession(): Promise<boolean> {
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
      if (!res.ok) return false;
      const data = (await res.json().catch(() => null)) as {
        authToken?: string;
        csrfToken?: string;
      } | null;
      applyParentMePayload(data);
      return !!(data?.csrfToken || data?.authToken);
    } catch {
      return false;
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
  const doFetch = () =>
    fetch(input, {
      credentials: "include",
      ...init,
      headers: buildHeaders(init),
    });

  let res = await doFetch();

  if (res.status === 403) {
    const body = (await res.clone().json().catch(() => null)) as {
      error?: string;
    } | null;
    if (
      body?.error === "csrf_token_required" ||
      body?.error === "csrf_token_invalid"
    ) {
      if (await refreshParentSession()) {
        res = await doFetch();
      }
    }
  }

  if (res.status !== 401) return res;

  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.pathname
        : (input as Request).url;
  if (url.includes("/api/parent-auth/")) return res;

  if (await refreshParentSession()) {
    return doFetch();
  }

  return res;
}

export interface ParentMe {
  id: number;
  email: string;
  displayName: string;
  schoolId: number;
  active: boolean;
  authToken?: string;
  csrfToken?: string;
  students: Array<{
    id: number;
    studentId: string;
    localSisId?: string | null;
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
