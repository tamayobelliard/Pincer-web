-- Sprint-3 Etapa 2 follow-up: orders.table_id + orders.table_number
-- Date: 2026-04-24
-- Scope: permitir que las órdenes dine-in identifiquen la mesa física
-- de origen. Sin estos campos, el dashboard no sabe a qué mesa llevar
-- la comida (bug reportado por founder al probar con celular real).
--
-- Decisiones:
--   D1 table_id BIGINT, SIN foreign key constraint. Soft reference.
--      Si la mesa se desactiva mientras hay órdenes pendientes, la FK
--      bloquearía el DELETE y romperia el flow. Preferimos que el
--      table_id quede apuntando a un row de `tables` inactivo.
--   D2 table_number INTEGER denormalizado. Evita JOIN en el dashboard
--      para mostrar "Mesa N" — y preserva el número histórico incluso
--      si la mesa se desactiva + recrea con otro número (poco probable
--      pero el invariante está cubierto).
--   D3 Ambos NULL para órdenes take_out/delivery. Retrocompatible —
--      órdenes pasadas no se tocan, nuevas órdenes no-dine_in las
--      dejan NULL.
--   D4 RLS anon_insert_orders actualizada para validar consistencia:
--      Si table_id IS NOT NULL:
--        - order_type DEBE ser 'dine_in'
--        - table_id DEBE existir en tables + estar active=true
--        - tables.restaurant_slug DEBE coincidir con orders.restaurant_slug
--      Si table_id IS NULL: permitido para cualquier order_type
--      (self_service sigue aceptando dine_in sin mesa, según diseño).
--
-- Conservado: status IN ('pending', 'paid') del check original (evita
-- que clientes marquen órdenes como 'accepted' o 'voided' directamente).
--
-- Ejecutar en Supabase SQL Editor.

BEGIN;

-- ──────────────────────────────────────────────────────────────
-- 1. Agregar columnas a orders
-- ──────────────────────────────────────────────────────────────

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS table_id BIGINT;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS table_number INTEGER;

-- ──────────────────────────────────────────────────────────────
-- 2. Índice para queries del dashboard por mesa (futuro Etapa 3
--    — cuenta abierta agrupa órdenes por table_id).
-- ──────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_orders_table_id
  ON orders(table_id)
  WHERE table_id IS NOT NULL;

-- ──────────────────────────────────────────────────────────────
-- 3. Actualizar RLS anon_insert_orders con validación referencial
--
-- DROP + CREATE explícito (no REPLACE) — PostgreSQL no soporta
-- CREATE OR REPLACE POLICY.
-- ──────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "anon_insert_orders" ON orders;

CREATE POLICY "anon_insert_orders"
  ON orders FOR INSERT TO anon
  WITH CHECK (
    restaurant_slug IS NOT NULL
    AND status IN ('pending', 'paid')
    AND (
      -- Caso A: sin table_id, cualquier order_type permitido
      -- (flow take_out/delivery + self_service dine_in).
      table_id IS NULL
      OR (
        -- Caso B: con table_id, debe ser dine_in + referencia válida
        -- a una mesa activa del mismo restaurante. Previene:
        --   - order_type='take_out' + table_id inventado
        --   - table_id de otro restaurante (cross-tenant)
        --   - table_id de mesa desactivada
        order_type = 'dine_in'
        AND EXISTS (
          SELECT 1 FROM tables t
          WHERE t.id = table_id
            AND t.restaurant_slug = orders.restaurant_slug
            AND t.active = true
        )
      )
    )
  );

-- ──────────────────────────────────────────────────────────────
-- 4. Verificación
-- ──────────────────────────────────────────────────────────────

SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema='public' AND table_name='orders'
  AND column_name IN ('table_id', 'table_number')
ORDER BY column_name;

SELECT policyname, cmd, with_check IS NOT NULL AS has_check
FROM pg_policies
WHERE tablename='orders' AND policyname='anon_insert_orders';

COMMIT;

-- Esperado post-migration:
--   orders.table_id        → bigint
--   orders.table_number    → integer
--   policy anon_insert_orders → has_check=true
--
-- Smoke tests manuales post-ejecución (via consola del browser):
--
-- 1. INSERT válido take_out (caso A, existente, debe seguir funcionando):
--      POST /rest/v1/orders { restaurant_slug:'thedeck', order_type:'take_out',
--                             status:'pending', items:'[]', total:100 }
--      → 201
--
-- 2. INSERT válido dine_in con mesa real:
--      POST /rest/v1/orders { ..., order_type:'dine_in', table_id:1,
--                             table_number:1, ...restaurant_slug:'thedeck' }
--      → 201 (donde 1 es un id real de tables con active=true)
--
-- 3. INSERT rechazado dine_in con table_id inventado:
--      POST /rest/v1/orders { ..., table_id:999999, ... }
--      → 403 (policy violation)
--
-- 4. INSERT rechazado take_out con table_id:
--      POST /rest/v1/orders { order_type:'take_out', table_id:1, ... }
--      → 403 (inconsistencia)
--
-- 5. INSERT rechazado cross-tenant:
--      POST /rest/v1/orders { restaurant_slug:'mrsandwich', order_type:'dine_in',
--                             table_id:1 }  -- mesa 1 es de thedeck
--      → 403
