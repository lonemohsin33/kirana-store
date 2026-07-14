import type { PoolClient } from "pg";

const ALLOWED_COLUMNS = new Set([
  "default_payment_mode",
  "default_atta_product_id",
  "shop_name",
  "gstin",
  "shop_address",
  "shop_logo_file_id",
  "round_off_to_rupee",
]);

export async function getPreferences(client: PoolClient, telegramChatId: number) {
  const { rows } = await client.query("SELECT * FROM owner_preferences WHERE telegram_chat_id = $1", [telegramChatId]);
  if (rows.length > 0) return rows[0];
  const { rows: created } = await client.query(
    `INSERT INTO owner_preferences (telegram_chat_id)
     VALUES ($1)
     ON CONFLICT (telegram_chat_id) DO UPDATE SET telegram_chat_id = EXCLUDED.telegram_chat_id
     RETURNING *`,
    [telegramChatId]
  );
  return created[0];
}

export async function setPreference(client: PoolClient, telegramChatId: number, key: string, value: unknown) {
  await getPreferences(client, telegramChatId); // ensure a row exists
  if (ALLOWED_COLUMNS.has(key)) {
    const { rows } = await client.query(
      `UPDATE owner_preferences SET ${key} = $2, updated_at = now() WHERE telegram_chat_id = $1 RETURNING *`,
      [telegramChatId, value]
    );
    return rows[0];
  }
  const { rows } = await client.query(
    `UPDATE owner_preferences
     SET extra = jsonb_set(extra, $2, $3::jsonb, true), updated_at = now()
     WHERE telegram_chat_id = $1
     RETURNING *`,
    [telegramChatId, [key], JSON.stringify(value)]
  );
  return rows[0];
}
