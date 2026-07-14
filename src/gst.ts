// Pure GST/rounding math. No DB, no I/O — every invoice and daily-close total depends on this
// being exhaustively unit-tested in isolation from anything else in the system.

import Decimal from "decimal.js";

Decimal.set({ rounding: Decimal.ROUND_HALF_UP });

function round2(value: Decimal): Decimal {
  return value.toDecimalPlaces(2);
}

export interface LineTax {
  taxableValue: Decimal;
  cgstAmount: Decimal;
  sgstAmount: Decimal;
  lineTotal: Decimal;
}

/**
 * Compute one bill line's taxable value and CGST/SGST split.
 *
 * Packaged-goods MRP in India is tax-inclusive by law — the GST is already inside the printed
 * price, not added on top. Loose goods are quoted tax-exclusive (they have no MRP concept).
 * `priceIsTaxInclusive` selects the branch.
 *
 * Rounding convention: round this LINE's tax to 2dp here; bill headers sum already-rounded
 * lines rather than rounding a header total independently (that's what causes an invoice whose
 * displayed total doesn't tie to its own line-by-line breakup).
 */
export function computeLineTax(params: {
  unitPrice: Decimal.Value;
  qty: Decimal.Value;
  gstRate: Decimal.Value;
  priceIsTaxInclusive: boolean;
}): LineTax {
  const unitPrice = new Decimal(params.unitPrice);
  const qty = new Decimal(params.qty);
  const gstRate = new Decimal(params.gstRate);

  const taxableValuePerUnit = params.priceIsTaxInclusive
    ? unitPrice.div(gstRate.div(100).plus(1))
    : unitPrice;

  const taxableValue = round2(taxableValuePerUnit.times(qty));
  const totalTax = round2(taxableValue.times(gstRate).div(100));
  const cgstAmount = round2(totalTax.div(2));
  // Remainder (not a second independent rounding) to SGST — guarantees cgst + sgst == totalTax
  // exactly, with no paisa left unaccounted for by rounding both halves separately.
  const sgstAmount = totalTax.minus(cgstAmount);

  const lineTotal = params.priceIsTaxInclusive
    ? round2(unitPrice.times(qty))
    : taxableValue.plus(totalTax);

  return { taxableValue, cgstAmount, sgstAmount, lineTotal };
}

export interface BillTotals {
  subtotal: Decimal;
  totalCgst: Decimal;
  totalSgst: Decimal;
  grandTotal: Decimal;
  roundOff: Decimal;
}

export function computeBillTotals(lines: LineTax[], roundOffToRupee = false): BillTotals {
  const subtotal = lines.reduce((acc, l) => acc.plus(l.taxableValue), new Decimal(0));
  const totalCgst = lines.reduce((acc, l) => acc.plus(l.cgstAmount), new Decimal(0));
  const totalSgst = lines.reduce((acc, l) => acc.plus(l.sgstAmount), new Decimal(0));
  const rawTotal = subtotal.plus(totalCgst).plus(totalSgst);

  let roundOff = new Decimal(0);
  let grandTotal = rawTotal;
  if (roundOffToRupee) {
    const rounded = rawTotal.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    roundOff = rounded.minus(rawTotal);
    grandTotal = rounded;
  }

  return {
    subtotal: round2(subtotal),
    totalCgst: round2(totalCgst),
    totalSgst: round2(totalSgst),
    grandTotal: round2(grandTotal),
    roundOff: round2(roundOff),
  };
}
