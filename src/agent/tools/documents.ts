// Document-generation tools. These NEVER touch the Telegram API to send anything — they return
// a structured { filePath, fileKind } marker in the tool result, which the dispatcher recognizes
// after generateText() resolves and turns into a Telegram sendDocument call. Keeps "who calls
// Telegram" to exactly one place (src/telegram/dispatcher.ts).

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { withClient } from "../../db/pool.ts";
import { getPreferences } from "../../db/queries/preferences.ts";
import { generateAnalysisDeck } from "../../documents/analysisDeck.ts";
import { BillNotFinalizedError, generateInvoicePdf } from "../../documents/invoicePdf.ts";
import type { TelegramClient } from "../../telegram/client.ts";
import type { ChatContext } from "./context.ts";

export const DOCUMENT_TOOL_NAMES = new Set(["generate_invoice_pdf", "generate_analysis_deck"]);

export function buildDocumentTools(ctx: ChatContext, telegram: TelegramClient): ToolSet {
  return {
    generate_invoice_pdf: tool({
      description:
        "Generate a clean, GST-correct PDF invoice for a FINALIZED bill and send it to the owner " +
        "in this chat. Fails if the bill is still a draft — finalize it first.",
      inputSchema: z.object({ billId: z.number().int() }),
      execute: async ({ billId }) => {
        const prefs = await withClient((c) => getPreferences(c, ctx.chatId));
        const logoBytes = prefs.shop_logo_file_id ? await telegram.getFileBytes(prefs.shop_logo_file_id) : null;
        try {
          const filePath = await generateInvoicePdf(billId, logoBytes);
          return { filePath, fileKind: "invoice_pdf", billId };
        } catch (err) {
          if (err instanceof BillNotFinalizedError) return { error: "bill_not_finalized" };
          throw err;
        }
      },
    }),

    generate_analysis_deck: tool({
      description:
        "Generate a PowerPoint (PPTX) business analysis deck with real charts — sales trend, top " +
        "items, stock health, GST collected — over the requested period, and send it to the owner.",
      inputSchema: z.object({
        periodDays: z.number().int().positive().describe("how many trailing days to analyse, e.g. 7 for 'this week'"),
      }),
      execute: async ({ periodDays }) => {
        const filePath = await generateAnalysisDeck(periodDays || 7);
        return { filePath, fileKind: "analysis_deck", periodDays: periodDays || 7 };
      },
    }),
  };
}
