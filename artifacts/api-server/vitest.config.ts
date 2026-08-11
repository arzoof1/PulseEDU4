import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 30000,
    hookTimeout: 30000,
    // DB-backed suites share one Postgres database and seed overlapping
    // fixtures (same school codes, same district_integrations rows), so test
    // FILES must not run concurrently. `fileParallel` was a typo for
    // `fileParallelism` and `poolOptions` was removed in Vitest 4 — both were
    // silently ignored, leaving files parallel.
    fileParallelism: false,
    pool: "forks",
    maxForks: 1,
    minForks: 1,
  },
});
