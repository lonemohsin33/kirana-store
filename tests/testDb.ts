import { Client } from "pg";
import { initPool, closePool } from "../src/db/pool.ts";
import { runMigrations } from "../scripts/runMigrations.ts";

const BASE_DSN = process.env.TEST_DATABASE_URL ?? "postgresql://postgres:mohsin@localhost:5432/kirana_agent_ts_test";

/** Each test FILE gets its own DB (node:test runs files as separate processes, possibly
 * concurrently) — a shared DB name would race on DROP/CREATE between files. */
export async function setupTestDb(suffix: string): Promise<string> {
  const dsn = `${BASE_DSN}_${suffix}`;
  const adminDsn = dsn.replace(/\/[^/]+$/, "/postgres");
  const dbName = dsn.split("/").pop()!;
  const admin = new Client({ connectionString: adminDsn });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();

  await runMigrations(dsn);
  initPool(dsn);
  return dsn;
}

export async function teardownTestDb(): Promise<void> {
  await closePool();
}
