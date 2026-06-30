import type {
  OneRosterClass,
  OneRosterDemographics,
  OneRosterEnrollment,
  OneRosterFixtureBundle,
  OneRosterOrg,
  OneRosterUser,
} from "./types.js";

/** Default ClassLink OneRoster proxy token endpoint (district creds are tenant-scoped). */
export const CLASSLINK_DEFAULT_TOKEN_URL =
  "https://oneroster-proxy.classlink.io/oauth2/token";

export type OneRosterLiveClientOptions = {
  baseUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  /** Injectable for unit tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
};

type TokenCache = {
  accessToken: string;
  expiresAtMs: number;
};

export class OneRosterApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "OneRosterApiError";
  }
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function escapeOneRosterFilterValue(value: string): string {
  return value.replace(/'/g, "''");
}

function schoolOrgFilter(
  field: string,
  schoolOrgSourcedId: string | undefined,
): string | undefined {
  if (!schoolOrgSourcedId?.trim()) return undefined;
  const id = escapeOneRosterFilterValue(schoolOrgSourcedId.trim());
  return `${field}='${id}'`;
}

function parseTotalCount(headers: Headers): number | null {
  const raw = headers.get("x-total-count") ?? headers.get("X-Total-Count");
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

function parseLinkNextOffset(linkHeader: string | null): number | null {
  if (!linkHeader) return null;
  const parts = linkHeader.split(",");
  for (const part of parts) {
    const section = part.trim();
    if (!/rel="?next"?/i.test(section)) continue;
    const urlMatch = section.match(/<([^>]+)>/);
    if (!urlMatch?.[1]) continue;
    try {
      const url = new URL(urlMatch[1]);
      const offset = url.searchParams.get("offset");
      if (offset != null) {
        const n = parseInt(offset, 10);
        if (Number.isFinite(n)) return n;
      }
    } catch {
      /* ignore malformed Link URLs */
    }
  }
  return null;
}

export class OneRosterLiveClient {
  private readonly baseUrl: string;
  private readonly tokenUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetchImpl: typeof fetch;
  private tokenCache: TokenCache | null = null;

  constructor(options: OneRosterLiveClientOptions) {
    this.baseUrl = trimTrailingSlash(options.baseUrl);
    this.tokenUrl = options.tokenUrl;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getAccessToken(): Promise<string> {
    const cached = this.tokenCache;
    if (cached && Date.now() < cached.expiresAtMs) {
      return cached.accessToken;
    }

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    const res = await this.fetchImpl(this.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    });

    const text = await res.text();
    if (!res.ok) {
      throw new OneRosterApiError(
        `ClassLink token request failed (${res.status}).`,
        res.status,
        text,
      );
    }

    let payload: { access_token?: string; expires_in?: number };
    try {
      payload = JSON.parse(text) as typeof payload;
    } catch {
      throw new OneRosterApiError(
        "ClassLink token response was not valid JSON.",
        res.status,
        text,
      );
    }

    const accessToken = payload.access_token?.trim();
    if (!accessToken) {
      throw new OneRosterApiError(
        "ClassLink token response missing access_token.",
        res.status,
        text,
      );
    }

    const expiresIn =
      typeof payload.expires_in === "number" && payload.expires_in > 0
        ? payload.expires_in
        : 3600;
    const bufferSec = 60;
    this.tokenCache = {
      accessToken,
      expiresAtMs: Date.now() + Math.max(0, expiresIn - bufferSec) * 1000,
    };
    return accessToken;
  }

  /** Lightweight reachability check — fetches a single org row. */
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
      schoolOrgFilter("org.sourcedId", schoolOrgSourcedId),
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

  async fetchFixtureBundle(
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

    for (let page = 0; page < 500; page++) {
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

      const linked = nextOffset;
      if (linked != null && linked > offset) {
        offset = linked;
        continue;
      }
      offset += items.length;
    }

    return all;
  }

  private async fetchCollectionPage<T>(
    resourcePath: string,
    rootKey: string,
    opts: { limit: number; offset: number; filter?: string },
  ): Promise<{ items: T[]; total: number | null; nextOffset: number | null }> {
    const params = new URLSearchParams({
      limit: String(opts.limit),
      offset: String(opts.offset),
    });
    if (opts.filter) params.set("filter", opts.filter);

    const url = `${this.baseUrl}/${resourcePath}?${params.toString()}`;
    const token = await this.getAccessToken();
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
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

export function resolveClasslinkTokenUrl(
  configTokenUrl: string | undefined,
): string {
  const fromConfig = configTokenUrl?.trim();
  if (fromConfig) return fromConfig;
  const fromEnv = process.env.CLASSLINK_ONEROSTER_TOKEN_URL?.trim();
  if (fromEnv) return fromEnv;
  return CLASSLINK_DEFAULT_TOKEN_URL;
}

export function resolveClasslinkBaseUrl(
  configBaseUrl: string | undefined,
): string | null {
  const fromConfig = configBaseUrl?.trim();
  if (fromConfig) return trimTrailingSlash(fromConfig);
  const fromEnv = process.env.CLASSLINK_ONEROSTER_BASE_URL?.trim();
  if (fromEnv) return trimTrailingSlash(fromEnv);
  return null;
}
