// Shared handoff for the standalone Recording Studio (opened in its own tab so
// the camera/mic work outside the Replit preview iframe). The teleprompter
// script is passed via localStorage (same-origin, shared across tabs) rather
// than the URL, so long drafts aren't truncated by URL length limits.
export const STUDIO_SCRIPT_KEY = "pulseDna.studioScript";

export function openRecordingStudio(script: string): void {
  try {
    localStorage.setItem(STUDIO_SCRIPT_KEY, script ?? "");
  } catch {
    // If storage is unavailable the studio still opens with an empty script.
  }
  const url = `${window.location.origin}${import.meta.env.BASE_URL}studio`;
  window.open(url, "_blank", "noopener,noreferrer");
}
