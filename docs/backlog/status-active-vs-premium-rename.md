# Backlog D — status 'active' legacy vs 'premium' rename

**Status:** Discusión · **Autor:** 2026-04-24 · **Prioridad:** Baja (decisión de limpieza semántica; no bloquea nada)

## Contexto

Los 4 restaurantes hoy en producción tienen:

| Restaurante | status actual | plan actual | Comentario |
|---|---|---|---|
| mrsandwich | `active` | premium (?) | Cliente real, pilotaje pagado |
| squareone | `active` | premium (?) | Cliente real |
| hummus | `active` | ? | Estado preciso TBD |
| thedeck | `active` (post-Reactivar manual) | ? | Primer cliente custom template |

En el ciclo de vida nuevo (`demo → trial → premium/basic`), `'active'` **no tiene lugar**. Los que están pagando serían `'premium'`; los que ya no pagan serían `'basic'`. Pero migrar los legacy puede romper cosas si no se hace con cuidado.

Dos preguntas separadas:
1. ¿Qué debería ser el `status` de los 4 restaurantes existentes en el nuevo modelo?
2. ¿Vale la pena hacer esa migración o aceptar `'active'` como sinónimo permanente de `'premium'` legacy?

## Opciones

### Opción 1: Migrar 'active' → 'premium'

Un UPDATE en DB:

```sql
UPDATE restaurant_users
SET status = 'premium'
WHERE status = 'active';
```

**Pros:**
- Una sola fuente de verdad — no hay "active" disuelto entre "premium y basic"
- El código puede eventualmente retirar `'active'` de `OPERATIONAL_STATUSES`
- Consistencia semántica

**Cons:**
- Requiere confirmar que los 4 restaurantes efectivamente están pagando (si alguno no paga, debería ir a `basic`)
- Cualquier dashboard/report/log que filtre por `status='active'` explícito (hay varios en admin/index.html) rompería sin un search & replace coordinado
- Ver sección "Code sites" abajo — hay 20+ referencias literales a `'active'`

### Opción 2: Mantener 'active' como alias permanente

`'active'` vive para siempre en `OPERATIONAL_STATUSES`, significando "legacy premium". Nuevos restaurantes usan el flow nuevo (`demo → trial → premium/basic`), legacy se queda con su status.

**Pros:**
- Zero riesgo de romper legacy
- Commit `de51910` ya aceptó `'active'` como status operacional
- No hay presión real — el sistema funciona

**Cons:**
- Complejidad semántica permanente: nuevo dev debe preguntar "¿por qué hay `active` y `premium` si son lo mismo?"
- Reports que quieran "% de clientes pagados" tienen que hacer `status IN ('active', 'premium')` en vez de un solo valor

### Opción 3: Migrar a 'premium' PERO solo al hacer otro cambio forzoso

Esperar a un momento donde ya estés tocando esos rows por otra razón (ej. agregando campo `has_paid_for_premium` del backlog B). Aprovechar el mismo script para limpiar status.

**Pros:**
- No dedicar un sprint a migración de nombres
- Cambio se valida en el contexto de otro cambio ya planeado

**Cons:**
- Puede quedar colgado indefinidamente si no hay otra razón para tocar los rows

## Code sites que referencian `'active'` literal

Grep count actual (excluyendo comentarios):

- `api/admin.js` — 7 sitios (SET en create/transfer + condiciones UI toggle)
- `api/auth.js` — 1 sitio (ya movido a OPERATIONAL_STATUSES_FILTER)
- `admin/index.html` — 6 sitios (render condicional: `r.status === 'active'`)
- `api/signup.js` — 1 sitio (SET on self-signup)

El refactor de filtros ya eliminó 10 usos. Los restantes son **writes** (SET) o **condicionales UI** (render `if status === 'active'`). Si migramos, estos sitios tienen que actualizarse todos:

| Sitio | Cambio |
|---|---|
| `api/admin.js:223` | `status: email ? 'active' : 'demo'` → `status: email ? 'premium' : 'demo'` (o `'trial'` si se adopta lifecycle A) |
| `api/admin.js:500` | `status: 'active'` en handleTransferToProd → `status: 'trial'` (per backlog A) |
| `api/signup.js:431` | `status: 'active'` → `status: 'premium'` (aunque self-signup probablemente debería ir a demo o trial según flujo) |
| `admin/index.html:861, 874, 875, etc` | `r.status === 'active'` → probablemente `'premium'`, pero con cuidado con los condicionales de UI (ej. "mostrar QR solo si active" — sería "mostrar QR si premium o trial") |

## Recomendación

**Opción 3** (esperar momento oportuno). Razonamiento:

1. El refactor `OPERATIONAL_STATUSES_FILTER` ya cubrió el dolor real (reads que filtraban narrow).
2. Los writes de `'active'` no bloquean nada hoy — crean rows que el filtro acepta.
3. La migración de nombres requiere coordinación con backlog A y B (porque cambian la semántica de qué-es-qué).
4. Hacerla aislada es riesgo sin upside inmediato.

**Trigger natural para migración:** cuando se implemente backlog B (cron expire-trials) y toquemos los rows de legacy para agregar `has_paid_for_premium`, aprovechar para UPDATE también `status`.

## Decisiones abiertas

- **D1**: ¿Founder prefiere opción 1 (limpieza inmediata) o 3 (diferida)? Respuesta esperada: 3.
- **D2**: Si opción 1: ¿los 4 legacy van todos a `'premium'`? (Hummus y thedeck estatus de pago incierto — puede ser basic.) Confirmar antes de UPDATE.

## Impacto en código (si se ejecuta la migración)

1. SQL migration: `UPDATE restaurant_users SET status='premium' WHERE status='active'`
2. `api/admin.js` — 2-3 sitios
3. `api/signup.js` — 1 sitio
4. `admin/index.html` — 6 sitios de render
5. (Opcional) `api/statuses.js` — quitar `'active'` de `OPERATIONAL_STATUSES`
6. (Opcional) DB CHECK constraint: quitar `'active'` de valores válidos

Después de ejecutado, `'active'` no debería existir en ningún row ni en ningún source file (excepto comments históricos).
