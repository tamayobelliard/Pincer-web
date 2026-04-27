# Código huérfano — close-day modal + confirmCloseDay

## Contexto

El dashboard tiene un modal "Cerrar Día" + función `confirmCloseDay`
que escribe `archived_date` a las órdenes completadas del día actual.
Esa función es el **único** writer de `archived_date` en todo el
codebase (verificado 2026-04-27).

El modal se abre con `openCloseDayModal()`. Esa función **no tiene
callers**. El botón "Cerrar Dia 📋" que la invocaba fue removido en
el commit `bfef2f1` ("Add shift system") cuando se migró el topbar
al sistema de turnos. Desde entonces el archivado vía botón es
inalcanzable desde la UI.

Los comentarios del código (líneas 4466-4467, 4584, 5252 — corregidos
en el commit que documenta este file) referenciaban este mecanismo
como si funcionara, lo que confundió el diagnóstico del bug de cards
no-limpiadas en The Deck (sprint-3 etapa 3, abril 2026).

## Estado actual del cleanup

Resuelto en commit `2026-04-27 fix(dashboard): replace storeOpenedAt
filter with calendar-day filter`. `loadOrders` ahora filtra
`created_at >= getTodayMidnightISO()` (medianoche hora DR), por lo
que las cards de días anteriores no aparecen en Mesas Abiertas ni
en Órdenes en Vivo aunque `archived_date` siga NULL.

`archived_date` queda como columna no-cero-data (Mr. Sandwich y
Square One sí tienen valores históricos del período pre-bfef2f1
cuando el botón existía), pero ya no se escribe ni afecta la UI
operativa.

## Decidir antes del próximo sprint operativo

**Opción A — Reactivar como botón manual.**
Agregar "📋 Archivar día" al sidebar o al menú de turno. Útil para:
- Cajera que quiere snapshot histórico explícito al cierre.
- Reportes que filtran por `archived_date` (no existe ninguno hoy).
- Auditoría visible: "este día se cerró formalmente a las X".

Costo: ~5 líneas (un botón + onclick existente).

**Opción B — Borrar todo lo huérfano.**
Eliminar `confirmCloseDay`, `openCloseDayModal`, `closeCloseDayModal`,
el HTML del `closeDayModal`, los CSS asociados, y eventualmente la
columna `archived_date` (vía migration). Reduce ruido cognitivo.

Costo: ~80 líneas borradas + 1 migration.

**Opción C — Dejar como está.**
Código muerto identificado y comentado. Cero costo. Riesgo: alguien
en el futuro vuelve a confundirse.

## Recomendación

Opción C ahora, Opción B cuando haya un sprint de cleanup. Opción A
solo si un cliente pide explícitamente la funcionalidad de archivado
manual.

## Referencias

- Bug investigado 2026-04-27 (cards de The Deck no se limpiaban).
- Diagnóstico: el "auto-archivado" creído por el founder no existía
  desde marzo. La limpieza real era el filtro de `storeOpenedAt`,
  que dependía de transiciones schedule/override y se rompía con
  override pegado.
- Commit del fix temporal: `fix(dashboard): replace storeOpenedAt
  filter with calendar-day filter`.
