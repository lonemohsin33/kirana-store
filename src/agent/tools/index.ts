import type { ToolSet } from "ai";
import type { TelegramClient } from "../../telegram/client.ts";
import { buildBillingTools } from "./billing.ts";
import type { ChatContext } from "./context.ts";
import { buildDocumentTools } from "./documents.ts";
import { buildInventoryTools } from "./inventory.ts";
import { buildKhataTools } from "./khata.ts";
import { buildPreferencesTools } from "./preferences.ts";
import { buildReportingTools } from "./reporting.ts";

export function buildAllTools(ctx: ChatContext, telegram: TelegramClient): ToolSet {
  return {
    ...buildInventoryTools(ctx),
    ...buildBillingTools(ctx),
    ...buildKhataTools(ctx),
    ...buildReportingTools(),
    ...buildPreferencesTools(ctx),
    ...buildDocumentTools(ctx, telegram),
  };
}

export { DOCUMENT_TOOL_NAMES } from "./documents.ts";
