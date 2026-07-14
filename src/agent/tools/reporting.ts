import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { withClient } from "../../db/pool.ts";
import * as q from "../../db/queries/reporting.ts";

export function buildReportingTools(): ToolSet {
  return {
    get_daily_summary: tool({
      description:
        "Get the sales summary for one day: total sales, tax collected (CGST/SGST split), " +
        "cash/UPI/card breakdown, and top-selling items. Use this for 'today's sales?' and " +
        "'close the day' style requests.",
      inputSchema: z.object({ date: z.string().nullable().describe("YYYY-MM-DD, or null for today") }),
      execute: async ({ date }) => {
        const dateStr = date ?? new Date().toISOString().slice(0, 10);
        return withClient((c) => q.getDailySummary(c, dateStr));
      },
    }),
  };
}
