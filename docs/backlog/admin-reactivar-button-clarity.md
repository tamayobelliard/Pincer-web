# Backlog E — Botón "Reactivar" del admin: clarificar propósito

**Status:** Propuesta · **Autor:** 2026-04-24 · **Prioridad:** Baja (funcional hoy, ambiguo UX)

## Contexto

El botón `btn-toggle` en la lista de restaurantes del admin (`admin/index.html:877`) tiene label dinámico:

```js
// línea 861:
const toggleText = r.status === 'active' ? 'Suspender' : 'Reactivar';
```

Comportamiento (`toggleStatus` en línea 907):

```js
const newStatus = currentStatus === 'active' ? 'suspended' : 'active';
await PATCH(restaurants, { id, status: newStatus });
if (res.ok) {
  loadRestaurants();
  if (newStatus === 'active') showQR(id);   // auto-muestra QR al activar
}
```

El botón hace **tres cosas distintas** según el status actual:

| Status actual | Label mostrado | Acción | Uso real |
|---|---|---|---|
| `active` | "Suspender" | → `suspended` | Admin pausa un cliente (ej. impago) |
| `suspended` | "Reactivar" | → `active` | Admin reanuda el servicio |
| `demo` | "Reactivar" | → `active` | Shortcut — salta el flow "Pasar a Producción" |
| `pending`, `disabled` (legacy) | "Reactivar" | → `active` | Normalización de estados viejos |

**El QR auto-show** es la pista de diseño original: el botón fue concebido como "poner el restaurante en producción" (ver QR para imprimir). Pero evolucionó a ser un interruptor general que cubre 4 casos distintos sin distinguirlos.

## Problema observado

Founder hoy usa "Reactivar" sobre demos para saltarse la ceremonia de "Pasar a Producción" (el flow `btn-transfer` que pide email + genera password + manda welcome email). Eso:

- ✅ Para sus **propios test restaurantes** (ej. "Test Restaurante Borrar") → funcional, apropiado.
- ⚠️ Para **clientes reales en demo** → salta el welcome email y la asignación de email → cliente recibe acceso sin credenciales claras.

El flow "Pasar a Producción" (`btn-transfer`) hace lo correcto:
- Exige email + phone + contact
- Genera password nuevo
- Manda welcome email con credenciales
- Transita `demo → active` vía `handleTransferToProd`

Ambos botones viven en la misma card del restaurante hoy. No hay señalización de cuál usar cuándo.

## Propuestas (no excluyentes)

### Opción A: Labels distintos según contexto

Reemplazar el label genérico "Reactivar" por variantes según status origen:

```js
const toggleText =
  r.status === 'active'   ? 'Suspender' :
  r.status === 'demo'     ? 'Saltar a Activo (advanced)' :
  r.status === 'suspended' ? 'Reactivar' :
                             'Normalizar status';
```

Claridad inmediata, cero cambio de comportamiento. El founder sabe exactamente qué flow elegir.

### Opción B: Esconder el toggle para demos

```diff
- <button class="btn-toggle" onclick="toggleStatus(...)">${toggleText}</button>
+ ${r.status !== 'demo' ? `<button class="btn-toggle" ...>${toggleText}</button>` : ''}
```

Fuerza a usar "Pasar a Producción" para demos. Pros: no se salta la ceremonia. Cons: founder pierde el shortcut útil para sus propios tests (tendría que llenar email fake).

### Opción C: Confirmación al saltar ceremonia

Si el usuario hace click "Reactivar" sobre un demo, mostrar confirm:

```
Vas a activar "The Deck" sin enviar welcome email ni generar
credenciales nuevas. ¿Es un test interno o cliente real?

[Es test, continuar]  [Es cliente — usar 'Pasar a Producción']
```

Balance: preserva shortcut para tests, previene accidentes con clientes reales.

### Opción D: Renombrar el flow completo según lifecycle nuevo

Bajo el ciclo demo → trial → premium/basic (backlogs A y B), el botón puede reorganizarse:

| Status origen | Botón visible | Label | Acción |
|---|---|---|---|
| demo | "Entregar a cliente" | (btn-transfer existente) | demo → trial |
| demo | — | (sin shortcut toggle) | — |
| trial, premium | "Suspender" | btn-toggle | → suspended |
| basic | "Activar Premium" | nuevo botón | → premium |
| suspended | "Reactivar" | btn-toggle | → status anterior* |

*La transición de suspended a qué? Necesita saber cuál era el status antes de suspender. Agregaría `status_before_suspension TEXT` en la row, seteado al momento de suspender. Cuando se reactive, restaura ese valor. Si no hay valor → `active` como fallback legacy.

## Recomendación

**Opción A + C combinadas**, implementadas cuando se trabaje en backlog A. Son baratas, no rompen nada, y reducen ambigüedad para el founder. Opción D es la visión completa pero depende del lifecycle nuevo.

No hacer nada hoy — el botón funciona, el founder conoce su uso, hay trabajos de más valor primero.

## Decisiones abiertas

- **D1**: ¿Se aprueba opción A para labels dinámicos?
- **D2**: ¿Opción C (confirmación) vale la fricción UX o prefiere founder "shoot-from-the-hip"?
- **D3**: Cuando se implemente lifecycle A/B, ¿se aplica opción D completa o solo A?

## Impacto en código (si se implementan A + C)

- `admin/index.html` — 10 líneas: cambiar construcción de `toggleText` + agregar `confirm()` en `toggleStatus`

## No hacer

- Eliminar `btn-toggle` sin reemplazo — founder lo usa.
- Bloquear el shortcut de demo → active sin warning — pierde utilidad para tests.
- Renombrar "Pasar a Producción" antes de resolver lifecycle A — el nombre correcto es ambiguo fuera del modelo nuevo.
