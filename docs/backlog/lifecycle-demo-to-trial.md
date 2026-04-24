# Backlog A — Lifecycle transition: demo → trial

**Status:** Propuesta · **Autor:** 2026-04-24 (post Sprint-3 Etapa 1) · **Prioridad:** Alta (habilita el ciclo de vida real del cliente)

## Contexto

Hoy el admin tiene dos flows para marcar un restaurante como "vivo":

1. **Pasar a Producción** (`btn-transfer` → `handleTransferToProd` en `api/admin.js:461`)
   - Solo visible cuando `status='demo'`
   - Exige email del cliente + phone + contact
   - Genera password temporal nuevo
   - Manda welcome email con credenciales
   - Setea `status='active'` (legacy)

2. **Reactivar** (`btn-toggle`)
   - Polivalente: sirve para reactivar suspendidos, normalizar legacy, O graduar demos saltándose la ceremonia
   - Setea `status='active'` directo, sin email/password/welcome
   - Admin lo usa hoy como shortcut

Founder define el ciclo de vida real (no implementado):

```
creación (admin) ──> demo
                      │
                      │ "Entrega al cliente" (asigna email)
                      ↓
                    trial  (30 días premium gratis)
                      │
                      │ día 31, según pago
                      ↓
              ┌───────┴───────┐
           premium           basic
```

El status `'trial'` no existe hoy — ningún restaurante lo tiene, ningún endpoint lo escribe. Este doc propone la transición `demo → trial`.

## Propuesta

### 1. Schema

Ya existe `trial_expires_at` en `restaurant_users`. Confirmar que está populated correctamente hoy:

```sql
SELECT restaurant_slug, status, plan, trial_expires_at
FROM restaurant_users
WHERE trial_expires_at IS NOT NULL;
```

Posiblemente agregar `trial_starts_at TIMESTAMP WITH TIME ZONE` si queremos distinguir "cuándo empezó el trial" vs "cuándo expira" para reportes. `trial_expires_at = trial_starts_at + 30 days`.

CHECK constraint: `status IN ('demo', 'trial', 'premium', 'basic', 'active', 'suspended', 'disabled', 'pending')` — agregar si no existe.

### 2. Backend — extender `handleTransferToProd`

El endpoint ya hace 80% del trabajo. Solo cambia la transición de status:

```diff
- status: 'active',
+ status: 'trial',
+ trial_starts_at: new Date().toISOString(),
+ trial_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
```

El welcome email debería mencionar el trial explícitamente ("Tienes 30 días de premium gratis hasta el XX de XX").

**Alternativa:** renombrar el endpoint de `action=transfer` a `action=deliver-to-client` para que el nombre refleje la transición real. Hoy el verbo "transfer" en un sistema con multi-tenancy es ambiguo.

### 3. Admin UI — label del botón

`admin/index.html:874` — cambiar el label "Pasar a Producción" a "Entregar a cliente" o "Iniciar trial". Match con el verbo de negocio.

### 4. Dashboard — indicador visible del trial

Agregar un banner o chip en el header del dashboard del cliente:

> "Trial premium · Quedan 23 días"

Cambia de color cuando queden ≤ 5 días. Sin bloqueo, solo awareness.

### 5. Filtro `OPERATIONAL_STATUSES` ya listo

Commit `de51910` (2026-04-24) ya expandió el filtro a `in.(active,demo,trial,premium,basic)`. Cuando aparezca el primer restaurante en `status='trial'`, todo el read path lo trata igual que a `active`. No requiere tocar endpoints adicionales.

## Decisiones abiertas (pregunta founder)

- **D1**: ¿`trial_starts_at` nueva columna o derivar de `created_at` tras el transfer? Si los demos no llegan a trial siempre el mismo día que se crean, vale la pena separar.
- **D2**: ¿El flow "Reactivar" sigue existiendo para demos post-lifecycle? Ver backlog E.
- **D3**: ¿El email contact queda igual al del welcome original, o cambia copy para enfatizar trial?

## Dependencias

- Backlog B (trial → premium/basic): debe implementarse el mismo ciclo de trabajo para que los trials tengan destino claro al día 31.
- Backlog C (plan basic feature flags): define qué se bloquea para quien no pague.

## Impacto en código existente

- `api/admin.js` — handleTransferToProd (una línea)
- `admin/index.html` — label del botón (una línea)
- `dashboard/index.html` — banner trial (nuevo, ~30 líneas)
- SQL — migration para agregar `trial_starts_at` (si se adopta) + backfill

## Testing plan

1. Crear demo en admin → Entregar a cliente → verificar `status='trial'`, `trial_expires_at` = hoy + 30d.
2. Login como el trial → todas las features premium visibles/funcionales.
3. Banner aparece en dashboard con días correctos.
4. Welcome email tiene copy de trial.
