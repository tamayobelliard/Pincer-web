-- Migration: Agregar campo prices_include_tax a restaurant_users
-- Date: 2026-04-22
-- Sprint-2 C2 — feat campo de config fiscal + backfill.
-- Scope: restaurant_users. Los 5 restaurantes activos hoy tienen precios
-- que ya incluyen ITBIS (convención legacy). The Deck es la excepción
-- (precios sin ITBIS). Founder confirmó esto el 2026-04-22.
--
-- Default true cubre los 5 automáticamente. UPDATE explícito pone thedeck
-- en false. Cualquier restaurante nuevo creado después del deploy de
-- Sprint-2 C2 debe elegir el valor explícito en el admin form.
--
-- Idempotente: el ADD COLUMN IF NOT EXISTS maneja re-ejecución. El UPDATE
-- también (ponerlo en false dos veces no cambia nada).
--
-- Ejecutar manualmente en Supabase SQL Editor DESPUÉS del deploy del
-- sprint-2 C2 (para que el backend ya sepa qué hacer con el campo).
-- El frontend C3 lee el campo y condicionalmente muestra el desglose
-- ITBIS; si el campo no existe todavía, restaurantData.prices_include_tax
-- es undefined, que el código maneja con fallback a true.

BEGIN;

-- 1. Agregar columna con default true (todos los restaurantes existentes
--    asumen incluir ITBIS, que es la convención histórica del código).
ALTER TABLE restaurant_users
  ADD COLUMN IF NOT EXISTS prices_include_tax BOOLEAN NOT NULL DEFAULT true;

-- 2. Backfill: The Deck es la excepción — precios sin ITBIS.
UPDATE restaurant_users
SET prices_include_tax = false
WHERE restaurant_slug = 'thedeck';

-- 3. Agregar la columna al view público para que el frontend la pueda leer.
CREATE OR REPLACE VIEW restaurant_users_public AS
SELECT
  id, username, restaurant_slug, display_name, role, status,
  business_type, address, phone, contact_name, email, hours,
  website, notes, chatbot_personality, logo_url, menu_style,
  menu_groups, plan, trial_expires_at, order_types, delivery_fee,
  prices_include_tax,
  created_at,
  (azul_merchant_id IS NOT NULL AND azul_merchant_id != '') AS payment_enabled
FROM restaurant_users;
-- NOTA: el view original filtraba por status='active'. En prod hoy el
-- view acepta también 'demo' (drift detectado en known-issues #3).
-- Conservo ese comportamiento quitando el WHERE — thedeck (status='demo')
-- debe seguir leyéndose. Si eventualmente se cierra ese drift, volver
-- al WHERE status IN ('active','demo').

-- Re-grant necesario post-REPLACE
GRANT SELECT ON restaurant_users_public TO anon;

-- 4. Verificación: mostrar el estado de los 6 restaurantes.
SELECT restaurant_slug, display_name, prices_include_tax
FROM restaurant_users
WHERE restaurant_slug IS NOT NULL
ORDER BY restaurant_slug;

COMMIT;

-- Esperado post-migration:
--   holyharmonycafe     true
--   hummus              true
--   mrsandwich          true
--   squareone           true
--   tastystoriescafe    true
--   thedeck             false    ← único con precios sin ITBIS
