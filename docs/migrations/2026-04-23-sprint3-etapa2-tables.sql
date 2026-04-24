-- Sprint-3 Etapa 2: tables — identificación de mesa vía QR token
-- Date: 2026-04-23 (ejecución: 2026-04-24+)
-- Scope: nueva tabla `tables` que permite al dashboard generar un QR por
-- mesa. El menú cliente lee `?table=N&t=TOKEN` del URL y valida el token
-- para saber desde qué mesa proviene la orden. Esta migration es SOLO
-- schema + RLS + view pública — la UI + endpoints vienen en commits 2-4.
--
-- Decisiones:
--   D1 qr_token UNIQUE global (no solo por restaurante). Simplifica el
--      lookup en /api/tables/validate (un solo indice, sin falsos
--      positivos cross-tenant). 32 chars base62 → ~190 bits de entropía,
--      imposible de adivinar.
--   D2 unique (restaurant_slug, table_number) WHERE active=true.
--      Permite recrear una mesa con el mismo número después de desactivar
--      (caso: regenerar QR desde cero tras extravío). Las rows inactivas
--      quedan como audit trail.
--   D3 created_by_user_id BIGINT — match con restaurant_users.id y
--      restaurant_sessions.user_id (convención del schema existente).
--      Nullable: si el row se creó vía SQL seed o admin impersonate, no
--      tiene session de user concreto.
--   D4 qr_token NOT NULL + UNIQUE. Columna indexada para lookup O(1).
--   D5 restaurant_tables_public view (patrón known-issue #9, DROP+CREATE)
--      expone solo lo que el menú cliente necesita: id, slug, table_number,
--      qr_token, active. Grant SELECT al role anon.
--
-- Known-issue #9 seguido: DROP VIEW + CREATE (no REPLACE). Idempotente
-- vía IF NOT EXISTS (CREATE TABLE, indexes) + IF EXISTS (DROP VIEW).
--
-- Ejecutar manualmente en Supabase SQL Editor.

BEGIN;

-- ──────────────────────────────────────────────────────────────
-- 1. Tabla `tables`
-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tables (
  id                  BIGSERIAL PRIMARY KEY,
  restaurant_slug     TEXT NOT NULL,
  table_number        INTEGER NOT NULL CHECK (table_number > 0),
  qr_token            TEXT NOT NULL,
  active              BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_user_id  BIGINT,
  deactivated_at      TIMESTAMPTZ
);

-- qr_token único global — lookup directo en /api/tables/validate.
CREATE UNIQUE INDEX IF NOT EXISTS tables_qr_token_idx
  ON tables(qr_token);

-- Unique parcial: (slug, table_number) único solo entre activas.
-- Permite desactivar y recrear con el mismo número (ej. regenerar QR).
CREATE UNIQUE INDEX IF NOT EXISTS tables_slug_number_active_idx
  ON tables(restaurant_slug, table_number)
  WHERE active = true;

-- Índice adicional para listar mesas activas por restaurante.
CREATE INDEX IF NOT EXISTS tables_slug_active_idx
  ON tables(restaurant_slug)
  WHERE active = true;

-- ──────────────────────────────────────────────────────────────
-- 2. RLS — anon SELECT activas, writes denegados (via service role)
-- ──────────────────────────────────────────────────────────────

ALTER TABLE tables ENABLE ROW LEVEL SECURITY;

-- Anon puede leer mesas activas (menú cliente valida qr_token al cargar,
-- dashboard también puede leer via anon key si se quisiera — hoy todas
-- las reads van vía API con service role). El filtro WHERE active=true
-- previene exposición de rows desactivadas como audit trail.
DROP POLICY IF EXISTS "anon_select_tables" ON tables;
CREATE POLICY "anon_select_tables"
  ON tables FOR SELECT TO anon
  USING (active = true);

-- Todos los writes pasan por /api/tables/* con session auth + service role.
DROP POLICY IF EXISTS "deny_anon_insert_tables" ON tables;
CREATE POLICY "deny_anon_insert_tables"
  ON tables FOR INSERT TO anon
  WITH CHECK (false);

DROP POLICY IF EXISTS "deny_anon_update_tables" ON tables;
CREATE POLICY "deny_anon_update_tables"
  ON tables FOR UPDATE TO anon
  USING (false);

DROP POLICY IF EXISTS "deny_anon_delete_tables" ON tables;
CREATE POLICY "deny_anon_delete_tables"
  ON tables FOR DELETE TO anon
  USING (false);

-- ──────────────────────────────────────────────────────────────
-- 3. View pública restaurant_tables_public
--
-- Expone solo columnas operacionales (no created_by_user_id ni
-- deactivated_at — son internas). Filtrada a activas.
--
-- DROP + CREATE (no REPLACE) por known-issue #9.
-- ──────────────────────────────────────────────────────────────

DROP VIEW IF EXISTS restaurant_tables_public CASCADE;

CREATE VIEW restaurant_tables_public AS
SELECT
  id,
  restaurant_slug,
  table_number,
  qr_token,
  active
FROM tables
WHERE active = true;

GRANT SELECT ON restaurant_tables_public TO anon;

-- ──────────────────────────────────────────────────────────────
-- 4. Verificación — estructura inicial (vacía, los restaurantes crearán
--    sus mesas via dashboard).
-- ──────────────────────────────────────────────────────────────

SELECT
  'tables' AS table_name,
  COUNT(*) AS row_count,
  COUNT(*) FILTER (WHERE active = true) AS active_count
FROM tables;

-- Verificar que la view existe y está vacía todavía.
SELECT COUNT(*) AS public_rows FROM restaurant_tables_public;

COMMIT;

-- Esperado post-migration:
--   tables:                  row_count=0, active_count=0
--   restaurant_tables_public: public_rows=0
--
-- Post-migration el dashboard de The Deck (única con service_model=
-- waiter_service hoy) podrá crear mesas via la UI nueva en commit 3.
-- Los demás restaurantes (self_service) no verán la sección.
