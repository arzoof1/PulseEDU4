import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

function positiveIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return defaultValue;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export const pool = new Pool({
  connectionString: databaseUrl,
  max: positiveIntEnv("PG_POOL_MAX", 10),
  idleTimeoutMillis: positiveIntEnv("PG_IDLE_TIMEOUT_MS", 30_000),
  connectionTimeoutMillis: positiveIntEnv("PG_CONNECTION_TIMEOUT_MS", 5_000),
});
export const db = drizzle(pool, { schema });

export * from "./schema";
