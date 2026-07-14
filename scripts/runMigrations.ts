// Apply any migration file in src/db/migrations not yet recorded in applied_migrations.
// Idempotent and safe to run on every process start (including after a Render restart): each
// file is applied inside its own transaction and recorded by filename so re-running this script
// is a no-op once a given migration has already landed.

import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "..", "src", "db", "migrations");

export async function runMigrations(databaseUrl: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      "CREATE TABLE IF NOT EXISTS applied_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"
    );
    const { rows } = await client.query("SELECT filename FROM applied_migrations");
    const alreadyApplied = new Set(rows.map((r) => r.filename));

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      if (alreadyApplied.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO applied_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING", [file]);
        await client.query("COMMIT");
        console.log(`applied migration: ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dsn = process.env.DATABASE_URL;
  if (!dsn) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  runMigrations(dsn).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
