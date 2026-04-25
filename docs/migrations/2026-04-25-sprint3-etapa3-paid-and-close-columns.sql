-- Sprint-3 Etapa 3 Commit 6: orders.paid_at + close_reason + close_note
-- Date: 2026-04-25
--
-- Fix discovery: el commit original solo pedía close_reason + close_note,
-- pero el código del dashboard (ot_markPaid + ot_submitClose) también
-- escribe paid_at — el commit de código asumió que la columna existía
-- y no era así. PostgREST devuelve 400 al PATCH si una columna no
-- existe, así que el flow Marcar Pagada / Cerrar Mesa fallaba con
-- "ERROR 42703: column paid_at of relation orders does not exist".
--
-- Esta migración consolida las 3 columnas que necesita Commit 6:
--
--   paid_at         TIMESTAMPTZ  — cuándo se cerró/pagó la orden
--   close_reason    TEXT         — razón del cierre manual (dropdown)
--   close_note      TEXT         — nota libre opcional al cerrar
--
-- Patrón <estado>_at consistente con el resto de orders:
-- digitada_at (aceptada), lista_at (lista), notified_at (notificada),
-- voided_at (anulada), bill_requested_at (cuenta solicitada).
--
-- paid_at se setea cuando:
--   - Cajera click "Marcar como Pagada" en Mesa Abierta (post bill request)
--   - Cajera click "Cerrar Mesa" con razón del dropdown
--
-- Los 3 campos son nullable. Orders existentes pre-migration y orders
-- futuras pagadas vía Azul (que no pasan por este flow) los dejan NULL —
-- audit trail solo del flow nuevo de cierre manual desde el dashboard.
--
-- Valores canónicos esperados para close_reason:
--   'paid_cash'       — Pagó en efectivo
--   'paid_card_pos'   — Pagó con tarjeta (POS del restaurante)
--   'paid_pincer'     — Pagó con Pincer
--   'abandoned'       — Cliente abandonó sin pagar
--   'cancelled_wrong' — Cancelada (pedido equivocado)
--   'other'           — Otro (se combina con close_note)
--
-- No CHECK constraint sobre close_reason — los valores son UX-layer.
-- Si se introduce un typo, el reporte lo detectará sin romper la operación.
--
-- RLS: no requiere cambios. anon_update_orders ya es USING(true), el
-- PATCH desde dashboard (anon key) pasa la policy existente para los
-- 3 campos nuevos.

BEGIN;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS close_reason TEXT;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS close_note TEXT;

-- ──────────────────────────────────────────────────────────────
-- Verificación
-- ──────────────────────────────────────────────────────────────

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema='public' AND table_name='orders'
  AND column_name IN ('paid_at', 'close_reason', 'close_note')
ORDER BY column_name;

COMMIT;

-- Esperado post-migration: 3 filas
--   close_note    → text,                          YES nullable
--   close_reason  → text,                          YES nullable
--   paid_at       → timestamp with time zone,      YES nullable
