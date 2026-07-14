# Supermarket Ops Agent — Kirana Ops Bot

**Telegram bot:** [`@my_kirana_ops_bot`](https://t.me/my_kirana_ops_bot) (kept running on Render for review)

A conversational agent that runs a small Indian kirana store end-to-end through Telegram —
receiving stock, cutting GST-correct bills, running khata (customer credit), closing the day, and
generating PDF invoices / PPTX analysis decks. The model orchestrates a designed tool surface;
there is no keyword/regex intent router anywhere in this codebase (the only literal string match
is `/new`, a Telegram chat-reset convention, not a business command).

## Harness

**Vercel AI SDK** (`ai` + `@ai-sdk/google`) with **Gemini** (`gemini-flash-latest`). One agent turn
is one `generateText()` call with `tools` and `stopWhen: stepCountIs(20)`, letting the model chain
multiple tool calls — resolve a product, check stock, add a bill line, re-view the draft — within a
single turn before producing its reply. TypeScript's ecosystem covers both required artifacts:
`pdfkit` for the GST PDF invoice, `pptxgenjs` for a deck with **real, editable chart objects**
(`slide.addChart`, not screenshots).

## Control loop

One long-running Node process, one `pg.Pool`. Two transports feed the same `Dispatcher`:

- **Locally**: `dispatcher.runForever()` long-polls Telegram's `getUpdates`.
- **On Render**: a free-tier Web Service can't run a Background Worker, and there's no public
  HTTPS URL for Telegram to call during local dev — so `main.ts` branches on `RENDER_EXTERNAL_URL`
  (auto-set by Render for Web Services). When present, it registers a Telegram webhook against a
  minimal `node:http` server (`src/telegram/webhookServer.ts`) instead; when absent (local dev), it
  falls back to long-polling unchanged. Both paths converge on the same `Dispatcher.handleUpdate`.

Per update: `processed_updates` (keyed on Telegram's `update_id`) is checked *before* the agent is
invoked at all — a true redelivery of an already-completed update is a full no-op. Otherwise the
update is routed through that chat's `runTurn()` call, its response is streamed back via
`sendMessage`/`sendDocument`, and the update is marked complete. An `AsyncLock` per chat serializes
turns within one chat while different chats run fully concurrently against the shared DB pool —
this is what the concurrency hard-part actually exercises in `tests/concurrency.test.ts`.

Postgres is the durable memory layer: preferences, draft bills, and every ledger survive `/new` and
a full process restart. Conversation history itself (the `ModelMessage[]` array) is kept in-memory
per chat for the process's lifetime — restarting loses in-flight conversational context, but never
loses store state (stock, bills, khata, preferences), which is what the spec's hard parts actually
grade.

## Skill / tool design

Six thin, composable tool groups, each backed by `src/db/queries/*.ts` (owns the SQL) — no giant
tool, no intent router:

| Group | File | Tools |
|---|---|---|
| Inventory | `src/agent/tools/inventory.ts` | `lookup_products`, `get_stock_level`, `list_low_stock`, `get_reorder_suggestions`, `add_product`, `receive_stock`, `adjust_stock`, `update_product_price` |
| Billing (draft state machine) | `src/agent/tools/billing.ts` | `start_bill`, `add_bill_line`, `remove_bill_line`, `edit_bill_line`, `view_draft_bill`, `finalize_bill`, `void_bill` |
| Khata | `src/agent/tools/khata.ts` | `find_customer`, `create_customer`, `put_on_credit`, `record_khata_payment`, `get_khata_balance` |
| Reporting | `src/agent/tools/reporting.ts` | `get_daily_summary` |
| Preferences | `src/agent/tools/preferences.ts` | `get_preferences`, `set_preference` |
| Documents | `src/agent/tools/documents.ts` | `generate_invoice_pdf`, `generate_analysis_deck` |

A bill is a **DB-backed draft** (`bills.status='draft'` + `bill_line_items`), not conversation-held
state — Render can restart the service mid-conversation, and a DB row is what makes `finalize_bill`
idempotently retryable at all. `add_bill_line`/`remove_bill_line`/`edit_bill_line` never touch
stock; only `finalize_bill` checks and decrements, atomically, exactly once.

## How each hard part is solved

- **Grounding** — `lookup_products`/`get_stock_level` are the only source of truth for price/GST/
  stock; the system prompt (`src/agent/systemPrompt.ts`) forbids stating a figure not just
  retrieved via a tool this turn, and instructs the model to ask a clarifying question ("atta —
  loose or Aashirvaad 5kg?") when a lookup returns more than one close match.
- **Oversell guard** — enforced in `finalize_bill`'s transaction (`src/db/queries/bills.ts`), not
  the prompt: all line-item product rows are locked (`lockProductsOrdered`, `ORDER BY id FOR
  UPDATE` — a deterministic order so concurrent finalizes never deadlock), each line's qty is
  checked against the now-current `stock_qty`, and the whole transaction returns a structured
  `insufficient_stock` result (naming the exact shortfall per line) if any line would go negative —
  no partial finalize. Verified against a real concurrent-connection race in
  `tests/concurrency.test.ts::two concurrent bills never oversell`.
- **GST correctness** — `src/gst.ts` is pure, dependency-free (besides `decimal.js` for exact
  arithmetic), and unit-tested (`tests/gst.test.ts`, 8 cases). Packaged MRP is tax-inclusive by law,
  so `taxableValue = unitPrice / (1 + rate/100)`; loose goods are tax-exclusive. Each line's tax is
  rounded to 2dp first, then summed for the header (never rounded independently) so the invoice
  always ties to its own breakup; CGST/SGST split evenly with the rounding remainder absorbed by
  SGST so `cgst + sgst == totalTax` exactly.
- **Multi-turn bills with edits** — see draft-bill design above; `view_draft_bill` is the ground
  truth the model is instructed to re-read every turn instead of trusting its memory of the
  conversation.
- **Idempotency** — two layers. (1) `processed_updates` keyed on Telegram's `update_id`, checked
  before the agent runs at all (`src/telegram/dispatcher.ts`). (2) Because a crash can leave an
  update `processing`-but-incomplete (legitimate reprocessing, not a dupe), every money/stock tool
  is *independently* idempotent: `finalize_bill`'s `draft→finalized` transition is guarded by a row
  lock, so a retry against an already-finalized bill returns the existing result rather than
  re-decrementing; `receive_stock` carries a `stock_in_events` uniqueness check on
  `(telegram_update_id, product_id, qty, cost_price)`; khata credit-sale linkage is deduped via an
  `ON CONFLICT (telegram_update_id, customer_id, type, amount) DO NOTHING`. Verified in
  `tests/idempotency.test.ts`.
- **Concurrency** — every mutating tool call is exactly one short-lived transaction; nothing is
  ever held open across a Telegram message or an LLM turn, so a slow multi-turn conversation never
  blocks a concurrent bill or stock-in on the same SKU. See `tests/concurrency.test.ts`.
- **Guardrails** — no `delete_*` tool exists anywhere (only `adjust_stock`, always logged via
  `stock_ledger`, and soft-deactivate). Below-cost sales and stock adjustments require an explicit
  `confirm=true` the model may only set after the owner confirms in chat — the tool returns the
  risk description instead of mutating anything when `confirm` is false. `record_khata_payment`
  errors `customer_not_found` rather than silently creating a customer.
- **Real artifacts** — `generate_invoice_pdf` (`pdfkit`) and `generate_analysis_deck` (`pptxgenjs`
  **native chart objects** — line/bar/pie/stacked-column, editable in PowerPoint, not screenshots)
  are pure functions of a `billId`/period → file path; the *dispatcher*, not the tool, calls
  Telegram's `sendDocument` (`src/agent/tools/documents.ts` only ever returns a `{filePath,
  fileKind}` marker), so tools never touch the Telegram API directly.
- **Memory across sessions** — `owner_preferences` (one row per chat) is read fresh into the system
  prompt on *every single turn* (`runTurn.ts`), not just at chat creation — so standing preferences
  (default payment mode, default atta brand, shop name/GSTIN for invoices) survive both `/new` and
  a cold process start after a Render restart.

## Two stretch goals implemented

1. **Reorder suggestions from sales velocity** — `get_reorder_suggestions` computes days-of-stock-
   left from actual finalized-sale quantities over the trailing 14 days, not just a flat
   reorder-level breach (`src/db/queries/products.ts::getReorderSuggestions`).
2. **Branded/templated invoice PDF** — the PDF header pulls shop name/GSTIN/address/logo from
   `owner_preferences`; the logo is a Telegram `file_id` fetched via `getFile` at render time and
   never persisted to disk.

## Running locally

```
npm install
cp .env.example .env   # fill in GOOGLE_GENERATIVE_AI_API_KEY, TELEGRAM_BOT_TOKEN, DATABASE_URL
npm start               # runs migrations, then long-polls Telegram (no RENDER_EXTERNAL_URL set)
```

Tests (needs a scratch Postgres reachable via `TEST_DATABASE_URL`, defaults to a local one):

```
npm test
```

## Deployment (Render)

`render.yaml` declares a single free-tier **Web Service** (`runtime: node`, `npm install` /
`npm start`) as a Blueprint. Render's free plan doesn't run Background Workers, so the process
detects it's on Render via `RENDER_EXTERNAL_URL` and switches to Telegram webhook mode instead of
long-polling (see Control loop above) — a plain `node:http` server on `PORT`, no framework needed.

Render's free plan also caps one Postgres instance per account, so this Blueprint takes
`DATABASE_URL` as a secret rather than provisioning its own — pointed at a free
[Neon](https://neon.tech) Postgres instance in this deployment. `runMigrations()` runs on every
boot and is idempotent (tracks applied files in `applied_migrations`), so a fresh database
self-seeds the schema and starter product catalog with no manual setup.

Secrets set in the Render dashboard (`sync: false`/`generateValue: true` in the blueprint — never
committed): `GOOGLE_GENERATIVE_AI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `DATABASE_URL`,
`TELEGRAM_WEBHOOK_SECRET` (auto-generated; hashed via SHA-256 before use as Telegram's
`secret_token`, since Telegram's allowed charset is narrower than Render's generated values).

## Getting the two credentials

**Telegram bot token** — open Telegram, message `@BotFather`, send `/newbot`, choose a display
name and a unique username ending in `bot`. BotFather replies with the token — set it as
`TELEGRAM_BOT_TOKEN`.

**Gemini API key** — sign in at [aistudio.google.com](https://aistudio.google.com) → Get API key →
Create API key — set it as `GOOGLE_GENERATIVE_AI_API_KEY`.

## Manual verification checklist

1. **Grounding** — ask the price of a SKU not yet added; bot must say it doesn't have it, never
   invent a number; `add_product` it; re-ask to confirm the price now traces to the DB.
2. **Oversell guard** — receive 5 units, try to bill 10 and finalize; expect a refusal naming the
   shortfall; stock unchanged.
3. **GST correctness** — bill a 0%-loose item and a 12%-packaged item together; finalize; pull the
   PDF; check CGST=SGST=6% on the packaged line, 0 on the loose line, total ties to the breakup.
4. **Multi-turn bill + edits** — start a bill, add several items, "drop the butter", "make it 6
   Maggi", view, finalize — stock unchanged until finalize.
5. **Idempotency** — restart the worker right after a finalize commits, before the reply sends;
   confirm exactly one finalized bill/decrement/invoice.
6. **Concurrency** — two near-simultaneous bills selling the last units of one SKU; total sold
   never exceeds stock.
7. **Guardrails** — sell below cost → confirmation prompt, not a silent sale; "delete stock" → bot
   explains there's no delete; payment for a nonexistent khata customer → not-found, no silent
   creation.
8. **Real artifacts** — request a PDF invoice and an analysis deck; confirm real `.pdf`/`.pptx`
   files arrive and the pptx charts are genuinely editable (Edit Data works in PowerPoint).
9. **Memory across sessions** — set a preference, `/new`, restart the worker, finalize a bill
   without naming a payment mode — the bot defaults per the stored preference.
