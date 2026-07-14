// The control loop: one Telegram update in, idempotency-gated, routed through one generateText()
// turn, streamed back out. This is the only place that decides when to call Telegram's
// sendMessage/sendDocument — tools never touch the Telegram API directly.

import type { ModelMessage } from "ai";
import { getPool } from "../db/pool.ts";
import { runTurn } from "../agent/runTurn.ts";
import type { TelegramClient } from "./client.ts";

const DOCUMENT_CAPTIONS: Record<string, string> = {
  invoice_pdf: "Here's the invoice.",
  analysis_deck: "Here's the analysis deck.",
};

class AsyncLock {
  private queue: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.queue;
    this.queue = new Promise((resolve) => (release = resolve));
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export class Dispatcher {
  private histories = new Map<number, ModelMessage[]>();
  private locks = new Map<number, AsyncLock>();

  constructor(private telegram: TelegramClient) {}

  private lockFor(chatId: number): AsyncLock {
    let lock = this.locks.get(chatId);
    if (!lock) {
      lock = new AsyncLock();
      this.locks.set(chatId, lock);
    }
    return lock;
  }

  async handleUpdate(update: any): Promise<void> {
    const updateId: number = update.update_id;
    const message = update.message ?? update.edited_message;
    if (!message || typeof message.text !== "string") return; // ignore non-text updates

    const chatId: number = message.chat.id;
    const userId: number = message.from.id;
    const text: string = message.text;

    const pool = getPool();
    const insertResult = await pool.query(
      `INSERT INTO processed_updates (update_id, telegram_chat_id, status)
       VALUES ($1, $2, 'processing') ON CONFLICT (update_id) DO NOTHING RETURNING update_id`,
      [updateId, chatId]
    );
    if (insertResult.rows.length === 0) {
      const { rows } = await pool.query("SELECT status FROM processed_updates WHERE update_id = $1", [updateId]);
      if (rows[0]?.status === "completed") {
        console.log(`skipping redelivered update_id=${updateId} (already completed)`);
        return;
      }
      // status still 'processing' from a crashed prior attempt: fall through and reprocess.
      // Safe because every mutating tool is independently idempotent.
    }

    const lock = this.lockFor(chatId);
    try {
      await lock.run(async () => {
        if (text.trim() === "/new") {
          this.histories.set(chatId, []);
          await this.telegram.sendMessage(chatId, "Started a new chat. Your saved preferences still apply.");
          return;
        }

        const history = this.histories.get(chatId) ?? [];
        const result = await runTurn(history, text, { chatId, userId, updateId }, this.telegram);
        this.histories.set(chatId, [...history, ...result.newMessages]);

        if (result.text.trim()) {
          await this.telegram.sendMessage(chatId, result.text);
        }
        for (const doc of result.documents) {
          try {
            await this.telegram.sendDocument(chatId, doc.filePath, DOCUMENT_CAPTIONS[doc.fileKind] ?? "");
          } finally {
            await import("node:fs/promises").then((fs) => fs.unlink(doc.filePath).catch(() => {}));
          }
        }
      });
    } catch (err) {
      console.error(`error handling update_id=${updateId}`, err);
      await this.telegram.sendMessage(chatId, "Sorry, something went wrong on my end. Please try that again.");
      await pool.query("UPDATE processed_updates SET status = 'failed', completed_at = now() WHERE update_id = $1", [updateId]);
      return;
    }

    await pool.query("UPDATE processed_updates SET status = 'completed', completed_at = now() WHERE update_id = $1", [updateId]);
  }

  async runForever(): Promise<void> {
    let offset: number | null = null;
    console.log("starting Telegram long-poll loop");
    for (;;) {
      let updates: any[];
      try {
        updates = await this.telegram.getUpdates(offset);
      } catch (err) {
        console.error("getUpdates failed, backing off", err);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      for (const update of updates) {
        offset = update.update_id + 1;
        try {
          await this.handleUpdate(update);
        } catch (err) {
          console.error(`unhandled error processing update ${update.update_id}`, err);
        }
      }
    }
  }
}
