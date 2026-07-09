import { db, authAuditLogTable } from "@workspace/db";
import { logger } from "./logger.js";

// Best-effort writer for the authentication / privileged-identity audit trail
// (Gate A / items 2.5, 3.6). Never throws into the caller: an audit-write
// failure is logged but must not break the security action it records.

export type AuthAuditEvent = {
  action: string;
  schoolId?: number | null;
  actorStaffId?: number | null;
  actorName?: string | null;
  targetStaffId?: number | null;
  ip?: string | null;
  payload?: Record<string, unknown>;
};

export async function writeAuthAudit(ev: AuthAuditEvent): Promise<void> {
  try {
    await db.insert(authAuditLogTable).values({
      action: ev.action,
      schoolId: ev.schoolId ?? null,
      actorStaffId: ev.actorStaffId ?? null,
      actorName: ev.actorName ?? null,
      targetStaffId: ev.targetStaffId ?? null,
      ip: ev.ip ?? null,
      payload: ev.payload ?? {},
    });
  } catch (err) {
    logger.error(
      { err, action: ev.action },
      "[authAudit] failed to write audit row",
    );
  }
}
