// Single source of truth for building the email `From` header.
//
// `RESEND_FROM_EMAIL` may be configured either as a bare address
// (`noreply@host`) or already in display-name form (`Brand <noreply@host>`).
// When a sender prepends its own display name, it MUST NOT wrap an address
// that is already in `Name <addr>` form — doing so yields a malformed
// `School <Brand <noreply@host>>` header that Resend rejects with
// `validation_error: Invalid \`from\` field`.
//
// This helper guards that case (the check the 11 ad-hoc call sites lacked):
// if `fromEmail` already contains "<", it is returned untouched.
export function formatFromHeader(
  fromName: string | null | undefined,
  fromEmail: string,
): string {
  if (!fromName) return fromEmail;
  if (fromEmail.includes("<")) return fromEmail;
  const safeName = fromName.replace(/"/g, "'");
  return `${safeName} <${fromEmail}>`;


}
