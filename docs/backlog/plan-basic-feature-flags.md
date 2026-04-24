# Backlog C — Plan Basic: feature flags

**Status:** Propuesta inicial (founder revisa lista exacta) · **Autor:** 2026-04-24 · **Prioridad:** Media (requiere A y B para tener efecto)

## Contexto

Cuando un trial termina sin pago, el restaurante pasa a `status='basic'` (backlog B). `basic` = plan gratuito con features limitados. Este doc propone qué se limita — la lista final la decide el founder según trade-offs de retención vs valor del premium.

Principio: el plan basic **no debe desmotivar al cliente a seguir usando Pincer** (una alternativa gratis sigue siendo mejor que Rappi), pero debe dejar suficiente headroom para que upgradear a premium sea tentador.

## Features propuestos a bloquear en basic

| Feature | Status | Justificación bloqueo |
|---|---|---|
| **Mesero virtual con IA** (`/api/waiter-chat`) | ✂ Bloquear | Costo Anthropic real. Premium es lo que paga el AI. |
| **Dashboard AI** (`/api/chat`) | ✂ Bloquear | Mismo argumento. |
| **Weekly AI insights** (`/api/generate-insights`) | ✂ Bloquear | Cron cuesta tokens. Básicos ven sales, no AI summaries. |
| **Custom menu template** (ej thedeck) | ✂ Bloquear | Fuerza al generic template. Premium es el upsell visual. |
| **WhatsApp promo creation** (`/api/whatsapp-webhook`) | ✂ Bloquear | Twilio tiene costo. Premium incluye canal de marketing. |
| **Loyalty program** (cuando shippee) | ✂ Bloquear (quizás) | Feature de retención de cliente — premium incentive. |
| **Multi-promo carousel** (cuando shippee) | ✂ Bloquear (quizás) | 1 promo activa en basic, 3 en premium. |
| **Menu items con video** (cuando shippee) | ✂ Bloquear | Storage más caro. |
| **Analytics pixels integration** (cuando shippee) | ✂ Bloquear | Feature de marketing avanzado. |

| Feature | Status | Justificación NO bloqueo |
|---|---|---|
| **Core ordering** (menú público, cart, checkout) | ✓ Mantener | Es el producto. |
| **Payments vía Azul** | ✓ Mantener | Cobrar es el valor core. |
| **Push notifications dashboard** | ✓ Mantener | Barato, mejora UX. |
| **Shift management** | ✓ Mantener | Core ops. |
| **Reports (PDF shift close)** | ✓ Mantener | Core ops. |
| **Basic menu management** (productos CRUD) | ✓ Mantener | Core. |
| **Store open/closed toggle** | ✓ Mantener | Core ops. |
| **QR code** | ✓ Mantener | Sin QR no hay orden. |
| **Order types (dine_in/take_out/delivery)** | ✓ Mantener | Core. |

## Implementación técnica

### 1. Server-side gate helper

Agregar a `api/statuses.js`:

```js
// true si el restaurante tiene acceso a features premium
export function hasPremiumAccess(status) {
  return ['active', 'trial', 'premium'].includes(status);
  // 'demo' tiene acceso pre-entrega (prueba todo)
  // 'basic', 'grace' bloqueados de premium features
}
```

Cada endpoint premium-only llama el helper al top:

```js
// api/waiter-chat.js
const session = await verifyRestaurantSession(...);
if (!session.valid) return 403;
const status = await getRestaurantStatus(session.restaurant_slug);
if (!hasPremiumAccess(status)) {
  return res.status(403).json({
    success: false,
    error: 'Feature disponible en plan Premium',
    upgrade_url: `/${session.restaurant_slug}/dashboard?upgrade=true`
  });
}
```

Inlining status en la sesión sería ideal (evitar round-trip): cuando se crea la session en login, guardar `status` en `restaurant_sessions` o devolverlo al frontend. Scope de decisión futuro.

### 2. Client-side UX

Cuando el dashboard detecte `status='basic'`:
- Sidebar muestra features bloqueados grisáceos con candado 🔒
- Click en feature bloqueado → modal "Este feature es Premium · Upgrade" con CTA a WhatsApp del founder
- Banner persistente arriba: "Plan Basic · Upgrade a Premium para desbloquear AI + customización"

### 3. Menú público (cliente final)

Cuando `basic`:
- Custom template → genérico (ya lo manejaría `menu/index.html` vía rewrite condicional en `vercel.json`? O server-side check en la ruta). Implementación TBD.
- Sin pinzer chatbot (icono flotante oculto).
- Sin promo carousel premium — 1 promo simple si acaso.

### 4. DB query helpers

Crear `api/restaurant-plan.js` con:

```js
export async function getRestaurantPlan(slug, supabaseUrl, supabaseKey) {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/restaurant_users?restaurant_slug=eq.${slug}&select=status&limit=1`,
    { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0]?.status || null;
}
```

Y el helper `hasPremiumAccess` ahí también.

## Decisiones abiertas (founder revisa)

- **D1**: La lista de features arriba — ¿alguna que no estoy bloqueando y debería? ¿Alguna overkill?
- **D2**: ¿Basic puede mandar notificaciones push al dispositivo del dueño? (Firebase tiene costo pero casi nulo por device).
- **D3**: ¿Cuántos productos max en el menú para basic? Ejemplo "hasta 30 productos" vs premium ilimitado. Common SaaS pattern.
- **D4**: ¿Upgrade path es WhatsApp al founder (mantiene touch personal) o self-serve con pasarela? Si self-serve, requiere Stripe/PayPal/etc. — scope grande.

## Dependencias

- Backlog B: sin el cron que degrada a `basic`, ningún restaurante entra al flow.
- Backlog A: sin trial definido, no hay momento natural para el downgrade.

## Anti-patterns a evitar

- **No hacer features basic peores gratuitamente**. Premium debe ser upgrade, no "desbloqueo de lo normal".
- **No anunciar features basic en la landing**. La landing debe vender premium; basic es rescate post-trial.
- **No hacer el bloqueo hostil**. Un modal "🔒 Premium" con copy amable es mejor que "Acceso denegado".

## Testing plan

1. Cambiar un restaurante de prueba a `status='basic'` manualmente.
2. Login como ese restaurante → verificar que los features de la lista de bloqueo están deshabilitados (botón 🔒 en sidebar, modal al click, 403 en endpoints).
3. Verificar que los features mantenidos funcionan (ordering, payments, shifts, reports).
4. Verificar UX del upgrade CTA.
5. Cambiar a `status='premium'` → todo desbloqueado sin recargar (o con recarga, aceptable).
