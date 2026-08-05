// Deployment-level email master switch. Mirrors aiGlobalSwitch: kept
// dependency-free so the shared Resend client wrapper can import it without
// creating a cycle.
//
// When email is disabled (EMAIL_ENABLED=false/0/no/off) every send routed
// through getUncachableResendClient() becomes a logged no-op — password
// resets, invites, digests, parent messages and all other transactional mail
// are suppressed WITHOUT throwing, so callers stay on their existing happy
// path. Re-enable only after the Resend DPA is executed (approval tracker
// LG-07).
//
// Default: enabled when unset, so normal product behavior is unchanged until a
// deployment explicitly sets EMAIL_ENABLED=false. The Hall Pass-only launch
// sets it to false.

export function isEmailGloballyEnabled(): boolean {
  const raw = process.env.EMAIL_ENABLED;
  if (raw === undefined || raw === "") return true;
  const v = raw.trim().toLowerCase();
  return v !== "false" && v !== "0" && v !== "no" && v !== "off";
}
