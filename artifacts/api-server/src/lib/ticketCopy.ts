// Shared responsibility verbiage for the Event Ticketing module. The SAME
// wording must appear on every delivery surface (email body, PDF attachment,
// and Parent Portal) so families get one consistent message about how the
// codes work and who is responsible for not over-sharing them.

export const TICKET_RESPONSIBILITY_HEADLINE =
  "One scan = admitted. Please protect these codes.";

export const TICKET_RESPONSIBILITY_LINES: string[] = [
  "Each code below can be scanned ONCE. The first scan is admitted at the door; any later scan of the same code is turned away as \u201calready used.\u201d",
  "These codes are yours to share with the family attending together \u2014 but whoever holds a code can use it. If the same code reaches more than one person, only the first to arrive gets in.",
  "Treat each code like a cash ticket. Screenshots, printouts, and the PDF all scan the same, so only share what you mean to give away.",
];

// Short human-readable reference shown next to each QR (the last 6 chars of
// the token, uppercased). Lets the office look up a specific ticket without
// exposing the full payload.
export function ticketShortCode(token: string): string {
  return token.slice(-6).toUpperCase();
}
