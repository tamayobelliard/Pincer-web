-- Migration: Reorder The Deck menu categories + normalize names
-- Date: 2026-04-21
-- Scope: SOLO restaurant_slug='thedeck'. Cero impacto en los otros 5.
-- Trigger: categorías quedaron en orden incorrecto tras upload de menú
-- (vinos primero porque fue la primera foto procesada). Orden objetivo:
-- café → desayunos → comida → postres → cocteles → vinos.
--
-- Ejecutar manualmente en Supabase SQL Editor. Idempotente: si se corre
-- dos veces el segundo no hace cambio (las filas ya tienen los nombres
-- normalizados y el display_order final).
--
-- Post-migración, correr la query de verificación al final del archivo
-- para confirmar 30 categorías en el orden objetivo, 214 items total.

BEGIN;

-- ──────────────────────────────────────────────────────────────
-- 1. Normalizar ortografía
-- ──────────────────────────────────────────────────────────────

-- Quita el "..." trailing de 'PARA PICAR...' → 'PARA PICAR' (14 filas)
UPDATE products
SET category = 'PARA PICAR'
WHERE restaurant_slug = 'thedeck' AND category = 'PARA PICAR...';

-- Corrige el typo de plural: 'PLATOS FUERTE' → 'PLATOS FUERTES' (5 filas)
UPDATE products
SET category = 'PLATOS FUERTES'
WHERE restaurant_slug = 'thedeck' AND category = 'PLATOS FUERTE';

-- Las demás 28 categorías ya tienen ortografía correcta (tildes + ñ
-- verificados por codepoint Unicode en la inspección pre-migración).

-- ──────────────────────────────────────────────────────────────
-- 2. Reordenar display_order
-- Fórmula: new_display_order = (cat_rank * 1000) + within_rank.
-- Dentro de cada categoría preserva el orden actual (ORDER BY display_order
-- ASC en el ROW_NUMBER) — no mezcla items dentro de una categoría.
-- * 1000 da margen de sobra: cualquier categoría tiene máx 19 items hoy,
-- el upper bound teórico es 1000 items/categoría antes de colisionar
-- con la siguiente.
-- ──────────────────────────────────────────────────────────────

WITH ranked AS (
  SELECT id,
         CASE category
           WHEN 'COFFEE CORNER' THEN 1
           WHEN 'SMOOTHIES' THEN 2
           WHEN 'DETOX & BOOSTERS' THEN 3
           WHEN 'PROTEIN BOOST' THEN 4
           WHEN 'DESAYUNOS' THEN 5
           WHEN 'OMELETTE CORNER' THEN 6
           WHEN 'PARA PICAR' THEN 7
           WHEN 'QUESADILLAS Y NACHOS' THEN 8
           WHEN 'PANINIS' THEN 9
           WHEN 'WRAPS' THEN 10
           WHEN 'SANDWICHES' THEN 11
           WHEN 'BURRATAS' THEN 12
           WHEN 'ENSALADAS' THEN 13
           WHEN 'PLATOS FUERTES' THEN 14
           WHEN 'PASTAS' THEN 15
           WHEN 'ESPECIALIDADES' THEN 16
           WHEN 'SALMÓN' THEN 17
           WHEN 'CARNES' THEN 18
           WHEN 'MENÚ DE NIÑOS' THEN 19
           WHEN 'GUARNICIONES ESPECIALES' THEN 20
           WHEN 'POSTRES' THEN 21
           WHEN 'MENÚ DE COCTELES' THEN 22
           WHEN 'SANGRÍAS' THEN 23
           WHEN 'MARGARITAS' THEN 24
           WHEN 'MOJITOS' THEN 25
           WHEN 'CERVEZAS' THEN 26
           WHEN 'TINTOS' THEN 27
           WHEN 'BLANCOS' THEN 28
           WHEN 'ROSADOS' THEN 29
           WHEN 'ESPUMANTES' THEN 30
           ELSE 999  -- catch-all: cualquier categoría no listada va al final
                     -- (hoy son 0 esas; defensivo para futuro)
         END AS cat_rank,
         ROW_NUMBER() OVER (PARTITION BY category ORDER BY display_order ASC) AS within_rank
  FROM products
  WHERE restaurant_slug = 'thedeck'
)
UPDATE products p
SET display_order = (ranked.cat_rank * 1000) + ranked.within_rank
FROM ranked
WHERE p.id = ranked.id;

COMMIT;

-- ──────────────────────────────────────────────────────────────
-- 3. Verificación — debe retornar 30 filas en el orden objetivo
-- ──────────────────────────────────────────────────────────────
SELECT category, MIN(display_order) AS first_order, COUNT(*) AS items
FROM products
WHERE restaurant_slug = 'thedeck'
GROUP BY category
ORDER BY first_order;

-- Esperado:
--  #  category              first_order  items
--  1  COFFEE CORNER         1001         19
--  2  SMOOTHIES             2001         7
--  3  DETOX & BOOSTERS      3001         9
--  4  PROTEIN BOOST         4001         4
--  5  DESAYUNOS             5001         18
--  6  OMELETTE CORNER       6001         3
--  7  PARA PICAR            7001         14
--  8  QUESADILLAS Y NACHOS  8001         5
--  9  PANINIS               9001         4
-- 10  WRAPS                 10001        3
-- 11  SANDWICHES            11001        9
-- 12  BURRATAS              12001        3
-- 13  ENSALADAS             13001        14
-- 14  PLATOS FUERTES        14001        5
-- 15  PASTAS                15001        6
-- 16  ESPECIALIDADES        16001        8
-- 17  SALMÓN                17001        6
-- 18  CARNES                18001        2
-- 19  MENÚ DE NIÑOS         19001        4
-- 20  GUARNICIONES ESPECIALES 20001      7
-- 21  POSTRES               21001        6
-- 22  MENÚ DE COCTELES      22001        16
-- 23  SANGRÍAS              23001        5
-- 24  MARGARITAS            24001        2
-- 25  MOJITOS               25001        3
-- 26  CERVEZAS              26001        10
-- 27  TINTOS                27001        11
-- 28  BLANCOS               28001        5
-- 29  ROSADOS               29001        1
-- 30  ESPUMANTES            30001        5
--                                        ─────
-- Total: 30 categorías, 214 items.
