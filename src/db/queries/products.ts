// Product/inventory queries. Every function takes an already-connected pg client so the caller
// (a tool function) controls the transaction boundary.

import type { PoolClient } from "pg";
import Decimal from "decimal.js";
import { withTransaction } from "../pool.ts";

export async function searchProducts(client: PoolClient, query: string, limit = 8) {
  const { rows } = await client.query(
    `SELECT id, sku_name, brand, unit, is_loose, hsn_code, gst_rate, price_is_tax_inclusive,
            cost_price, sell_price, stock_qty, reorder_level,
            similarity(sku_name, $1) AS name_sim
     FROM products
     WHERE is_active
       AND (
             sku_name ILIKE '%' || $1 || '%'
          OR brand ILIKE '%' || $1 || '%'
          OR $1 ILIKE ANY (search_aliases)
          OR EXISTS (SELECT 1 FROM unnest(search_aliases) a WHERE $1 ILIKE '%' || a || '%')
          OR similarity(sku_name, $1) > 0.25
       )
     ORDER BY name_sim DESC NULLS LAST, sku_name
     LIMIT $2`,
    [query, limit]
  );
  return rows;
}

export async function getProduct(client: PoolClient, productId: number) {
  const { rows } = await client.query("SELECT * FROM products WHERE id = $1 AND is_active", [productId]);
  return rows[0] ?? null;
}

/** Locks the row. Must only be called inside an already-open transaction. */
export async function getProductForUpdate(client: PoolClient, productId: number) {
  const { rows } = await client.query("SELECT * FROM products WHERE id = $1 FOR UPDATE", [productId]);
  return rows[0] ?? null;
}

/** Locks all given product rows in one query, ordered by id — the deterministic lock order that
 * prevents deadlocks between two bills finalizing concurrently over overlapping SKUs. */
export async function lockProductsOrdered(client: PoolClient, productIds: number[]) {
  if (productIds.length === 0) return new Map<number, any>();
  const { rows } = await client.query(
    "SELECT * FROM products WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE",
    [productIds]
  );
  return new Map(rows.map((r) => [r.id, r]));
}

export async function createProduct(
  client: PoolClient,
  params: {
    skuName: string;
    unit: string;
    hsnCode: string;
    gstRate: Decimal.Value;
    costPrice: Decimal.Value;
    sellPrice: Decimal.Value;
    priceIsTaxInclusive?: boolean;
    isLoose?: boolean;
    brand?: string | null;
    initialQty?: Decimal.Value;
    reorderLevel?: Decimal.Value;
    searchAliases?: string[];
  }
) {
  const { rows } = await client.query(
    `INSERT INTO products
       (sku_name, brand, unit, is_loose, hsn_code, gst_rate, price_is_tax_inclusive,
        cost_price, sell_price, stock_qty, reorder_level, search_aliases)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      params.skuName,
      params.brand ?? null,
      params.unit,
      params.isLoose ?? false,
      params.hsnCode,
      params.gstRate.toString(),
      params.priceIsTaxInclusive ?? true,
      params.costPrice.toString(),
      params.sellPrice.toString(),
      (params.initialQty ?? 0).toString(),
      (params.reorderLevel ?? 0).toString(),
      params.searchAliases ?? [],
    ]
  );
  return rows[0];
}

export async function updateProductPrice(
  client: PoolClient,
  productId: number,
  params: { newSellPrice?: Decimal.Value | null; newCostPrice?: Decimal.Value | null; newGstRate?: Decimal.Value | null }
) {
  const { rows } = await client.query(
    `UPDATE products
     SET sell_price = COALESCE($2, sell_price),
         cost_price = COALESCE($3, cost_price),
         gst_rate   = COALESCE($4, gst_rate),
         updated_at = now()
     WHERE id = $1 AND is_active
     RETURNING *`,
    [
      productId,
      params.newSellPrice != null ? params.newSellPrice.toString() : null,
      params.newCostPrice != null ? params.newCostPrice.toString() : null,
      params.newGstRate != null ? params.newGstRate.toString() : null,
    ]
  );
  return rows[0] ?? null;
}

export async function insertStockLedger(
  client: PoolClient,
  params: {
    productId: number;
    changeQty: Decimal.Value;
    reason: "stock_in" | "sale" | "adjustment" | "void_reversal";
    resultingQty: Decimal.Value;
    referenceType?: string | null;
    referenceId?: number | null;
    telegramChatId?: number | null;
  }
) {
  await client.query(
    `INSERT INTO stock_ledger
       (product_id, change_qty, reason, reference_type, reference_id, resulting_qty, telegram_chat_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      params.productId,
      params.changeQty.toString(),
      params.reason,
      params.referenceType ?? null,
      params.referenceId ?? null,
      params.resultingQty.toString(),
      params.telegramChatId ?? null,
    ]
  );
}

/** Row-locked stock-in. Idempotent: a byte-identical replayed call (same update_id, product,
 * qty, cost_price) is silently absorbed via the stock_in_events unique constraint. */
export async function receiveStock(params: {
  productId: number;
  qty: Decimal.Value;
  costPrice: Decimal.Value;
  mrp: Decimal.Value | null;
  telegramChatId: number;
  telegramUpdateId: number | null;
}) {
  return withTransaction(async (client) => {
    const qty = new Decimal(params.qty);
    const costPrice = new Decimal(params.costPrice);

    const existing = await client.query(
      `SELECT id FROM stock_in_events
       WHERE telegram_update_id = $1 AND product_id = $2 AND qty = $3 AND cost_price = $4`,
      [params.telegramUpdateId, params.productId, qty.toString(), costPrice.toString()]
    );
    if (existing.rows.length > 0) {
      const product = await getProduct(client, params.productId);
      return { idempotentReplay: true, product };
    }

    const product = await getProductForUpdate(client, params.productId);
    if (!product) throw new Error(`product ${params.productId} not found`);

    const newQty = new Decimal(product.stock_qty).plus(qty);
    const mrp = params.mrp != null ? new Decimal(params.mrp) : null;
    const updated = await client.query(
      `UPDATE products
       SET stock_qty = $2, cost_price = $3, sell_price = COALESCE($4, sell_price), updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [params.productId, newQty.toString(), costPrice.toString(), mrp?.toString() ?? null]
    );
    const event = await client.query(
      `INSERT INTO stock_in_events (product_id, qty, cost_price, mrp, telegram_chat_id, telegram_update_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id`,
      [params.productId, qty.toString(), costPrice.toString(), mrp?.toString() ?? null, params.telegramChatId, params.telegramUpdateId]
    );
    await insertStockLedger(client, {
      productId: params.productId,
      changeQty: qty,
      reason: "stock_in",
      resultingQty: newQty,
      referenceType: "stock_in_event",
      referenceId: event.rows[0].id,
      telegramChatId: params.telegramChatId,
    });
    return { idempotentReplay: false, product: updated.rows[0] };
  });
}

export async function adjustStock(params: {
  productId: number;
  deltaQty: Decimal.Value;
  reasonNote: string;
  telegramChatId: number;
}) {
  return withTransaction(async (client) => {
    const product = await getProductForUpdate(client, params.productId);
    if (!product) throw new Error(`product ${params.productId} not found`);
    const deltaQty = new Decimal(params.deltaQty);
    const newQty = new Decimal(product.stock_qty).plus(deltaQty);
    if (newQty.isNegative()) {
      return { ok: false, error: "would_go_negative", currentQty: product.stock_qty, requestedDelta: deltaQty.toString() };
    }
    const updated = await client.query(
      "UPDATE products SET stock_qty = $2, updated_at = now() WHERE id = $1 RETURNING *",
      [params.productId, newQty.toString()]
    );
    await insertStockLedger(client, {
      productId: params.productId,
      changeQty: deltaQty,
      reason: "adjustment",
      resultingQty: newQty,
      referenceType: "manual",
      telegramChatId: params.telegramChatId,
    });
    return { ok: true, product: updated.rows[0], note: params.reasonNote };
  });
}

export async function listLowStock(client: PoolClient) {
  const { rows } = await client.query(
    "SELECT * FROM products WHERE is_active AND stock_qty <= reorder_level ORDER BY stock_qty ASC"
  );
  return rows;
}

/** Stretch goal: days-of-stock-left from recent sales velocity, folded together with a pure
 * reorder-level breach (which is always flagged regardless of velocity data). */
export async function getReorderSuggestions(client: PoolClient, lookbackDays = 14) {
  const { rows } = await client.query(
    `WITH velocity AS (
       SELECT bli.product_id, SUM(bli.qty) / $1::numeric AS avg_daily_qty
       FROM bill_line_items bli
       JOIN bills b ON b.id = bli.bill_id
       WHERE b.status = 'finalized' AND b.finalized_at >= now() - make_interval(days => $2)
       GROUP BY bli.product_id
     )
     SELECT p.id, p.sku_name, p.stock_qty, p.reorder_level,
            v.avg_daily_qty,
            CASE WHEN v.avg_daily_qty IS NULL OR v.avg_daily_qty = 0 THEN NULL
                 ELSE p.stock_qty / v.avg_daily_qty END AS days_of_stock_left
     FROM products p
     LEFT JOIN velocity v ON v.product_id = p.id
     WHERE p.is_active AND (p.stock_qty <= p.reorder_level OR v.avg_daily_qty IS NOT NULL)
     ORDER BY days_of_stock_left ASC NULLS LAST`,
    [lookbackDays, lookbackDays]
  );
  return rows;
}
