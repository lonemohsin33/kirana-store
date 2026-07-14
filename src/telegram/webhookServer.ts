// Render's free plan only runs Web Services, not Background Workers, so on Render we receive
// updates via Telegram webhook instead of long-polling. Telegram expects a fast ack, so the
// request is acknowledged with 200 immediately and the update is dispatched afterward.

import { createServer } from "node:http";

export function startWebhookServer(
  port: number,
  path: string,
  secretToken: string,
  onUpdate: (update: unknown) => Promise<void>
): void {
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200).end("ok");
      return;
    }
    if (req.method !== "POST" || req.url !== path) {
      res.writeHead(404).end();
      return;
    }
    if (req.headers["x-telegram-bot-api-secret-token"] !== secretToken) {
      res.writeHead(401).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.writeHead(200).end();
      try {
        const update = JSON.parse(body);
        onUpdate(update).catch((err) => console.error("webhook update handling failed", err));
      } catch (err) {
        console.error("failed to parse webhook body", err);
      }
    });
  });
  server.listen(port, () => console.log(`webhook server listening on port ${port}`));
}
