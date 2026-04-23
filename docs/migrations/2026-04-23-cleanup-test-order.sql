-- Cleanup: DELETE orden #9 de thedeck
-- Date: 2026-04-23
-- Contexto: Sprint-2 validación del founder encontró BUG 1 crítico —
-- thedeck permitió ordenar estando cerrado. La orden #9 (id=271, total
-- RD$80, customer RAFAEL BELLIARD / 8295481236) se coló por race
-- condition en checkStoreOpen. El commit que arregla el bug está
-- pusheado; esta orden de test se borra para no contaminar métricas
-- ni reportes de shift. Founder confirmó DELETE (no hay necesidad de
-- auditabilidad, es data de test).
--
-- Ejecutar manualmente en Supabase SQL Editor.
-- Idempotente: si ya se borró (no existe), el DELETE no hace nada.

BEGIN;

-- Verificación pre-delete
SELECT id, order_number, total, status, customer_name, phone, created_at
FROM orders
WHERE id = 271;
-- Esperado: 1 fila (o 0 si ya se borró)

-- Delete por id (no por order_number — order_number es por-restaurante,
-- no primary key, y evita colisión accidental con futuros order_number=9
-- de otros restaurantes).
DELETE FROM orders WHERE id = 271;

-- Verificación post-delete
SELECT id, order_number, total FROM orders WHERE id = 271;
-- Esperado: 0 filas

COMMIT;
