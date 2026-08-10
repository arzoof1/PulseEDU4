import type { OneRosterOrg } from "./types.js";

/** Resolved ClassLink / OneRoster school org used to scope a sync run. */
export type ResolvedSchoolOrg = {
  sourcedId: string;
  identifier: string | null;
  name: string;
  type: string;
};

export type SchoolOrgMappingConfig = {
  /** ClassLink org `sourcedId` (preferred). */
  schoolOrgSourcedId?: string;
  /** ClassLink org `identifier` (often state school code). */
  schoolOrgIdentifier?: string;
  /** PulseEDU `schools.state_school_code` — cross-checked against org identifier. */
  stateSchoolCode?: string;
};

export type SchoolOrgIndex = {
  bySourcedId: Map<string, OneRosterOrg>;
  /** All school-type orgs keyed by normalized identifier variants. */
  byIdentifier: Map<string, OneRosterOrg>;
  schools: OneRosterOrg[];
};

const SCHOOL_ORG_TYPES = new Set(["school", "local", "department"]);
const NON_CAMPUS_ORG_TYPES = new Set([
  "district",
  "state",
  "national",
]);

function isSchoolOrg(org: OneRosterOrg): boolean {
  const t = (org.type ?? "").toLowerCase();
  if (SCHOOL_ORG_TYPES.has(t)) return true;
  // Some ClassLink tenants label campus orgs with vendor-specific types while
  // still attaching a school identifier. Accept those as campuses.
  if (org.identifier?.trim() && !NON_CAMPUS_ORG_TYPES.has(t)) return true;
  return false;
}

function isActiveOrg(org: OneRosterOrg): boolean {
  return (org.status ?? "active").toLowerCase() === "active";
}

/**
 * Strip common vendor prefixes ClassLink/FL SIS feeds put on school codes
 * (e.g. ENT0342 → 0342) so lookups stay resilient.
 */
export function stripSchoolCodePrefix(code: string): string {
  const t = code.trim();
  if (!t) return t;
  const m = t.match(/^(?:ENT|SCH|FL|DOE|ORG)[_-]?(.+)$/i);
  return m?.[1]?.trim() || t;
}

/** Numeric school codes may appear with or without leading zeros ("0241" vs "241"). */
export function schoolCodesMatch(a: string, b: string): boolean {
  const left = a.trim();
  const right = b.trim();
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.toLowerCase() === right.toLowerCase()) return true;

  const leftKeys = new Set(schoolCodeLookupKeys(left));
  for (const key of schoolCodeLookupKeys(right)) {
    if (leftKeys.has(key)) return true;
  }
  return false;
}

/** Identifier lookup keys (zero-padded, unpadded, ENT-stripped variants). */
export function schoolCodeLookupKeys(code: string): string[] {
  const t = code.trim();
  if (!t) return [];
  const keys = new Set<string>();

  const add = (raw: string) => {
    const v = raw.trim();
    if (!v) return;
    keys.add(v);
    keys.add(v.toLowerCase());
    if (/^\d+$/.test(v)) {
      const n = parseInt(v, 10);
      keys.add(String(n));
      keys.add(String(n).padStart(4, "0"));
    }
  };

  add(t);
  const stripped = stripSchoolCodePrefix(t);
  if (stripped !== t) add(stripped);
  // Digits-only extraction as last-resort match (ENT0342 → 0342).
  const digits = t.replace(/\D+/g, "");
  if (digits && digits !== t && digits !== stripped) add(digits);

  return [...keys];
}

export function buildSchoolOrgIndex(orgs: OneRosterOrg[]): SchoolOrgIndex {
  const bySourcedId = new Map<string, OneRosterOrg>();
  const byIdentifier = new Map<string, OneRosterOrg>();
  const schools: OneRosterOrg[] = [];

  for (const org of orgs) {
    if (!isActiveOrg(org)) continue;
    bySourcedId.set(org.sourcedId, org);
    // Also index by lower-case sourcedId for case-insensitive hits.
    bySourcedId.set(org.sourcedId.toLowerCase(), org);
    if (!isSchoolOrg(org)) continue;
    schools.push(org);
    if (org.identifier?.trim()) {
      for (const key of schoolCodeLookupKeys(org.identifier)) {
        if (!byIdentifier.has(key)) {
          byIdentifier.set(key, org);
        }
      }
    }
  }

  return { bySourcedId, byIdentifier, schools };
}

function toResolved(org: OneRosterOrg): ResolvedSchoolOrg {
  return {
    sourcedId: org.sourcedId,
    identifier: org.identifier?.trim() ?? null,
    name: org.name,
    type: org.type,
  };
}

function findSchoolByIdentifier(
  index: SchoolOrgIndex,
  identifier: string,
): OneRosterOrg | null {
  for (const key of schoolCodeLookupKeys(identifier)) {
    const hit = index.byIdentifier.get(key);
    if (hit) return hit;
  }
  return null;
}

function findOrgBySourcedId(
  index: SchoolOrgIndex,
  sourcedId: string,
): OneRosterOrg | null {
  return (
    index.bySourcedId.get(sourcedId) ??
    index.bySourcedId.get(sourcedId.toLowerCase()) ??
    null
  );
}

export type ResolveSchoolOrgResult =
  | { ok: true; org: ResolvedSchoolOrg; warnings?: string[] }
  | { ok: false; errors: string[] };

/**
 * Resolve the ClassLink school org for a sync using config + OneRoster org feed.
 * Cross-validates `schoolOrgSourcedId`, `schoolOrgIdentifier`, and `stateSchoolCode`.
 *
 * Resilience for mislabeled configs (common in the wild):
 * - If `schoolOrgSourcedId` is missing from the feed (e.g. `ENT0342` was stored
 *   as a sourcedId when it is really an identifier), fall back to identifier
 *   matching instead of hard-failing.
 */
export function resolveSchoolOrg(
  orgs: OneRosterOrg[],
  config: SchoolOrgMappingConfig,
): ResolveSchoolOrgResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const index = buildSchoolOrgIndex(orgs);

  const wantSourcedId = config.schoolOrgSourcedId?.trim();
  const wantIdentifier =
    config.schoolOrgIdentifier?.trim() ||
    config.stateSchoolCode?.trim() ||
    undefined;

  let candidate: OneRosterOrg | null = null;

  if (wantSourcedId) {
    const byId = findOrgBySourcedId(index, wantSourcedId);
    if (byId) {
      if (!isSchoolOrg(byId)) {
        return {
          ok: false,
          errors: [
            `ClassLink org "${wantSourcedId}" is type "${byId.type}", expected a school org.`,
          ],
        };
      }
      candidate = byId;
    } else {
      // Misconfigured: identifier stuffed into schoolOrgSourcedId (e.g. ENT0342).
      const asIdentifier = findSchoolByIdentifier(index, wantSourcedId);
      if (asIdentifier) {
        candidate = asIdentifier;
        warnings.push(
          `sis_config.schoolOrgSourcedId "${wantSourcedId}" was not a live ClassLink sourcedId; matched org "${asIdentifier.name}" (${asIdentifier.sourcedId}) via identifier instead. Update sis_config.schoolOrgSourcedId to "${asIdentifier.sourcedId}".`,
        );
      } else {
        errors.push(
          `ClassLink school org "${wantSourcedId}" was not found in the OneRoster org feed (tried as sourcedId and as identifier).`,
        );
      }
    }
  }

  if (wantIdentifier) {
    const byCode = findSchoolByIdentifier(index, wantIdentifier);
    if (!byCode) {
      // Only hard-error identifier miss when we have no candidate yet.
      if (!candidate) {
        errors.push(
          `No ClassLink school org matched identifier/state code "${wantIdentifier}".`,
        );
      } else {
        warnings.push(
          `No ClassLink school org matched identifier/state code "${wantIdentifier}" (continuing with resolved org "${candidate.name}").`,
        );
      }
    } else if (candidate && candidate.sourcedId !== byCode.sourcedId) {
      // Prefer the identifier/state-code org — sourcedId field is often stale
      // or mislabeled (ENT0342), while state school codes stay stable.
      warnings.push(
        `ClassLink org sourcedId "${candidate.sourcedId}" does not match org for identifier "${wantIdentifier}" (${byCode.sourcedId} / ${byCode.name}). Using identifier match.`,
      );
      candidate = byCode;
    } else if (!candidate) {
      candidate = byCode;
    }
  }

  if (!candidate && !wantSourcedId && !wantIdentifier) {
    if (index.schools.length === 1) {
      candidate = index.schools[0]!;
    } else {
      return {
        ok: false,
        errors: [
          "School org mapping is required: set sis_config.schoolOrgSourcedId or stateSchoolCode.",
        ],
      };
    }
  }

  if (!candidate) {
    return { ok: false, errors };
  }

  if (
    config.stateSchoolCode?.trim() &&
    candidate.identifier?.trim() &&
    !schoolCodesMatch(config.stateSchoolCode, candidate.identifier)
  ) {
    errors.push(
      `PulseEDU state school code "${config.stateSchoolCode}" does not match ClassLink org identifier "${candidate.identifier}" for org ${candidate.sourcedId}.`,
    );
  }

  if (
    config.schoolOrgIdentifier?.trim() &&
    candidate.identifier?.trim() &&
    !schoolCodesMatch(config.schoolOrgIdentifier, candidate.identifier)
  ) {
    errors.push(
      `Configured schoolOrgIdentifier "${config.schoolOrgIdentifier}" does not match ClassLink org identifier "${candidate.identifier}".`,
    );
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    org: toResolved(candidate),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
