// Tiny module-level signal that the full-screen Recording Studio overlay is
// open. The staff app (App.tsx) runs several background timers — most notably a
// 1-second clock tick that re-renders the entire (very large) App tree every
// second, plus assorted 15s data polls. While the studio overlay is up, those
// re-renders churn the main thread underneath it and make the teleprompter
// scroll pause then jump. The studio raises this flag on mount; the App timers
// check it and skip their work so the main thread stays free for smooth
// scrolling. It is a ref-count (not a boolean) so nested/overlapping mounts
// during React StrictMode double-invocation can't prematurely clear it.

let activeCount = 0;

export function beginStudioSession(): void {
  activeCount += 1;
}

export function endStudioSession(): void {
  activeCount = Math.max(0, activeCount - 1);
}

export function isStudioSessionActive(): boolean {
  return activeCount > 0;
}
