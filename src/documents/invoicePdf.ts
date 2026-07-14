// GST invoice PDF generation. Pure function of DB state: a billId (and optional pre-fetched
// logo bytes) in, a file path out. Never accepts model-provided numbers — only an id to look up.
// Reads only a FINALIZED bill; errors otherwise, since an invoice for a draft makes no sense.

import PDFDocument from "pdfkit";
import { createWriteStream } from "node:fs";
import { withClient } from "../db/pool.ts";
import { getBill, getLineItems } from "../db/queries/bills.ts";
import { getCustomer } from "../db/queries/khata.ts";
import { getPreferences } from "../db/queries/preferences.ts";

export class BillNotFinalizedError extends Error {}

const OUT_DIR = "/tmp";

export async function generateInvoicePdf(billId: number, logoBytes?: Buffer | null): Promise<string> {
  const { bill, lineRows, customer, prefs } = await withClient(async (client) => {
    const bill = await getBill(client, billId);
    if (!bill) throw new Error(`bill ${billId} not found`);
    if (bill.status !== "finalized") throw new BillNotFinalizedError(`bill ${billId} is not finalized (status=${bill.status})`);

    const lines = await getLineItems(client, billId);
    const { rows: lineRows } = await client.query(
      `SELECT bli.*, p.sku_name FROM bill_line_items bli
       JOIN products p ON p.id = bli.product_id
       WHERE bli.bill_id = $1 ORDER BY bli.line_no`,
      [billId]
    );
    const customer = bill.customer_id ? await getCustomer(client, bill.customer_id) : null;
    const prefs = await getPreferences(client, bill.telegram_chat_id);
    return { bill, lines, lineRows, customer, prefs };
  });

  const path = `${OUT_DIR}/invoice_${billId}.pdf`;
  await render(path, { bill, lineRows, customer, prefs, logoBytes });
  return path;
}

function money(v: string | number): string {
  return Number(v).toFixed(2);
}

async function render(
  path: string,
  params: { bill: any; lineRows: any[]; customer: any | null; prefs: any; logoBytes?: Buffer | null }
): Promise<void> {
  const { bill, lineRows, customer, prefs, logoBytes } = params;
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const stream = createWriteStream(path);
  doc.pipe(stream);

  const shopName = prefs.shop_name || "Kirana Store";
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  if (logoBytes) {
    try {
      doc.image(logoBytes, doc.page.margins.left, doc.y, { width: 60, height: 60 });
    } catch {
      // Corrupt/unsupported image bytes — skip the logo rather than fail the whole invoice.
    }
  }

  const leftX = doc.page.margins.left;

  doc.fontSize(18).font("Helvetica-Bold").text(shopName, leftX, doc.y, { width: pageWidth, align: "center" });
  const addressBits = [prefs.shop_address, prefs.gstin ? `GSTIN: ${prefs.gstin}` : null].filter(Boolean);
  if (addressBits.length > 0) {
    doc.fontSize(9).font("Helvetica").text(addressBits.join(" | "), leftX, doc.y, { width: pageWidth, align: "center" });
  }
  let y = doc.y + 14;
  doc.fontSize(14).font("Helvetica-Bold").text("TAX INVOICE", leftX, y, { width: pageWidth, align: "center" });
  y += 24;

  doc.fontSize(9).font("Helvetica");
  doc.text(`Invoice No.: INV-${bill.id}`, leftX, y, { width: 250 });
  doc.text(`Date: ${bill.finalized_at ? new Date(bill.finalized_at).toISOString().slice(0, 10) : ""}`, leftX + 300, y, { width: 195 });
  y += 14;
  doc.text(`Payment Mode: ${(bill.payment_mode || "").toUpperCase()}`, leftX, y, { width: 250 });
  doc.text(`Reference: ${bill.payment_reference || "-"}`, leftX + 300, y, { width: 195 });
  y += 14;
  if (customer) {
    doc.text(`Customer: ${customer.name}`, leftX, y, { width: 250 });
    doc.text(`Phone: ${customer.phone || "-"}`, leftX + 300, y, { width: 195 });
    y += 14;
  }
  y += 16;

  // Column widths sum to <= pageWidth (A4 with 50pt margins ~= 495pt available).
  const cols = [
    { label: "#", width: 20 },
    { label: "Item", width: 120 },
    { label: "HSN", width: 45 },
    { label: "Qty", width: 40 },
    { label: "Unit Price", width: 55 },
    { label: "Taxable Val.", width: 60 },
    { label: "CGST", width: 45 },
    { label: "SGST", width: 45 },
    { label: "Line Total", width: 55 },
  ];

  const drawRow = (values: string[], rowY: number, opts: { header?: boolean } = {}) => {
    let x = leftX;
    doc.font(opts.header ? "Helvetica-Bold" : "Helvetica").fontSize(8);
    for (let i = 0; i < cols.length; i++) {
      doc.text(values[i], x, rowY, { width: cols[i].width, align: i === 1 ? "left" : "right" });
      x += cols[i].width;
    }
  };

  drawRow(cols.map((c) => c.label), y, { header: true });
  y += 14;
  doc.moveTo(leftX, y - 2).lineTo(leftX + pageWidth, y - 2).stroke();

  for (const line of lineRows) {
    drawRow(
      [
        String(line.line_no),
        line.sku_name,
        line.hsn_code,
        String(line.qty),
        money(line.unit_price),
        money(line.taxable_value),
        money(line.cgst_amount),
        money(line.sgst_amount),
        money(line.line_total),
      ],
      y
    );
    y += 16;
  }
  y += 4;
  doc.moveTo(leftX, y).lineTo(leftX + pageWidth, y).stroke();
  y += 20;

  // Tax summary by slab
  const slabTotals = new Map<string, { taxable: number; cgst: number; sgst: number }>();
  for (const line of lineRows) {
    const key = String(Number(line.gst_rate));
    const cur = slabTotals.get(key) ?? { taxable: 0, cgst: 0, sgst: 0 };
    cur.taxable += Number(line.taxable_value);
    cur.cgst += Number(line.cgst_amount);
    cur.sgst += Number(line.sgst_amount);
    slabTotals.set(key, cur);
  }
  doc.font("Helvetica-Bold").fontSize(10).text("Tax Summary by Slab", leftX, y, { width: pageWidth });
  y += 16;
  const slabCols = [
    { label: "GST Slab", width: 80 },
    { label: "Taxable Value", width: 100 },
    { label: "CGST", width: 80 },
    { label: "SGST", width: 80 },
  ];
  let sx = leftX;
  doc.font("Helvetica-Bold").fontSize(8);
  for (const c of slabCols) {
    doc.text(c.label, sx, y, { width: c.width, align: "right" });
    sx += c.width;
  }
  y += 14;
  doc.font("Helvetica").fontSize(8);
  for (const [rate, totals] of [...slabTotals.entries()].sort()) {
    sx = leftX;
    const vals = [`${rate}%`, totals.taxable.toFixed(2), totals.cgst.toFixed(2), totals.sgst.toFixed(2)];
    for (let i = 0; i < slabCols.length; i++) {
      doc.text(vals[i], sx, y, { width: slabCols[i].width, align: "right" });
      sx += slabCols[i].width;
    }
    y += 14;
  }
  y += 16;

  const totalsX = leftX + pageWidth - 220;
  const printTotalLine = (label: string, value: string, bold = false) => {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(10);
    doc.text(label, totalsX, y, { width: 140 });
    doc.text(`Rs ${value}`, totalsX + 140, y, { width: 80, align: "right" });
    y += 16;
  };
  printTotalLine("Subtotal (taxable value)", money(bill.subtotal));
  printTotalLine("Total CGST", money(bill.total_cgst));
  printTotalLine("Total SGST", money(bill.total_sgst));
  doc.moveTo(totalsX, y - 4).lineTo(totalsX + 220, y - 4).stroke();
  printTotalLine("Grand Total", money(bill.grand_total), true);

  doc.end();
  await new Promise<void>((resolvePromise, reject) => {
    stream.on("finish", () => resolvePromise());
    stream.on("error", reject);
  });
}
