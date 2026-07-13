import { Router, type IRouter, type Request } from "express";
import { eq } from "drizzle-orm";
import { db, staffTable, staffMfaRecoveryCodesTable } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { isStaffMfaEnabled } from "../lib/staffMfaSwitch.js";
import { encryptMfaSecret, decryptMfaSecret } from "../lib/mfaCrypto.js";
import { isMfaRequiredForStaffCached } from "../lib/mfaPolicyCache.js";
import { writeAuthAudit } from "../lib/authAudit.js";
import {
  generateTotpSecret,
  buildOtpauthUri,
  verifyTotp,
  generateRecoveryCodes,
} from "../lib/staffMfa.js";
import {
  storeRecoveryCodes,
  consumeRecoveryCode,
  countUnusedRecoveryCodes,
} from "../lib/staffMfaStore.js";
import {
  verifyPrivilegedReauth,
  PRIVILEGED_REAUTH_WINDOW_MS,
} from "../lib/privilegedReauth.js";

// Staff MFA enrollment + management (Gate A / Section 1, Slice 2). These
// endpoints let a staff member VOLUNTARILY enroll in TOTP MFA and manage
// recovery codes. They do NOT yet change the login flow — enrollment is
// opt-in and enforcement lands in a later slice. Guarded by the master
// switch (STAFF_MFA_ENABLED) and by an authenticated staff session.

const router: IRouter = Router();

function clientIp(req: Request): string | null {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) {
    return fwd.split(",")[0].trim();
  }
  return req.ip ?? null;
}

async function loadStaff(staffId: number) {
  const [s] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, staffId))
    .limit(1);
  return s ?? null;
}

// Gate: master switch on + authenticated staff. Applies to every /auth/mfa/*.
router.use("/auth/mfa", (req, res, next) => {
  if (!isStaffMfaEnabled()) {
    res.status(404).json({ error: "mfa_disabled" });
    return;
  }
  if (!req.staffId) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  next();
});

router.get("/auth/mfa/status", async (req, res) => {
  const staff = await loadStaff(req.staffId!);
  if (!staff) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const enrolled = !!staff.mfaEnrolledAt;
  const [required, recoveryCodesRemaining] = await Promise.all([
    // Use the SAME cached resolver the enrollment gate uses, so the client's
    // "am I required?" answer can never disagree with what the server actually
    // enforces (a divergence would let the dashboard mount while every route
    // 403s — the white-screen bug this replaced).
    isMfaRequiredForStaffCached(staff),
    enrolled ? countUnusedRecoveryCodes(staff.id) : Promise.resolve(0),
  ]);
  res.json({ enrolled, required, recoveryCodesRemaining });
});

// Begin enrollment: generate + store a PENDING secret (enrolledAt stays null
// until verify-setup confirms the user's authenticator is working).
router.post("/auth/mfa/setup", async (req, res) => {
  const staff = await loadStaff(req.staffId!);
  if (!staff) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  if (staff.mfaEnrolledAt) {
    res.status(409).json({ error: "already_enrolled" });
    return;
  }
  const secret = generateTotpSecret();
  await db
    .update(staffTable)
    .set({ mfaSecretEnc: encryptMfaSecret(secret) })
    .where(eq(staffTable.id, staff.id));
  res.json({ secret, otpauthUri: buildOtpauthUri(staff.email, secret) });
});

// Confirm enrollment: verify a code against the pending secret, then activate
// MFA, mint recovery codes (shown ONCE), and bump the token version.
router.post("/auth/mfa/verify-setup", async (req, res) => {
  const staff = await loadStaff(req.staffId!);
  if (!staff) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  if (staff.mfaEnrolledAt) {
    res.status(409).json({ error: "already_enrolled" });
    return;
  }
  if (!staff.mfaSecretEnc) {
    res.status(400).json({ error: "no_pending_setup" });
    return;
  }
  let secret: string;
  try {
    secret = decryptMfaSecret(staff.mfaSecretEnc);
  } catch (err) {
    logger.error({ err, staffId: staff.id }, "[mfa] pending secret decrypt failed");
    res.status(500).json({ error: "mfa_error" });
    return;
  }
  if (!verifyTotp(secret, (req.body ?? {}).code)) {
    res.status(400).json({ error: "invalid_code" });
    return;
  }
  const codes = generateRecoveryCodes();
  await storeRecoveryCodes(staff.id, codes);
  await db
    .update(staffTable)
    .set({
      mfaEnrolledAt: new Date(),
      mfaLastUsedAt: new Date(),
      authTokenVersion: staff.authTokenVersion + 1,
    })
    .where(eq(staffTable.id, staff.id));
  await writeAuthAudit({
    action: "mfa_enrolled",
    schoolId: staff.schoolId,
    actorStaffId: staff.id,
    actorName: staff.displayName,
    targetStaffId: staff.id,
    ip: clientIp(req),
  });
  res.json({ enrolled: true, recoveryCodes: codes });
});

// Disable MFA. Step-up: requires a current TOTP OR a valid recovery code.
router.post("/auth/mfa/disable", async (req, res) => {
  const staff = await loadStaff(req.staffId!);
  if (!staff) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  if (!staff.mfaEnrolledAt || !staff.mfaSecretEnc) {
    res.status(400).json({ error: "not_enrolled" });
    return;
  }
  const code = (req.body ?? {}).code;
  let ok = false;
  try {
    ok = verifyTotp(decryptMfaSecret(staff.mfaSecretEnc), code);
  } catch {
    ok = false;
  }
  if (!ok && typeof code === "string") {
    ok = await consumeRecoveryCode(staff.id, code);
  }
  if (!ok) {
    res.status(400).json({ error: "invalid_code" });
    return;
  }
  await db
    .update(staffTable)
    .set({
      mfaSecretEnc: null,
      mfaEnrolledAt: null,
      authTokenVersion: staff.authTokenVersion + 1,
    })
    .where(eq(staffTable.id, staff.id));
  await db
    .delete(staffMfaRecoveryCodesTable)
    .where(eq(staffMfaRecoveryCodesTable.staffId, staff.id));
  await writeAuthAudit({
    action: "mfa_disabled",
    schoolId: staff.schoolId,
    actorStaffId: staff.id,
    actorName: staff.displayName,
    targetStaffId: staff.id,
    ip: clientIp(req),
  });
  res.json({ disabled: true });
});

// Regenerate recovery codes. Step-up: requires a current TOTP.
router.post("/auth/mfa/recovery-codes/regenerate", async (req, res) => {
  const staff = await loadStaff(req.staffId!);
  if (!staff) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  if (!staff.mfaEnrolledAt || !staff.mfaSecretEnc) {
    res.status(400).json({ error: "not_enrolled" });
    return;
  }
  if (!verifyTotp(decryptMfaSecret(staff.mfaSecretEnc), (req.body ?? {}).code)) {
    res.status(400).json({ error: "invalid_code" });
    return;
  }
  const codes = generateRecoveryCodes();
  await storeRecoveryCodes(staff.id, codes);
  await writeAuthAudit({
    action: "mfa_recovery_regenerated",
    schoolId: staff.schoolId,
    actorStaffId: staff.id,
    actorName: staff.displayName,
    targetStaffId: staff.id,
    ip: clientIp(req),
  });
  res.json({ recoveryCodes: codes });
});

// Privileged step-up reauthentication (Section 1.15). Verifies the current
// password (+ MFA/recovery code when enrolled) and opens a short-lived window
// on the session, so sensitive actions (bulk export, Safety Plan viewing) can
// require a RECENT step-up without prompting on every request. Deliberately
// NOT under the /auth/mfa switch gate above: it must work for password-only
// (unenrolled) accounts too.
router.post("/auth/reauth", async (req, res) => {
  if (!req.staffId) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const staff = await loadStaff(req.staffId);
  if (!staff || !staff.active) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const result = await verifyPrivilegedReauth(staff, req.body);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  req.session.privilegedReauthAt = Date.now();
  await new Promise<void>((resolve, reject) =>
    req.session.save((err) => (err ? reject(err) : resolve())),
  );
  await writeAuthAudit({
    action: "privileged_reauth",
    schoolId: staff.schoolId,
    actorStaffId: staff.id,
    actorName: staff.displayName,
    targetStaffId: staff.id,
    ip: clientIp(req),
  });
  res.json({
    ok: true,
    reauthAt: req.session.privilegedReauthAt,
    windowMs: PRIVILEGED_REAUTH_WINDOW_MS,
  });
});

export default router;
