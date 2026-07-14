// Single pg Pool for the whole process. Every query module borrows a client from here and
// runs exactly one transaction per tool call — nothing is ever held open across a Telegram
// message or a model turn.

import { Pool, type PoolClient, types } from "pg";

// pg's default parsers turn timestamp/timestamptz columns into JS Date objects. Every tool
// execute() returns raw DB rows straight through as its result, which lands in the Gemini
// message history; the AI SDK's tool-output schema requires JSON-safe values, and a bare Date
// fails that validation the next time the history is replayed. Return ISO strings instead so
// every row is JSON-safe without having to sanitize each query function individually.
for (const oid of [1082, 1114, 1184]) {
  types.setTypeParser(oid, (val) => new Date(val).toISOString());
}

let pool: Pool | null = null;

export function initPool(databaseUrl: string): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: databaseUrl, max: 10 });
  }
  return pool;
}

export function getPool(): Pool {
  if (!pool) {
    throw new Error("DB pool not initialized — call initPool() at startup first");
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  });
}
