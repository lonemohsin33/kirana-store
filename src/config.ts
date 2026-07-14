import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

export const config = {
  get googleApiKey() {
    return required("GOOGLE_GENERATIVE_AI_API_KEY");
  },
  get telegramBotToken() {
    return required("TELEGRAM_BOT_TOKEN");
  },
  get databaseUrl() {
    return required("DATABASE_URL");
  },
  get webhookSecret() {
    return required("TELEGRAM_WEBHOOK_SECRET");
  },
  port: Number(process.env.PORT ?? 3000),
  logLevel: process.env.LOG_LEVEL ?? "info",
};
