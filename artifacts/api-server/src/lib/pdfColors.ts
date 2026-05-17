// Defensive color helpers shared across pdfkit-based PDF generators.
//
// pdfkit accepts "#RRGGBB" or "RRGGBB" strings but throws on anything
// else (e.g. "rebeccapurple" or "rgb(...)"). Falling back to a neutral
// slate keeps a single bad house color from blocking a whole batch
// print job.

export function normalizeHex(raw: string | null | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (/^#?[0-9a-fA-F]{6}$/.test(trimmed)) {
    return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  }
  return "#475569";
}
