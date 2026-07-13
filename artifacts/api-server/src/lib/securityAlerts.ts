import { db, adminNotificationsTable } from "@workspace/db";
import { logger } from "./logger.js";

// In-app security alerting (Section 3: 3.2 failed logins, 3.6 role changes,
// 3.7 bulk exports). Writes an admin_notifications row scoped to the school so
// the event surfaces in Admin Notifications (badge + list) for that school's
// admins. Best-effort: an alerting failure must NEVER break the security action
// that triggered it (a login, a role change, an export), so this swallows and
// logs errors. This is the single choke point for security alerts — an email /
// SMS fan-out (Resend / Twilio) can be added here later without touching the
// call sites.

export type SecurityAlertType =
  | "security_failed_logins"
  | "security_role_changed"
  | "security_data_export"
  | "security_api_volume"
  | "security_impossible_travel";

export async function raiseSecurityAlert(input: {
  schoolId: number | null | undefined;
  type: SecurityAlertType;
  payload: Record<string, unknown>;
}): Promise<void> {
  // Notifications are school-scoped; without a school we have no audience.
  if (input.schoolId == null) return;
  try {
    await db.insert(adminNotificationsTable).values({
      schoolId: input.schoolId,
      type: input.type,
      payload: input.payload,
    });
  } catch (err) {
    logger.error(
      { err, type: input.type },
      "[securityAlerts] failed to raise security alert",
    );
  }
}
