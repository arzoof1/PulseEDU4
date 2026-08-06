/**
 * setupClasslinkDistrict — provision the real ClassLink/OneRoster district:
 * upsert the district, upsert one school row per live OneRoster school org
 * (so state codes always match ClassLink), and create/refresh one
 * `district_integrations` row per school (sis_provider=classlink,
 * useFixtures:false) pointed at that org's sourcedId.
 *
 * Non-destructive. DRY-RUN by default — prints exactly what it would do.
 * Pass `--apply` to write. Idempotent (safe to re-run as schools change).
 *
 * Sources:
 *   --source=live     (default) fetch orgs from the live API using
 *                     CLASSLINK_ONEROSTER_BASE_URL / _CLIENT_ID / _CLIENT_SECRET
 *   --source=fixture  read the bundled OneRoster fixture orgs (offline test)
 *
 * Usage (prod, from repo root):
 *   DATABASE_URL=... \
 *   CLASSLINK_ONEROSTER_BASE_URL=https://hernandocountysd-fl-v2.rosterserver.com/ims/oneroster/v1p1 \
 *   CLASSLINK_ONEROSTER_CLIENT_ID=... CLASSLINK_ONEROSTER_CLIENT_SECRET=... \
 *   pnpm --filter @workspace/scripts classlink-setup            # dry run
 *   ...same env... pnpm --filter @workspace/scripts classlink-setup -- --apply
 */
import {
  db,
  pool,
  districtsTable,
  schoolsTable,
  districtIntegrationsTable,
} from "@workspace/db";
import {
  OneRosterLiveClient,
  resolveOneRosterBaseUrl,
  loadOneRosterFixtures,
  type OneRosterOrg,
} from "@workspace/sis-adapters";
import { and, eq } from "drizzle-orm";

const ID_ENV = "CLASSLINK_ONEROSTER_CLIENT_ID";
const SECRET_ENV = "CLASSLINK_ONEROSTER_CLIENT_SECRET";

type Args = {
  apply: boolean;
  source: "live" | "fixture";
  districtSlug: string;
  districtName: string;
  districtCode: string;
};

function parseArgs(argv: string[]): Args {
  const get = (name: string, def: string): string => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : def;
  };
  const source = get("source", "live");
  return {
    apply: argv.includes("--apply"),
    source: source === "fixture" ? "fixture" : "live",
    districtSlug: get("district-slug", "hernando"),
    districtName: get("district-name", "Hernando County School District"),
    districtCode: get("district-code", "27"),
  };
}

/** Derive a PulseEDU state_school_code from an org (identifier, else digits of sourcedId). */
function orgStateCode(org: OneRosterOrg): string | null {
  const id = org.identifier?.trim();
  if (id) return id;
  const digits = org.sourcedId.replace(/\D+/g, "");
  return digits || null;
}

function shortNameFrom(name: string): string {
  return name.replace(/\b(School|Middle|High|Elementary|Center)\b/gi, "").trim().split(/\s+/)[0] ?? name;
}

async function fetchOrgs(args: Args): Promise<OneRosterOrg[]> {
  if (args.source === "fixture") {
    return loadOneRosterFixtures().orgs;
  }
  const baseUrl = resolveOneRosterBaseUrl(process.env.CLASSLINK_ONEROSTER_BASE_URL);
  const consumerKey = process.env[ID_ENV]?.trim();
  const consumerSecret = process.env[SECRET_ENV]?.trim();
  if (!baseUrl) throw new Error(`Missing CLASSLINK_ONEROSTER_BASE_URL.`);
  if (!consumerKey || !consumerSecret)
    throw new Error(`Missing ${ID_ENV} / ${SECRET_ENV}.`);
  const client = new OneRosterLiveClient({ baseUrl, consumerKey, consumerSecret });
  return client.fetchOrgs();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.apply ? "APPLY (writes)" : "DRY-RUN (no writes)";
  console.log(`\n[classlink-setup] ${mode} — source=${args.source}\n`);

  const orgs = await fetchOrgs(args);
  const schoolOrgs = orgs.filter((o) => o.type === "school");
  console.log(
    `Fetched ${orgs.length} orgs (${schoolOrgs.length} schools).` +
      (schoolOrgs.length === 0 ? " Nothing to do." : ""),
  );
  if (schoolOrgs.length === 0) return;

  const baseUrl =
    args.source === "live"
      ? resolveOneRosterBaseUrl(process.env.CLASSLINK_ONEROSTER_BASE_URL)!
      : loadOneRosterFixtures().baseUrl;

  // Preview table.
  const rows = schoolOrgs.map((o) => ({
    school: o.name,
    stateCode: orgStateCode(o) ?? "(none)",
    sourcedId: o.sourcedId,
  }));
  console.table(rows);

  const skipped = schoolOrgs.filter((o) => !orgStateCode(o));
  if (skipped.length) {
    console.warn(
      `\n⚠ ${skipped.length} school org(s) have no identifier/state code and will be SKIPPED:\n` +
        skipped.map((o) => `   - ${o.name} (${o.sourcedId})`).join("\n"),
    );
  }

  if (!args.apply) {
    console.log(
      `\nDry run complete. Re-run with --apply to upsert ${schoolOrgs.length - skipped.length} school(s) + integrations.\n`,
    );
    return;
  }

  let districtId: number;
  let schoolsWritten = 0;
  let integrationsWritten = 0;

  await db.transaction(async (tx) => {
    // District.
    const [district] = await tx
      .insert(districtsTable)
      .values({
        name: args.districtName,
        slug: args.districtSlug,
        stateDistrictCode: args.districtCode,
      })
      .onConflictDoUpdate({
        target: districtsTable.slug,
        set: { name: args.districtName, stateDistrictCode: args.districtCode },
      })
      .returning({ id: districtsTable.id });
    districtId = district!.id;
    console.log(`District "${args.districtName}" → id ${districtId}`);

    for (const org of schoolOrgs) {
      const code = orgStateCode(org);
      if (!code) continue;

      // School (unique on district_id + state_school_code).
      const [school] = await tx
        .insert(schoolsTable)
        .values({
          districtId,
          name: org.name,
          shortName: shortNameFrom(org.name),
          stateSchoolCode: code,
        })
        .onConflictDoUpdate({
          target: [schoolsTable.districtId, schoolsTable.stateSchoolCode],
          set: { name: org.name },
        })
        .returning({ id: schoolsTable.id });
      const schoolId = school!.id;
      schoolsWritten++;

      // Integration row (no unique key on school_name — select-then-write).
      const sisConfig = {
        useFixtures: false,
        stateSchoolCode: code,
        schoolOrgSourcedId: org.sourcedId,
        schoolOrgIdentifier: org.identifier ?? null,
        rostersBaseUrl: baseUrl,
        rostersClientIdEnvVar: ID_ENV,
        rostersClientSecretEnvVar: SECRET_ENV,
      };
      const [existing] = await tx
        .select({ id: districtIntegrationsTable.id })
        .from(districtIntegrationsTable)
        .where(
          and(
            eq(districtIntegrationsTable.schoolName, org.name),
            eq(districtIntegrationsTable.sisProvider, "classlink"),
          ),
        );
      if (existing) {
        await tx
          .update(districtIntegrationsTable)
          .set({ sisProvider: "classlink", sisConfig, updatedAt: new Date() })
          .where(eq(districtIntegrationsTable.id, existing.id));
      } else {
        await tx.insert(districtIntegrationsTable).values({
          schoolName: org.name,
          sisProvider: "classlink",
          sisConfig,
          ssoProvider: "none",
        });
      }
      integrationsWritten++;
    }
  });

  console.log(
    `\n✅ Applied: ${schoolsWritten} school(s), ${integrationsWritten} integration(s) under district ${districtId!}.\n` +
      `Next: run one-school sync (POST /api/sis-sync/run with that school's integrationId), review, then all.\n`,
  );
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error("[classlink-setup] FAILED:", err);
    await pool.end();
    process.exit(1);
  });
