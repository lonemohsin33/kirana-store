// Real-DB tests for the concurrency and oversell-guard hard parts: two bills racing the same
// SKU, and a bill racing a concurrent stock-in, must never oversell or corrupt stock.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { withClient } from "../src/db/pool.ts";
import { addBillLine, finalizeBill, getOrCreateDraft } from "../src/db/queries/bills.ts";
import { createProduct, getProduct, receiveStock } from "../src/db/queries/products.ts";
import { setupTestDb, teardownTestDb } from "./testDb.ts";

before(() => setupTestDb("concurrency"));
after(teardownTestDb);

async function makeProduct(stockQty: string) {
  return withClient((c) =>
    createProduct(c, {
      skuName: "Test Maggi",
      unit: "packet",
      hsnCode: "1902",
      gstRate: "12",
      costPrice: "10.00",
      sellPrice: "14.00",
      initialQty: stockQty,
      reorderLevel: "5",
    })
  );
}

test("two concurrent bills never oversell", async () => {
  const product = await makeProduct("10");

  const sellSix = async (chatId: number) => {
    const bill = await withClient((c) => getOrCreateDraft(c, chatId, 1));
    await addBillLine({ billId: bill.id, productId: product.id, qty: "6" });
    return finalizeBill({
      billId: bill.id,
      telegramChatId: chatId,
      telegramUpdateId: chatId * 1000,
      paymentMode: "cash",
      paymentReference: null,
      confirmBelowCost: false,
      customerId: null,
    });
  };

  const [a, b] = await Promise.all([sellSix(101), sellSix(102)]);
  const results = [a, b];
  const successes = results.filter((r) => r.ok);
  const failures = results.filter((r) => !r.ok);

  assert.equal(successes.length, 1, "exactly one of the two 6-unit sales should succeed against 10 in stock");
  assert.equal(failures.length, 1);
  assert.equal((failures[0] as any).error, "insufficient_stock");

  const finalProduct = await withClient((c) => getProduct(c, product.id));
  assert.equal(finalProduct!.stock_qty, "4.000"); // 10 - 6, never negative, never double-sold
});

test("bill vs concurrent stock-in stays consistent", async () => {
  const product = await makeProduct("5");

  const sellFive = async () => {
    const bill = await withClient((c) => getOrCreateDraft(c, 201, 1));
    await addBillLine({ billId: bill.id, productId: product.id, qty: "5" });
    return finalizeBill({
      billId: bill.id,
      telegramChatId: 201,
      telegramUpdateId: 201000,
      paymentMode: "cash",
      paymentReference: null,
      confirmBelowCost: false,
      customerId: null,
    });
  };

  const receiveTen = () =>
    receiveStock({
      productId: product.id,
      qty: "10",
      costPrice: "10.00",
      mrp: null,
      telegramChatId: 202,
      telegramUpdateId: 202000,
    });

  const [saleResult, stockInResult] = await Promise.all([sellFive(), receiveTen()]);
  assert.equal(saleResult.ok, true);
  assert.equal(stockInResult.idempotentReplay, false);

  const finalProduct = await withClient((c) => getProduct(c, product.id));
  // Regardless of interleaving order, 5 (start) - 5 (sale) + 10 (stock-in) = 10, never negative.
  assert.equal(finalProduct!.stock_qty, "10.000");
});
