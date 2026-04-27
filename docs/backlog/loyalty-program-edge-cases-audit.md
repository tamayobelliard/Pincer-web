# Loyalty Program — Audit de edge cases antes de escalar

## Contexto

El programa VIP Club (loyalty) está activo en producción para Mr.
Sandwich desde 2026-04-27 como pieza central del lanzamiento. La
infraestructura existe desde abril (commits `bd99d2f`, `b8940ca` +
hotfix `46eb617` que reintroduce la caja en el menú principal).

Antes de promocionarlo masivamente y replicarlo a otros restaurantes
(food park de Mr. Sandwich, Foodtropolis), revisar los riesgos
operacionales / de UX listados abajo. La mayoría no son bugs
funcionales sino casos de borde donde la experiencia del cliente
puede romperse silenciosamente.

## Riesgos identificados (ranking por impacto)

### 1. Trampa UX: progreso visible sin acumulación real

`api/loyalty-increment.js:53-55` rechaza incrementar si la orden no
tiene `azul_order_id`:

```js
if (!order.azul_order_id) {
  return res.status(200).json({ counted: false, reason: 'not_card_payment' });
}
```

Si un restaurante tiene `loyalty_config.is_active=true` pero
`payment_enabled=false` (caso actual de Mr. Sandwich hasta que se
configure Azul), el cliente ve la caja "VIP Club" en el menú,
tipea su teléfono, ve "0 / 10", coloca 5 órdenes, vuelve, sigue
viendo "0 / 10". **El cliente piensa que ganó puntos pero nunca
acumuló.** Frustración + pérdida de credibilidad.

**Mitigación propuesta:**
- (a) Bloquear render del UI si payment_enabled=false (la caja no
  aparece hasta que Azul esté activo).
- (b) Mostrar un mensaje informativo "Próximamente: paga con tarjeta
  para empezar a acumular" en lugar de "0/10".
- (c) Aceptar todas las órdenes con `status='paid'` (no solo Azul) —
  pero re-introduce el riesgo de fraude que justificó el guard
  original (10 órdenes fake sin pagar = cubano gratis).

**Decisión pendiente.** Más urgente cuando algún restaurante con
loyalty activo no tenga Azul wireado.

### 2. Sin expiración de balance

`loyalty_balance.orders_count` nunca expira. Cliente que ordenó 1
vez hace 6 meses sigue con 1 punto. Para siempre. Acumula liability
contable indefinida y dificulta forecasting.

**Mitigación:** agregar columna `last_order_at` (ya existe) +
política de expiración configurable por restaurante (ej. "puntos
expiran a los 90 días sin actividad"). Cron diario que decrementa o
resetea. Sub-tarea: comunicar la política al cliente.

### 3. Refunds y cancelaciones no decrementan

`decrement_loyalty` RPC existe (`rls.sql:366-372`) pero **ningún
endpoint lo llama**. Si una orden se cancela o reembolsa post-pago:
- El balance ya tiene el +1.
- `loyalty_counted=true` en `orders`.
- No hay reverse path automático.

**Vector de manipulación:** cliente paga 10 órdenes con tarjeta,
solicita refund de 5 (cualquier razón), llega a 10 acumulados,
redime el cubano gratis, neto: cubano gratis por 5 órdenes pagadas.
A volumen, costoso.

**Mitigación:** hook en flujo de void/refund que llame
`decrement_loyalty` + flippear `loyalty_counted=false`.
Probablemente en `api/admin.js` (donde se hacen voids manuales) o
en el flujo de Azul callback de refund.

### 4. Cliente no se entera cuando gana el reward

Hoy la única forma de que el cliente sepa que tiene un cubano gratis
disponible es volver al menú, tipear su teléfono y ver la caja
verde. Sin notificación push, WhatsApp, ni email.

**Mitigación:** cuando `increment_loyalty` cruza el umbral
(`orders_count % orders_needed === 0`), mandar mensaje WhatsApp
("¡Ganaste un Cubano gratis! Úsalo en tu próxima orden"). Bloqueado
por: Twilio production rollout (backlog #24 en CLAUDE.md).

### 5. Reward stockout

Si el `reward_product_id` (ej: `cubano`) tiene `sold_out=true` o
`active=false` en `products`, el flujo `addLoyaltyReward()` lo
agrega al cart de todos modos. El cliente llega a la caja, descubre
que no hay cubano hoy, queda mal.

**Mitigación:** validar disponibilidad del reward product antes de
mostrar el botón "Agregar gratis". Si no disponible, mostrar mensaje
"Reward temporalmente agotado, vuelve mañana".

### 6. UX no diferencia órdenes pequeñas de grandes

Cliente que ordena un solo refresco ($150) acumula igual que cliente
que pide cubano + papas + bebida ($1,200). Margen wildly variable.
Para Mr. Sandwich (premium aspiracional), esto puede ser estratégico
(volumen de visitas), pero a otros restaurantes les conviene
ponderar por monto.

**Mitigación opcional:** soportar `min_order_amount` en
`loyalty_config` (no acumula si `total < N`). O esquema de puntos
por monto en lugar de por conteo.

### 7. Sin admin UI para ajustes manuales

Si un cliente reclama "yo ordené 10 veces pero solo me cuenta 8"
(razón legítima: una orden con phone mal escrito), la única forma de
ajustar es vía SQL directo. Founder o staff sin acceso DB no pueden
resolver.

**Mitigación:** sección admin "Loyalty" con búsqueda por teléfono,
ver balance, botones "Agregar punto" / "Redimir reward" /
"Resetear balance". Audit log de cambios manuales.

### 8. Inconsistencia de formato de teléfono

`api/loyalty-increment.js` y `api/loyalty-progress.js` deben usar
exactamente el mismo `normalizePhone`. Si difieren (ej. uno strippea
country code +1, el otro no), un cliente puede tener 2 balances
separados para el mismo número humano.

**Mitigación:** auditar que ambos endpoints usan el helper
compartido. Test unitario que valide casos: `8095551234`,
`+18095551234`, `(809) 555-1234`, `1-809-555-1234`.

### 9. `qualifying_categories` silent fail

Si la config tiene categorías con typos (`"sandwhiches"` en lugar
de `"sandwiches"`) o sin manejar acentos correctamente, ninguna
orden califica. El sistema responde 200 OK con
`reason: 'no_qualifying_items'` y el cliente nunca acumula. Sin
log visible al admin.

**Mitigación:** validar al guardar `loyalty_config` que las
categorías existan en `products.category` distinct del restaurante.
Bloquear save si hay categorías inválidas.

### 10. Customer churn cross-restaurant

Pincer tiene cliente con teléfono X que frequenta Mr. Sandwich,
Square One y Hummus. Acumula loyalty independiente en cada uno
(filas distintas en `loyalty_balance` por `restaurant_slug + phone`).
Hoy no hay UX que diga "tienes 3 programas activos en Pincer". Es
oportunidad de cross-sell (ver loyalty global) pero también riesgo
de overload visual si se muestra todo junto.

**Mitigación:** v2 feature — perfil de cliente con todos sus
loyalty programs. No urgente.

### 11. Estado UI desincronizado entre ambas cajas (menú + modal)

`renderLoyaltyVipBox` itera sobre `.loyalty-vip-box` con
`querySelectorAll`. Si una caja se elimina/oculta dinámicamente
mientras la otra renderiza, podrían quedar visualmente
desincronizadas. Caso edge: cliente abre modal, llena teléfono, lo
borra antes de cerrar el modal — `_loyaltyRewardAdded=true` queda en
la caja del menú principal aunque el cart se haya limpiado.

**Mitigación:** mover `_loyaltyRewardAdded` a estado derivado del
cart (`order.some(i => i.source === 'loyalty')`) en lugar de flag
global. Render siempre re-deriva.

### 12. Caja visible cruzando session sin borrar

Si cliente llena teléfono, ve caja, cierra el browser sin ordenar,
vuelve mañana. localStorage tiene su teléfono guardado. La caja
aparece directamente al cargar (sin tipear). Estilo "stalker" si
el cliente nunca ordenó pero el sistema "lo recuerda".

**Mitigación menor:** clear `pincer_customer_<slug>.phone` después
de N días de inactividad. O agregar opt-out explícito. Probablemente
no es problema real.

## Recomendación de priorización

**Antes del lanzamiento masivo (Mr. Sandwich + food park):**
- #1 (trampa UX) — bloqueador si Azul no está wireado.
- #5 (stockout del reward) — fácil de prevenir, alto impacto en
  imagen.
- #9 (qualifying_categories silent fail) — bloqueante para
  configurar nuevos restaurantes sin tocar SQL.

**Durante las primeras 2-4 semanas post-lanzamiento:**
- #3 (decrement en refunds) — observar si hay fraude real antes de
  invertir en infra.
- #2 (expiración) — solo si el founder ve que el balance acumulado
  supera límites razonables.
- #4 (notificación al cliente) — bloqueado por Twilio production.

**Backlog largo plazo:**
- #6, #7, #8, #10, #11, #12.

## Verificación pre-launch sugerida

Antes de promocionar el VIP Club en redes (36k followers de Mr.
Sandwich):

1. ¿Mr. Sandwich tendrá `payment_enabled=true` en el momento del
   lanzamiento? **Si NO**, decidir mitigación de #1 antes.
2. Confirmar que el `reward_product_id="cubano"` está activo + no
   sold-out en `products`.
3. Hacer una orden completa real con tarjeta (Chef Elly o staff) y
   verificar end-to-end:
   - Caja aparece en menú principal con teléfono nuevo.
   - Caja muestra "0 → 1" después de la orden completada.
   - Verificar fila en `loyalty_balance`.
4. Hacer 10 órdenes con el mismo teléfono y validar redemption del
   cubano gratis.

## Referencia

- Archivos relevantes: `api/loyalty-increment.js`,
  `api/loyalty-progress.js`, `menu/index.html` (loyalty box +
  fetchLoyaltyProgress + renderLoyaltyVipBox + addLoyaltyReward),
  `rls.sql` (tablas + RPCs).
- Commits: `bd99d2f` (introducción Phase 2), `168a06b` (revert
  inline), `46eb617` (re-introducción inline + estrella, hotfix
  2026-04-27).
- Decisión arquitectural: el guard de fraude vive en el endpoint,
  no en el UI. Esto permite UI generosa (mostrar siempre) sin
  comprometer la integridad del balance.
