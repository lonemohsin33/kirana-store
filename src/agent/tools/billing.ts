import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { withClient } from "../../db/pool.ts";
import * as q from "../../db/queries/bills.ts";
import type { ChatContext } from "./context.ts";

export function buildBillingTools(ctx: ChatContext): ToolSet {
  return {
    start_bill: tool({
      description:
        "Open a new draft bill for this chat, or return the one already in progress if the owner " +
        "already started one. A bill lives as a draft — nothing is charged or decremented from " +
        "stock — until finalize_bill is called.",
      inputSchema: z.object({}),
      execute: async () => {
        const bill = await withClient((c) => q.getOrCreateDraft(c, ctx.chatId, ctx.userId));
        return { bill };
      },
    }),

    add_bill_line: tool({
      description:
        "Add one item to the current draft bill. Resolve the product via lookup_products first if " +
        "you don't already have its productId from this conversation.",
      inputSchema: z.object({
        billId: z.number().int(),
        productId: z.number().int(),
        qty: z.number().positive(),
        unitPriceOverride: z.number().nullable().describe("null to use the product's current sell price"),
      }),
      execute: async (args) => q.addBillLine({ billId: args.billId, productId: args.productId, qty: args.qty, unitPriceOverride: args.unitPriceOverride }),
    }),

    remove_bill_line: tool({
      description: "Remove one line from the current draft bill by its line number (from view_draft_bill).",
      inputSchema: z.object({ billId: z.number().int(), lineNo: z.number().int() }),
      execute: async (args) => q.removeBillLine({ billId: args.billId, lineNo: args.lineNo }),
    }),

    edit_bill_line: tool({
      description: "Change the quantity of an existing line on the current draft bill, e.g. 'make it 6 Maggi'.",
      inputSchema: z.object({ billId: z.number().int(), lineNo: z.number().int(), newQty: z.number().positive() }),
      execute: async (args) => q.editBillLine({ billId: args.billId, lineNo: args.lineNo, newQty: args.newQty }),
    }),

    view_draft_bill: tool({
      description:
        "Get the full current state of a draft bill: every line item and the computed GST " +
        "breakup. Always re-check this rather than trusting your own memory of the conversation " +
        "before finalizing or describing the bill back to the owner.",
      inputSchema: z.object({ billId: z.number().int() }),
      execute: async (args) => {
        const result = await withClient((c) => q.viewDraftBill(c, args.billId));
        if (!result) return { error: "bill_not_found" };
        return result;
      },
    }),

    finalize_bill: tool({
      description:
        "Finalize the draft bill: this is the ONLY point stock is decremented and the sale becomes " +
        "final. Will refuse (insufficientStock) if any line exceeds available stock — never retry " +
        "with a smaller quantity without telling the owner why. Will refuse (confirmationRequired) " +
        "if any line is priced below its cost price — re-call with confirmBelowCost=true only " +
        "after the owner explicitly confirms they want to sell at a loss. For a credit sale, pass " +
        "paymentMode='khata' and customerId (use find_customer/create_customer first).",
      inputSchema: z.object({
        billId: z.number().int(),
        paymentMode: z.enum(["cash", "upi", "card", "khata"]),
        paymentReference: z.string().nullable().describe("UPI/card transaction reference, or null"),
        confirmBelowCost: z.boolean(),
        customerId: z.number().int().nullable().describe("required if paymentMode is khata, else null"),
      }),
      execute: async (args) =>
        q.finalizeBill({
          billId: args.billId,
          telegramChatId: ctx.chatId,
          telegramUpdateId: ctx.updateId,
          paymentMode: args.paymentMode,
          paymentReference: args.paymentReference,
          confirmBelowCost: args.confirmBelowCost,
          customerId: args.customerId,
        }),
    }),

    void_bill: tool({
      description:
        "Reverse a finalized bill: restores stock and reverses any khata credit. Requires " +
        "confirm=true. Never deletes the bill — it becomes status='void' and stays in the audit trail.",
      inputSchema: z.object({ billId: z.number().int(), reason: z.string(), confirm: z.boolean() }),
      execute: async (args) => {
        if (!args.confirm) return { confirmationRequired: true };
        return q.voidBill({ billId: args.billId, reason: args.reason, telegramChatId: ctx.chatId });
      },
    }),
  };
}
