import crypto from "node:crypto";
import type {
  OneRosterClass,
  OneRosterDemographics,
  OneRosterEnrollment,
  OneRosterFixtureBundle,
  OneRosterOrg,
  OneRosterUser,
} from "./types.js";

// Live ClassLink OneRoster 1.1 REST client.
//
// AUTH: ClassLink Roster Server (rosterserver.com) uses OAuth 1.0a two-legged
// request signing (HMAC-SHA256), NOT OAuth2 client-credentials. Each request is
// signed with the district's consumer key + secret; there is no token endpoint.
// Verified against hernandocountysd-fl-v2.rosterserver.com (2026-08-05).

export class OneRosterApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "OneRosterApiError";
  }
}

function trimTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

// RFC 3986 percent-encoding (encodeURIComponent leaves !*'() — OAuth requires them encoded).
function pctEncode(v: string): string {
  return encodeURIComponent(v).replace(
    /[!*'()]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

// Build an OAuth 1.0a Authorization header for a two-legged (no token) request.
// `signatureUrl` must be the request URL WITHOUT the query string; all query
// params are folded into the signature base string.
function oauth1Header(
  method: string,
  signatureUrl: string,
  queryParams: Record<string, string>,
  consumerKey: string,
  consumerSecret: string,
): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: consumerKey,
    oauth_signature_method: "HMAC-SHA256",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_version: "1.0",
  };
  const all: Record<string, string> = { ...queryParams, ...oauth };
  const paramStr = Object.keys(all)
    .sort()
    .map((k) => `${pctEncode(k)}=${pctEncode(all[k])}`)
    .join("&");
  const base = `${method.toUpperCase()}&${pctEncode(signatureUrl)}&${pctEncode(paramStr)}`;
  const signingKey = `${pctEncode(consumerSecret)}&`; // empty token secret
  const signature = crypto
    .createHmac("sha256", signingKey)
    .update(base)
    .digest("base64");
  oauth.oauth_signature = signature;
  return (
    "OAuth " +
    Object.keys(oauth)
      .map((k) => `${pctEncode(k)}="${pctEncode(oauth[k])}"`)
      .join(", ")
  );
}

function schoolOrgFilter(
  field: string,
  schoolOrgSourcedId?: string,
): string | undefined {
  return schoolOrgSourcedId ? `${field}='${schoolOrgSourcedId}'` : undefined;
}

function parseTotalCount(headers: Headers): number | null {
  const raw = headers.get("x-total-count");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function parseLinkNextOffset(link: string | null): number | null {
  if (!link) return null;
  const next = link.split(",").find((p) => /rel="?next"?/.test(p));
  if (!next) return null;
  const m = next.match(/[?&]offset=(\d+)/);
  return m ? Number(m[1]) : null;
}

export type OneRosterLiveClientOptions = {
  /** Full OneRoster v1p1 base, e.g. "https://<host>/ims/oneroster/v1p1". */
  baseUrl: string;
  consumerKey: string;
  consumerSecret: string;
  /** Injectable for unit tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
};

export class OneRosterLiveClient {
  private readonly baseUrl: string;
  private readonly consumerKey: string;
  private readonly consumerSecret: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OneRosterLiveClientOptions) {
    this.baseUrl = trimTrailingSlash(options.baseUrl);
    this.consumerKey = options.consumerKey;
    this.consumerSecret = options.consumerSecret;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Lightweight reachability + auth check — fetches a single org row. */
  async ping(): Promise<void> {
    await this.fetchCollectionPage<OneRosterOrg>("orgs", "orgs", {
      limit: 1,
      offset: 0,
    });
  }

  async fetchOrgs(): Promise<OneRosterOrg[]> {
    return this.fetchCollection<OneRosterOrg>("orgs", "orgs");
  }
  async fetchUsers(schoolOrgSourcedId?: string): Promise<OneRosterUser[]> {
    return this.fetchCollection<OneRosterUser>(
      "users",
      "users",
      schoolOrgFilter("orgs.sourcedId", schoolOrgSourcedId),
    );
  }
  async fetchClasses(schoolOrgSourcedId?: string): Promise<OneRosterClass[]> {
    return this.fetchCollection<OneRosterClass>(
      "classes",
      "classes",
      schoolOrgFilter("school.sourcedId", schoolOrgSourcedId),
    );
  }
  async fetchEnrollments(
    schoolOrgSourcedId?: string,
  ): Promise<OneRosterEnrollment[]> {
    return this.fetchCollection<OneRosterEnrollment>(
      "enrollments",
      "enrollments",
      schoolOrgFilter("school.sourcedId", schoolOrgSourcedId),
    );
  }
  async fetchDemographics(): Promise<OneRosterDemographics[]> {
    return this.fetchCollection<OneRosterDemographics>(
      "demographics",
      "demographics",
    );
  }

  /** Pull the full roster bundle (optionally scoped to one school org). */
  async fetchBundle(
    schoolOrgSourcedId?: string,
  ): Promise<OneRosterFixtureBundle> {
    const [orgs, users, classes, enrollments, demographics] = await Promise.all(
      [
        this.fetchOrgs(),
        this.fetchUsers(schoolOrgSourcedId),
        this.fetchClasses(schoolOrgSourcedId),
        this.fetchEnrollments(schoolOrgSourcedId),
        this.fetchDemographics(),
      ],
    );
    return {
      baseUrl: this.baseUrl,
      orgs,
      users,
      courses: [],
      classes,
      enrollments,
      demographics,
    };
  }

  private async fetchCollection<T>(
    resourcePath: string,
    rootKey: string,
    filter?: string,
  ): Promise<T[]> {
    const pageSize = 500;
    const all: T[] = [];
    let offset = 0;
    let total: number | null = null;

    for (let page = 0; page < 1000; page++) {
      const { items, total: pageTotal, nextOffset } =
        await this.fetchCollectionPage<T>(resourcePath, rootKey, {
          limit: pageSize,
          offset,
          filter,
        });
      if (total == null && pageTotal != null) total = pageTotal;
      all.push(...items);

      if (items.length === 0) break;
      if (total != null && all.length >= total) break;
      if (items.length < pageSize && total == null) break;

      offset =
        nextOffset != null && nextOffset > offset ? nextOffset : offset + items.length;
    }
    return all;
  }

  private async fetchCollectionPage<T>(
    resourcePath: string,
    rootKey: string,
    opts: { limit: number; offset: number; filter?: string },
  ): Promise<{ items: T[]; total: number | null; nextOffset: number | null }> {
    const query: Record<string, string> = {
      limit: String(opts.limit),
      offset: String(opts.offset),
    };
    if (opts.filter) query.filter = opts.filter;

    const signatureUrl = `${this.baseUrl}/${resourcePath}`;
    const authHeader = oauth1Header(
      "GET",
      signatureUrl,
      query,
      this.consumerKey,
      this.consumerSecret,
    );
    const url = `${signatureUrl}?${new URLSearchParams(query).toString()}`;
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: { Authorization: authHeader, Accept: "application/json" },
    });

    const text = await res.text();
    if (!res.ok) {
      throw new OneRosterApiError(
        `OneRoster ${resourcePath} request failed (${res.status}).`,
        res.status,
        text,
      );
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new OneRosterApiError(
        `OneRoster ${resourcePath} response was not valid JSON.`,
        res.status,
        text,
      );
    }
    const raw = payload[rootKey];
    if (!Array.isArray(raw)) {
      throw new OneRosterApiError(
        `OneRoster ${resourcePath} response missing "${rootKey}" array.`,
        res.status,
        text,
      );
    }
    return {
      items: raw as T[],
      total: parseTotalCount(res.headers),
      nextOffset: parseLinkNextOffset(res.headers.get("link")),
    };
  }
}

// Normalize a district-supplied base URL to the OneRoster v1p1 endpoint.
// Accepts either the bare host or a full v1p1 URL.
export function resolveOneRosterBaseUrl(
  configBaseUrl: string | undefined,
): string | null {
  const raw = (configBaseUrl ?? process.env.CLASSLINK_ONEROSTER_BASE_URL)?.trim();
  if (!raw) return null;
  const trimmed = trimTrailingSlash(raw);
  return /\/ims\/oneroster\/v1p1$/i.test(trimmed)
    ? trimmed
    : `${trimmed}/ims/oneroster/v1p1`;
}
