# The Deck — plan de implementación del template custom

**Status:** pendiente de aprobación. No ejecutar hasta "aprobado, procede".
**Autor:** Claude (plan fase previa a implementación).
**Fecha:** 2026-04-20.
**Objetivo:** crear el primer template custom por restaurante en Pincer, implementar "The Deck" según el design handoff de Claude Design. Cero impacto en los 5 restaurantes existentes.

---

## 1. Qué entrega Claude Design

Archivo descomprimido en `/tmp/thedeck-design/the-deck-menu-pincer/`:

### 1.1 Assets (4 screens)
- `project/screens/menu-home.html` — página principal del menú (header con tile pattern + emblema arqueado + category tabs + wine rows con leader dotted + CTA "Ordenar Ahora" + FAB mesero virtual + footer decorativo).
- `project/screens/item-popup.html` — modal de detalle de item (hero image + descripción + notes textarea + qty selector + cancel/add buttons).
- `project/screens/chatbot-closed.html` — estado cerrado (solo FAB visible).
- `project/screens/chatbot-open.html` — panel abierto (header navy con logo + gold rule + message bubbles + quick reply pills + text input + send button).

### 1.2 Design system
- `project/design-system.html` — CSS variables + componentes (colors, typography, spacing, radii, shadows, buttons, badges, inputs, section headers).
- `project/DEVELOPER-GUIDE.md` — recetas detalladas para las pantallas que Claude Design **no** cubrió (carrito, comprobante, confirmación, empty state, búsqueda, error, etc.) usando el mismo lenguaje visual.

### 1.3 Paleta + tipografía identificada
- **Colores:** navy `#0b1e3a` (dominante) + cream `#f6efda` + gold `#c9a961` + gold soft `#d9c48a` + gold dark `#a8883f` + surface `#ffffff`.
- **Fonts:** Playfair Display (headings, prices, branding), Georgia fallback + labels serif, Inter (body UI).
- **Patrón decorativo:** tile SVG inline 64x64 con rombos + cruces + puntos dorados en esquinas. Se usa en el header del menú y el footer.

### 1.4 Screens NO cubiertas (según guía DEVELOPER-GUIDE §4)
1. Carrito / tu orden — con recetas CSS específicas.
2. Confirmación de orden — check dorado + número de orden grande.
3. Comprobante de pago — patrón ornamental de fondo + detalle + total con gold rule.
4. Empty state del carrito.
5. Búsqueda (no urgente para MVP).

---

## 2. Schema changes

Dos columnas nuevas en `restaurant_users`, ambas opcionales (backward-compat total):

```sql
BEGIN;

ALTER TABLE restaurant_users
  ADD COLUMN IF NOT EXISTS custom_template BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS custom_template_path TEXT;

-- Documentación inline en el schema:
COMMENT ON COLUMN restaurant_users.custom_template IS
  'When true, this restaurant uses a custom HTML template instead of the generic menu/index.html. Enabled per restaurant via /admin.';
COMMENT ON COLUMN restaurant_users.custom_template_path IS
  'Identifier of the custom template directory under menu/templates/. E.g., "thedeck" → /menu/templates/thedeck/index.html. Must match a path in vercel.json rewrites.';

COMMIT;
```

**Backward compat:**
- Todos los restaurantes existentes quedan con `custom_template = false` (default). Sin cambio de comportamiento.
- La columna `menu_style` (theme genérico) sigue existiendo — se usa solo cuando `custom_template = false`.
- Las policies RLS no necesitan cambio: ambas columnas son anon-visibles vía la vista `restaurant_users_public` (ya incluye `SELECT *` lógicamente — verificamos al ejecutar que están expuestas).

**Verificación post-migración:**
```sql
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'restaurant_users'
  AND column_name IN ('custom_template', 'custom_template_path');
```

---

## 3. Archivos NUEVOS a crear

### 3.1 Template directory — `menu/templates/thedeck/`

```
menu/templates/thedeck/
├── index.html              # Página principal del menú (port de menu-home.html adaptado)
├── assets/
│   ├── logo.jpg            # Copia del logo actual de The Deck (de Supabase Storage) — embebido local para performance
│   └── (NO icons, NO fonts local — Google Fonts via CDN, icons inline SVG)
```

**Decisión intencionada:** un SOLO archivo HTML (`index.html`) que contiene todas las vistas (menú + item popup como modal + cart + checkout + chat) igual que hace `menu/index.html` hoy. Razones:
- Arquitectura existente: `menu/index.html` es un SPA monolítico con toda la lógica JS. El template custom mantiene la misma filosofía — permite reusar el patrón mental.
- Vercel serve estático simple sin templating engine.
- Cuando el user navega entre "home → item popup → cart → checkout", todo es client-side DOM manipulation, no page loads reales.

**Tamaño esperado de `index.html`:** 4000-6000 líneas (vs las ~8000 de `menu/index.html`). Menor porque no incluye el flujo de delivery/takeout (The Deck solo tiene `order_types: ['dine_in']`) ni las 6 variantes de theme.

### 3.2 Assets
- `menu/templates/thedeck/assets/logo.jpg` — opcional. El logo ya vive en Supabase Storage (`logos/thedeck.jpg`) y se sirve desde ahí. Si queremos reducir dependencia Supabase en el render inicial, bajamos el logo y lo servimos del repo. Recomendación: **dejar en Supabase** (consistente con el resto del stack, cambios de logo via /admin se reflejan sin redeploy). El `<img>` apunta al URL de Supabase Storage.

---

## 4. Archivos EXISTENTES a modificar

### 4.1 `vercel.json`

Agregar un rewrite ESPECÍFICO **antes del catch-all** `/:slug → /menu/index.html`:

```diff
   "rewrites": [
     { "source": "/admin", ... },
     ...
     { "source": "/:slug/dashboard", "destination": "/dashboard/index.html" },
+    { "source": "/thedeck", "destination": "/menu/templates/thedeck/index.html" },
     { "source": "/:slug", "has": [{ "type": "header", "key": "user-agent", ... }], "destination": "/api/og?slug=:slug" },
     { "source": "/:slug", "destination": "/menu/index.html" }
   ],
```

**Orden importa:** Vercel rewrites son first-match-wins. El rewrite específico de `/thedeck` captura antes que el `/:slug` genérico. Los bots sociales (User-Agent match) van a `/api/og` — **este caso sigue funcionando** para `/thedeck` porque el specific rewrite no tiene `has` condition, pero el OG rewrite para `/:slug` tiene el `has` que filtra por UA. Si queremos OG image custom para thedeck, agregamos una regla específica; si no, los bots ven el HTML del template custom (aceptable, mejor que romper el OG).

**Alternativa considerada y descartada:** un resolver dinámico server-side que queryee Supabase para saber qué template servir. Más flexible pero:
- Añade latencia (1 Supabase query por cada page load del menú).
- Requiere un endpoint Vercel function en vez de static serve.
- Scale-out es linear con custom templates igual que la opción hardcoded.

Rechazado para este MVP. Re-evaluar cuando haya 4+ custom templates.

### 4.2 Opcional — `menu/index.html`

Decisión pendiente (ver §7 casos edge): agregar un check temprano en `loadRestaurantData()` que si `data.custom_template === true` redirija a `/menu/templates/${data.custom_template_path}/index.html`. Actúa como **segunda línea de defensa** por si el vercel.json rewrite no dispara (ej: desarrollo local con `vercel dev`, branches preview donde el rewrite no se aplique por alguna razón).

Propongo NO hacerlo en commit 1. Solo si el testing muestra que hace falta. Simplifica el plan.

### 4.3 `rls.sql`

Agregar el bloque SQL de §2 al final del archivo con fecha y comentario. Pattern idéntico a las migraciones anteriores (is_pincer_staff, sessions_3ds).

---

## 5. Integración con flujos existentes

El template custom debe replicar funcionalmente todo lo que hace `menu/index.html`, pero con HTML/CSS propios. No se comparte código JS — cada template se mantiene aislado para evitar contaminación cross-restaurant.

| Flujo | Origen en menu/index.html | Port al template The Deck |
|---|---|---|
| Cargar productos desde Supabase | `loadRestaurantData()` + products query | Igual, copiado literal (query `products?restaurant_slug=eq.thedeck`) |
| Outage fallback | El `body.innerHTML` replacement con CTA WhatsApp | Mismo pattern, con CTA estilizado al design system (botón navy + gold) |
| localStorage cache del WhatsApp phone | `localStorage.setItem('pincer_whatsapp_' + SLUG, ...)` | Igual |
| Cart add/remove items | `addItem()` / `removeItem()` / renderCart | Igual lógica, nuevo render HTML (recetas §4 de DEVELOPER-GUIDE) |
| Checkout → Azul payment | `openCheckoutModal()` + `processPayment()` + 3DS flow | Igual lógica, nuevo render modal + sub-modals con estética design system |
| Chatbot (waiter-chat) | `openPinzer()` + `sendChatMessage()` + 503 handler | Igual endpoint (`/api/waiter-chat`), nuevo render del panel según screen chatbot-open.html |
| Fail-closed 503 handler | Commit `2fb78ef` — muestra mensaje de outage en el chat | Igual lógica, mensaje con tipografía Playfair + gold rule |
| Track page_events | `track()` a /api/track | Igual. No cambios |
| Loyalty VIP box | `renderLoyaltyVipBox()` | **Opcional para MVP** — The Deck no tiene loyalty config todavía. Ship sin esto; agregar después si Chef configura el programa |
| Promo popups | `renderPromoPopup()` | **Opcional para MVP** — mismo criterio |
| Store open/closed logic | `isOpenBySchedule()` + `store_settings` | Igual, con UI stylised (gold rule + Playfair label "Cerrado") |
| Order submit a Supabase | `submitOrder()` insert a `orders` | Igual endpoint + payload |
| 3DS Challenge flow | `/api/payment` → `/api/3ds` → postMessage | Igual (invisible, es iframe) |
| Push notifications FCM | No aplica (es dashboard, no menu) | — |

**Loyalty y Promo se dejan fuera del MVP** para reducir superficie de testing. Se agregan en un PR posterior cuando Chef Elly de The Deck decida activarlos.

---

## 6. Recetas del Developer Guide para pantallas no diseñadas

Seguiré §4 de DEVELOPER-GUIDE.md literalmente. Resumen por pantalla:

### 6.1 Carrito / Tu Pedido
- Background: cream (`--color-bg`).
- Título "Tu Pedido" — Playfair 24-28px.
- Contador de items en caption gold (`11 items` en uppercase, letter-spacing 2px).
- Item rows con el mismo `.wine-row` pattern: name Georgia 14px + leader dotted + price.
- Qty pill con bordes finos (reutilizado de `item-popup.html`).
- Subtotal/impuestos en sección inferior con border-top + labels caption.
- CTA "Completar Orden" = `.btn-primary` full-width con badge de total.

### 6.2 Modal de checkout (phone + name)
- Modal con `border-radius: var(--radius-lg)` + `border-top: 2px solid var(--color-accent)`.
- Inputs con estilo `.input` del design system (cream bg + border sutil + focus gold).
- Sub-confirmación para pagos (estilo similar al transfer confirm del admin).

### 6.3 Confirmación de orden enviada
- Fondo cream + tile pattern opacity 0.04 arriba (220px altura como el header del menú).
- Check mark dorado 64px con anillo `@keyframes pulse`.
- "¡Tu orden fue recibida!" Playfair 28.
- Subtexto "Te notificaremos por WhatsApp..." Inter 14 color-text-soft.
- Badge dorado con número de orden.
- 2 CTAs: "Seguir ordenando" (primary) + "Ver detalles" (secondary).

### 6.4 Comprobante de pago
- Fondo cream + patrón decorativo 0.04 entero.
- Check dorado centrado arriba.
- "The Deck" Playfair 24 + "COMPROBANTE DE PAGO" caption gold.
- Card con número de orden: `# 1` Playfair 48px 600, border `1px solid var(--color-accent)`.
- Detalle items: mismo `.wine-row`.
- Total separado con gold-rule.
- CTA "Descargar recibo" `.btn-primary`.
- Aviso hora con fondo `rgba(201,169,97,0.15)`.

### 6.5 Empty state del carrito
- Icono SVG line en gold-dark 48px.
- Título Playfair 20 navy.
- Mensaje Inter 14 color-text-soft max-width 280px.
- CTA "Explorar menú" `.btn-secondary` (ghost con border).

---

## 7. Casos edge críticos

### 7.1 Bots sociales en `/thedeck`
El rewrite de OG image para `/:slug` tiene `has: user-agent match`. El nuevo rewrite `/thedeck → template` NO tiene ese `has`, así que bots caerían al template HTML en vez del OG image. **Mitigación:** duplicar la regla OG con un specific source primero:
```json
{ "source": "/thedeck", "has": [{...UA match...}], "destination": "/api/og?slug=thedeck" },
{ "source": "/thedeck", "destination": "/menu/templates/thedeck/index.html" },
```

### 7.2 `/thedeck/dashboard` debe seguir funcionando
El rewrite `/:slug/dashboard → /dashboard/index.html` viene antes del catch-all. El nuevo rewrite `/thedeck` es más específico pero sin `/dashboard`. Orden: `/thedeck/dashboard` matchea primero con `/:slug/dashboard` (el slug capture) — **sigue funcionando**. Verificar en smoke test.

### 7.3 Supabase caído (outage)
The Deck hoy es solo demo para Tamayo, pero eventualmente será cliente real en producción. El template debe tener el **mismo outage fallback** que `menu/index.html` (`body.innerHTML = ...` con CTA WhatsApp desde localStorage cache). Literal port del commit `2631e31`.

### 7.4 Fail-closed del chatbot
Commit `2fb78ef` agregó un handler de 503 en menu/index.html que muestra mensaje de outage en vez de alucinar. Template debe portar este handler — pero adaptado estéticamente (Playfair + color-accent-3 para el icono warning).

### 7.5 Fonts de Google CDN
CSP actual (vercel.json línea 53) ya permite `style-src https://fonts.googleapis.com` y `font-src https://fonts.gstatic.com`. **No requiere cambio.** Verifico al terminar integración.

### 7.6 Assets relative paths
Screens del design tienen paths `../images/logo.jpg`. Cuando porteo, ajusto a ruta absoluta o al URL de Supabase Storage del logo actual de The Deck: `https://tcwujslibopzfyufhjsr.supabase.co/storage/v1/object/public/product-images/logos/thedeck.jpg`.

### 7.7 El flag `custom_template` se setea manualmente
Al final, **después de que todo esté validado**, un `UPDATE restaurant_users SET custom_template = true, custom_template_path = 'thedeck' WHERE restaurant_slug = 'thedeck';`. Es el "interruptor" que activa el template para el demo real con Chef.

Pero el routing ya funciona desde que se mergea el vercel.json rewrite — el flag de DB es advisory. Esto es positivo: el rewrite puede estar listo y nadie lo usa hasta que el UPDATE se ejecute (porque antes del UPDATE, `/thedeck` sigue navegando al custom template, pero nadie conoce la URL — solo se expone después del demo). Decisión: **el rewrite se mergea junto con el resto**; el UPDATE lo corre Tamayo cuando esté listo el demo real.

### 7.8 Chef Elly (Mr. Sandwich) y Square One
Ninguno tiene `custom_template=true`. Sus URLs `/mrsandwich`, `/squareone` caen al catch-all `/:slug → /menu/index.html`. Cero cambio.

### 7.9 Admin `/admin` — mostrar estado del template
**Fuera de scope de este PR.** Puede agregarse después un badge/indicator en la lista de /admin mostrando qué restaurantes usan custom template. No bloqueante.

---

## 8. Plan de rollback

Multi-capa, del más rápido al más drástico:

1. **Flip flag en DB (instantáneo):** `UPDATE restaurant_users SET custom_template = false WHERE restaurant_slug = 'thedeck';`. Si el código del template usa el flag como guard interno (ver §4.2 optional), esto revierte sin deploy.

2. **Remove el rewrite de vercel.json (1 deploy):** borra `{ "source": "/thedeck", ... }`. Push → Vercel redeploya en 30-60s. `/thedeck` vuelve al catch-all (menu/index.html genérico). Seguimiento de 1 commit.

3. **Revert full branch (1 deploy):** `git revert <merge-sha>`. Deshace el schema también (ALTER TABLE IF NOT EXISTS es drop manual; columns quedan pero nunca se leen). Columnas `custom_template` + `custom_template_path` quedan en DB vacías — no estorban.

4. **Desactivación manual del UPDATE:** si querés mantener el rewrite pero desactivar el template: setear `custom_template=false` y que el template mismo redirija al catch-all. Requiere el opt-in del §4.2.

---

## 9. Commits granulares + estimados

Orden (9 commits + 1 SQL manual + 1 UPDATE manual final):

| # | Scope | Archivo(s) | Estimado | Revertible? |
|---|---|---|---|---|
| SQL-1 | Migración schema (manual en Supabase) | — | 5 min | Sí (drop columns) |
| 1 | `rls.sql` — documentar migración | `rls.sql` | 5 min | Sí |
| 2 | `menu/templates/thedeck/index.html` — skeleton + header + tabs + wine rows (static, datos hardcoded para QA visual) | Nuevo | 2-3 h | Sí (eliminar directorio) |
| 3 | Wire product loading desde Supabase (reemplaza data hardcoded) | index.html | 1 h | Sí |
| 4 | Item popup modal (port de item-popup.html) | index.html | 1 h | Sí |
| 5 | Cart / Tu Pedido (receta DEVELOPER-GUIDE §4.1) | index.html | 2 h | Sí |
| 6 | Checkout + Azul flow + 3DS (port de menu/index.html) | index.html | 2-3 h | Sí |
| 7 | Chatbot (port del panel + fail-closed) | index.html | 1-2 h | Sí |
| 8 | Confirmación + Comprobante + Empty state (recetas §4.3-4.5) | index.html | 1-2 h | Sí |
| 9 | `vercel.json` — rewrite `/thedeck` + OG variant | vercel.json | 15 min | Sí (remove rule) |
| UPDATE-1 | Activar flag (manual, solo cuando todo validado) | DB | 2 min | Sí |

**Total estimado de codificación:** 10-14 horas concentradas. Calendar: **2 días** con pausas para validación.

**Smoke test entre cada commit:**
- `pincerweb.com/mrsandwich` → HTTP 200.
- `pincerweb.com/squareone` → HTTP 200.
- `pincerweb.com/thedeck` → antes de commit 9: HTTP 200 con menú genérico (sin impacto). Después de commit 9: HTTP 200 con template custom.
- `pincerweb.com/thedeck/dashboard` → HTTP 200 (protected by auth).

**Aprobaciones intermedias no requeridas** salvo sorpresa (per protocolo establecido). Ping final post-commit-9 con checklist de validación E2E.

---

## 10. Validación post-implementación (te toca ejecutar)

1. `/thedeck` carga con el template custom. Header tiene tile pattern navy + emblema arqueado + logo de The Deck.
2. Categorías (Tintos, Blancos, etc.) aparecen como pills con la active en navy bg.
3. Items reales del DB (los 214) aparecen en wine rows con leader dotted + precio RD$.
4. Click en un item abre modal con hero, descripción, qty selector, botones.
5. Cart con items muestra total. Completar orden abre checkout.
6. Pago con tarjeta: sandbox Azul aprueba end-to-end (ya validado en otro PR).
7. Chatbot "Mesero Virtual" abre panel estilo design, responde, no aluciano.
8. `/mrsandwich` sigue genérico, no afectado.
9. `/squareone` sigue genérico, no afectado.
10. `/thedeck/dashboard` abre dashboard normal (no afectado).

---

## 11. Post-mortem del design

**Áreas que el design handoff NO cubre pero están en el scope del template custom:**
- Login del cliente (si hubiera login de customer — Pincer no tiene, se identifica por phone en checkout).
- Historial de órdenes del cliente (no existe tampoco).
- Propinas, split bill, cuentas abiertas — **relacionado con el proyecto separado de OCR** que Tamayo mencionó. **NO en este PR.**

Estos se construyen cuando arranque el proyecto de cuentas abiertas, reutilizando el mismo design system.

---

## 12. Referencias cruzadas con plan multi-tenant

El plan multi-tenant (`docs/multi-tenant-plan.md`) sigue aplazado. Este proyecto NO depende del multi-tenant. Sí hay sinergia futura: si/cuando se haga el split a `restaurants` table, las columnas `custom_template` + `custom_template_path` se mueven allá.

---

## 13. Mantenimiento futuro — drift entre genérico y customs

**Principio:** la decisión de §5 de NO compartir JS entre `menu/index.html` (genérico) y los templates custom tiene una consecuencia: cualquier cambio funcional al genérico debe evaluarse contra cada custom para no dejarlos atrás. El riesgo es que después de 6 meses el custom de The Deck tenga un bug ya arreglado en el genérico, o viceversa.

**Mitigación obligatoria:** agregar a `CLAUDE.md` una sección **"Cuando modificas menu/index.html — checklist de paralelismo"** con esta política:

- Si el cambio es **solo CSS/estilos** del template genérico → no aplica a customs (cada uno tiene su propio CSS).
- Si el cambio toca **lógica funcional** (cart, checkout, chatbot, fail-closed handlers, outage fallback, payment flow, tracking, localStorage cache, etc.) → **REVISAR si aplica a templates custom**. En la mayoría de los casos sí aplica y hay que portar.
- **Lista de templates custom actuales (a mantener actualizada):**
  - `menu/templates/thedeck/index.html`
- Al agregar un custom nuevo, **actualizar la lista en CLAUDE.md** como parte del PR.

**Trigger de re-evaluación arquitectónica:** cuando haya **3-4 custom templates activos**, considerar refactor a shared JS modules + slot-based templating para reducir duplicación. Antes de eso, el costo de mantener la arquitectura isolate-por-template es menor que el costo de construir una abstracción prematura.

**Por qué no abstraer ahora:**
1. Solo hay 1 custom template (The Deck). YAGNI.
2. La arquitectura correcta para shared JS no se conoce todavía — aprender con 3-4 customs reales da mejor data.
3. Cualquier abstracción introducida ahora tendría que re-diseñarse cuando aparezca el 2do y 3er caso.

El commit 1 de este plan (docs/rls.sql update) **también añade la sección a CLAUDE.md** para que la política viva junto al resto de las convenciones del codebase.

---

## Espero tu aprobación

Cuando apruebes, ejecuto en este orden:
1. SQL manual en Supabase (te paso al clipboard).
2. Commits 1-9 en serie con smoke tests entre cada uno.
3. Ping final con checklist de validación.
4. Tú corres el UPDATE final para activar el flag cuando estés listo para el demo real.

Sin cambios hasta "aprobado, procede".
