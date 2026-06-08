import os from "node:os";
import { Worker } from "node:worker_threads";

type BcryptWorkerRequest =
  | { id: number; op: "hash"; password: string; saltOrRounds: number }
  | { id: number; op: "compare"; password: string; hash: string };
type BcryptWorkerRequestInput =
  | { op: "hash"; password: string; saltOrRounds: number }
  | { op: "compare"; password: string; hash: string };

type BcryptWorkerResponse =
  | { id: number; result: string | boolean; error?: never }
  | { id: number; result?: never; error: string };

type QueuedJob<T extends string | boolean> = {
  message: BcryptWorkerRequest;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
};

type WorkerSlot = {
  worker: Worker;
  current: QueuedJob<string | boolean> | null;
};

function positiveIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return defaultValue;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function defaultWorkerCount(): number {
  const available =
    typeof os.availableParallelism === "function"
      ? os.availableParallelism()
      : os.cpus().length;
  return Math.max(1, Math.min(4, available - 1));
}

class BcryptWorkerPool {
  private readonly queue: QueuedJob<string | boolean>[] = [];
  private readonly slots: WorkerSlot[] = [];
  private nextId = 1;

  constructor(size: number) {
    for (let i = 0; i < size; i++) {
      this.slots.push(this.createSlot());
    }
  }

  run<T extends string | boolean>(
    message: BcryptWorkerRequestInput,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        message: { ...message, id: this.nextId++ } as BcryptWorkerRequest,
        resolve: resolve as (value: string | boolean) => void,
        reject,
      });
      this.dispatch();
    });
  }

  private createSlot(): WorkerSlot {
    const slot: WorkerSlot = {
      worker: new Worker(new URL("./bcryptWorker.mjs", import.meta.url)),
      current: null,
    };

    slot.worker.on("message", (response: BcryptWorkerResponse) => {
      const job = slot.current;
      if (!job || job.message.id !== response.id) return;
      slot.current = null;

      if ("error" in response) {
        job.reject(new Error(response.error));
      } else {
        job.resolve(response.result);
      }
      this.dispatch();
    });

    slot.worker.on("error", (err) => {
      const job = slot.current;
      slot.current = null;
      if (job) job.reject(err instanceof Error ? err : new Error(String(err)));
    });

    slot.worker.on("exit", (code) => {
      const index = this.slots.indexOf(slot);
      if (index >= 0) {
        this.slots.splice(index, 1);
      }
      const job = slot.current;
      slot.current = null;
      if (job) {
        job.reject(new Error(`bcrypt worker exited with code ${code}`));
      }
      this.slots.push(this.createSlot());
      this.dispatch();
    });

    return slot;
  }

  private dispatch(): void {
    for (const slot of this.slots) {
      if (slot.current || this.queue.length === 0) continue;
      const job = this.queue.shift();
      if (!job) continue;
      slot.current = job;
      slot.worker.postMessage(job.message);
    }
  }
}

const pool = new BcryptWorkerPool(
  positiveIntEnv("BCRYPT_WORKER_POOL_SIZE", defaultWorkerCount()),
);

export function bcryptHash(
  password: string,
  saltOrRounds = 10,
): Promise<string> {
  return pool.run<string>({ op: "hash", password, saltOrRounds });
}

export function bcryptCompare(
  password: string,
  hash: string,
): Promise<boolean> {
  return pool.run<boolean>({ op: "compare", password, hash });
}
