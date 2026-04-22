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

## 6. Cambios de comportamiento sutiles en #1.1

**Observado:** el hotfix #1.1 reemplazó `typeof body[key] !== expectedType` por `!isValidType(body[key], expectedType)`. La lógica es equivalente para string/boolean/array pero **más estricta para number**: `isValidType` agrega `&& Number.isFinite(value)`, por lo que rechaza `NaN` e `Infinity`.

**Antes:** `NaN`/`Infinity` pasaban la validación como `typeof === 'number'`. El único campo number del whitelist es `delivery_fee` (integer en DB), así que cualquier `NaN`/`Infinity` hubiera causado un 500 al momento del PATCH a Postgres.

**Ahora:** `NaN`/`Infinity` se rechazan con 400 + log structured (`reason: 'wrong_type', received_type: 'number'`). Cliente recibe mensaje de error inmediato en vez de 500 genérico.

**Impacto:** ninguno en uso normal — no existe setting donde `NaN`/`Infinity` sea intencional. Si algún cliente histórico había enviado accidentalmente `NaN` (por bug en frontend), antes fallaba con 500, ahora falla con 400 más informativo. Mejora estricta, no regresión.

**Documentado por completitud del audit** — si en el futuro alguien detecta un 400 inesperado en `delivery_fee`, buscar `update_settings_validation_rejected` con `received_type: 'number'` en Vercel logs.

---

## Principios

- **Fuente de verdad**: `menu/index.html` es canonical para lógica funcional. Los templates custom en `menu/templates/<slug>/` solo difieren en visual. Cualquier bug en el genérico se registra acá si no se resuelve en el momento.
- **No silent rejects**: cualquier validación que rechace debe emitir log structured. Los silent 400s son uno de los anti-patterns más costosos (ver #1).
- **Data integrity primero**: si un bug de código causa drift de data, fijar el código + documentar la data drift + decidir migración caso-por-caso (forzada vs opt-in).
