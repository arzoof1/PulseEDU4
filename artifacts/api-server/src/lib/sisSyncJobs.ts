// Background job runner for manual SIS sync requests from the ClassLink Sync
// panel. A live sync pulls the FULL district OneRoster bundle; on a cold cache
// that takes longer than the reverse proxy allows, so a synchronous HTTP
// handler surfaces as an HTML 504 ("Unexpected token '<' … not valid JSON")
// while the sync silently finishes server-side anyway. Instead: POST starts
// the sync here and returns a job id immediately; the panel polls the job
// until it completes. The nightly cron path is unchanged (no HTTP involved).
//
// In-memory by design: a pm2 restart drops job records but never sync results
// (per-integration sisLastSyncAt/Status are persisted by the sync itself) —
// the panel's Refresh recovers the truth. One sync job runs at a time; a
// second start request returns the running job instead of stacking district
// pulls.

import { randomUUID } from "node:crypto";
import {
  runScheduledSisRosterSyncs,
  runSisSyncForIntegration,
  type ScheduledSisSyncRowResult,
  type SisSyncResult,
} from "./sisRosterSync.js";
import { logger } from "./logger.js";

export type SisSyncJob = {
  id: string;
  kind: "all" | "integration";
  integrationId: number | null;
  status: "running" | "done" | "failed";
  startedAt: string;
  finishedAt: string | null;
  /** kind=integration → SisSyncResult; kind=all → ScheduledSisSyncRowResult[] */
  result: SisSyncResult | ScheduledSisSyncRowResult[] | null;
  error: string | null;
};

const jobs = new Map<string, SisSyncJob>();
let activeJobId: string | null = null;

// Keep the map bounded — finished jobs older than the last N are pruned.
const MAX_FINISHED_JOBS = 20;

function pruneFinished(): void {
  const finished = [...jobs.values()]
    .filter((j) => j.status !== "running")
    .sort((a, b) => (a.finishedAt ?? "").localeCompare(b.finishedAt ?? ""));
  while (finished.length > MAX_FINISHED_JOBS) {
    const oldest = finished.shift();
    if (oldest) jobs.delete(oldest.id);
  }
}

export function getSisSyncJob(id: string): SisSyncJob | null {
  return jobs.get(id) ?? null;
}

export function getActiveSisSyncJob(): SisSyncJob | null {
  if (!activeJobId) return null;
  const job = jobs.get(activeJobId);
  return job && job.status === "running" ? job : null;
}

/**
 * Start a sync job (or return the one already running — never two concurrent
 * district pulls). The work runs detached from any HTTP request lifecycle.
 */
export function startSisSyncJob(
  kind: "all" | "integration",
  integrationId?: number,
): { job: SisSyncJob; alreadyRunning: boolean } {
  const active = getActiveSisSyncJob();
  if (active) return { job: active, alreadyRunning: true };

  const job: SisSyncJob = {
    id: randomUUID(),
    kind,
    integrationId: integrationId ?? null,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    result: null,
    error: null,
  };
  jobs.set(job.id, job);
  activeJobId = job.id;

  void (async () => {
    try {
      job.result =
        kind === "all"
          ? await runScheduledSisRosterSyncs()
          : await runSisSyncForIntegration(integrationId!);
      job.status = "done";
    } catch (err: unknown) {
      job.status = "failed";
      job.error = err instanceof Error ? err.message : String(err);
      logger.error({ err, jobId: job.id, kind, integrationId }, "SIS sync job failed");
    } finally {
      job.finishedAt = new Date().toISOString();
      if (activeJobId === job.id) activeJobId = null;
      pruneFinished();
    }
  })();

  return { job, alreadyRunning: false };
}
