-- Migration FIX: Reorder 4 categories that fell into ELSE 999 in the first run
-- Date: 2026-04-21 (follow-up to 2026-04-21-thedeck-categories.sql)
-- Scope: SOLO restaurant_slug='thedeck'. Cero impacto en los otros 5.
-- Trigger: el primer migration dejó 4 categorías con tilde/ñ en display_order
-- 999001 porque el CASE WHEN literal no hizo match por diferencia de
-- normalización Unicode entre el archivo SQL pegado y los valores en DB.
--
-- Fix: UPDATE correctivo que usa LIKE con patrones 100% ASCII (no depende
-- de NFC vs NFD). Cada una de las 4 categorías se identifica por un
-- prefijo/fragment ASCII único dentro de los 30 nombres.
--
-- Categorías afectadas + prefijo ASCII único:
--   SALMÓN           → 'SALM%'        → cat_rank 17
--   MENÚ DE NIÑOS    → 'MEN% DE NI%'  → cat_rank 19
--   MENÚ DE COCTELES → 'MEN% DE COCT%'→ cat_rank 22
--   SANGRÍAS         → 'SANGR%'       → cat_rank 23
--
-- Idempotente: si se corre dos veces el segundo no cambia nada (las filas
-- ya tienen el display_order correcto, el WHERE las excluye).

BEGIN;

WITH fix AS (
  SELECT id,
         CASE
           WHEN category LIKE 'SALM%'          THEN 17
           WHEN category LIKE 'MEN%DE NI%'     THEN 19
           WHEN category LIKE 'MEN%DE COCT%'   THEN 22
           WHEN category LIKE 'SANGR%'         THEN 23
         END AS cat_rank,
         ROW_NUMBER() OVER (PARTITION BY category ORDER BY display_order ASC) AS within_rank
  FROM products
  WHERE restaurant_slug = 'thedeck'
    AND display_order >= 999000
)
UPDATE products p
SET display_order = (fix.cat_rank * 1000) + fix.within_rank
FROM fix
WHERE p.id = fix.id
  AND fix.cat_rank IS NOT NULL;

COMMIT;

-- ──────────────────────────────────────────────────────────────
-- Verificación — debe retornar las 30 categorías con first_order
-- ascendente de 1001 a 30001, sin ningún 999001.
-- ──────────────────────────────────────────────────────────────
SELECT category, MIN(display_order) AS first_order, COUNT(*) AS items
FROM products
WHERE restaurant_slug = 'thedeck'
GROUP BY category
ORDER BY first_order;

-- Esperado (las 4 corregidas en negrita conceptual):
--  #  category                first_order  items
--  1  COFFEE CORNER           1001         19
--  2  SMOOTHIES               2001         7
--  3  DETOX & BOOSTERS        3001         9
--  4  PROTEIN BOOST           4001         4
--  5  DESAYUNOS               5001         18
--  6  OMELETTE CORNER         6001         3
--  7  PARA PICAR              7001         14
--  8  QUESADILLAS Y NACHOS    8001         5
--  9  PANINIS                 9001         4
-- 10  WRAPS                   10001        3
-- 11  SANDWICHES              11001        9
-- 12  BURRATAS                12001        3
-- 13  ENSALADAS               13001        14
-- 14  PLATOS FUERTES          14001        5
-- 15  PASTAS                  15001        6
-- 16  ESPECIALIDADES          16001        8
-- 17  SALMÓN                  17001        6    ← fix
-- 18  CARNES                  18001        2
-- 19  MENÚ DE NIÑOS           19001        4    ← fix
-- 20  GUARNICIONES ESPECIALES 20001        7
-- 21  POSTRES                 21001        6
-- 22  MENÚ DE COCTELES        22001        16   ← fix
-- 23  SANGRÍAS                23001        5    ← fix
-- 24  MARGARITAS              24001        2
-- 25  MOJITOS                 25001        3
-- 26  CERVEZAS                26001        10
-- 27  TINTOS                  27001        11
-- 28  BLANCOS                 28001        5
-- 29  ROSADOS                 29001        1
-- 30  ESPUMANTES              30001        5
--                                          ─────
-- Total: 30 categorías, 214 items. Ningún 999001.
