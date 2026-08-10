// Source-context bcrypt worker for UNBUNDLED runs (vitest / tsx).
//
// lib/bcrypt.ts spawns `new Worker(new URL("./bcryptWorker.mjs", import.meta.url))`.
// In the production build that URL resolves to the bundled dist/bcryptWorker.mjs
// (built from src/bcryptWorker.ts). When the code runs unbundled from source
// (integration tests), it resolves HERE instead — so integration tests that
// hash/compare passwords work without a prior build. This is a plain-ESM mirror
// of src/bcryptWorker.ts; the build never references it (see build.mjs
// entryPoints), so production is unaffected.
import { parentPort } from "node:worker_threads";
import bcrypt from "bcryptjs";

if (!parentPort) {
  throw new Error("bcrypt worker must be started as a worker thread");
}

parentPort.on("message", async (message) => {
  try {
    const result =
      message.op === "hash"
        ? await bcrypt.hash(message.password, message.saltOrRounds)
        : await bcrypt.compare(message.password, message.hash);
    parentPort.postMessage({ id: message.id, result });
  } catch (err) {
    parentPort.postMessage({
      id: message.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
