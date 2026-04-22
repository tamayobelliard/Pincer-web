-- Migration: Fix order_types para The Deck
-- Date: 2026-04-22
-- Scope: SOLO restaurant_slug='thedeck'. Cero impacto en los otros 5.
-- Trigger: Validación en prod (22 abr) reveló que el dashboard save de
--          order_types venía rechazándose silenciosamente por bug en
--          api/update-settings.js (whitelist declaraba 'string' pero el
--          dashboard envía array). El bug fue corregido en hotfix #1.1.
--          Sin embargo, la DB de The Deck quedó con el default del signup
--          ['dine_in'] cuando el founder configuró ['take_out'] desde UI.
--
-- Otros 5 restaurantes (mrsandwich, squareone, tastystoriescafe,
-- holyharmonycafe, hummus) pueden tener drift similar. Decisión del
-- founder (22 abr): NO migrar forzadamente — contactar a cada uno
-- post-deploy para que re-guarden desde el dashboard ahora que la
-- validación funciona. Solo The Deck se migra ahora porque hay evidencia
-- directa del problema.
--
-- Ejecutar manualmente en Supabase SQL Editor post-deploy del hotfix.
-- Idempotente: si se corre dos veces el segundo no hace cambio.

BEGIN;

-- Antes: mostrar el valor actual para auditoría
SELECT restaurant_slug, display_name, status, business_type, order_types
FROM restaurant_users
WHERE restaurant_slug = 'thedeck';
-- Esperado pre-migration: order_types = ['dine_in']

-- Update: alinear a la intención del founder
UPDATE restaurant_users
SET order_types = ARRAY['take_out']::text[]
WHERE restaurant_slug = 'thedeck';

-- Después: verificar el cambio
SELECT restaurant_slug, display_name, status, business_type, order_types
FROM restaurant_users
WHERE restaurant_slug = 'thedeck';
-- Esperado post-migration: order_types = ['take_out']

COMMIT;

-- ──────────────────────────────────────────────────────────────
-- Smoke test posterior al UPDATE:
-- 1. Abrir https://www.pincerweb.com/thedeck
-- 2. Agregar un item al carrito, abrir checkout
-- 3. Debe aparecer el campo "Nombre de quien recoge" (no estaba antes)
-- 4. Completar nombre + teléfono DR + submit
-- 5. En el dashboard de The Deck, la orden nueva debe mostrar
--    badge "🥡 PARA LLEVAR" (no "🍽️ COMER AQUÍ")
-- 6. El WhatsApp message debe decir "pasa a recogerla" (take-out),
--    no "pasa por caja a pagar" (dine-in).
-- ──────────────────────────────────────────────────────────────
