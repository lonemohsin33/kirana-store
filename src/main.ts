import { config } from "./config.ts";
import { closePool, initPool } from "./db/pool.ts";
import { runMigrations } from "../scripts/runMigrations.ts";
import { TelegramClient } from "./telegram/client.ts";
import { Dispatcher } from "./telegram/dispatcher.ts";

async function main(): Promise<void> {
  await runMigrations(config.databaseUrl);
  initPool(config.databaseUrl);

  const telegram = new TelegramClient(config.telegramBotToken);
  const dispatcher = new Dispatcher(telegram);
  try {
    await dispatcher.runForever();
  } finally {
    await closePool();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
