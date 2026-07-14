// Thin wrapper over the Telegram Bot API. No framework — just fetch calls. Long-polling via
// getUpdates; sendMessage/sendDocument for replies; getFile+download for fetching an uploaded
// logo's bytes on demand (never persisted to disk between invoices).

import { basename } from "node:path";

const API_ROOT = "https://api.telegram.org";

export class TelegramClient {
  private base: string;
  private fileBase: string;

  constructor(botToken: string) {
    this.base = `${API_ROOT}/bot${botToken}`;
    this.fileBase = `${API_ROOT}/file/bot${botToken}`;
  }

  async getUpdates(offset: number | null, timeoutSec = 50): Promise<any[]> {
    const params = new URLSearchParams({ timeout: String(timeoutSec) });
    if (offset != null) params.set("offset", String(offset));
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await fetch(`${this.base}/getUpdates?${params}`);
        if (!res.ok) throw new Error(`getUpdates HTTP ${res.status}`);
        const body = await res.json();
        return body.result;
      } catch (err) {
        if (attempt === 4) throw err;
        await new Promise((r) => setTimeout(r, Math.min(2 ** attempt * 1000, 10000)));
      }
    }
    return [];
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    const chunkSize = 4000;
    for (let start = 0; start < Math.max(text.length, 1); start += chunkSize) {
      const chunk = text.slice(start, start + chunkSize) || "(no response)";
      const res = await fetch(`${this.base}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: chunk }),
      });
      if (!res.ok) throw new Error(`sendMessage HTTP ${res.status}: ${await res.text()}`);
    }
  }

  async sendDocument(chatId: number, filePath: string, caption?: string): Promise<void> {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    if (caption) form.set("caption", caption);
    const fileBuffer = await import("node:fs/promises").then((fs) => fs.readFile(filePath));
    form.set("document", new Blob([fileBuffer]), basename(filePath));
    const res = await fetch(`${this.base}/sendDocument`, { method: "POST", body: form });
    if (!res.ok) throw new Error(`sendDocument HTTP ${res.status}: ${await res.text()}`);
  }

  async setWebhook(url: string, secretToken: string): Promise<void> {
    const res = await fetch(`${this.base}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, secret_token: secretToken, allowed_updates: ["message", "edited_message"] }),
    });
    if (!res.ok) throw new Error(`setWebhook HTTP ${res.status}: ${await res.text()}`);
  }

  async deleteWebhook(): Promise<void> {
    const res = await fetch(`${this.base}/deleteWebhook`, { method: "POST" });
    if (!res.ok) throw new Error(`deleteWebhook HTTP ${res.status}: ${await res.text()}`);
  }

  async getFileBytes(fileId: string): Promise<Buffer | null> {
    const res = await fetch(`${this.base}/getFile?file_id=${encodeURIComponent(fileId)}`);
    if (!res.ok) return null;
    const body = await res.json();
    const filePath = body.result?.file_path;
    if (!filePath) return null;
    const fileRes = await fetch(`${this.fileBase}/${filePath}`);
    if (!fileRes.ok) return null;
    return Buffer.from(await fileRes.arrayBuffer());
  }
}
