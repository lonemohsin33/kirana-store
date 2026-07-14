import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { withClient } from "../../db/pool.ts";
import * as q from "../../db/queries/khata.ts";
import type { ChatContext } from "./context.ts";

export function buildKhataTools(ctx: ChatContext): ToolSet {
  return {
    find_customer: tool({
      description:
        "Search khata customers by name. Returns every close match so you can ask 'which Ramesh?' " +
        "when there's more than one, rather than guessing.",
      inputSchema: z.object({ nameQuery: z.string() }),
      execute: async ({ nameQuery }) => ({ matches: await withClient((c) => q.findCustomers(c, nameQuery)) }),
    }),

    create_customer: tool({
      description:
        "Register a new khata customer. Only use this after find_customer confirms they don't " +
        "already exist, or after the owner explicitly confirms they want a new customer created.",
      inputSchema: z.object({ name: z.string(), phone: z.string().nullable() }),
      execute: async ({ name, phone }) => ({ created: await withClient((c) => q.createCustomer(c, { name, phone })) }),
    }),

    put_on_credit: tool({
      description:
        "Add an amount to a customer's khata (credit) balance directly, not tied to a bill — " +
        "e.g. 'put 500 on Ramesh's credit'. Requires an existing customerId from find_customer.",
      inputSchema: z.object({ customerId: z.number().int(), amount: z.number().positive(), note: z.string().nullable() }),
      execute: async (args) =>
        q.putOnCredit({
          customerId: args.customerId,
          amount: args.amount,
          telegramChatId: ctx.chatId,
          telegramUpdateId: ctx.updateId,
          note: args.note,
        }),
    }),

    record_khata_payment: tool({
      description:
        "Record a customer paying down their khata balance, e.g. 'Ramesh paid 300'. Errors with " +
        "customer_not_found if the customerId doesn't resolve to an existing customer — never " +
        "create a customer implicitly here; ask the owner or use create_customer explicitly first.",
      inputSchema: z.object({
        customerId: z.number().int(),
        amount: z.number().positive(),
        paymentMode: z.enum(["cash", "upi", "card"]),
        paymentReference: z.string().nullable(),
      }),
      execute: async (args) =>
        q.recordPayment({
          customerId: args.customerId,
          amount: args.amount,
          paymentMode: args.paymentMode,
          paymentReference: args.paymentReference,
          telegramChatId: ctx.chatId,
          telegramUpdateId: ctx.updateId,
        }),
    }),

    get_khata_balance: tool({
      description: "Get a customer's current khata balance and recent transaction history.",
      inputSchema: z.object({ customerId: z.number().int() }),
      execute: async ({ customerId }) => {
        const result = await withClient((c) => q.getBalance(c, customerId));
        if (!result) return { error: "customer_not_found" };
        return result;
      },
    }),
  };
}
