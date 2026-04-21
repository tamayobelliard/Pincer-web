-- ══════════════════════════════════════════════════════════════
-- Pincer — Supabase Row Level Security (RLS) Policies
-- Run this in Supabase SQL Editor after deploying the code changes.
-- Service role key bypasses RLS, so all api/ endpoints are unaffected.
-- These policies protect against direct anon key abuse.
-- ══════════════════════════════════════════════════════════════


-- ──────────────────────────────────────────────────────────────
-- 1. restaurant_sessions (NEW TABLE) — Service role only
-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS restaurant_sessions (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token           text NOT NULL UNIQUE,
  user_id         bigint NOT NULL,
  restaurant_slug text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_restaurant_sessions_token ON restaurant_sessions(token);
CREATE INDEX IF NOT EXISTS idx_restaurant_sessions_expires ON restaurant_sessions(expires_at);

ALTER TABLE restaurant_sessions ENABLE ROW LEVEL SECURITY;
-- No anon policies = anon key cannot access this table


-- ──────────────────────────────────────────────────────────────
-- 2. restaurant_users — Anon can SELECT active rows, no writes
-- ──────────────────────────────────────────────────────────────

ALTER TABLE restaurant_users ENABLE ROW LEVEL SECURITY;

-- Anon can read active restaurants (menu page + dashboard settings load)
CREATE POLICY "anon_select_restaurant_users"
  ON restaurant_users FOR SELECT TO anon
  USING (status = 'active');

-- Block all anon writes (all writes go through API with service role)
CREATE POLICY "deny_anon_insert_restaurant_users"
  ON restaurant_users FOR INSERT TO anon
  WITH CHECK (false);

CREATE POLICY "deny_anon_update_restaurant_users"
  ON restaurant_users FOR UPDATE TO anon
  USING (false);

CREATE POLICY "deny_anon_delete_restaurant_users"
  ON restaurant_users FOR DELETE TO anon
  USING (false);

-- Public view that strips sensitive columns
-- Access via: /rest/v1/restaurant_users_public
CREATE OR REPLACE VIEW restaurant_users_public AS
SELECT
  id, username, restaurant_slug, display_name, role, status,
  business_type, address, phone, contact_name, email, hours,
  website, notes, chatbot_personality, logo_url, menu_style,
  menu_groups, plan, trial_expires_at, order_types, delivery_fee,
  created_at,
  (azul_merchant_id IS NOT NULL AND azul_merchant_id != '') AS payment_enabled
FROM restaurant_users
WHERE status = 'active';

GRANT SELECT ON restaurant_users_public TO anon;


-- ──────────────────────────────────────────────────────────────
-- 3. products — Public read, anon writes (dashboard uses anon key)
-- ──────────────────────────────────────────────────────────────

ALTER TABLE products ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_select_products"
  ON products FOR SELECT TO anon
  USING (true);

-- Dashboard writes products via anon key (sold_out toggle, add/edit/delete)
CREATE POLICY "anon_insert_products"
  ON products FOR INSERT TO anon
  WITH CHECK (restaurant_slug IS NOT NULL);

CREATE POLICY "anon_update_products"
  ON products FOR UPDATE TO anon
  USING (true);

CREATE POLICY "anon_delete_products"
  ON products FOR DELETE TO anon
  USING (true);


-- ──────────────────────────────────────────────────────────────
-- 4. orders — Public read, anonymous insert (customers), dashboard update
-- ──────────────────────────────────────────────────────────────

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_select_orders"
  ON orders FOR SELECT TO anon
  USING (true);

-- Customers create orders — pending (normal) or paid (after payment)
CREATE POLICY "anon_insert_orders"
  ON orders FOR INSERT TO anon
  WITH CHECK (restaurant_slug IS NOT NULL AND status IN ('pending', 'paid'));

-- Dashboard updates order status
CREATE POLICY "anon_update_orders"
  ON orders FOR UPDATE TO anon
  USING (true);

-- No deletes via anon
CREATE POLICY "deny_anon_delete_orders"
  ON orders FOR DELETE TO anon
  USING (false);


-- ──────────────────────────────────────────────────────────────
-- 5. page_events — Service role only (via api/track.js)
-- ──────────────────────────────────────────────────────────────

ALTER TABLE page_events ENABLE ROW LEVEL SECURITY;
-- No anon policies = completely locked down


-- ──────────────────────────────────────────────────────────────
-- 6. chat_messages — Service role only (via api/waiter-chat.js)
-- ──────────────────────────────────────────────────────────────

ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
-- No anon policies = completely locked down


-- ──────────────────────────────────────────────────────────────
-- 7. store_settings — Public read, dashboard writes
-- ──────────────────────────────────────────────────────────────

ALTER TABLE store_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_select_store_settings"
  ON store_settings FOR SELECT TO anon
  USING (true);

CREATE POLICY "anon_insert_store_settings"
  ON store_settings FOR INSERT TO anon
  WITH CHECK (true);

CREATE POLICY "anon_update_store_settings"
  ON store_settings FOR UPDATE TO anon
  USING (true);

CREATE POLICY "deny_anon_delete_store_settings"
  ON store_settings FOR DELETE TO anon
  USING (false);


-- ──────────────────────────────────────────────────────────────
-- 8. fcm_tokens — Dashboard insert/upsert
-- ──────────────────────────────────────────────────────────────

ALTER TABLE fcm_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_insert_fcm_tokens"
  ON fcm_tokens FOR INSERT TO anon
  WITH CHECK (true);

-- Upsert requires UPDATE policy
CREATE POLICY "anon_update_fcm_tokens"
  ON fcm_tokens FOR UPDATE TO anon
  USING (true);


-- ──────────────────────────────────────────────────────────────
-- 9. admin_sessions — Service role only
-- ──────────────────────────────────────────────────────────────

ALTER TABLE admin_sessions ENABLE ROW LEVEL SECURITY;
-- No anon policies = completely locked down


-- ──────────────────────────────────────────────────────────────
-- 10. restaurant_insights — Public read only
-- ──────────────────────────────────────────────────────────────

ALTER TABLE restaurant_insights ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_select_restaurant_insights"
  ON restaurant_insights FOR SELECT TO anon
  USING (true);

CREATE POLICY "deny_anon_write_restaurant_insights"
  ON restaurant_insights FOR INSERT TO anon
  WITH CHECK (false);

CREATE POLICY "deny_anon_update_restaurant_insights"
  ON restaurant_insights FOR UPDATE TO anon
  USING (false);

CREATE POLICY "deny_anon_delete_restaurant_insights"
  ON restaurant_insights FOR DELETE TO anon
  USING (false);


-- ──────────────────────────────────────────────────────────────
-- 11. promotions — WhatsApp promo popup data
-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS promotions (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_slug text NOT NULL,
  is_active       boolean NOT NULL DEFAULT true,
  title           text NOT NULL,
  description     text,
  price           integer,
  original_price  integer,
  cta_text        text DEFAULT 'Ordenar Ahora',
  badge_text      text DEFAULT 'NUEVO',
  image_url       text,
  source_phone    text,
  wa_status       text DEFAULT 'published',
  product_id      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz
);

CREATE INDEX IF NOT EXISTS idx_promotions_active
  ON promotions (restaurant_slug) WHERE is_active = true;

ALTER TABLE promotions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_select_promotions"
  ON promotions FOR SELECT TO anon
  USING (true);

CREATE POLICY "deny_anon_insert_promotions"
  ON promotions FOR INSERT TO anon
  WITH CHECK (false);

CREATE POLICY "deny_anon_update_promotions"
  ON promotions FOR UPDATE TO anon
  USING (false);

CREATE POLICY "deny_anon_delete_promotions"
  ON promotions FOR DELETE TO anon
  USING (false);


-- ──────────────────────────────────────────────────────────────
-- 12. shifts — Sistema de turnos
-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS shifts (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_slug     text NOT NULL,
  nombre_encargado    text NOT NULL,
  turno               text NOT NULL DEFAULT 'personalizado',
  hora_inicio         timestamptz NOT NULL DEFAULT now(),
  hora_cierre         timestamptz,
  status              text NOT NULL DEFAULT 'abierto',
  total_ordenes       int DEFAULT 0,
  ordenes_completadas int DEFAULT 0,
  ordenes_canceladas  int DEFAULT 0,
  total_bruto         int DEFAULT 0,
  total_neto          int DEFAULT 0,
  fee_pincer          int DEFAULT 0,
  itbis               int DEFAULT 0,
  total_efectivo      int DEFAULT 0,
  total_tarjeta       int DEFAULT 0,
  total_delivery      int DEFAULT 0,
  total_pickup        int DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  closed_at           timestamptz
);

CREATE INDEX IF NOT EXISTS idx_shifts_active ON shifts(restaurant_slug) WHERE status = 'abierto';

ALTER TABLE shifts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_select_shifts"
  ON shifts FOR SELECT TO anon
  USING (true);

CREATE POLICY "anon_insert_shifts"
  ON shifts FOR INSERT TO anon
  WITH CHECK (restaurant_slug IS NOT NULL);

CREATE POLICY "anon_update_shifts"
  ON shifts FOR UPDATE TO anon
  USING (true);

CREATE POLICY "deny_anon_delete_shifts"
  ON shifts FOR DELETE TO anon
  USING (false);

-- Link orders to shifts
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shift_id bigint;

-- Voided orders timestamp (dashboard reject flow, Apr 15)
-- Set when an order is cancelled via the reject button, either by voiding
-- an Azul payment (api/void-payment.js) or cancelling a non-payment order
-- (direct PATCH from dashboard).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS voided_at timestamptz;

-- Voided items audit trail (Apr 15)
-- Comma-separated list of item names that were unavailable when the order
-- was rejected. Displayed on the voided order card so staff can see the reason.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS voided_items text;

-- Loyalty flag (Apr 16) — prevents double-counting in loyalty program
ALTER TABLE orders ADD COLUMN IF NOT EXISTS loyalty_counted BOOLEAN DEFAULT false;

-- ──────────────────────────────────────────────────────────────
-- LOYALTY PROGRAM tables (Apr 16)
-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS loyalty_config (
  restaurant_slug  TEXT PRIMARY KEY,
  program_name     TEXT NOT NULL DEFAULT 'VIP Club',
  orders_needed    INT NOT NULL DEFAULT 10,
  reward_product_id TEXT,
  reward_name      TEXT NOT NULL DEFAULT 'Reward',
  qualifying_categories JSONB NOT NULL DEFAULT '[]',
  is_active        BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE loyalty_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "deny_anon_all_loyalty_config"
  ON loyalty_config FOR ALL TO anon USING (false);

CREATE TABLE IF NOT EXISTS loyalty_balance (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_slug  TEXT NOT NULL,
  phone            TEXT NOT NULL,
  orders_count     INT NOT NULL DEFAULT 0,
  rewards_redeemed INT NOT NULL DEFAULT 0,
  last_order_at    TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(restaurant_slug, phone)
);

ALTER TABLE loyalty_balance ENABLE ROW LEVEL SECURITY;
CREATE POLICY "deny_anon_all_loyalty_balance"
  ON loyalty_balance FOR ALL TO anon USING (false);

CREATE INDEX IF NOT EXISTS idx_loyalty_balance_lookup
  ON loyalty_balance (restaurant_slug, phone);

-- Atomic RPCs for loyalty operations (race-condition-safe)
CREATE OR REPLACE FUNCTION increment_loyalty(p_slug TEXT, p_phone TEXT)
RETURNS INT LANGUAGE sql AS $$
  INSERT INTO loyalty_balance (restaurant_slug, phone, orders_count, last_order_at)
  VALUES (p_slug, p_phone, 1, now())
  ON CONFLICT (restaurant_slug, phone)
  DO UPDATE SET orders_count = loyalty_balance.orders_count + 1, last_order_at = now()
  RETURNING orders_count;
$$;

CREATE OR REPLACE FUNCTION decrement_loyalty(p_slug TEXT, p_phone TEXT)
RETURNS INT LANGUAGE sql AS $$
  UPDATE loyalty_balance
  SET orders_count = GREATEST(0, orders_count - 1)
  WHERE restaurant_slug = p_slug AND phone = p_phone
  RETURNING orders_count;
$$;

CREATE OR REPLACE FUNCTION redeem_loyalty(p_slug TEXT, p_phone TEXT)
RETURNS INT LANGUAGE sql AS $$
  UPDATE loyalty_balance
  SET rewards_redeemed = rewards_redeemed + 1
  WHERE restaurant_slug = p_slug AND phone = p_phone
  RETURNING rewards_redeemed;
$$;


-- ──────────────────────────────────────────────────────────────
-- Cleanup: Delete expired sessions (run periodically or add to cron)
-- ──────────────────────────────────────────────────────────────
-- DELETE FROM restaurant_sessions WHERE expires_at < now();
-- DELETE FROM admin_sessions WHERE expires_at < now();


-- ──────────────────────────────────────────────────────────────
-- Account lockout columns for brute-force protection
-- ──────────────────────────────────────────────────────────────
ALTER TABLE restaurant_users ADD COLUMN IF NOT EXISTS failed_login_attempts int NOT NULL DEFAULT 0;
ALTER TABLE restaurant_users ADD COLUMN IF NOT EXISTS locked_until timestamptz;


-- ──────────────────────────────────────────────────────────────
-- Distributed rate limiting table
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rate_limits (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key        text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_key_created ON rate_limits(key, created_at);

ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;
-- No anon policies = service role only

-- Cleanup: delete entries older than 5 minutes (run via cron)
-- DELETE FROM rate_limits WHERE created_at < now() - interval '5 minutes';


-- ──────────────────────────────────────────────────────────────
-- Session token hashing migration
-- Rename 'token' column to 'token_hash' and re-index
-- ──────────────────────────────────────────────────────────────

-- Restaurant sessions: rename token → token_hash
ALTER TABLE restaurant_sessions RENAME COLUMN token TO token_hash;
DROP INDEX IF EXISTS idx_restaurant_sessions_token;
CREATE INDEX IF NOT EXISTS idx_restaurant_sessions_token_hash ON restaurant_sessions(token_hash);

-- Admin sessions: rename token → token_hash
ALTER TABLE admin_sessions RENAME COLUMN token TO token_hash;
CREATE INDEX IF NOT EXISTS idx_admin_sessions_token_hash ON admin_sessions(token_hash);


-- ──────────────────────────────────────────────────────────────
-- Payment audit / fraud detection table
-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS payment_audit (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ip              text NOT NULL,
  card_last4      text,
  card_bin        text,
  restaurant_slug text,
  amount          integer DEFAULT 0,
  success         boolean NOT NULL DEFAULT false,
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_audit_ip_created ON payment_audit(ip, created_at);
CREATE INDEX IF NOT EXISTS idx_payment_audit_bin_created ON payment_audit(card_bin, created_at);

ALTER TABLE payment_audit ENABLE ROW LEVEL SECURITY;
-- No anon policies = service role only


-- ──────────────────────────────────────────────────────────────
-- sessions_3ds — 3DS 2.0 flow state per Azul payment session
-- Documentado retroactivamente (la tabla existía en Supabase pero no aqui).
-- Apr 17, 2026: añade azul_merchant_id para enrutar Continue/Callback
-- al merchant correcto en lugar de usar AZUL_MERCHANT_ID del env.
-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sessions_3ds (
  id                            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id                    text NOT NULL UNIQUE,
  azul_order_id                 text,
  custom_order_id               text,
  azul_merchant_id              text,
  status                        text NOT NULL DEFAULT 'initiated',
  method_notification_received  boolean NOT NULL DEFAULT false,
  cres                          text,
  final_response                jsonb,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now()
);

-- Si la tabla ya existía (schema drift pre-Apr 17), asegura que la columna nueva está:
ALTER TABLE sessions_3ds ADD COLUMN IF NOT EXISTS azul_merchant_id text;

CREATE INDEX IF NOT EXISTS idx_sessions_3ds_session_id ON sessions_3ds(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_3ds_created_at ON sessions_3ds(created_at);

ALTER TABLE sessions_3ds ENABLE ROW LEVEL SECURITY;
-- No anon policies = service role only


-- ──────────────────────────────────────────────────────────────
-- Custom menu templates — per-restaurant HTML/CSS (Apr 20, 2026)
-- Primer consumidor: The Deck (docs/the-deck-custom-template-plan.md).
-- ──────────────────────────────────────────────────────────────
ALTER TABLE restaurant_users
  ADD COLUMN IF NOT EXISTS custom_template BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE restaurant_users
  ADD COLUMN IF NOT EXISTS custom_template_path TEXT;

-- Notes on routing: el flag custom_template es advisory. El routing real
-- vive en vercel.json como rewrite especifico por slug ANTES del catch-all
-- /:slug -> /menu/index.html. Al agregar un custom template nuevo:
--   1. Crear menu/templates/<slug>/index.html.
--   2. Agregar rewrite { "source": "/<slug>", "destination": "/menu/templates/<slug>/index.html" }.
--   3. UPDATE restaurant_users SET custom_template=true, custom_template_path='<slug>' WHERE restaurant_slug='<slug>'.
-- Al remover: revert cada paso. El flag permite rollback desde DB sin redeploy
-- si el template se guarda como fallback/redirect en menu/index.html (opcional,
-- no implementado en el MVP).
