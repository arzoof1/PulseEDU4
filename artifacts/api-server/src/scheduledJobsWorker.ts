import { logger } from "./lib/logger.js";
import {
  scheduledJobsEnabled,
  startScheduledJobs,
} from "./lib/scheduledJobs.js";

if (process.env.NODE_ENV === "test") {
  logger.info("Scheduled jobs worker disabled in test environment");
} else if (!scheduledJobsEnabled(true)) {
  logger.info("Scheduled jobs worker disabled by RUN_SCHEDULED_JOBS=false");
} else {
  startScheduledJobs("worker");
  logger.info("Scheduled jobs worker started");
}
