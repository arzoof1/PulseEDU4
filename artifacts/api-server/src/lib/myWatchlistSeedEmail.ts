// Best-effort notification email when a core team member seeds an
// entry on a teacher's My Watch List. Fire-and-forget — never throws,
// never blocks the POST response, never reverses the create.
//
// Email is the secondary channel. The PRIMARY notification is the
// in-app banner driven by the unacknowledged seeded-entry count.

import { getUncachableResendClient } from "./resendClient.js";

interface Args {
  toEmail: string;
  toDisplayName: string;
  fromDisplayName: string;
  studentDisplayName: string;
  groupLabel: string;
  note: string;
  appBaseUrl: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function sendMyWatchlistSeedEmail(args: Args): Promise<void> {
  try {
    if (!args.toEmail || !args.toEmail.includes("@")) return;
    const { client, fromEmail } = await getUncachableResendClient();
    const subject = `[PulseEDU] ${args.fromDisplayName} added a student to your Watch List`;
    const noteSnippet = args.note.trim().slice(0, 240);
    const noteBlock = noteSnippet
      ? `<p style="margin:0 0 12px;color:#374151;font-size:14px;line-height:1.5">
           <strong style="color:#111827">Why I'm watching:</strong><br/>
           ${escapeHtml(noteSnippet)}
         </p>`
      : "";
    const html = `
      <div style="font-family:system-ui,-apple-system,sans-serif;max-width:540px;margin:0 auto;padding:24px;color:#111827">
        <h2 style="margin:0 0 12px;font-size:18px">${escapeHtml(args.fromDisplayName)} added a student to your Watch List</h2>
        <p style="margin:0 0 12px;color:#374151;font-size:14px;line-height:1.5">
          Hi ${escapeHtml(args.toDisplayName)},
        </p>
        <p style="margin:0 0 12px;color:#374151;font-size:14px;line-height:1.5">
          <strong>${escapeHtml(args.studentDisplayName)}</strong> was just added
          to your <em>${escapeHtml(args.groupLabel)}</em> group on My Watch List.
        </p>
        ${noteBlock}
        <p style="margin:16px 0 0;color:#374151;font-size:14px;line-height:1.5">
          Open <a href="${escapeHtml(args.appBaseUrl)}" style="color:#0d9488;text-decoration:underline">PulseEDU</a> to see the entry.
          A small "Added by ${escapeHtml(args.fromDisplayName)}" badge will be on the card so you know it didn't appear out of nowhere.
        </p>
        <p style="margin:24px 0 0;color:#9ca3af;font-size:12px">
          This is a one-time notification. You can quiet the badge in-app by
          clicking "Acknowledge" on the card. My Watch List is private to you —
          ${escapeHtml(args.fromDisplayName)} won't see your notes or any other
          students you've added yourself.
        </p>
      </div>
    `;
    await client.emails.send({
      from: fromEmail,
      to: args.toEmail,
      subject,
      html,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[my-watchlist] seed-email failed (non-fatal)",
      err instanceof Error ? err.message : String(err),
    );
  }
}
