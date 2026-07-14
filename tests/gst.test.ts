import { test } from "node:test";
import assert from "node:assert/strict";
import Decimal from "decimal.js";
import { computeLineTax, computeBillTotals } from "../src/gst.ts";

test("tax-inclusive packaged line ties to MRP", () => {
  const line = computeLineTax({ unitPrice: "62.00", qty: "1", gstRate: "12", priceIsTaxInclusive: true });
  assert.equal(line.lineTotal.toFixed(2), "62.00");
  assert.equal(line.cgstAmount.plus(line.sgstAmount).toFixed(2), line.lineTotal.minus(line.taxableValue).toFixed(2));
  assert.equal(line.cgstAmount.toFixed(2), line.sgstAmount.toFixed(2));
});

test("loose zero-rate item has no tax", () => {
  const line = computeLineTax({ unitPrice: "45.00", qty: "2", gstRate: "0", priceIsTaxInclusive: false });
  assert.equal(line.taxableValue.toFixed(2), "90.00");
  assert.equal(line.cgstAmount.toFixed(2), "0.00");
  assert.equal(line.sgstAmount.toFixed(2), "0.00");
  assert.equal(line.lineTotal.toFixed(2), "90.00");
});

test("cgst + sgst always equals total tax, no paisa leakage", () => {
  const line = computeLineTax({ unitPrice: "14.00", qty: "3", gstRate: "12", priceIsTaxInclusive: true });
  const totalTax = line.lineTotal.minus(line.taxableValue);
  assert.equal(line.cgstAmount.plus(line.sgstAmount).toFixed(2), totalTax.toFixed(2));
});

test("bill totals sum from already-rounded lines and tie to line totals", () => {
  const lines = [
    computeLineTax({ unitPrice: "62.00", qty: "1", gstRate: "12", priceIsTaxInclusive: true }),
    computeLineTax({ unitPrice: "45.00", qty: "2", gstRate: "0", priceIsTaxInclusive: false }),
    computeLineTax({ unitPrice: "14.00", qty: "6", gstRate: "12", priceIsTaxInclusive: true }),
  ];
  const totals = computeBillTotals(lines);
  const sumLineTotals = lines.reduce((acc, l) => acc.plus(l.lineTotal), new Decimal(0));
  assert.equal(totals.grandTotal.toFixed(2), sumLineTotals.toFixed(2));
  assert.equal(
    totals.grandTotal.toFixed(2),
    totals.subtotal.plus(totals.totalCgst).plus(totals.totalSgst).toFixed(2)
  );
});

test("round-off-to-rupee adjusts grand total and reports the adjustment", () => {
  const lines = [computeLineTax({ unitPrice: "14.00", qty: "1", gstRate: "12", priceIsTaxInclusive: true })];
  const totals = computeBillTotals(lines, true);
  assert.equal(totals.grandTotal.toFixed(0), totals.grandTotal.toFixed(2).split(".")[0]);
  const raw = totals.subtotal.plus(totals.totalCgst).plus(totals.totalSgst);
  assert.equal(totals.grandTotal.minus(raw).toFixed(2), totals.roundOff.toFixed(2));
});

test("every supported GST slab round-trips to the same tax-inclusive total", () => {
  for (const rate of ["0", "5", "12", "18", "28"]) {
    const line = computeLineTax({ unitPrice: "100.00", qty: "1", gstRate: rate, priceIsTaxInclusive: true });
    assert.equal(line.lineTotal.toFixed(2), "100.00");
  }
});
