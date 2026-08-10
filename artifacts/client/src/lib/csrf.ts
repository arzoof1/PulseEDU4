// Session-bound CSRF token (from login / auth/me). Kept in memory only.

let inMemoryCsrfToken: string | null = null;

export function setCsrfToken(token: string | null | undefined) {
  inMemoryCsrfToken = token && token.length > 0 ? token : null;
}

export function clearCsrfToken() {
  inMemoryCsrfToken = null;
}

export function getCsrfToken(): string | null {
  return inMemoryCsrfToken;
}

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function csrfHeadersForMethod(method?: string): Record<string, string> {
  const m = (method ?? "GET").toUpperCase();
  if (!UNSAFE_METHODS.has(m) || !inMemoryCsrfToken) return {};
  return { "X-CSRF-Token": inMemoryCsrfToken };
}
