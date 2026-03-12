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
