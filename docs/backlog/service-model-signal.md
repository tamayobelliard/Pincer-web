# Service model signal — waiters vs self-service

## Status
Planned — prereq para el flujo de cuentas abiertas (proyecto separado, piloto con The Deck).

## Motivación
Hoy Pincer trata todos los restaurantes como "ordena y paga de una vez" para cualquier `order_type`. Eso funciona para food trucks, cafeterías self-service, pickup y delivery. Pero **no aplica** a restaurantes con meseros que abren cuentas por mesa y cobran al final (flujo de The Deck y casi todo bar/restaurante formal).

Sin esta señal, no podemos rutear los pedidos al flow correcto cuando construyamos cuentas abiertas. Los dos flows son incompatibles a nivel de checkout, notificaciones, y dashboard — el dueño necesita ver un ticket abierto con items acumulándose, no pagos atomizados.

## La señal faltante
Cada restaurante tiene `order_types: ['dine_in' | 'take_out' | 'delivery']`. Eso dice **qué tipos de pedido** aceptan. No dice **cómo cobran cuando es dine_in**.

Falta: una indicación explícita de si el negocio usa meseros (service model = `waiter_service`) o es self-service / contra-pide (service model = `self_service`).

## Reglas de ruteo (canon)
Independiente del service model:
- `take_out` (pickup) → **ordena y paga de una vez**. Siempre.
- `delivery` → **ordena y paga de una vez**. Siempre.

Depende del service model (solo aplica a `dine_in`):
- `dine_in` + `self_service` → **ordena y paga de una vez** (flow actual).
- `dine_in` + `waiter_service` → **cuentas abiertas** (flow nuevo, OCR pendiente).

En el caso mixto (un restaurante que tiene meseros en mesa pero también hace pickup), cada pedido se rutea por su tipo: pickup inmediato, dine-in vía cuenta abierta.

## Cómo capturar el signal

**Opción A — checkbox simple en onboarding:**
`¿Hay meseros en el negocio que atienden la mesa? [Sí] [No]`

Mapea a columna boolean `has_waiters` en `restaurant_users` (o lo que sea la tabla de config post-refactor).

**Opción B — radio explícito con service_model:**
`¿Cómo toman órdenes sus clientes cuando están en el local?
- Piden directo en caja/counter, pagan y esperan (self-service)
- Un mesero toma la orden en la mesa y cobran al final (con cuentas abiertas)
- No aplica — no tenemos dine-in, solo pickup/delivery`

Tercera opción: N/A. El signal se ignora en ruteo si `order_types` no incluye `dine_in`.

**Recomendación:** Opción B. La A es ambigua cuando alguien contesta "Sí" pero en realidad es un contra-pide con repartidor a mesa. El radio forces claridad.

## Dónde añadir la pregunta

1. **`/admin` → Nuevo Cliente modal** (admin/index.html):
   - Campo nuevo después de "Tipo de negocio" y antes de "Dirección".
   - Pre-selección sugerida según `business_type`:
     - `Restaurante`, `Bar` → default `waiter_service`
     - `Cafetería`, `Food Truck`, `Panadería` → default `self_service`
     - Otro → sin pre-selección, obliga elegir
   - El admin puede override.

2. **Signup público** (signup/index.html):
   - Paso nuevo en el wizard.
   - Mismo texto + misma lógica de pre-selección.

3. **Editar restaurante** (mismo modal de admin en modo edit):
   - Campo editable igual que los otros. Cambio de self_service → waiter_service requerirá activación del flow de cuentas abiertas cuando exista.

## Schema

Propuesta mínima:

```sql
ALTER TABLE restaurant_users
  ADD COLUMN IF NOT EXISTS service_model TEXT
    CHECK (service_model IN ('self_service', 'waiter_service'))
    DEFAULT 'self_service';
```

`DEFAULT 'self_service'` mantiene backward compat (todos los restaurantes actuales se tratan como self-service, que es el flow actual — cero cambio de comportamiento para ellos).

Al hacer la migración multi-tenant real (si/cuando), el campo va a `restaurants` no a `users`.

## Frontend ruteo (cuando exista cuentas abiertas)

En `menu/index.html`, al determinar el flow de checkout:

```js
// Pseudocódigo
function decideFlow(orderType, serviceModel) {
  if (orderType !== 'dine_in') return 'pay_now';  // pickup/delivery siempre
  if (serviceModel === 'waiter_service') return 'open_tab';
  return 'pay_now';  // self_service default
}
```

La UI del menú/checkout cambia según el flow. Botones, textos, integración con la cuenta — todo eso es parte del proyecto de cuentas abiertas, no de este signal.

## Dependencia con The Deck
The Deck es el piloto de cuentas abiertas. Sin este signal capturado en su row, el flow de cuentas abiertas no sabe cuándo activarse vs el flow normal. Por lo tanto:

**Antes del demo a The Deck:** si el flow de cuentas abiertas está en desarrollo, el signal debe existir en DB para The Deck — aunque la UI de captura aún no esté lista (se inserta manualmente vía SQL por ahora).

**Antes de cerrar venta con The Deck:** la UI de captura debe estar lista, porque al transferir a producción el flow de cuentas abiertas debe activarse automáticamente.

## Costos
- Schema: 1 columna nueva, default backward-compat. Cero migración de datos.
- Admin UI: 1 campo nuevo + lógica de pre-selección. ~30 min.
- Signup UI: 1 paso nuevo en el wizard. ~30-60 min.
- Total: 1-2 horas trabajo antes de cuentas abiertas.

Aporte: desbloquea el flow correcto para el segmento full-service, que probablemente es el 60-70% del TAM real de Pincer en República Dominicana (restaurantes formales, bares, hotelería).

## Pre-requisitos para implementar
Ninguno. Se puede ejecutar hoy mismo si fuera prioridad. Actualmente se aplaza porque:
1. The Deck aún no ha visto el demo (no urgente hasta que ellos decidan seguir).
2. El flow de cuentas abiertas aún no existe (este signal sin ese flow no hace nada útil por sí solo — pero sin el signal el flow no puede ejecutar).

Cuando arranque el proyecto de cuentas abiertas, este doc es su primer paso.

## Cuándo ejecutar
Cuando Tamayo decida arrancar el flow de cuentas abiertas (probablemente ventana: después del demo exitoso con The Deck + compromiso del cliente de firmar). Hasta entonces: doc en el backlog, cero código.
