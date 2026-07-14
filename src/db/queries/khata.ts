import type { PoolClient } from "pg";
import Decimal from "decimal.js";
import { withTransaction } from "../pool.ts";

export async function findCustomers(client: PoolClient, nameQuery: string, limit = 5) {
  const { rows } = await client.query(
    `SELECT * FROM customers
     WHERE name ILIKE '%' || $1 || '%' OR similarity(name, $1) > 0.3
     ORDER BY similarity(name, $1) DESC NULLS LAST, name
     LIMIT $2`,
    [nameQuery, limit]
  );
  return rows;
}

export async function getCustomer(client: PoolClient, customerId: number) {
  const { rows } = await client.query("SELECT * FROM customers WHERE id = $1", [customerId]);
  return rows[0] ?? null;
}

export async function createCustomer(client: PoolClient, params: { name: string; phone?: string | null }) {
  const { rows } = await client.query("INSERT INTO customers (name, phone) VALUES ($1, $2) RETURNING *", [
    params.name,
    params.phone ?? null,
  ]);
  return rows[0];
}

export async function putOnCredit(params: {
  customerId: number;
  amount: Decimal.Value;
  telegramChatId: number;
  telegramUpdateId: number | null;
  note?: string | null;
}) {
  return withTransaction(async (client) => {
    const { rows: custRows } = await client.query("SELECT * FROM customers WHERE id = $1 FOR UPDATE", [params.customerId]);
    if (custRows.length === 0) return { ok: false, error: "customer_not_found" };

    const amount = new Decimal(params.amount);
    const { rows: txnRows } = await client.query(
      `INSERT INTO khata_transactions (customer_id, type, amount, telegram_chat_id, telegram_update_id)
       VALUES ($1, 'credit_sale', $2, $3, $4)
       ON CONFLICT (telegram_update_id, customer_id, type, amount) DO NOTHING
       RETURNING *`,
      [params.customerId, amount.toString(), params.telegramChatId, params.telegramUpdateId]
    );
    if (txnRows.length === 0) {
      const { rows: freshRows } = await client.query("SELECT * FROM customers WHERE id = $1", [params.customerId]);
      return { ok: true, idempotentReplay: true, customer: freshRows[0] };
    }
    const { rows: updatedRows } = await client.query(
      "UPDATE customers SET balance = balance + $2 WHERE id = $1 RETURNING *",
      [params.customerId, amount.toString()]
    );
    return { ok: true, idempotentReplay: false, customer: updatedRows[0], transaction: txnRows[0] };
  });
}

/** Errors with customer_not_found rather than silently creating a customer — the literal
 * "no settling a nonexistent khata" guard. */
export async function recordPayment(params: {
  customerId: number;
  amount: Decimal.Value;
  paymentMode: string;
  paymentReference: string | null;
  telegramChatId: number;
  telegramUpdateId: number | null;
}) {
  return withTransaction(async (client) => {
    const { rows: custRows } = await client.query("SELECT * FROM customers WHERE id = $1 FOR UPDATE", [params.customerId]);
    if (custRows.length === 0) return { ok: false, error: "customer_not_found" };

    const amount = new Decimal(params.amount);
    const { rows: txnRows } = await client.query(
      `INSERT INTO khata_transactions (customer_id, type, amount, payment_mode, payment_reference, telegram_chat_id, telegram_update_id)
       VALUES ($1, 'payment', $2, $3, $4, $5, $6)
       ON CONFLICT (telegram_update_id, customer_id, type, amount) DO NOTHING
       RETURNING *`,
      [params.customerId, amount.toString(), params.paymentMode, params.paymentReference, params.telegramChatId, params.telegramUpdateId]
    );
    if (txnRows.length === 0) {
      const { rows: freshRows } = await client.query("SELECT * FROM customers WHERE id = $1", [params.customerId]);
      return { ok: true, idempotentReplay: true, customer: freshRows[0] };
    }
    const { rows: updatedRows } = await client.query(
      "UPDATE customers SET balance = balance - $2 WHERE id = $1 RETURNING *",
      [params.customerId, amount.toString()]
    );
    return { ok: true, idempotentReplay: false, customer: updatedRows[0], transaction: txnRows[0] };
  });
}

export async function getBalance(client: PoolClient, customerId: number) {
  const customer = await getCustomer(client, customerId);
  if (!customer) return null;
  const { rows: recent } = await client.query(
    "SELECT * FROM khata_transactions WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 10",
    [customerId]
  );
  return { customer, recentTransactions: recent };
}
