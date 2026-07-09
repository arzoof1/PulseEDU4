// Deployment-level master switch for the staff MFA feature. Kept
// dependency-free (mirrors aiGlobalSwitch). Default: ON (feature available).
// Turning it off makes the /auth/mfa/* endpoints 404 and short-circuits the
// login-flow enforcement — an instant kill switch if the feature misbehaves.
// Enforcement is still gated per-school/district by the mfa_required_* policy
// flags, so "on" alone does not force anyone into MFA.

export function isStaffMfaEnabled(): boolean {
  const raw = process.env.STAFF_MFA_ENABLED;
  if (raw === undefined || raw === "") return true;
  const v = raw.trim().toLowerCase();
  return v !== "false" && v !== "0" && v !== "no" && v !== "off";
}
