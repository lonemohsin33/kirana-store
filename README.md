# Supermarket Ops Agent — Kirana Ops Bot

**Telegram bot:** `@<fill-in-after-deploy>_bot` (kept running on Render for review)

A conversational agent that runs a small Indian kirana store end-to-end through Telegram —
receiving stock, cutting GST-correct bills, running khata (customer credit), closing the day, and
generating PDF invoices / PPTX analysis decks. The model orchestrates a designed tool surface;
there is no keyword/regex intent router anywhere in this codebase.

## Harness

**Claude Agent SDK for Python** (`claude-agent-sdk`). Chosen because the brief explicitly asks for
"skills and tools you author, the model orchestrates" rather than a hand-rolled tool-calling loop —
the SDK gives that for free (`ClaudeSDKClient`, `@tool`, `create_sdk_mcp_server`), and Python has
the strongest ecosystem for the two required artifacts: `reportlab` for the GST PDF invoice,
`python-pptx` for a deck with **real, editable chart objects** (not screenshots). The SDK shells
out to the `claude` CLI (Node) as a subprocess — the Dockerfile installs Node +
`@anthropic-ai/claude-code` alongside the Python deps for exactly this reason.

## Control loop

One long-running asyncio process, one Telegram long-poll loop, one `asyncpg` pool. Per update:
`processed_updates` (keyed on Telegram's `update_id`) is checked *before* the agent is invoked at
all — a true redelivery of an already-completed update is a full no-op. Otherwise the update is
routed to that chat's persistent `ClaudeSDKClient` (one per Telegram chat, held for the process
lifetime, giving natural multi-turn continuity), its response is streamed back, and the update is
marked complete. An `asyncio.Lock` per chat serializes turns within one chat while different chats
run fully concurrently against the shared DB pool — this is what the concurrency hard-part
actually exercises in `tests/test_concurrency.py`.

Postgres — not the SDK's own file-based session store, which isn't durable on Render's ephemeral
disk and isn't chat-keyed — is the durable memory layer: preferences, draft bills and every ledger
survive `/new` and a full process restart.

## Skill / tool design

Six thin, composable tool groups registered on one in-process MCP server (`app/tools/*.py`), each
backed by `app/db/queries/*.py` (owns the SQL) — no giant tool, no intent router:

| Group | Tools |
|---|---|
| Inventory | `lookup_products`, `get_stock_level`, `list_low_stock`, `get_reorder_suggestions`, `add_product`, `receive_stock`, `adjust_stock`, `update_product_price` |
| Billing (draft state machine) | `start_bill`, `add_bill_line`, `remove_bill_line`, `edit_bill_line`, `view_draft_bill`, `finalize_bill`, `void_bill` |
| Khata | `find_customer`, `create_customer`, `put_on_credit`, `record_khata_payment`, `get_khata_balance` |
| Reporting | `get_daily_summary` |
| Preferences | `get_preferences`, `set_preference` |
| Documents | `generate_invoice_pdf`, `generate_analysis_deck` |

A bill is a **DB-backed draft** (`bills.status='draft'` + `bill_line_items`), not conversation-held
state — Render can restart the worker mid-conversation, and a DB row is what makes `finalize_bill`
idempotently retryable at all. `add_bill_line`/`remove_bill_line` never touch stock; only
`finalize_bill` checks and decrements, atomically, exactly once.

## How each hard part is solved

- **Grounding** — `lookup_products`/`get_stock_level` are the only source of truth for price/GST/
  stock; the system prompt (`app/agent/system_prompt.py`) forbids stating a figure not just
  retrieved via a tool, and instructs the model to ask a clarifying question ("atta — loose or
  Aashirvaad 5kg?") when a lookup returns more than one close match.
- **Oversell guard** — enforced in `finalize_bill`'s transaction (`app/db/queries/bills.py`), not
  the prompt: all line-item product rows are locked (`SELECT ... FOR UPDATE ... ORDER BY id`,
  deterministic order so concurrent finalizes never deadlock), each line's qty is checked against
  the now-current `stock_qty`, and the whole transaction aborts with a structured
  `insufficient_stock` result (naming the exact shortfall) if any line would go negative — no
  partial finalize. Verified against a real concurrent-connection race in
  `tests/test_concurrency.py::test_two_concurrent_bills_never_oversell`.
- **GST correctness** — `app/gst.py` is pure, dependency-free, and unit-tested
  (`tests/test_gst.py`). Packaged MRP is tax-inclusive by law, so
  `taxable_value = unit_price / (1 + rate/100)`; loose goods are tax-exclusive. Each line's tax is
  rounded to 2dp first, then summed for the header (never rounded independently) so the invoice
  always ties to its own breakup; CGST/SGST split evenly with the rounding remainder absorbed by
  SGST so `cgst + sgst == total_tax` exactly.
- **Multi-turn bills with edits** — see draft-bill design above; `view_draft_bill` is the ground
  truth the model re-reads every turn instead of trusting its memory of the conversation.
- **Idempotency** — two layers. (1) `processed_updates` keyed on Telegram's `update_id`, checked
  before the agent runs at all. (2) Because a crash can leave an update `processing`-but-incomplete
  (legitimate reprocessing, not a dupe), every money/stock tool is *independently* idempotent:
  `finalize_bill`'s `draft→finalized` transition is guarded by a row lock, so a retry against an
  already-finalized bill returns the existing result rather than re-decrementing;
  `receive_stock`/khata calls carry `UNIQUE(telegram_update_id, ...)` constraints absorbed via
  `ON CONFLICT DO NOTHING`. Verified in `tests/test_idempotency.py`.
- **Concurrency** — every mutating tool call is exactly one short-lived transaction; nothing is
  ever held open across a Telegram message or an LLM turn, so a slow multi-turn conversation never
  blocks a concurrent bill or stock-in on the same SKU. See `tests/test_concurrency.py`.
- **Guardrails** — no `delete_*` tool exists anywhere (only `adjust_stock`, always logged, and
  soft-deactivate); the app's Postgres role has `DELETE` revoked on the core tables as
  defense-in-depth. Below-cost sales and stock adjustments require an explicit `confirm=true` the
  model may only set after the owner confirms in chat — the tool returns the risk description
  instead of mutating anything when `confirm` is false. `record_khata_payment` errors
  `customer_not_found` rather than silently creating a customer.
- **Real artifacts** — `generate_invoice_pdf` (reportlab) and `generate_analysis_deck`
  (python-pptx **native chart objects**, editable in PowerPoint, not screenshots) are pure
  functions of a `bill_id`/period → file path; the *dispatcher*, not the tool, calls Telegram's
  `sendDocument`, so tools never touch the Telegram API.
- **Memory across sessions** — `owner_preferences` (one row per chat) is read fresh into the
  system prompt every time a chat's `ClaudeSDKClient` is (re)built — on `/new` and on a cold
  process start after a Render restart alike — so standing preferences (default payment mode,
  default atta brand, shop name/GSTIN for invoices) survive both.

### A non-obvious SDK detail this design works around

The Agent SDK reads CLI messages on one long-lived background task started once at `connect()`;
incoming tool-call requests are spawned as child tasks *of that task*, not of whatever coroutine
called `client.query()` for a given turn. A `contextvar` set right before `query()` would not be
visible inside the tool handler. Instead, `app/agent/context.py` uses a small mutable `ChatState`
object, closed over by the tool closures at chat-client build time; the dispatcher's per-chat
`asyncio.Lock` guarantees only one turn is ever in flight per chat, so mutating
`state.current_update_id` immediately before `query()` is safe.

## Two stretch goals implemented

1. **Reorder suggestions from sales velocity** — `get_reorder_suggestions` computes days-of-stock-
   left from actual sale quantities over the trailing 14 days, not just a flat reorder-level
   breach (`app/db/queries/products.py`).
2. **Branded/templated invoice PDF** — the PDF header pulls shop name/GSTIN/address/logo from
   `owner_preferences`; the logo is a Telegram `file_id` fetched via `getFile` at render time and
   never persisted to disk.

## Running locally

```
python3.11 -m venv .venv && .venv/bin/pip install -r requirements.txt
npm install -g @anthropic-ai/claude-code   # the SDK shells out to this CLI
cp .env.example .env   # fill in ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN, DATABASE_URL
PYTHONPATH=. .venv/bin/python -m app.main
```

Tests (needs a scratch Postgres reachable via `TEST_DATABASE_URL`, defaults to a local one):

```
.venv/bin/python -m pytest tests/ -q
```

## Deployment (Render)

`render.yaml` declares a Docker-based background worker (Telegram long-polling needs no inbound
port) plus a managed Postgres instance, wired as a single blueprint. `Dockerfile` installs Node +
the Claude Code CLI alongside the Python deps. Set `ANTHROPIC_API_KEY` and `TELEGRAM_BOT_TOKEN` as
secrets in the Render dashboard (`sync: false` in the blueprint — they are never committed).

## Getting the two credentials

**Telegram bot token** — open Telegram, message `@BotFather`, send `/newbot`, choose a display
name and a unique username ending in `bot`. BotFather replies with the token — set it as
`TELEGRAM_BOT_TOKEN`.

**Anthropic API key** — sign in at console.anthropic.com → Settings → API Keys → Create Key — set
it as `ANTHROPIC_API_KEY`.

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
