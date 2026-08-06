import { describe, it, expect } from "vitest";
import {
  OneRosterLiveClient,
  OneRosterApiError,
  resolveOneRosterBaseUrl,
} from "@workspace/sis-adapters";

// Unit tests for the live ClassLink OneRoster client. No network: a fake
// `fetch` is injected so we can assert the OAuth 1.0a signing, pagination
// loop, and error handling deterministically.

const BASE = "https://example.rosterserver.com/ims/oneroster/v1p1";
const KEY = "consumer-key-123";
const SECRET = "consumer-secret-abc";

type Captured = { url: string; headers: Record<string, string> };

/** Build a fake fetch that records each call and replays queued responses. */
function fakeFetch(
  pages: Array<{ body: unknown; status?: number; headers?: Record<string, string> }>,
): { fetchImpl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  let i = 0;
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers: Record<string, string> = {};
    const h = init?.headers as Record<string, string> | undefined;
    if (h) for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = v;
    calls.push({ url, headers });
    const page = pages[Math.min(i, pages.length - 1)];
    i++;
    return new Response(
      typeof page.body === "string" ? page.body : JSON.stringify(page.body),
      { status: page.status ?? 200, headers: page.headers },
    );
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** Parse an `OAuth k="v", ...` header into a map (values are percent-decoded). */
function parseOAuthHeader(value: string): Record<string, string> {
  expect(value.startsWith("OAuth ")).toBe(true);
  const out: Record<string, string> = {};
  for (const part of value.slice("OAuth ".length).split(", ")) {
    const m = part.match(/^([^=]+)="(.*)"$/);
    if (m) out[decodeURIComponent(m[1]!)] = decodeURIComponent(m[2]!);
  }
  return out;
}

describe("resolveOneRosterBaseUrl", () => {
  it("appends the v1p1 path to a bare host", () => {
    expect(resolveOneRosterBaseUrl("https://host.rosterserver.com")).toBe(
      "https://host.rosterserver.com/ims/oneroster/v1p1",
    );
  });
  it("tolerates a trailing slash on a bare host", () => {
    expect(resolveOneRosterBaseUrl("https://host.rosterserver.com/")).toBe(
      "https://host.rosterserver.com/ims/oneroster/v1p1",
    );
  });
  it("leaves an already-qualified v1p1 URL unchanged", () => {
    expect(resolveOneRosterBaseUrl(BASE)).toBe(BASE);
  });
  it("returns null when neither arg nor env is set", () => {
    const prev = process.env.CLASSLINK_ONEROSTER_BASE_URL;
    delete process.env.CLASSLINK_ONEROSTER_BASE_URL;
    try {
      expect(resolveOneRosterBaseUrl(undefined)).toBeNull();
    } finally {
      if (prev !== undefined) process.env.CLASSLINK_ONEROSTER_BASE_URL = prev;
    }
  });
});

describe("OneRosterLiveClient — OAuth 1.0a signing", () => {
  it("signs each request with a two-legged HMAC-SHA256 OAuth header", async () => {
    const { fetchImpl, calls } = fakeFetch([{ body: { orgs: [] } }]);
    const client = new OneRosterLiveClient({
      baseUrl: BASE,
      consumerKey: KEY,
      consumerSecret: SECRET,
      fetchImpl,
    });
    await client.fetchOrgs();

    expect(calls).toHaveLength(1);
    const auth = parseOAuthHeader(calls[0]!.headers["authorization"]!);
    expect(auth.oauth_consumer_key).toBe(KEY);
    expect(auth.oauth_signature_method).toBe("HMAC-SHA256");
    expect(auth.oauth_version).toBe("1.0");
    expect(auth.oauth_nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(auth.oauth_timestamp).toMatch(/^\d+$/);
    // A non-empty base64 signature must be present.
    expect(auth.oauth_signature).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(calls[0]!.headers["accept"]).toBe("application/json");
    expect(calls[0]!.url).toContain(`${BASE}/orgs?`);
    expect(calls[0]!.url).toContain("limit=500");
  });

  it("generates a fresh nonce per request", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { body: { orgs: [{ sourcedId: "a" }] }, headers: { "x-total-count": "2" } },
      { body: { orgs: [{ sourcedId: "b" }] } },
    ]);
    const client = new OneRosterLiveClient({
      baseUrl: BASE,
      consumerKey: KEY,
      consumerSecret: SECRET,
      fetchImpl,
    });
    await client.fetchOrgs();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const n1 = parseOAuthHeader(calls[0]!.headers["authorization"]!).oauth_nonce;
    const n2 = parseOAuthHeader(calls[1]!.headers["authorization"]!).oauth_nonce;
    expect(n1).not.toBe(n2);
  });
});

describe("OneRosterLiveClient — pagination", () => {
  it("follows x-total-count across pages and concatenates results", async () => {
    const page1 = Array.from({ length: 500 }, (_, i) => ({ sourcedId: `s${i}` }));
    const page2 = Array.from({ length: 50 }, (_, i) => ({ sourcedId: `s${500 + i}` }));
    const { fetchImpl, calls } = fakeFetch([
      { body: { users: page1 }, headers: { "x-total-count": "550" } },
      { body: { users: page2 }, headers: { "x-total-count": "550" } },
    ]);
    const client = new OneRosterLiveClient({
      baseUrl: BASE,
      consumerKey: KEY,
      consumerSecret: SECRET,
      fetchImpl,
    });
    const users = await client.fetchUsers();
    expect(users).toHaveLength(550);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toContain("offset=500");
  });

  it("stops after a short page when no total is advertised", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { body: { orgs: [{ sourcedId: "only" }] } },
    ]);
    const client = new OneRosterLiveClient({
      baseUrl: BASE,
      consumerKey: KEY,
      consumerSecret: SECRET,
      fetchImpl,
    });
    const orgs = await client.fetchOrgs();
    expect(orgs).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });
});

describe("OneRosterLiveClient — errors", () => {
  it("throws OneRosterApiError with the HTTP status on a non-2xx response", async () => {
    const { fetchImpl } = fakeFetch([{ body: "nope", status: 401 }]);
    const client = new OneRosterLiveClient({
      baseUrl: BASE,
      consumerKey: KEY,
      consumerSecret: SECRET,
      fetchImpl,
    });
    await expect(client.ping()).rejects.toBeInstanceOf(OneRosterApiError);
    await expect(client.ping()).rejects.toMatchObject({ status: 401 });
  });

  it("throws when the payload is missing the expected root array", async () => {
    const { fetchImpl } = fakeFetch([{ body: { notOrgs: [] } }]);
    const client = new OneRosterLiveClient({
      baseUrl: BASE,
      consumerKey: KEY,
      consumerSecret: SECRET,
      fetchImpl,
    });
    await expect(client.fetchOrgs()).rejects.toBeInstanceOf(OneRosterApiError);
  });
});

describe("OneRosterLiveClient — fetchBundle", () => {
  it("returns a bundle with every roster collection populated", async () => {
    // orgs, users, classes, enrollments, demographics each resolve to one page.
    const { fetchImpl } = fakeFetch([
      { body: { orgs: [{ sourcedId: "org1", type: "school", name: "S" }] } },
      { body: { users: [{ sourcedId: "u1", role: "student" }] } },
      { body: { classes: [{ sourcedId: "c1", title: "Math" }] } },
      { body: { enrollments: [{ sourcedId: "e1", role: "student" }] } },
      { body: { demographics: [{ sourcedId: "u1" }] } },
    ]);
    const client = new OneRosterLiveClient({
      baseUrl: BASE,
      consumerKey: KEY,
      consumerSecret: SECRET,
      fetchImpl,
    });
    const bundle = await client.fetchBundle();
    expect(bundle.baseUrl).toBe(BASE);
    expect(bundle.orgs).toHaveLength(1);
    expect(bundle.users).toHaveLength(1);
    expect(bundle.classes).toHaveLength(1);
    expect(bundle.enrollments).toHaveLength(1);
    expect(bundle.demographics).toHaveLength(1);
    expect(bundle.courses).toEqual([]);
  });
});
