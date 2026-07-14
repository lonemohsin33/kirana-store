import { config } from "./config.ts";
import { closePool, initPool } from "./db/pool.ts";
import { runMigrations } from "../scripts/runMigrations.ts";
import { TelegramClient } from "./telegram/client.ts";
import { Dispatcher } from "./telegram/dispatcher.ts";
import { startWebhookServer } from "./telegram/webhookServer.ts";

// Render's free plan only runs Web Services (which need an inbound port), not Background
// Workers, so RENDER_EXTERNAL_URL (auto-set by Render for Web Services) selects webhook mode;
// local dev has no public HTTPS URL for Telegram to call, so it falls back to long-polling.
async function main(): Promise<void> {
  await runMigrations(config.databaseUrl);
  initPool(config.databaseUrl);

  const telegram = new TelegramClient(config.telegramBotToken);
  const dispatcher = new Dispatcher(telegram);

  const externalUrl = process.env.RENDER_EXTERNAL_URL;
  if (externalUrl) {
    // The webhook server keeps the process (and the pool) alive for its lifetime; there is no
    // "done" point to close the pool at, unlike the long-poll loop below.
    const path = `/telegram/${config.webhookSecret}`;
    await telegram.setWebhook(`${externalUrl}${path}`, config.webhookSecret);
    startWebhookServer(config.port, path, config.webhookSecret, (update) => dispatcher.handleUpdate(update));
    return;
  }

  try {
    await telegram.deleteWebhook();
    await dispatcher.runForever();
  } finally {
    await closePool();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
