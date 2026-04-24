-- Fix: tables.created_by_user_id era BIGINT, debe ser UUID
-- Date: 2026-04-24
--
-- Bug: POST /api/tables/create respondía 500 "Error al crear mesa".
-- Raw text de PostgREST:
--   invalid input syntax for type bigint: '383f171a-5760-483c-8544-61981a4ae13e'
--
-- Causa raíz: la migración original (sprint3-etapa2-tables, 2026-04-23)
-- declaró created_by_user_id BIGINT basándose en rls.sql:22 que documenta
-- restaurant_sessions.user_id como bigint. La realidad en producción es:
--   - restaurant_users.id              uuid
--   - admin_sessions.user_id           uuid
--   - restaurant_sessions.user_id      text (almacena UUIDs coercionados)
--   - tables.created_by_user_id        bigint  ← el bug
--
-- El session.user_id llega como string UUID-formateado desde el backend
-- (la cadena restaurant_users.id → restaurant_sessions.user_id). Postgres
-- intenta castearlo a bigint y falla.
--
-- rls.sql está desfasado respecto a prod (ver docs/backlog/rls-sql-schema-drift.md).
-- Esta migración corrige la columna al tipo correcto.
--
-- Seguro de aplicar: la tabla tables está vacía (active_count=0 confirmado
-- en la migration original; el INSERT fallido no commiteó ninguna row).
-- USING NULL es trivial — no hay data a preservar.

BEGIN;

-- ──────────────────────────────────────────────────────────────
-- 1. ALTER tipo de columna
-- ──────────────────────────────────────────────────────────────

ALTER TABLE tables
  ALTER COLUMN created_by_user_id TYPE UUID
  USING NULL;

-- ──────────────────────────────────────────────────────────────
-- 2. Verificación
-- ──────────────────────────────────────────────────────────────

SELECT column_name, data_type, udt_name
FROM information_schema.columns
WHERE table_schema='public'
  AND table_name='tables'
  AND column_name='created_by_user_id';

COMMIT;

-- Esperado post-migration:
--   column_name=created_by_user_id | data_type=uuid | udt_name=uuid
--
-- Post-aplicación, el endpoint /api/tables/create debería responder 200
-- con { success: true, id, table_number, qr_token, qr_url }.
--
-- No requiere cambio en el código — session.user_id ya es un string
-- UUID-formateado y Postgres lo acepta directo en una columna UUID.
