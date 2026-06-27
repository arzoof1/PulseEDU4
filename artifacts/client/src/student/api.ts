// Student-side fetch helper. Mirrors the parent api.ts but uses a SEPARATE
// storage key so a student, parent, and staff user can each be signed in in
// different tabs of the same browser without stomping on each other. The
// student bearer token is the iframe fallback for when the session cookie is
// blocked inside the Replit preview.
const KEY = "pulseed.studentToken";

export function setStudentToken(token: string | null | undefined) {
  try {
    if (token) sessionStorage.setItem(KEY, token);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* sessionStorage may be unavailable */
  }
}

export function getStudentToken(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function buildHeaders(init: RequestInit): Headers {
  const headers = new Headers(init.headers ?? {});
  const t = getStudentToken();
  if (t && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${t}`);
  }
  return headers;
}

let refreshInFlight: Promise<string | null> | null = null;

async function refreshStudentToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const headers = new Headers();
      const t = getStudentToken();
      if (t) headers.set("Authorization", `Bearer ${t}`);
      const res = await fetch("/api/student-auth/me", {
        credentials: "include",
        headers,
      });
      if (!res.ok) return null;
      const data = (await res.json().catch(() => null)) as
        | { authToken?: string }
        | null;
      const fresh = data?.authToken;
      if (typeof fresh === "string" && fresh.length > 0) {
        setStudentToken(fresh);
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

export async function studentFetch(
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
  if (url.includes("/api/student-auth/")) return res;

  const fresh = await refreshStudentToken();
  if (!fresh) return res;
  const retryHeaders = new Headers(init.headers ?? {});
  retryHeaders.set("Authorization", `Bearer ${fresh}`);
  return fetch(input, {
    credentials: "include",
    ...init,
    headers: retryHeaders,
  });
}

export interface StudentMe {
  id: number;
  schoolId: number;
  localSisId: string | null;
  firstName: string;
  lastName: string;
  grade: number;
  authToken?: string;
}

export interface StudentSnapshot {
  student: {
    localSisId: string | null;
    firstName: string;
    lastName: string;
    grade: number;
  };
  points: {
    lifetimeEarned: number;
    available: number;
    spent: number;
    thisWeek: number;
    positiveCount: number;
    negativeCount: number;
    byTeacher: Array<{ staffName: string; points: number; count: number }>;
  };
  recentRecognitions: Array<{
    reason: string;
    points: number;
    staffName: string;
    polarity: string;
    note: string | null;
    createdAt: string;
  }>;
  attendance: {
    pct: number | null;
    presentDays: number;
    totalDays: number;
    absences: number;
    tardiesYtd: number;
  };
  house: { name: string; color: string } | null;
}

// Mirrors the server's StoreCatalogItemView exactly so the client's
// disabled-state matches the server's redeem decision.
export interface StoreCatalogItem {
  id: number;
  name: string;
  description: string;
  pointsCost: number;
  hasImage: boolean;
  requiresApproval: boolean;
  perStudentLimit: number | null;
  ownedActiveCount: number;
  available: boolean;
  unavailableReason: string | null;
  affordable: boolean;
  pointsToGo: number;
}

// Mirrors the server's StoreOrderView.
export interface StoreOrder {
  id: number;
  itemName: string;
  pointsSpent: number;
  status: string;
  createdAt: string;
  fulfilledAt: string | null;
  deliverTeacherName: string | null;
  deliverPeriod: string | null;
  cancelReason: string | null;
}

export interface StudentStore {
  enabled: boolean;
  wallet: { earned: number; spent: number; available: number };
  items: StoreCatalogItem[];
  orders: StoreOrder[];
}

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
