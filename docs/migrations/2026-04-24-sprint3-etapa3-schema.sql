-- Sprint-3 Etapa 3 Commit 1 · Schema cuenta abierta
-- Date: 2026-04-24
--
-- Scope: dos columnas nullable sobre `orders` que habilitan el flow de
-- cuenta abierta dine-in de Etapa 3. Sin tabla nueva — una "cuenta" es
-- la agregación lógica de orders con mismo table_id + phone + status
-- NOT IN ('paid','cancelled').
--
-- Decisiones (founder 2026-04-24):
--   D1. customer_name obligatorio en el flow (validación cliente), pero
--       columna nullable en DB — orders pre-Etapa 3 no tienen nombre
--       y no queremos romperlas retroactivamente.
--   D2. bill_requested_at llenado vía UPDATE cuando el cliente toca
--       "Solicitar cuenta" en el menú. Nullable. Se limpia a NULL si
--       cancela la solicitud.
--   D3. Index parcial sobre (table_id, phone) WHERE bill_requested_at
--       IS NOT NULL — acelera la query del dashboard "órdenes con
--       solicitud activa" (uso más frecuente en el flow nuevo).
--   D4. RLS anon_update_orders ya es USING(true) — permite todos los
--       UPDATE de anon, incluyendo setear bill_requested_at. NO requiere
--       cambios. RLS anon_insert_orders ya valida (status, slug, table_id
--       consistency en commit 1cd81db); customer_name no necesita gate
--       adicional (es libre).

BEGIN;

-- ──────────────────────────────────────────────────────────────
-- 1. Columnas nuevas en orders
-- ──────────────────────────────────────────────────────────────

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS customer_name TEXT;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS bill_requested_at TIMESTAMPTZ;

-- ──────────────────────────────────────────────────────────────
-- 2. Index parcial — órdenes con solicitud de cuenta activa.
--    Usado por dashboard (/api no, directo via anon key) en el
--    Commit 4 de Etapa 3 para destacar mesas con cuenta pendiente.
-- ──────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_orders_bill_requested
  ON orders(table_id, phone)
  WHERE bill_requested_at IS NOT NULL;

-- ──────────────────────────────────────────────────────────────
-- 3. Verificación
-- ──────────────────────────────────────────────────────────────

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema='public' AND table_name='orders'
  AND column_name IN ('customer_name', 'bill_requested_at')
ORDER BY column_name;

SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename='orders' AND indexname='idx_orders_bill_requested';

COMMIT;

-- Esperado post-migration:
--   orders.bill_requested_at → timestamptz, YES nullable
--   orders.customer_name     → text,        YES nullable
--   idx_orders_bill_requested listado con su definición parcial
--
-- Próximo paso (Commit 1-B): menú cliente empieza a poblar
-- customer_name en el payload. Commit 1-C: dashboard lo displaya.
-- bill_requested_at queda inerte hasta Commit 3 de esta etapa.
