# Admin Economics — Vista de unit economics por restaurante

## Contexto y motivación

Founder quiere visibilidad completa de unit economics por
restaurante directamente en el dashboard admin, accesible con un
click. Esto es crítico para:

- Decisiones de pricing (qué planes ofrecer, en qué tier).
- Identificar restaurantes no rentables (alto uso de IA, bajo
  ingreso).
- Identificar restaurantes muy rentables (candidatos a upsell o
  referencia).
- Negociaciones de retención con clientes que amenazan churn.
- Visibilidad para inversionistas/cofounders en el futuro.
- Tomar decisiones de qué restaurantes priorizar en soporte.

Hoy hay ceguera completa: no se mide costo de IA por restaurante,
no hay vista consolidada de profit por cliente.

## Scope funcional

**Ubicación**: dashboard admin (super-admin de Pincer, no dashboard
del restaurante).

**Interacción**:
- Botón "Economics" o "💰 Economics" en cada card de restaurante
  listado en admin.
- Click → abre pop-up modal con análisis completo de ese
  restaurante específico.
- Vista mensual por default, con selector de rango (mes actual,
  mes anterior, últimos 30/60/90 días, año, custom).

### Contenido del pop-up

```
┌─────────────────────────────────────────────────────────┐
│  💰 Economics — {Restaurant Name}                       │
│  Período: Octubre 2026 (1-26)        [Selector rango]  │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  📊 RESUMEN                                             │
│  ┌──────────────────────────────────────────────────┐  │
│  │  Beneficio neto: RD$ +XX,XXX                     │  │
│  │  Margen: XX%                                     │  │
│  │  ROI: ~ X.X x                                    │  │
│  └──────────────────────────────────────────────────┘  │
│                                                         │
│  💵 INGRESOS (Revenue Pincer)                           │
│  ┌──────────────────────────────────────────────────┐  │
│  │  Plan mensual                  RD$ X,XXX         │  │
│  │  Comisiones por transacción    RD$ X,XXX         │  │
│  │     N órdenes × Y% promedio                      │  │
│  │  Add-ons / setup fees          RD$ XXX           │  │
│  │  ─────────────────────────                       │  │
│  │  Total ingresos                RD$ X,XXX         │  │
│  └──────────────────────────────────────────────────┘  │
│                                                         │
│  📉 COSTOS                                              │
│  ┌──────────────────────────────────────────────────┐  │
│  │  Infraestructura                                 │  │
│  │  ├─ Anthropic API (IA)         RD$ XXX           │  │
│  │  │   • Chatbot waiter:  X tokens                 │  │
│  │  │   • Chatbot general: X tokens                 │  │
│  │  │   • Insights/cron:   X tokens                 │  │
│  │  │   • Parse menu:      X tokens                 │  │
│  │  ├─ Supabase share*            RD$ XX            │  │
│  │  ├─ Vercel share*              RD$ XX            │  │
│  │  ├─ Twilio (WhatsApp)          RD$ X             │  │
│  │  ├─ Azul (gateway fees)        RD$ XX            │  │
│  │  ─────────────────────────                       │  │
│  │  Total infraestructura         RD$ XXX           │  │
│  │                                                  │  │
│  │  Operacionales (asignados)                       │  │
│  │  ├─ Soporte (estimado)         RD$ XX            │  │
│  │  ├─ Onboarding amortizado      RD$ XX            │  │
│  │  ─────────────────────────                       │  │
│  │  Total operacionales           RD$ XX            │  │
│  │                                                  │  │
│  │  TOTAL COSTOS                  RD$ X,XXX         │  │
│  └──────────────────────────────────────────────────┘  │
│                                                         │
│  📈 USO DETALLADO                                       │
│  ┌──────────────────────────────────────────────────┐  │
│  │  Órdenes procesadas                 N            │  │
│  │  Volumen transaccional      RD$ X,XXX,XXX        │  │
│  │  Conversaciones chatbot             X            │  │
│  │  Mensajes WhatsApp enviados         X            │  │
│  │  Mesas activas (si aplica)          N            │  │
│  └──────────────────────────────────────────────────┘  │
│                                                         │
│  📅 TENDENCIA (últimos 6 meses)                         │
│  [Mini-gráfico de profit por mes]                       │
│                                                         │
│  *Compartido entre clientes — método de prorrateo:      │
│   por volumen de uso (queries/storage/bandwidth)        │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

## Infraestructura técnica requerida

Datos a capturar (que hoy NO existen):

### 1. AI Usage (Anthropic API)

- Tabla nueva: `ai_usage`.
- Schema: `id, created_at, restaurant_slug, endpoint
  (waiter-chat/chat/generate-insights/parse-menu/pincer-chat),
  session_id (nullable), order_id (nullable), input_tokens,
  output_tokens, cache_read_tokens, cache_creation_tokens, model,
  estimated_cost_usd`.
- Hook en los 5 endpoints que llaman `api.anthropic.com`.
- Helper compartido `logAiUsage()` fire-and-forget.

### 2. Twilio Usage (WhatsApp)

- Tabla nueva o columna en notifications: `twilio_cost`.
- Capturar de Twilio response (tiene precio por mensaje).
- O calcular por count: N mensajes × $0.X promedio.

### 3. Azul Transaction Fees

- Ya hay registro de transacciones en `orders`.
- Calcular: `SUM(orders.total) × azul_fee_rate`.
- `azul_fee_rate` puede ser config global o por restaurante.

### 4. Supabase/Vercel costs (allocations)

- Costo total mensual conocido (factura).
- Prorratear por restaurante usando proxy: # de queries, # de
  orders, storage usado.
- Tabla `cost_allocation_config` con factores por servicio.

### 5. Plan revenue

- Ya existe en `restaurant_users.plan`.
- Multiplicar por monto del plan (config de pricing).

### 6. Setup/Add-ons

- Tabla nueva: `revenue_events`.
- Schema: `id, restaurant_slug, type
  (setup/addon/refund/etc), amount, currency, created_at,
  description`.

### 7. Operacionales (estimados)

- Configurables en admin (no medidos exactamente):
  - Soporte: $X por restaurante por mes.
  - Onboarding amortizado: $Y / 12 meses.

## Plan de implementación por fases

### Fase 1 — Captura de datos básicos (~3-4h)
- Migración SQL: tabla `ai_usage`.
- Helper `logAiUsage()` en `lib/`.
- Hook en los 5 endpoints.
- Migración SQL: `revenue_events`.
- Validar: datos empiezan a acumularse.

### Fase 2 — Cálculo de costos (~2h)
- Servicio en `api/admin/economics.js` (o similar).
- Función `calculateRestaurantEconomics(slug, dateRange)`.
- Calcular ingresos, costos infra, costos operacionales,
  beneficio neto, margen.
- Endpoint `GET /api/admin/economics?slug=X&from=Y&to=Z`.

### Fase 3 — UI en dashboard admin (~3h)
- Botón "💰 Economics" en cada card de restaurante.
- Modal con el contenido visual descrito arriba.
- Selector de rango temporal.
- Mini-gráfico de tendencia (Chart.js o similar).
- Loading states + error states.

### Fase 4 — Operacionales configurables (~1h)
- Sección admin: "Configuración de costos operacionales".
- Inputs: costo soporte/restaurante/mes, onboarding amortizado/
  mes, etc.
- Tabla `cost_config`.

### Fase 5 — Refinamiento iterativo (después de ver datos reales)
- Ajustar prorrateo de Supabase/Vercel basado en uso real.
- Agregar métricas adicionales que pidan stakeholders.
- Exportar a CSV / PDF.
- Comparativas entre restaurantes.

## Dependencias y consideraciones

- **Depende**: configuración correcta de pricing por plan en
  algún lugar central (puede estar duplicado hoy).
- **Depende**: tener facturas/costos de Supabase, Vercel,
  Anthropic, Twilio actualizados para prorratear.
- **Independiente**: del Sprint-3 dine-in (puede empezar después
  del demo).
- **Ideal**: 2-3 semanas de datos acumulados antes de mostrar el
  dashboard, para tener cifras reales no estimadas.

**Prioridad**: Alta — antes de escalar a 10+ restaurantes.
Visibilidad estratégica crítica para founder.

**Próximo paso**: Después del demo de The Deck, cuando founder
confirme bandwidth para sesión dedicada (~6-8 horas total para
Fases 1-4).

## Nota de diseño

El nombre "Economics" es claro y profesional, alineado con
terminología de SaaS/startup. Alternativas consideradas:
"Profitability", "Revenue & Costs", "Unit Economics" — todas
válidas pero más largas. "Economics" es conciso y sugiere
análisis integral.

## NO implementar ahora

Implementación en sesión dedicada futura.
