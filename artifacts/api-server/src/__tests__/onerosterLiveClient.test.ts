import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClasslinkRosterAdapter,
  OneRosterLiveClient,
  classlinkUsesFixtures,
} from "@workspace/sis-adapters";

const TOKEN_URL = "https://oneroster-proxy.classlink.io/oauth2/token";
const BASE_URL = "https://demo.classlink.com/oneroster/v1p1";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
}

describe("OneRosterLiveClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fetches and caches OAuth token", async () => {
    let tokenCalls = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = typeof url === "string" ? url : url.toString();
      if (href === TOKEN_URL) {
        tokenCalls++;
        return jsonResponse({
          access_token: "tok-abc",
          token_type: "bearer",
          expires_in: 3600,
        });
      }
      if (href.startsWith(`${BASE_URL}/orgs`)) {
        return jsonResponse({ orgs: [{ sourcedId: "org-1", name: "School", type: "school", status: "active" }] });
      }
      throw new Error(`unexpected fetch: ${href}`);
    });

    const client = new OneRosterLiveClient({
      baseUrl: BASE_URL,
      tokenUrl: TOKEN_URL,
      clientId: "id",
      clientSecret: "secret",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await client.ping();
    await client.ping();
    expect(tokenCalls).toBe(1);
  });

  it("paginates collection endpoints via offset", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = typeof url === "string" ? url : url.toString();
      if (href === TOKEN_URL) {
        return jsonResponse({ access_token: "tok", expires_in: 3600 });
      }
      if (href.includes("/users?")) {
        const parsed = new URL(href);
        const offset = Number(parsed.searchParams.get("offset") ?? "0");
        if (offset === 0) {
          return jsonResponse(
            { users: [{ sourcedId: "u1", givenName: "A", familyName: "B", role: "student", status: "active" }] },
            { headers: { "x-total-count": "2" } },
          );
        }
        return jsonResponse(
          { users: [{ sourcedId: "u2", givenName: "C", familyName: "D", role: "student", status: "active" }] },
          { headers: { "x-total-count": "2" } },
        );
      }
      throw new Error(`unexpected fetch: ${href}`);
    });

    const client = new OneRosterLiveClient({
      baseUrl: BASE_URL,
      tokenUrl: TOKEN_URL,
      clientId: "id",
      clientSecret: "secret",
      fetchImpl: fetchImpl as typeof fetch,
    });

    const users = await client.fetchUsers();
    expect(users).toHaveLength(2);
    expect(users.map((u) => u.sourcedId)).toEqual(["u1", "u2"]);
  });
});

describe("ClasslinkRosterAdapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.CLASSLINK_MOCK;
    delete process.env.CLASSLINK_ONEROSTER_CLIENT_ID;
    delete process.env.CLASSLINK_ONEROSTER_CLIENT_SECRET;
    delete process.env.CLASSLINK_ONEROSTER_BASE_URL;
  });

  it("uses fixtures when CLASSLINK_MOCK=true", async () => {
    process.env.CLASSLINK_MOCK = "true";
    const adapter = new ClasslinkRosterAdapter({
      schoolOrgSourcedId: "org-parrott-0241",
    });
    const ping = await adapter.ping();
    expect(ping.ok).toBe(true);
    expect(ping.message).toContain("mock fixtures");
    const students = await adapter.listStudents();
    expect(students.length).toBeGreaterThan(0);
  });

  it("classlinkUsesFixtures respects explicit useFixtures=false", () => {
    process.env.CLASSLINK_MOCK = "true";
    expect(classlinkUsesFixtures({ useFixtures: false })).toBe(false);
  });

  it("live ping succeeds with mocked HTTP", async () => {
    process.env.CLASSLINK_ONEROSTER_CLIENT_ID = "client-id";
    process.env.CLASSLINK_ONEROSTER_CLIENT_SECRET = "client-secret";
    process.env.CLASSLINK_ONEROSTER_BASE_URL = BASE_URL;

    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = typeof url === "string" ? url : url.toString();
      if (href === TOKEN_URL) {
        return jsonResponse({ access_token: "tok", expires_in: 3600 });
      }
      if (href.startsWith(`${BASE_URL}/orgs`)) {
        return jsonResponse({ orgs: [] });
      }
      if (href.includes("/users?")) {
        return jsonResponse({ users: [] });
      }
      if (href.includes("/classes?")) {
        return jsonResponse({ classes: [] });
      }
      if (href.includes("/enrollments?")) {
        return jsonResponse({ enrollments: [] });
      }
      if (href.includes("/demographics?")) {
        return jsonResponse({ demographics: [] });
      }
      throw new Error(`unexpected fetch: ${href}`);
    });

    vi.stubGlobal("fetch", fetchImpl);

    const ping = await new ClasslinkRosterAdapter({
      useFixtures: false,
      rostersBaseUrl: BASE_URL,
      rostersTokenUrl: TOKEN_URL,
    }).ping();
    expect(ping.ok).toBe(true);
    expect(ping.message).toContain("reachable");

    const students = await new ClasslinkRosterAdapter({
      useFixtures: false,
      rostersBaseUrl: BASE_URL,
      rostersTokenUrl: TOKEN_URL,
      schoolOrgSourcedId: "org-parrott-0241",
    }).listStudents();
    expect(students).toEqual([]);
  });

  it("live ping reports missing credentials", async () => {
    const ping = await new ClasslinkRosterAdapter({
      useFixtures: false,
      rostersBaseUrl: BASE_URL,
    }).ping();
    expect(ping.ok).toBe(false);
    expect(ping.message).toMatch(/client id/i);
  });
});
