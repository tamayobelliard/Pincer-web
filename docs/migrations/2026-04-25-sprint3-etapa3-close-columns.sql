-- Sprint-3 Etapa 3 Commit 6: orders.close_reason + orders.close_note
-- Date: 2026-04-25
--
-- Scope: columnas para tracking de cierre manual de mesa en dashboard.
-- Commit 6 agrega botón "Cerrar Mesa" que permite a la cajera cerrar
-- una cuenta sin que el cliente haya solicitado (casos: pagó en efectivo
-- directo, abandonó, cancelada, etc.). La razón se captura para
-- auditoría y reporting futuro.
--
-- Ambas columnas nullable — orders cerradas vía "Marcar como Pagada"
-- (flow normal post-bill-requested) no usan estas columnas, solo
-- las cerradas manualmente vía "Cerrar Mesa" con dropdown de razón.
--
-- Valores canónicos esperados para close_reason:
--   'paid_cash'       — Pagó en efectivo
--   'paid_card_pos'   — Pagó con tarjeta (POS del restaurante)
--   'paid_pincer'     — Pagó con Pincer
--   'abandoned'       — Cliente abandonó sin pagar
--   'cancelled_wrong' — Cancelada (pedido equivocado)
--   'other'           — Otro (se combina con close_note)
--
-- No CHECK constraint — los valores son UX-layer, no crítico gate. Si
-- se introduce un typo, el reporte lo detectará sin romper la operación.
--
-- RLS: no requiere cambios. anon_update_orders ya es USING(true), así
-- el PATCH de close_reason + close_note desde el dashboard (anon key)
-- pasa la misma policy existente.

BEGIN;

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
  AND column_name IN ('close_reason', 'close_note')
ORDER BY column_name;

COMMIT;

-- Esperado post-migration:
--   orders.close_note    → text, YES nullable
--   orders.close_reason  → text, YES nullable
