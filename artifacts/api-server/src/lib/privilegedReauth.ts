import { staffTable } from "@workspace/db";
import { bcryptCompare } from "./bcrypt.js";
import { decryptMfaSecret } from "./mfaCrypto.js";
import { verifyTotp } from "./staffMfa.js";
import { consumeRecoveryCode } from "./staffMfaStore.js";

type StaffRow = typeof staffTable.$inferSelect;

export type PrivilegedReauthInput = {
  currentPassword?: unknown;
  code?: unknown;
};

export type PrivilegedReauthFailure = {
  ok: false;
  status: number;
  error: string;
};

export type PrivilegedReauthResult = { ok: true } | PrivilegedReauthFailure;

export async function verifyPrivilegedReauth(
  staff: StaffRow,
  input: PrivilegedReauthInput | undefined,
): Promise<PrivilegedReauthResult> {
  const currentPassword = input?.currentPassword;
  if (typeof currentPassword !== "string" || currentPassword.length === 0) {
    return {
      ok: false,
      status: 403,
      error: "reauth_required",
    };
  }

  const passwordOk = await bcryptCompare(currentPassword, staff.passwordHash);
  if (!passwordOk) {
    return {
      ok: false,
      status: 401,
      error: "Current password is incorrect",
    };
  }

  if (!staff.mfaEnrolledAt || !staff.mfaSecretEnc) {
    return { ok: true };
  }

  const code = input?.code;
  if (typeof code !== "string" || code.trim().length === 0) {
    return {
      ok: false,
      status: 403,
      error: "mfa_code_required",
    };
  }

  let codeOk = false;
  try {
    codeOk = verifyTotp(decryptMfaSecret(staff.mfaSecretEnc), code);
  } catch {
    codeOk = false;
  }
  if (!codeOk) {
    codeOk = await consumeRecoveryCode(staff.id, code);
  }
  if (!codeOk) {
    return {
      ok: false,
      status: 401,
      error: "invalid_code",
    };
  }

  return { ok: true };
}

// The step-up window helper lives in a DB-free module so it stays unit-testable
// without DATABASE_URL. Re-exported here so callers have a single import point.
export {
  PRIVILEGED_REAUTH_WINDOW_MS,
  hasFreshPrivilegedReauth,
} from "./privilegedReauthWindow.js";
