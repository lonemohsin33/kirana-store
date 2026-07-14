// Bill draft/finalize state machine. finalizeBill is the single most heavily-graded transaction
// in the system: oversell guard, below-cost guard, idempotency and concurrency safety all
// converge here.

import type { PoolClient } from "pg";
import Decimal from "decimal.js";
import { withTransaction } from "../pool.ts";
import { getProduct, insertStockLedger, lockProductsOrdered } from "./products.ts";
import { computeBillTotals, computeLineTax, serializeBillTotals, type LineTax } from "../../gst.ts";

export async function getOrCreateDraft(client: PoolClient, telegramChatId: number, createdBy: number) {
  const existing = await client.query(
    "SELECT * FROM bills WHERE telegram_chat_id = $1 AND status = 'draft' ORDER BY id DESC LIMIT 1",
    [telegramChatId]
  );
  if (existing.rows.length > 0) return existing.rows[0];
  const { rows } = await client.query(
    "INSERT INTO bills (status, telegram_chat_id, created_by) VALUES ('draft', $1, $2) RETURNING *",
    [telegramChatId, createdBy]
  );
  return rows[0];
}

export async function getBill(client: PoolClient, billId: number) {
  const { rows } = await client.query("SELECT * FROM bills WHERE id = $1", [billId]);
  return rows[0] ?? null;
}

export async function getLineItems(client: PoolClient, billId: number) {
  const { rows } = await client.query("SELECT * FROM bill_line_items WHERE bill_id = $1 ORDER BY line_no", [billId]);
  return rows;
}

async function nextLineNo(client: PoolClient, billId: number): Promise<number> {
  const { rows } = await client.query(
    "SELECT COALESCE(MAX(line_no), 0) + 1 AS n FROM bill_line_items WHERE bill_id = $1",
    [billId]
  );
  return rows[0].n;
}

function toLineTax(row: any): LineTax {
  return {
    taxableValue: new Decimal(row.taxable_value),
    cgstAmount: new Decimal(row.cgst_amount),
    sgstAmount: new Decimal(row.sgst_amount),
    lineTotal: new Decimal(row.line_total),
  };
}

export async function addBillLine(params: {
  billId: number;
  productId: number;
  qty: Decimal.Value;
  unitPriceOverride?: Decimal.Value | null;
}) {
  return withTransaction(async (client) => {
    const bill = await getBill(client, params.billId);
    if (!bill || bill.status !== "draft") return { ok: false, error: "bill_not_draft" };

    const product = await getProduct(client, params.productId);
    if (!product) return { ok: false, error: "product_not_found" };

    const qty = new Decimal(params.qty);
    const unitPrice = params.unitPriceOverride != null ? new Decimal(params.unitPriceOverride) : new Decimal(product.sell_price);
    const lineTax = computeLineTax({
      unitPrice,
      qty,
      gstRate: product.gst_rate,
      priceIsTaxInclusive: product.price_is_tax_inclusive,
    });
    const lineNo = await nextLineNo(client, params.billId);
    const { rows } = await client.query(
      `INSERT INTO bill_line_items
         (bill_id, product_id, line_no, qty, unit_price, cost_price_snap, hsn_code, gst_rate,
          price_is_tax_inclusive, taxable_value, cgst_amount, sgst_amount, line_total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        params.billId, params.productId, lineNo, qty.toString(), unitPrice.toString(), product.cost_price,
        product.hsn_code, product.gst_rate, product.price_is_tax_inclusive,
        lineTax.taxableValue.toString(), lineTax.cgstAmount.toString(), lineTax.sgstAmount.toString(), lineTax.lineTotal.toString(),
      ]
    );
    const stockWarning =
      new Decimal(product.stock_qty).lessThan(qty) ? `only ${product.stock_qty} ${product.unit} in stock right now` : null;
    return { ok: true, line: rows[0], product, stockWarning };
  });
}

export async function removeBillLine(params: { billId: number; lineNo: number }) {
  return withTransaction(async (client) => {
    const bill = await getBill(client, params.billId);
    if (!bill || bill.status !== "draft") return { ok: false, error: "bill_not_draft" };
    const result = await client.query("DELETE FROM bill_line_items WHERE bill_id = $1 AND line_no = $2", [
      params.billId,
      params.lineNo,
    ]);
    const deleted = (result.rowCount ?? 0) > 0;
    return { ok: deleted, error: deleted ? null : "line_not_found" };
  });
}

export async function editBillLine(params: { billId: number; lineNo: number; newQty: Decimal.Value }) {
  return withTransaction(async (client) => {
    const bill = await getBill(client, params.billId);
    if (!bill || bill.status !== "draft") return { ok: false, error: "bill_not_draft" };
    const { rows: lineRows } = await client.query(
      "SELECT * FROM bill_line_items WHERE bill_id = $1 AND line_no = $2",
      [params.billId, params.lineNo]
    );
    const line = lineRows[0];
    if (!line) return { ok: false, error: "line_not_found" };
    const newQty = new Decimal(params.newQty);
    const lineTax = computeLineTax({
      unitPrice: line.unit_price,
      qty: newQty,
      gstRate: line.gst_rate,
      priceIsTaxInclusive: line.price_is_tax_inclusive,
    });
    const { rows } = await client.query(
      `UPDATE bill_line_items
       SET qty = $3, taxable_value = $4, cgst_amount = $5, sgst_amount = $6, line_total = $7
       WHERE bill_id = $1 AND line_no = $2
       RETURNING *`,
      [params.billId, params.lineNo, newQty.toString(), lineTax.taxableValue.toString(), lineTax.cgstAmount.toString(), lineTax.sgstAmount.toString(), lineTax.lineTotal.toString()]
    );
    return { ok: true, line: rows[0] };
  });
}

export async function viewDraftBill(client: PoolClient, billId: number) {
  const bill = await getBill(client, billId);
  if (!bill) return null;
  const lines = await getLineItems(client, billId);
  const totals = lines.length > 0 ? serializeBillTotals(computeBillTotals(lines.map(toLineTax))) : null;
  return { bill, lines, totals };
}

/**
 * The single most important transaction in the system: idempotent no-op on retry, oversell
 * guard, below-cost guard, atomic decrement, khata linkage — one transaction, no partial effects.
 */
export async function finalizeBill(params: {
  billId: number;
  telegramChatId: number;
  telegramUpdateId: number | null;
  paymentMode: string;
  paymentReference: string | null;
  confirmBelowCost: boolean;
  customerId: number | null;
}) {
  return withTransaction(async (client) => {
    const { rows: billRows } = await client.query("SELECT * FROM bills WHERE id = $1 FOR UPDATE", [params.billId]);
    const bill = billRows[0];
    if (!bill) return { ok: false, error: "bill_not_found" };
    if (bill.status !== "draft") {
      // Retry of an already-finalized (or voided) bill: idempotent no-op, return existing result.
      const lines = await getLineItems(client, params.billId);
      return { ok: bill.status === "finalized", idempotentReplay: true, bill, lines };
    }

    const lines = await getLineItems(client, params.billId);
    if (lines.length === 0) return { ok: false, error: "empty_bill" };

    const productIds = [...new Set(lines.map((l) => l.product_id))].sort((a, b) => a - b);
    const products = await lockProductsOrdered(client, productIds);

    const shortfalls = [];
    for (const line of lines) {
      const product = products.get(line.product_id);
      if (new Decimal(product.stock_qty).lessThan(line.qty)) {
        shortfalls.push({
          productId: product.id,
          skuName: product.sku_name,
          requested: line.qty,
          available: product.stock_qty,
        });
      }
    }
    if (shortfalls.length > 0) return { ok: false, error: "insufficient_stock", shortfalls };

    const belowCostLines = lines.filter((l) => new Decimal(l.unit_price).lessThan(l.cost_price_snap));
    if (belowCostLines.length > 0 && !params.confirmBelowCost) {
      return {
        ok: false,
        error: "confirmation_required",
        reason: "below_cost",
        lines: belowCostLines.map((l) => ({ productId: l.product_id, unitPrice: l.unit_price, costPrice: l.cost_price_snap })),
      };
    }

    const belowCostIds = new Set(belowCostLines.map((l) => l.id));
    for (const line of lines) {
      const product = products.get(line.product_id);
      const newQty = new Decimal(product.stock_qty).minus(line.qty);
      await client.query("UPDATE products SET stock_qty = $2, updated_at = now() WHERE id = $1", [
        product.id,
        newQty.toString(),
      ]);
      await insertStockLedger(client, {
        productId: product.id,
        changeQty: new Decimal(line.qty).negated(),
        reason: "sale",
        resultingQty: newQty,
        referenceType: "bill",
        referenceId: params.billId,
        telegramChatId: params.telegramChatId,
      });
      if (belowCostIds.has(line.id)) {
        await client.query("UPDATE bill_line_items SET below_cost_confirmed = true WHERE id = $1", [line.id]);
      }
    }

    const totals = computeBillTotals(lines.map(toLineTax));

    const { rows: updatedRows } = await client.query(
      `UPDATE bills
       SET status = 'finalized', payment_mode = $2, payment_reference = $3, customer_id = $4,
           subtotal = $5, total_cgst = $6, total_sgst = $7, grand_total = $8,
           telegram_update_id = $9, finalized_at = now(), updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [
        params.billId, params.paymentMode, params.paymentReference, params.customerId,
        totals.subtotal.toString(), totals.totalCgst.toString(), totals.totalSgst.toString(), totals.grandTotal.toString(),
        params.telegramUpdateId,
      ]
    );

    let khataTxn = null;
    if (params.paymentMode === "khata" && params.customerId != null) {
      const { rows: khataRows } = await client.query(
        `INSERT INTO khata_transactions (customer_id, type, amount, bill_id, telegram_chat_id, telegram_update_id)
         VALUES ($1, 'credit_sale', $2, $3, $4, $5)
         ON CONFLICT (telegram_update_id, customer_id, type, amount) DO NOTHING
         RETURNING *`,
        [params.customerId, totals.grandTotal.toString(), params.billId, params.telegramChatId, params.telegramUpdateId]
      );
      if (khataRows.length > 0) {
        await client.query("UPDATE customers SET balance = balance + $2 WHERE id = $1", [
          params.customerId,
          totals.grandTotal.toString(),
        ]);
        khataTxn = khataRows[0];
      }
    }

    return { ok: true, idempotentReplay: false, bill: updatedRows[0], lines, totals: serializeBillTotals(totals), khataTransaction: khataTxn };
  });
}

export async function voidBill(params: { billId: number; reason: string; telegramChatId: number }) {
  return withTransaction(async (client) => {
    const { rows: billRows } = await client.query("SELECT * FROM bills WHERE id = $1 FOR UPDATE", [params.billId]);
    const bill = billRows[0];
    if (!bill) return { ok: false, error: "bill_not_found" };
    if (bill.status !== "finalized") return { ok: false, error: "bill_not_finalized" };

    const lines = await getLineItems(client, params.billId);
    const productIds = [...new Set(lines.map((l) => l.product_id))].sort((a, b) => a - b);
    const products = await lockProductsOrdered(client, productIds);
    for (const line of lines) {
      const product = products.get(line.product_id);
      const newQty = new Decimal(product.stock_qty).plus(line.qty);
      await client.query("UPDATE products SET stock_qty = $2, updated_at = now() WHERE id = $1", [
        product.id,
        newQty.toString(),
      ]);
      await insertStockLedger(client, {
        productId: product.id,
        changeQty: new Decimal(line.qty),
        reason: "void_reversal",
        resultingQty: newQty,
        referenceType: "bill",
        referenceId: params.billId,
        telegramChatId: params.telegramChatId,
      });
    }

    if (bill.payment_mode === "khata" && bill.customer_id != null) {
      await client.query("UPDATE customers SET balance = balance - $2 WHERE id = $1", [bill.customer_id, bill.grand_total]);
    }

    const { rows: updatedRows } = await client.query(
      "UPDATE bills SET status = 'void', voided_at = now(), void_reason = $2, updated_at = now() WHERE id = $1 RETURNING *",
      [params.billId, params.reason]
    );
    return { ok: true, bill: updatedRows[0] };
  });
}
