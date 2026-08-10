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

const SCHOOL_ORG_TYPES = new Set(["school", "local"]);

function isSchoolOrg(org: OneRosterOrg): boolean {
  return SCHOOL_ORG_TYPES.has((org.type ?? "").toLowerCase());
}

function isActiveOrg(org: OneRosterOrg): boolean {
  return (org.status ?? "active").toLowerCase() === "active";
}

/** Numeric school codes may appear with or without leading zeros ("0241" vs "241"). */
export function schoolCodesMatch(a: string, b: string): boolean {
  const left = a.trim();
  const right = b.trim();
  if (!left || !right) return false;
  if (left === right) return true;
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    return parseInt(left, 10) === parseInt(right, 10);
  }
  return left.toLowerCase() === right.toLowerCase();
}

/** Identifier lookup keys (zero-padded and unpadded numeric variants). */
export function schoolCodeLookupKeys(code: string): string[] {
  const t = code.trim();
  if (!t) return [];
  const keys = new Set<string>([t, t.toLowerCase()]);
  if (/^\d+$/.test(t)) {
    const n = parseInt(t, 10);
    keys.add(String(n));
    keys.add(String(n).padStart(4, "0"));
  }
  return [...keys];
}

export function buildSchoolOrgIndex(orgs: OneRosterOrg[]): SchoolOrgIndex {
  const bySourcedId = new Map<string, OneRosterOrg>();
  const byIdentifier = new Map<string, OneRosterOrg>();
  const schools: OneRosterOrg[] = [];

  for (const org of orgs) {
    if (!isActiveOrg(org)) continue;
    bySourcedId.set(org.sourcedId, org);
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

export type ResolveSchoolOrgResult =
  | { ok: true; org: ResolvedSchoolOrg }
  | { ok: false; errors: string[] };

/**
 * Resolve the ClassLink school org for a sync using config + OneRoster org feed.
 * Cross-validates `schoolOrgSourcedId`, `schoolOrgIdentifier`, and `stateSchoolCode`.
 */
export function resolveSchoolOrg(
  orgs: OneRosterOrg[],
  config: SchoolOrgMappingConfig,
): ResolveSchoolOrgResult {
  const errors: string[] = [];
  const index = buildSchoolOrgIndex(orgs);

  const wantSourcedId = config.schoolOrgSourcedId?.trim();
  const wantIdentifier =
    config.schoolOrgIdentifier?.trim() ?? config.stateSchoolCode?.trim();

  let candidate: OneRosterOrg | null = null;

  if (wantSourcedId) {
    const byId = index.bySourcedId.get(wantSourcedId);
    if (!byId) {
      return {
        ok: false,
        errors: [
          `ClassLink school org "${wantSourcedId}" was not found in the OneRoster org feed.`,
        ],
      };
    }
    if (!isSchoolOrg(byId)) {
      return {
        ok: false,
        errors: [
          `ClassLink org "${wantSourcedId}" is type "${byId.type}", expected a school org.`,
        ],
      };
    }
    candidate = byId;
  }

  if (wantIdentifier) {
    const byCode = findSchoolByIdentifier(index, wantIdentifier);
    if (!byCode) {
      errors.push(
        `No ClassLink school org matched identifier/state code "${wantIdentifier}".`,
      );
    } else if (candidate && candidate.sourcedId !== byCode.sourcedId) {
      errors.push(
        `ClassLink org sourcedId "${candidate.sourcedId}" does not match org for identifier "${wantIdentifier}" (${byCode.sourcedId}).`,
      );
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

  return { ok: true, org: toResolved(candidate) };
}
