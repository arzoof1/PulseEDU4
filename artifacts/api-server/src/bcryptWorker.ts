import { parentPort } from "node:worker_threads";
import bcrypt from "bcryptjs";

type BcryptWorkerRequest =
  | { id: number; op: "hash"; password: string; saltOrRounds: number }
  | { id: number; op: "compare"; password: string; hash: string };

if (!parentPort) {
  throw new Error("bcrypt worker must be started as a worker thread");
}

parentPort.on("message", async (message: BcryptWorkerRequest) => {
  try {
    const result =
      message.op === "hash"
        ? await bcrypt.hash(message.password, message.saltOrRounds)
        : await bcrypt.compare(message.password, message.hash);
    parentPort?.postMessage({ id: message.id, result });
  } catch (err) {
    parentPort?.postMessage({
      id: message.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
