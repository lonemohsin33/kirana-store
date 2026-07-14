// Manual smoke test: create a product, a finalized bill, and generate both artifacts, without
// going through Telegram or the model at all — just to verify the document-generation code paths.

import { closePool, initPool, withClient } from "../src/db/pool.ts";
import { addBillLine, finalizeBill, getOrCreateDraft } from "../src/db/queries/bills.ts";
import { setPreference } from "../src/db/queries/preferences.ts";
import { createProduct } from "../src/db/queries/products.ts";
import { generateAnalysisDeck } from "../src/documents/analysisDeck.ts";
import { generateInvoicePdf } from "../src/documents/invoicePdf.ts";

async function main() {
  const dsn = "postgresql://postgres:mohsin@localhost:5432/kirana_agent_ts";
  initPool(dsn);

  const { billId } = await withClient(async (client) => {
    await setPreference(client, 999, "shop_name", "Sharma General Store");
    await setPreference(client, 999, "gstin", "27ABCDE1234F1Z5");
    await setPreference(client, 999, "shop_address", "Shop 4, MG Road, Pune");

    const atta = await createProduct(client, {
      skuName: "Smoke Test Atta", unit: "packet", hsnCode: "1101", gstRate: "5",
      costPrice: "235", sellPrice: "260", initialQty: "40", reorderLevel: "10",
    });
    const butter = await createProduct(client, {
      skuName: "Smoke Test Butter", unit: "packet", hsnCode: "0405", gstRate: "12",
      costPrice: "52", sellPrice: "62", initialQty: "30", reorderLevel: "10",
    });

    const bill = await getOrCreateDraft(client, 999, 1);
    await addBillLine({ billId: bill.id, productId: atta.id, qty: "2" });
    await addBillLine({ billId: bill.id, productId: butter.id, qty: "1" });

    const result = await finalizeBill({
      billId: bill.id, telegramChatId: 999, telegramUpdateId: 999001,
      paymentMode: "upi", paymentReference: "UPI-SMOKE-1", confirmBelowCost: false, customerId: null,
    });
    if (!result.ok) throw new Error(JSON.stringify(result));
    return { billId: result.bill!.id };
  });

  const pdfPath = await generateInvoicePdf(billId);
  console.log("PDF ->", pdfPath);

  const pptxPath = await generateAnalysisDeck(7);
  console.log("PPTX ->", pptxPath);

  await closePool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
