// One agent turn = one generateText() call. Unlike the Claude Agent SDK's CLI-subprocess model,
// there's no persistent background process to manage here — tools are rebuilt fresh (closing
// over this turn's ChatContext) on every call, and the caller (the dispatcher) is responsible
// for keeping the ModelMessage[] history across turns for a given chat.

import { google } from "@ai-sdk/google";
import { generateText, stepCountIs, type ModelMessage } from "ai";
import { renderSystemPrompt } from "./systemPrompt.ts";
import { buildAllTools, DOCUMENT_TOOL_NAMES } from "./tools/index.ts";
import type { ChatContext } from "./tools/context.ts";
import type { TelegramClient } from "../telegram/client.ts";
import { withClient } from "../db/pool.ts";
import { getPreferences } from "../db/queries/preferences.ts";

const MODEL_ID = "gemini-flash-latest";
const MAX_STEPS = 20;

export interface DocumentToSend {
  filePath: string;
  fileKind: string;
}

export interface TurnResult {
  text: string;
  newMessages: ModelMessage[];
  documents: DocumentToSend[];
}

export async function runTurn(
  history: ModelMessage[],
  userText: string,
  ctx: ChatContext,
  telegram: TelegramClient
): Promise<TurnResult> {
  const preferences = await withClient((c) => getPreferences(c, ctx.chatId));
  const system = renderSystemPrompt(preferences);
  const tools = buildAllTools(ctx, telegram);

  const messages: ModelMessage[] = [...history, { role: "user", content: userText }];

  const result = await generateText({
    model: google(MODEL_ID),
    system,
    messages,
    tools,
    stopWhen: stepCountIs(MAX_STEPS),
  });

  const documents: DocumentToSend[] = [];
  for (const call of result.toolCalls) {
    if (!DOCUMENT_TOOL_NAMES.has(call.toolName)) continue;
    const matchingResult = result.toolResults.find((r) => r.toolCallId === call.toolCallId);
    const output = matchingResult?.output as { filePath?: string; fileKind?: string } | undefined;
    if (output?.filePath && output?.fileKind) {
      documents.push({ filePath: output.filePath, fileKind: output.fileKind });
    }
  }

  return {
    text: result.text,
    newMessages: [{ role: "user", content: userText }, ...result.responseMessages],
    documents,
  };
}
