# Backlog B — Lifecycle transition: trial → premium o basic

**Status:** Propuesta · **Autor:** 2026-04-24 · **Prioridad:** Alta (bloquea la monetización real)

## Contexto

Backlog A propone `demo → trial` (30 días premium gratis). Este doc cubre qué pasa al día 31.

Dos rutas posibles:
- Cliente pagó → `status='premium'`
- Cliente NO pagó → `status='basic'` (features limitados, ver backlog C)

El cron existente `api/cron/downgrade-trials.js` maneja algo parecido en el modelo legacy:

```js
// Legacy query (hoy en producción):
// "restaurantes 'active' con plan='premium' cuyo trial expiró → plan='free'"
`?plan=eq.premium&trial_expires_at=lt.${now}&status=eq.active`
// Acción: plan: premium → free
```

Este cron **no funciona** para el ciclo nuevo porque:
1. No existe `status='trial'` hoy — su filtro sería inútil contra los trials.
2. El modelo nuevo mueve el signal de "plan" a "status" (plan se deprecaría o se reutilizaría para feature gating).
3. El downgrade nuevo va a `status='basic'`, no a `plan='free'`.

Por eso el commit `de51910` (OPERATIONAL_STATUSES refactor) dejó este cron deliberadamente sin tocar — requiere reescritura completa.

## Propuesta

### 1. Reescribir `api/cron/downgrade-trials.js` (o renombrar a `expire-trials.js`)

```js
// Query nueva:
`?status=eq.trial&trial_expires_at=lt.${now}&select=id,restaurant_slug,display_name,email,has_paid_for_premium`
```

**Campo nuevo `has_paid_for_premium BOOLEAN DEFAULT false`** en `restaurant_users`. Se actualiza cuando:
- Admin marca pago manualmente (stripe out of scope por ahora; DR payments son transferencia + foto del recibo)
- Hay un endpoint futuro que recibe webhooks de payment provider (backlog futuro)

Lógica del cron:

```js
for (const r of expired) {
  const newStatus = r.has_paid_for_premium ? 'premium' : 'basic';
  await patch(r.id, { status: newStatus });
  await sendEmail(r.email, subjectFor(newStatus), bodyFor(newStatus, r));
}
```

Emails distintos según transición:
- `trial → premium`: "Bienvenido a Premium. Sigues con todos los features."
- `trial → basic`: "Tu trial terminó. Tu cuenta pasó a plan gratuito. Los siguientes features se limitaron: [lista]. Para volver a premium: [link]."

### 2. Grace period

Founder mencionó considerarlo. Opciones:

- **Hard cutoff** (simple): día 31 → transición inmediata.
- **Grace 3-5 días** (cliente-friendly): día 31 → `status='grace'` (nuevo) por 5 días con banner de "pago pendiente", al día 36 → `basic` si no pagó.
- **Soft degradation**: mantiene premium pero banner cada vez más prominente hasta día 35.

**Recomiendo opción B** — añade un status más pero da margen real para cerrar el pago. Impacto: agregar `'grace'` a `OPERATIONAL_STATUSES` en `api/statuses.js` (una línea).

### 3. Upgrade manual posterior (basic → premium)

Cuando un basic finalmente paga, el admin necesita un botón "Activar premium" que:
- Setea `status='premium'`
- Setea `has_paid_for_premium=true`
- Manda email de bienvenida de vuelta a premium

UI: reutilizar el patrón del `btn-transfer` pero con copy distinto, visible solo para `status='basic'`.

### 4. Schedule del cron

Hoy corre **daily midnight** (`vercel.json`). Eso funciona para el ciclo nuevo también. La única diferencia es que muchos trials van a expirar el mismo día del mes (todos los trials iniciados un lunes expiran un lunes 30 días después) — considerar si eso causa picos de email. Con los volúmenes actuales (6 restaurantes, DR market) no es un problema.

## Decisiones abiertas

- **D1**: ¿Grace period sí o no? Si sí, 3 o 5 días.
- **D2**: `has_paid_for_premium` como campo booleano, o más rico (`premium_paid_until TIMESTAMP`)? Lo segundo permite renovaciones mensuales en el futuro.
- **D3**: Si el cliente paga mid-trial, ¿transición inmediata a `premium` (cutear el trial corto) o dejar que el trial corra sus 30 días (precio = bonus tiempo gratis)?

## Dependencias

- Backlog A (demo → trial): precondición, sin trials no hay qué expirar.
- Backlog C (basic feature flags): el downgrade a basic sin flags concretos no tiene efecto funcional — el cliente no notaría la degradación.

## Impacto en código

- `api/cron/downgrade-trials.js` — reescritura completa (~80 líneas)
- SQL — migration: agregar `has_paid_for_premium` (o `premium_paid_until`)
- `admin/index.html` — botón "Activar premium" para basics
- Email templates — 2 nuevos (trial→premium, trial→basic)
- `api/statuses.js` — agregar `'grace'` si se adopta opción B

## Testing plan

1. Crear trial con `trial_expires_at = yesterday`, `has_paid_for_premium=false` → correr cron manualmente → verificar `status='basic'` + email enviado.
2. Mismo caso con `has_paid_for_premium=true` → `status='premium'` + email correcto.
3. Grace period (si aplica): día 31 → `status='grace'`, día 36 → `status='basic'` si no pagó.
4. Flujo admin "Activar premium" sobre basic → `status='premium'`.
