# Generic menu — known issues

Drift, bugs latentes, y decisiones arquitectónicas pendientes en `menu/index.html` y áreas relacionadas (views de DB, rls.sql, update-settings, etc.). Se actualiza cuando se detecta algo durante audits de parity u otro trabajo.

Política: cada entrada documenta **qué se observó**, **por qué no se resolvió en el momento** (scope, coordinación, riesgo), y **cuándo se debería volver**. No registramos bugs triviales — solo los que tienen potencial de explotar más adelante o que afectan decisiones de diseño.

---

## 1. update-settings silent reject (RESUELTO 2026-04-22 hotfix #1.1)

**Observado:** `api/update-settings.js:116` declaraba `order_types: 'string'` en el whitelist. El dashboard (`dashboard/index.html:4788`) envía un array. La validación `typeof body[key] !== expectedType` fallaba con 400, pero el server no emitía `console.error` — rechazos invisibles en Vercel logs. Tres restaurantes (thedeck, hummus, tastystoriescafe) quedaron con `order_types=['dine_in']` (default del signup) cuando el founder había configurado otra cosa desde UI.

**Resolución:** hotfix #1.1 introdujo:
- `isValidType(value, expected)` con soporte de `'array'` vía `Array.isArray`.
- `validateOrderTypes(value, allowedValues)` con enum enforcement.
- `console.error(JSON.stringify({ event, reason, restaurant_slug, field, ... }))` en cada rejection.

**Follow-up pendiente:** los otros 5 restaurantes pueden tener drift similar — founder decidió contactarlos post-deploy para re-guardar desde dashboard (no migración forzada). Solo The Deck se migró en `docs/migrations/2026-04-22-thedeck-order-types.sql`.

## 2. business_type case inconsistency

**Observado:** `holyharmonycafe` tiene `business_type = "cafeteria"` (lowercase) mientras `tastystoriescafe` tiene `"Cafeteria"` (Title Case). El filter de `menu/index.html:6398` (y su copia en thedeck) usaba `.includes()` case-sensitive con valores Title Case, así que la variante lowercase evadía el filter. Hoy no hay impacto porque holyharmonycafe tiene `payment_enabled=false` (el filter solo aplica con Azul activo), pero es un bug latente.

**Mitigación aplicada (hotfix #1.2):** filter case-insensitive en ambos archivos (`menu/index.html:6398` + `menu/templates/thedeck/index.html`). Normaliza el input con `(BUSINESS_TYPE || '').toLowerCase()`.

**Follow-up pendiente:** normalizar la data en DB (UPDATE restaurant_users SET business_type = CASE ... END). Se deja para cuando se revise UX del dashboard admin (el dropdown debería forzar un set fijo de valores canónicos).

## 3. `rls.sql` desactualizado vs view real en prod

**Observado:** `rls.sql:64` define `restaurant_users_public` con `WHERE status = 'active'`. Consulta en vivo retornó `thedeck` con `status='demo'`. Alguien editó el view en Supabase UI para aceptar `status IN ('active','demo')` y no actualizó `rls.sql`.

**Impacto:** bajo. El view en prod es más permisivo, no restrictivo. El problema es que `rls.sql` deja de ser fuente de verdad de la policy real.

**Resolución pendiente:** auditar todos los views/policies contra la DB live, sincronizar `rls.sql`. Idealmente, migraciones en `docs/migrations/` deberían ser la fuente de verdad y `rls.sql` reconstruirse desde ahí. Se agendará cuando se haga la próxima revisión de seguridad de RLS/views.

**Mitigación temporal:** TODO comment al tope de `rls.sql` referenciando este issue (hotfix #1.5).

## 4. Smoke test HTTP 200 da falsos positivos

**Observado:** `vercel.json` tiene rewrite `/:slug → /menu/index.html`. Sirve el HTML 200 incluso si el slug no existe en DB. Esto hace que `curl -w %{http_code} /anyslug` siempre diga 200. El test de 6 menús post-Commit-#1 validaba solo 4 reales + 2 páginas-con-outage (holyharmony, tastystories — los slugs reales son `holyharmonycafe` y `tastystoriescafe`).

**Impacto:** falso sentido de seguridad. Un smoke test puede decir "200" mientras el restaurante está totalmente roto.

**Resolución pendiente:** ampliar smoke test a verificar que el body contenga el `display_name` del restaurante o un sentinel conocido (`<title>`, elemento específico del DOM). Ejemplo:

```bash
curl -s /slug | grep -q "Mr. Sandwich" || echo "BROKEN"
```

Se aplicará en el próximo sprint cuando se agregue CI automation (hoy no hay CI de e2e).

## 5. Potential order_types drift en 5 restaurantes

**Observado:** consecuencia del issue #1. Los restaurantes cuya intención del founder no coincida con `order_types` en DB tienen drift. Identificados como sospechosos (signup default `['dine_in']` único): hummus (Food Court), tastystoriescafe (Cafeteria). Los otros (mrsandwich, squareone, holyharmonycafe) tienen valores plausibles pero no confirmados.

**Resolución pendiente:** founder contactará a cada restaurante post-deploy para re-guardar desde dashboard. Ahora que update-settings funciona, los saves persistirán. Si alguno necesita migración forzada, generar archivo SQL aparte.

## 7. Copy condicional de pago/retiro (RESUELTO 2026-04-22 sprint #6)

**Observado:** `dashboard/index.html:3891` y `:4053` generaban WhatsApp messages con "Pasa por la caja a pagar y recogerla" — copy de flujo dine-in legacy aplicado a pedidos take_out (donde no hay caja para el cliente). `menu/templates/thedeck/index.html:1001` tenía "Conserva este número para reclamar tu pedido en la mesa" — residuo del mismo legacy. `menu/index.html:5586` y `:5621` también tenían "Pasa a la caja" en receipt del cliente post-ready.

**Resolución:** Commit #6 del sprint de parity introdujo copy condicional basado en `payment_enabled` (frontend, global del restaurante) o `isPaid` (dashboard, per-order). Matriz completa documentada en CLAUDE.md → Plantillas custom → Regla #4. Aplica a 4 sitios: showConfirmation de thedeck (+ equivalente genérico futuro), showReadyBanner, status badge ready, dashboard WhatsApp message (2 sitios idénticos).

**Follow-up:** cuando se construya el flujo dine-in con cuenta abierta para restaurantes tipo Restaurante, la matriz necesita una fila adicional con el copy de cuenta cerrada. Hoy dine_in cae al mismo mensaje de take_out en el MVP (acceptable porque solo Food Truck/Cafetería/Bar/Panadería usan dine_in y ahí funciona como take_out).

## 11. [RESUELTO — 2026-04-23] Diagnóstico inicial incorrecto: era un crash silencioso en init() de thedeck

**Diagnóstico original (incorrecto):** atribuí el "auto-open no dispara" de Sprint-2 A4 a testing contamination con `sessionStorage.pincer_welcomed_<slug>` — "se seteó en testings previos, recomendación limpiar manualmente".

**Root cause real:** un `TypeError: Cannot read properties of null (reading 'style')` en `menu/templates/thedeck/index.html:2297` accediendo a `#menuLoading` que había sido wipeado 2 líneas antes por `renderSections` vía `main.innerHTML = sections.join('')`. Como `init` es `async`, la excepción se convertía en unhandled promise rejection y **abortaba silenciosamente todo el código subsecuente** — incluyendo `checkStoreOpen`, `applyClosedOverlay`, `initChatbot`, tracking, promo check, setInterval.

**Origen del bug:** commit `47aa31e feat(thedeck): wire Supabase product loading + dynamic tabs + outage fallback` — primer commit funcional del template custom, pre-Sprint-1. **Bug presente desde el día 1 de thedeck.**

**Bugs enmascarados** (diagnósticos previos que atribuyeron el síntoma a otra causa, cuando todos compartían esta raíz):
- Sprint-1 hotfix 3-capas (overlay + race condition + submit gate): las capas agregadas son robustez genuina que se preserva, pero el síntoma principal (orden #9 con store cerrado) se explica por `storeClosed` nunca se seteaba a true porque `checkStoreOpen` nunca corría.
- Sprint-2 A4 (auto-open chatbot): `initChatbot` nunca corría.
- Hotfix post-Sprint-2 Bug A (overlay pobre): `applyClosedOverlay` nunca corría, por eso no poblaba logo + footer + etc.
- Hotfix post-Sprint-2 Bug B (chatbot no auto-abre cerrado): el `setTimeout(openChat('auto'))` del `applyClosedOverlay` nunca encolaba.

**Resolución (commit 2026-04-23):**
1. Null-check defensivo en línea 2297: `const loadingEl = document.getElementById('menuLoading'); if (loadingEl) loadingEl.style.display = 'none';`.
2. Refactor `init()` → wrapper con try/catch global que loguea `console.error('[thedeck] init failed:', err)` y dispara `renderOutageFallback()` en caso de crash. Cubre cualquier crash futuro similar.
3. Código lógico real movido a `_initImpl()`. `init()` es solo el boundary de error handling.

**Lección (→ nueva regla en CLAUDE.md Regla #6):** funciones async init no deben fallar silenciosamente. Null-checks defensivos + try/catch global + fallback visible son requisitos — no opcionales.

**Capas defensivas agregadas en sprints previos se preservan** — son robustez genuina (fail-closed safety del store_settings, double-guard en submit, sync gate pre-await). Ninguna era innecesaria; el bug raíz simplemente enmascaraba la necesidad de verlas activar bajo condiciones limpias.

## 6. Cambios de comportamiento sutiles en #1.1

**Observado:** el hotfix #1.1 reemplazó `typeof body[key] !== expectedType` por `!isValidType(body[key], expectedType)`. La lógica es equivalente para string/boolean/array pero **más estricta para number**: `isValidType` agrega `&& Number.isFinite(value)`, por lo que rechaza `NaN` e `Infinity`.

**Antes:** `NaN`/`Infinity` pasaban la validación como `typeof === 'number'`. El único campo number del whitelist es `delivery_fee` (integer en DB), así que cualquier `NaN`/`Infinity` hubiera causado un 500 al momento del PATCH a Postgres.

**Ahora:** `NaN`/`Infinity` se rechazan con 400 + log structured (`reason: 'wrong_type', received_type: 'number'`). Cliente recibe mensaje de error inmediato en vez de 500 genérico.

**Impacto:** ninguno en uso normal — no existe setting donde `NaN`/`Infinity` sea intencional. Si algún cliente histórico había enviado accidentalmente `NaN` (por bug en frontend), antes fallaba con 500, ahora falla con 400 más informativo. Mejora estricta, no regresión.

**Documentado por completitud del audit** — si en el futuro alguien detecta un 400 inesperado en `delivery_fee`, buscar `update_settings_validation_rejected` con `received_type: 'number'` en Vercel logs.

## 8. ITBIS inflado ~18% en shift reports (RESUELTO Sprint-2 C5)

**Observado:** `dashboard/index.html:3520` y `api/shift-report.js:188` usaban `totalSales * 0.18` para calcular el ITBIS del shift. Esto aplica 18% sobre un total que YA incluía ITBIS → sobre-estimación consistente. El receipt del cliente (`menu/index.html:5458`) hace reverse math (`total - total/1.18`) y da el valor correcto; los dos lados reportaban números distintos para el mismo pedido.

**Detectado en:** Sprint-2 C1 (investigación ITBIS, 2026-04-22).

**Impacto numérico medido sobre orders reales:**
- thedeck: RD$487 → RD$413 (−17.92%)
- mrsandwich: RD$7,506 → RD$6,361 (−18.00%)
- squareone: RD$1,787 → RD$1,515 (−17.95%)

**Resolución:** Sprint-2 C5 cambió la fórmula a `totalSales - totalSales / 1.18` en ambos sitios. Simétrica post-C3 (donde `orders.total` = precio final cobrado). Tres sitios de ITBIS en la app ahora concuerdan: cliente receipt, dashboard UI, PDF del shift report.

**Nota contable:** el ITBIS real recaudado no cambia (el dinero salió del precio con tax incluido). Solo se corrige el reporte — venta neta sube proporcionalmente, que es la cifra correcta para presentar a contabilidad.

## 9. "CREATE OR REPLACE VIEW" requiere mantener orden exacto de columnas

**Observado:** Al correr la SQL migration de Sprint-2 C2 (agregar `prices_include_tax` a `restaurant_users_public`), el patrón `CREATE OR REPLACE VIEW` falla si el orden/tipo de las columnas existentes cambia — PostgreSQL exige que la nueva definición sea "compatible" con la anterior. La solución en C2 fue recrear el view respetando el orden original más la nueva columna al final.

**Impacto:** menor si se es cuidadoso, pero fácil de romper. Si alguien reordena columnas por legibilidad, el REPLACE falla con mensaje poco obvio.

**Pendiente:** para próximas migraciones de views, preferir `DROP VIEW` + `CREATE VIEW` cuando el view es read-only desde frontend (sin dependencias estructurales de DB tipo materialized view o views anidados). Es más explícito y evita confusión sobre por qué el REPLACE falla. Ejemplo de patrón a usar:

```sql
DROP VIEW IF EXISTS restaurant_users_public;
CREATE VIEW restaurant_users_public AS SELECT ... ;
GRANT SELECT ON restaurant_users_public TO anon;
```

El único costo es que durante ~milisegundos la view no existe, lo cual es aceptable para cualquier operación offline de migración (el frontend tiene fallback a `restaurant_users` directo en fetchRestaurantData).

## 10. Azul ITBIS cálculo asume prices_include_tax=true

**Observado:** `menu/index.html:4797` calcula `itbisCents = Math.round((total - total/1.18) * 100)` para el payload Azul. Post-Sprint-2 C3, `total` refleja el precio final (incluye ITBIS para ambos tipos de restaurante), así que la fórmula sigue siendo correcta para los 5 restaurantes con Azul activo — todos tienen `prices_include_tax=true`.

**Pendiente:** si algún restaurante con `prices_include_tax=false` activara Azul en el futuro (caso hipotético: thedeck decide aceptar pago upfront algún día), la fórmula seguiría funcionando porque `total` incluye el ITBIS sumado, pero el desglose granular (base vs ITBIS) sobre el delivery fee quedaría ligeramente distribuido. No es incorrecto — Azul acepta el amount total + el ITBIS extraído — pero conviene auditar el día que ocurra.

---

## Principios

- **Fuente de verdad**: `menu/index.html` es canonical para lógica funcional. Los templates custom en `menu/templates/<slug>/` solo difieren en visual. Cualquier bug en el genérico se registra acá si no se resuelve en el momento.
- **No silent rejects**: cualquier validación que rechace debe emitir log structured. Los silent 400s son uno de los anti-patterns más costosos (ver #1).
- **Data integrity primero**: si un bug de código causa drift de data, fijar el código + documentar la data drift + decidir migración caso-por-caso (forzada vs opt-in).
