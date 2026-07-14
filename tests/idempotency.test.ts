// finalizeBill and receiveStock must be safe to replay with the same update_id — this is what
// makes a crash-then-redeliver of a Telegram update a no-op rather than a double sale.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { withClient } from "../src/db/pool.ts";
import { addBillLine, finalizeBill, getOrCreateDraft } from "../src/db/queries/bills.ts";
import { createProduct, getProduct, receiveStock } from "../src/db/queries/products.ts";
import { setupTestDb, teardownTestDb } from "./testDb.ts";

before(() => setupTestDb("idempotency"));
after(teardownTestDb);

test("finalize_bill retry is a no-op", async () => {
  const product = await withClient((c) =>
    createProduct(c, {
      skuName: "Test Atta",
      unit: "packet",
      hsnCode: "1101",
      gstRate: "5",
      costPrice: "230",
      sellPrice: "260",
      initialQty: "20",
      reorderLevel: "5",
    })
  );
  const bill = await withClient((c) => getOrCreateDraft(c, 301, 1));
  await addBillLine({ billId: bill.id, productId: product.id, qty: "2" });

  const finalizeOnce = () =>
    finalizeBill({
      billId: bill.id,
      telegramChatId: 301,
      telegramUpdateId: 301000,
      paymentMode: "upi",
      paymentReference: "UPI123",
      confirmBelowCost: false,
      customerId: null,
    });

  const first = await finalizeOnce();
  assert.equal(first.ok, true);
  assert.equal(first.idempotentReplay, false);

  const second = await finalizeOnce();
  assert.equal(second.ok, true);
  assert.equal(second.idempotentReplay, true);

  const finalProduct = await withClient((c) => getProduct(c, product.id));
  assert.equal(finalProduct!.stock_qty, "18.000"); // decremented exactly once, not twice
});

test("receive_stock retry with same update_id is absorbed", async () => {
  const product = await withClient((c) =>
    createProduct(c, {
      skuName: "Test Salt",
      unit: "packet",
      hsnCode: "2501",
      gstRate: "0",
      costPrice: "22",
      sellPrice: "28",
      initialQty: "0",
      reorderLevel: "5",
    })
  );

  const receiveOnce = () =>
    receiveStock({
      productId: product.id,
      qty: "50",
      costPrice: "22",
      mrp: null,
      telegramChatId: 401,
      telegramUpdateId: 401000,
    });

  const first = await receiveOnce();
  assert.equal(first.idempotentReplay, false);

  const second = await receiveOnce(); // simulates a redelivered Telegram update
  assert.equal(second.idempotentReplay, true);

  const finalProduct = await withClient((c) => getProduct(c, product.id));
  assert.equal(finalProduct!.stock_qty, "50.000"); // not 100
});
