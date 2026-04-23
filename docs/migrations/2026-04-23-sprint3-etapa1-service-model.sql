-- Sprint-3 Etapa 1: fundación — service_model + service_charge + split_checks
-- Date: 2026-04-23
-- Scope: habilitar los 3 signals que gobiernan Sprint-3 dine-in cuenta
-- abierta. Esta migration es SOLO schema + config, sin UI de cliente.
-- Las etapas 2-6 construyen encima.
--
-- Decisiones producto confirmadas por founder:
--   D1 service_charge_percent — obligatorio 10% por ley DR en waiter_service.
--      CHECK 0-30 para permitir restaurantes que elijan menos (o más, raro).
--   D2 allow_split_checks — default true. Solo aplica si waiter_service.
--   Service model — prereq del doc docs/backlog/service-model-signal.md.
--
-- Known-issue #9 seguido: DROP VIEW + CREATE (no REPLACE). Más explícito
-- y evita problemas de column-order compatibility de CREATE OR REPLACE.
--
-- Ejecutar manualmente en Supabase SQL Editor. Idempotente (IF NOT EXISTS
-- en ALTER, IF EXISTS en DROP).

BEGIN;

-- ──────────────────────────────────────────────────────────────
-- 1. Agregar columnas a restaurant_users
-- ──────────────────────────────────────────────────────────────

ALTER TABLE restaurant_users
  ADD COLUMN IF NOT EXISTS service_model TEXT
    CHECK (service_model IN ('self_service', 'waiter_service'))
    DEFAULT 'self_service';

ALTER TABLE restaurant_users
  ADD COLUMN IF NOT EXISTS service_charge_percent INTEGER
    CHECK (service_charge_percent >= 0 AND service_charge_percent <= 30)
    DEFAULT 0;

ALTER TABLE restaurant_users
  ADD COLUMN IF NOT EXISTS allow_split_checks BOOLEAN
    NOT NULL DEFAULT true;

-- ──────────────────────────────────────────────────────────────
-- 2. Backfill — The Deck único restaurante con waiter_service
-- ──────────────────────────────────────────────────────────────

UPDATE restaurant_users
SET service_model = 'waiter_service',
    service_charge_percent = 10,
    allow_split_checks = true
WHERE restaurant_slug = 'thedeck';

-- Los 5 restaurantes restantes mantienen defaults (self_service, 0, true).

-- ──────────────────────────────────────────────────────────────
-- 3. Actualizar view restaurant_users_public
--
-- Patrón DROP + CREATE (no REPLACE) por known-issue #9 —
-- REPLACE requiere orden exacto de columnas preexistentes, lo
-- cual es frágil ante cambios de schema futuros. DROP+CREATE
-- es más explícito y deja la view nueva limpia.
--
-- CASCADE solo si alguna otra view/function dependa (hoy no hay).
-- ──────────────────────────────────────────────────────────────

DROP VIEW IF EXISTS restaurant_users_public CASCADE;

CREATE VIEW restaurant_users_public AS
SELECT
  id, username, restaurant_slug, display_name, role, status,
  business_type, address, phone, contact_name, email, hours,
  website, notes, chatbot_personality, logo_url, menu_style,
  menu_groups, plan, trial_expires_at, order_types, delivery_fee,
  prices_include_tax,
  service_model,
  service_charge_percent,
  allow_split_checks,
  created_at,
  (azul_merchant_id IS NOT NULL AND azul_merchant_id != '') AS payment_enabled
FROM restaurant_users;

GRANT SELECT ON restaurant_users_public TO anon;

-- ──────────────────────────────────────────────────────────────
-- 4. Verificación — estado final de los 6 restaurantes
-- ──────────────────────────────────────────────────────────────

SELECT
  restaurant_slug,
  display_name,
  business_type,
  service_model,
  service_charge_percent,
  allow_split_checks
FROM restaurant_users
WHERE restaurant_slug IS NOT NULL
ORDER BY restaurant_slug;

COMMIT;

-- Esperado post-migration:
--   holyharmonycafe     cafeteria       self_service       0   true
--   hummus              Food Court      self_service       0   true
--   mrsandwich          Food Truck      self_service       0   true
--   squareone           Restaurante     self_service       0   true
--   tastystoriescafe    Cafeteria       self_service       0   true
--   thedeck             Restaurante     waiter_service    10   true
--
-- Nota sobre squareone: es business_type Restaurante pero el founder
-- decidió explícitamente NO setearlo como waiter_service en este
-- backfill. Si Square One eventualmente quiere dine-in, se activa
-- manualmente vía admin form o dashboard settings post-Etapa 1.
