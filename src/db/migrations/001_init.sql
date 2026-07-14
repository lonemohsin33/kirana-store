-- Kirana Ops Agent — initial schema.
-- Money = NUMERIC (never FLOAT). Quantities = NUMERIC(12,3) (loose goods are fractional kg).
-- No hard deletes anywhere: every mutating table is append-only or soft-deactivated.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE products (
  id                      BIGSERIAL PRIMARY KEY,
  sku_name                TEXT NOT NULL,
  brand                   TEXT,
  unit                    TEXT NOT NULL CHECK (unit IN ('kg','g','litre','ml','packet','dozen','piece')),
  is_loose                BOOLEAN NOT NULL DEFAULT false,
  hsn_code                TEXT NOT NULL,
  -- Classic multi-slab GST structure (0 / 0.25 / 3 / 5 / 12 / 18 / 28) as referenced in the brief's own
  -- domain description ("packaged staples 5%, FMCG like chocolates/soaps 12-18%").
  gst_rate                NUMERIC(5,2) NOT NULL CHECK (gst_rate IN (0,0.25,3,5,12,18,28)),
  price_is_tax_inclusive  BOOLEAN NOT NULL DEFAULT true,  -- true: packaged MRP goods; false: loose/quoted price
  cost_price              NUMERIC(12,2) NOT NULL CHECK (cost_price >= 0),
  sell_price              NUMERIC(12,2) NOT NULL CHECK (sell_price >= 0),  -- MRP for packaged goods
  stock_qty               NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (stock_qty >= 0),
  reorder_level           NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
  is_active               BOOLEAN NOT NULL DEFAULT true,  -- soft "discontinue"; never DELETE a product row
  search_aliases          TEXT[] NOT NULL DEFAULT '{}',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_products_name_trgm ON products USING gin (sku_name gin_trgm_ops);
CREATE INDEX idx_products_active ON products (is_active) WHERE is_active;

CREATE TABLE stock_ledger (
  id                BIGSERIAL PRIMARY KEY,
  product_id        BIGINT NOT NULL REFERENCES products(id),
  change_qty        NUMERIC(12,3) NOT NULL,
  reason            TEXT NOT NULL CHECK (reason IN ('stock_in','sale','adjustment','void_reversal')),
  reference_type    TEXT,
  reference_id      BIGINT,
  resulting_qty     NUMERIC(12,3) NOT NULL,
  telegram_chat_id  BIGINT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_stock_ledger_product ON stock_ledger (product_id, created_at DESC);

CREATE TABLE stock_in_events (
  id                  BIGSERIAL PRIMARY KEY,
  product_id          BIGINT NOT NULL REFERENCES products(id),
  qty                 NUMERIC(12,3) NOT NULL CHECK (qty > 0),
  cost_price          NUMERIC(12,2) NOT NULL CHECK (cost_price >= 0),
  mrp                 NUMERIC(12,2),
  telegram_chat_id    BIGINT NOT NULL,
  telegram_update_id  BIGINT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (telegram_update_id, product_id, qty, cost_price)
);

CREATE TABLE customers (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  phone       TEXT,
  balance     NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_customers_name_trgm ON customers USING gin (name gin_trgm_ops);

CREATE TABLE bills (
  id                  BIGSERIAL PRIMARY KEY,
  status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','finalized','void')),
  customer_id         BIGINT REFERENCES customers(id),
  telegram_chat_id    BIGINT NOT NULL,
  created_by          BIGINT NOT NULL,
  payment_mode        TEXT CHECK (payment_mode IN ('cash','upi','card','khata')),
  payment_reference   TEXT,
  subtotal            NUMERIC(12,2),
  total_cgst          NUMERIC(12,2),
  total_sgst          NUMERIC(12,2),
  grand_total         NUMERIC(12,2),
  telegram_update_id  BIGINT,
  finalized_at        TIMESTAMPTZ,
  voided_at           TIMESTAMPTZ,
  void_reason         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_bills_open_draft ON bills (telegram_chat_id) WHERE status = 'draft';
CREATE INDEX idx_bills_finalized_at ON bills (finalized_at) WHERE status = 'finalized';

CREATE TABLE bill_line_items (
  id                     BIGSERIAL PRIMARY KEY,
  bill_id                BIGINT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  product_id             BIGINT NOT NULL REFERENCES products(id),
  line_no                INT NOT NULL,
  qty                    NUMERIC(12,3) NOT NULL CHECK (qty > 0),
  unit_price             NUMERIC(12,2) NOT NULL,
  cost_price_snap        NUMERIC(12,2) NOT NULL,
  hsn_code               TEXT NOT NULL,
  gst_rate               NUMERIC(5,2) NOT NULL,
  price_is_tax_inclusive BOOLEAN NOT NULL,
  taxable_value          NUMERIC(12,2) NOT NULL,
  cgst_amount            NUMERIC(12,2) NOT NULL,
  sgst_amount            NUMERIC(12,2) NOT NULL,
  line_total             NUMERIC(12,2) NOT NULL,
  below_cost_confirmed   BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (bill_id, line_no)
);

CREATE TABLE khata_transactions (
  id                  BIGSERIAL PRIMARY KEY,
  customer_id         BIGINT NOT NULL REFERENCES customers(id),
  type                TEXT NOT NULL CHECK (type IN ('credit_sale','payment','adjustment')),
  amount              NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  bill_id             BIGINT REFERENCES bills(id),
  payment_mode        TEXT CHECK (payment_mode IN ('cash','upi','card')),
  payment_reference   TEXT,
  telegram_chat_id    BIGINT NOT NULL,
  telegram_update_id  BIGINT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (telegram_update_id, customer_id, type, amount)
);
CREATE INDEX idx_khata_customer ON khata_transactions (customer_id, created_at DESC);

CREATE TABLE owner_preferences (
  id                        BIGSERIAL PRIMARY KEY,
  telegram_chat_id          BIGINT NOT NULL UNIQUE,
  default_payment_mode      TEXT NOT NULL DEFAULT 'upi' CHECK (default_payment_mode IN ('cash','upi','card')),
  default_atta_product_id   BIGINT REFERENCES products(id),
  shop_name                 TEXT,
  gstin                     TEXT,
  shop_address              TEXT,
  shop_logo_file_id         TEXT,
  round_off_to_rupee        BOOLEAN NOT NULL DEFAULT false,
  extra                     JSONB NOT NULL DEFAULT '{}',
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE processed_updates (
  update_id         BIGINT PRIMARY KEY,
  telegram_chat_id  BIGINT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('processing','completed','failed')),
  result_summary    TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ
);

CREATE TABLE chat_sessions (
  telegram_chat_id      BIGINT PRIMARY KEY,
  active_draft_bill_id  BIGINT REFERENCES bills(id),
  last_activity_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Note: applied_migrations itself is created by scripts/runMigrations.ts before this file runs
-- (it has to exist before any migration can be tracked), not by this file.
