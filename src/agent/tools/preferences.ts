import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { withClient } from "../../db/pool.ts";
import * as q from "../../db/queries/preferences.ts";
import type { ChatContext } from "./context.ts";

export function buildPreferencesTools(ctx: ChatContext): ToolSet {
  return {
    get_preferences: tool({
      description:
        "Get this owner's standing preferences (default payment mode, default atta brand, shop " +
        "name/GSTIN/address for invoices, round-off setting). These persist across /new and " +
        "across restarts — always defer to them instead of asking again once set.",
      inputSchema: z.object({}),
      execute: async () => ({ preferences: await withClient((c) => q.getPreferences(c, ctx.chatId)) }),
    }),

    set_preference: tool({
      description:
        "Set a standing preference that should be remembered from now on, across /new chats and " +
        "restarts. Known keys: default_payment_mode (cash/upi/card), default_atta_product_id (a " +
        "productId from lookup_products), shop_name, gstin, shop_address, shop_logo_file_id, " +
        "round_off_to_rupee (true/false). Any other key is stored as-is for later reference.",
      inputSchema: z.object({ key: z.string(), value: z.string().describe("the value to store, as a string") }),
      execute: async ({ key, value }) => {
        let parsed: unknown = value;
        if (key === "round_off_to_rupee") {
          parsed = ["true", "1", "yes"].includes(value.trim().toLowerCase());
        } else if (key === "default_atta_product_id") {
          parsed = parseInt(value, 10);
        }
        const preferences = await withClient((c) => q.setPreference(c, ctx.chatId, key, parsed));
        return { preferences };
      },
    }),
  };
}
