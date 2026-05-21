import { pool } from "@workspace/db";
import { logger } from "./lib/logger";
import { runSeed } from "./seedRunner";

try {
  logger.info("Starting explicit seed run");
  await runSeed();
  logger.info("Explicit seed run complete");
} catch (err) {
  logger.error({ err }, "Explicit seed run failed");
  process.exitCode = 1;
} finally {
  await pool.end();
}
