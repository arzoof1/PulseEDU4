// Parent-notification stub for tardy logging.
//
// There is NO real SMS provider wired up (the only messaging integration
// configured is Resend email). This is an intentional scaffold: when a
// student is logged tardy we record the *intent* to text the parent so the
// real sender can be dropped in later without touching the route. It must
// never throw — a notification failure can never block the tardy insert.

interface StubLogger {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
}

export interface TardySmsStubArgs {
  schoolId: number;
  /** Canonical FLEID — for internal correlation only, never surfaced. */
  studentId: string;
  /** Student-facing local SIS id, when known (never the FLEID). */
  localSisId: string | null;
  studentName: string | null;
  parentPhone: string | null;
  period: string;
  log: StubLogger;
}

/**
 * Pretend to send a parent an SMS about a tardy. Logs what *would* be sent.
 * Returns silently (never throws) so the caller can fire-and-forget.
 */
export async function sendTardySmsStub(args: TardySmsStubArgs): Promise<void> {
  const { schoolId, studentId, localSisId, studentName, parentPhone, period, log } =
    args;
  try {
    const body = `${studentName ?? "Your student"} was marked tardy${
      period ? ` for period ${period}` : ""
    } today.`;

    if (!parentPhone || !parentPhone.trim()) {
      log.warn(
        { schoolId, studentId, localSisId },
        "[tardy-sms STUB] no parent phone on file — skipping",
      );
      return;
    }

    // No provider yet: this is where a Twilio/AWS SNS call would go.
    log.info(
      {
        schoolId,
        studentId,
        localSisId,
        to: parentPhone,
        period,
        body,
        provider: "stub",
      },
      "[tardy-sms STUB] would send parent SMS (no provider configured)",
    );
  } catch (err) {
    // Notifications are best-effort; never let them break the tardy insert.
    log.warn({ err, schoolId, studentId }, "[tardy-sms STUB] failed");
  }
}
