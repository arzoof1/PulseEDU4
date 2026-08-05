import { defineConfig } from "drizzle-kit";
import path from "path";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  // Versioned migration files live here (DV-05). `generate` writes a new
  // timestamped SQL migration + updates meta/_journal.json; `migrate` applies
  // any un-applied files. See MIGRATIONS.md for the gated review/rollback SOP.
  out: path.join(__dirname, "./migrations"),
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
