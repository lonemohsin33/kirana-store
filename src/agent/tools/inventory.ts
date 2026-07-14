import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { withClient } from "../../db/pool.ts";
import * as q from "../../db/queries/products.ts";
import type { ChatContext } from "./context.ts";

export function buildInventoryTools(ctx: ChatContext): ToolSet {
  return {
    lookup_products: tool({
      description:
        "Search the product catalog by name/brand/alias. This is the ONLY source of truth for " +
        "what SKUs exist, their price, GST rate and stock — never state a price or stock figure " +
        "you did not just retrieve from this tool. If more than one close match comes back and " +
        "it isn't obvious which the owner means (e.g. 'atta' could be loose atta or Aashirvaad " +
        "Atta 5kg), ask the owner to clarify instead of guessing.",
      inputSchema: z.object({ query: z.string().describe("free-text product name, e.g. 'atta', 'maggi', 'sugar'") }),
      execute: async ({ query }) => {
        const matches = await withClient((c) => q.searchProducts(c, query));
        return { matches };
      },
    }),

    get_stock_level: tool({
      description: "Get the exact current stock quantity, reorder level and unit for one product by id.",
      inputSchema: z.object({ productId: z.number().int() }),
      execute: async ({ productId }) => {
        const product = await withClient((c) => q.getProduct(c, productId));
        if (!product) return { error: "product_not_found" };
        return {
          skuName: product.sku_name,
          stockQty: product.stock_qty,
          unit: product.unit,
          reorderLevel: product.reorder_level,
        };
      },
    }),

    list_low_stock: tool({
      description: "List every product at or below its reorder level right now.",
      inputSchema: z.object({}),
      execute: async () => ({ lowStock: await withClient((c) => q.listLowStock(c)) }),
    }),

    get_reorder_suggestions: tool({
      description:
        "List products worth reordering soon, ranked by estimated days-of-stock-left computed " +
        "from actual sales velocity over the last 14 days (not just a flat reorder-level breach). " +
        "Products under their reorder level are always included even with no recent sales data.",
      inputSchema: z.object({}),
      execute: async () => ({ reorderSuggestions: await withClient((c) => q.getReorderSuggestions(c)) }),
    }),

    add_product: tool({
      description:
        "Register a brand-new SKU in the catalog. Use this only after lookup_products confirms " +
        "the product doesn't already exist. GST slab must be one of 0, 0.25, 3, 5, 12, 18, 28.",
      inputSchema: z.object({
        skuName: z.string(),
        unit: z.enum(["kg", "g", "litre", "ml", "packet", "dozen", "piece"]),
        hsnCode: z.string(),
        gstRate: z.number(),
        costPrice: z.number(),
        sellPrice: z.number().describe("MRP for packaged goods, per-unit price for loose goods"),
        priceIsTaxInclusive: z.boolean().describe("true for packaged MRP goods, false for loose items"),
        isLoose: z.boolean(),
        brand: z.string().nullable().describe("brand name, or null for loose/unbranded items"),
        initialQty: z.number().default(0),
        reorderLevel: z.number().default(0),
      }),
      execute: async (args) => {
        const created = await withClient((c) =>
          q.createProduct(c, {
            skuName: args.skuName,
            unit: args.unit,
            hsnCode: args.hsnCode,
            gstRate: args.gstRate,
            costPrice: args.costPrice,
            sellPrice: args.sellPrice,
            priceIsTaxInclusive: args.priceIsTaxInclusive,
            isLoose: args.isLoose,
            brand: args.brand,
            initialQty: args.initialQty,
            reorderLevel: args.reorderLevel,
          })
        );
        return { created };
      },
    }),

    receive_stock: tool({
      description:
        "Record newly received stock for an existing product (goods coming in from a supplier). " +
        "Updates cost price and, optionally, MRP; increments stock atomically.",
      inputSchema: z.object({
        productId: z.number().int(),
        qty: z.number().positive(),
        costPrice: z.number(),
        mrp: z.number().nullable().describe("new MRP/sell price if it changed, or null to leave it unchanged"),
      }),
      execute: async (args) => {
        return q.receiveStock({
          productId: args.productId,
          qty: args.qty,
          costPrice: args.costPrice,
          mrp: args.mrp,
          telegramChatId: ctx.chatId,
          telegramUpdateId: ctx.updateId,
        });
      },
    }),

    adjust_stock: tool({
      description:
        "Manually correct stock (breakage, expiry, miscount). Requires confirm=true to actually " +
        "apply — if confirm is false, describe the change to the owner and ask them to confirm first. " +
        "There is no way to delete stock or a product; this is the only way to reduce stock outside " +
        "of a sale, and it is always recorded in the audit ledger.",
      inputSchema: z.object({
        productId: z.number().int(),
        deltaQty: z.number().describe("positive to add, negative to remove"),
        reasonNote: z.string(),
        confirm: z.boolean(),
      }),
      execute: async (args) => {
        if (!args.confirm) {
          return { confirmationRequired: true, deltaQty: args.deltaQty, reason: args.reasonNote };
        }
        return q.adjustStock({
          productId: args.productId,
          deltaQty: args.deltaQty,
          reasonNote: args.reasonNote,
          telegramChatId: ctx.chatId,
        });
      },
    }),

    update_product_price: tool({
      description:
        "Update a product's cost price, sell price (MRP) and/or GST rate. Leave a field null to " +
        "keep its current value.",
      inputSchema: z.object({
        productId: z.number().int(),
        newSellPrice: z.number().nullable(),
        newCostPrice: z.number().nullable(),
        newGstRate: z.number().nullable(),
      }),
      execute: async (args) => {
        const product = await withClient((c) =>
          q.updateProductPrice(c, args.productId, {
            newSellPrice: args.newSellPrice,
            newCostPrice: args.newCostPrice,
            newGstRate: args.newGstRate,
          })
        );
        if (!product) return { error: "product_not_found" };
        return { updated: product };
      },
    }),
  };
}
