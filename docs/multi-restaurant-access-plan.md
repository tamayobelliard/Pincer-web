# Multi-restaurant access — plan de implementación

**Objetivo:** habilitar el flujo "crear demo → mostrar al cliente → transferir a producción" + mantener acceso de soporte permanente de Tamayo. Scope mínimo sobre el modelo actual (no refactor de schema).

**Estimado:** 2-3 días. **Primer uso:** demo real con The Deck.

---

## 1. Schema changes (mínimos)

`restaurant_users.status` **no tiene CHECK constraint** en `rls.sql` — acepta cualquier string. Los valores `'demo'` y `'suspended'` funcionan sin DDL extra sobre la columna. Pero la RLS anon filtra por `status = 'active'`, lo cual esconde demos del menú público. Hay que ampliarla.

```sql
-- Una sola migración SQL, idempotente.
ALTER TABLE restaurant_users
  ADD COLUMN IF NOT EXISTS is_pincer_staff BOOLEAN NOT NULL DEFAULT false;

-- Permitir que el menú público funcione en demos (Tamayo muestra pincerweb.com/eldeck
-- durante la venta). 'suspended' queda fuera — esconder es el propósito de suspender.
DROP POLICY IF EXISTS "anon_select_restaurant_users" ON restaurant_users;
CREATE POLICY "anon_select_restaurant_users"
  ON restaurant_users FOR SELECT TO anon
  USING (status IN ('active', 'demo'));

-- La vista pública (usada por OG, waiter-chat fallback, etc.) también.
CREATE OR REPLACE VIEW restaurant_users_public AS
SELECT id, username, restaurant_slug, display_name, role, status,
       business_type, address, phone, contact_name, email, hours,
       website, notes, chatbot_personality, logo_url, menu_style,
       menu_groups, plan, trial_expires_at, order_types, delivery_fee,
       created_at,
       (azul_merchant_id IS NOT NULL AND azul_merchant_id != '') AS payment_enabled
FROM restaurant_users
WHERE status IN ('active', 'demo');

-- Post-deploy, activar pincer_staff en tu cuenta:
UPDATE restaurant_users SET is_pincer_staff = true WHERE username = '<tu_username_admin>';
```

Agregado a `rls.sql` en un bloque al final con fecha. Reversible: drop column + revert policy/view.

---

## 2. Archivos a modificar

| Archivo | Cambio |
|---|---|
| `rls.sql` | Bloque nuevo al final (SQL arriba). |
| `api/admin.js` | (a) `handleCreate`: email opcional → si vacío, setea `status='demo'` en vez de `'active'`; genera password temp igual que hoy pero NO envía email. (b) Nuevo `handleTransferToProd`: recibe slug + email + whatsapp, requiere status='demo' actual, actualiza a `status='active'` + guarda email/phone, dispara envío de welcome email reusando `api/send-email.js`. (c) Nuevo `handleImpersonate`: verifica admin session, verifica que el admin tiene `is_pincer_staff=true`, crea fila en `restaurant_sessions` con user_id del admin + slug target + token_hash, responde con 302 + Set-Cookie `pincer_session`. (d) El handler existente `action=restaurants` PATCH (toggle status) ya sirve para Suspender ↔ Reactivar — solo verificar que acepta los 3 valores. |
| `admin/index.html` | (a) Quitar required del input email en el modal Nuevo Cliente. (b) Nueva función `renderStatusBadge(status)` que pinta verde/naranja/rojo. (c) Contadores arriba (total, activos, demos, suspendidos condicional). (d) Botón "Pasar a Producción" condicional a `status==='demo'` + modal con form email + whatsapp obligatorios. (e) Botón "Dashboard" cambia: si `is_pincer_staff` (leído del endpoint `?action=restaurants` extendido con ese campo en la respuesta), hace POST a `?action=impersonate` y navega; si no, comportamiento actual. (f) "Desactivar/Activar" renombrar a "Suspender/Reactivar" visual, reusar el endpoint PATCH existente — valida que el toggle escriba 'suspended' no 'inactive'. |
| `api/auth.js` | Sin cambios. El login normal sigue igual. La impersonación NO pasa por aquí. |

**No se tocan:** `menu/`, `dashboard/`, `login/`, ningún endpoint de pagos, chatbot, FCM, webhook Twilio.

---

## 3. Orden de commits (granular, revert selectivo)

1. **SQL migration** — bloque en `rls.sql`. Correr manualmente en Supabase. No commit de código todavía. (Paso manual en DB: 2 min.)
2. `api/admin.js` — solo `handleCreate` acepta email vacío + asigna `status='demo'`. Test: crear demo desde UI funcional tras next commit.
3. `admin/index.html` — quitar required del email + status badges + contadores. Coordina con commit #2.
4. `api/admin.js` — nuevo `handleTransferToProd` (endpoint `?action=transfer`). Reusa send-email helper.
5. `admin/index.html` — botón + modal "Pasar a Producción".
6. `api/admin.js` — nuevo `handleImpersonate` (endpoint `?action=impersonate`).
7. `admin/index.html` — lógica del botón Dashboard con impersonación.
8. `admin/index.html` — rename visual Desactivar→Suspender/Reactivar + confirmar valor del status (no se llama 'inactive').

7 commits de código + 1 SQL manual. Cada uno deployea solo y puede revertirse aislado.

---

## 4. Casos edge críticos (pueden romper producción)

1. **`restaurant_users_public` view cambia `WHERE`.** Cualquier código que lea esa vista ahora también trae demos. Impacto: `api/og.js`, `api/waiter-chat.js` (fallback), `api/pincer-chat.js` (landing), `api/chat.js` (dashboard AI). **Acciones:**
   - `api/pincer-chat.js`: filtrar `status=eq.active` explícito (no recomendar demos al público).
   - `api/waiter-chat.js` y `api/og.js`: OK que demos aparezcan (Tamayo demo al cliente).
   - `api/chat.js` (dashboard AI): verificar en smoke test que funciona normal cuando Tamayo entra como `pincer_staff` a un demo. NO agregar lógica especial — solo confirmar que no se rompe (ambos estados deberían permitir queries sobre `restaurant_users`, pero el fail-closed pattern del commit `2b8dcb2` fue diseñado para happy path `active`).

2. **RLS policy anon ampliada.** Cualquier uso del anon key que asumía "todo lo que veo es activo" puede leer demos ahora. Esto es el mismo punto de arriba desde otra perspectiva — **decidir ahora**: `pincer-chat.js` filtra por `status=eq.active` explícito, no confía en RLS.

3. **Impersonación y sesiones existentes.** Si Tamayo ya tiene un `pincer_session` cookie de otro restaurante y clickea Dashboard de uno nuevo, el nuevo cookie sobrescribe el anterior (mismo nombre, misma ruta, SameSite=Strict). No es bug — es el comportamiento esperado. Pero vale clarificarlo: **una sola sesión de dashboard viva a la vez por browser**. Si Tamayo necesita ver dos a la vez → usar ventanas incógnito distintas.

4. **El impersonation endpoint es peligroso si un no-admin lo alcanza.** Mitigación: gate estricto al inicio del handler — verifica admin session + verifica que el admin user tiene `is_pincer_staff=true` en su fila. Dos checks, no uno.

5. **Transfer a producción envía credenciales por email — si ese email fue escrito mal, las credenciales quedan con quien no debería.** Mitigación doble: (a) el modal principal de "Pasar a Producción" ya muestra el email como campo. (b) **Sub-confirmación obligatoria** antes del envío: al hacer click en "Confirmar transferencia", abrir segundo modal/confirm con el email destacado visualmente: *"Vas a transferir [nombre restaurante] a producción. Las credenciales se enviarán a: email@cliente.com. ¿Confirmas? [Cancelar] [Sí, transferir]"*. Solo el segundo click dispara el POST. El `Set-Cookie` de impersonación no se expone — solo password temporal en el email.

6. **SQL drop + recreate de policy/view no es atómico.** Hay una ventana de milisegundos donde la policy no existe. Corrida en Supabase SQL Editor es transaccional por statement, no por batch. **Acción:** correr los 3 statements juntos en un `BEGIN; ... COMMIT;` para atomicidad real.

---

## 5. Validación post-deploy

Después de cada commit — smoke test: `curl /mrsandwich` → HTTP 200. `curl /squareone` → HTTP 200. Login con Chef Elly no roto.

Al final del PR:
- Crear demo desde `/admin` sin email → aparece con badge naranja DEMO. Menú `/eldemo` carga.
- Abrir dashboard del demo desde `/admin` (impersonación) → entra directo sin login.
- Pasar demo a producción con email test → **sub-confirmación muestra el email destacado antes del envío** → email llega con credenciales temporales. Login desde `/login` con esas credenciales funciona. Badge cambia a verde ACTIVO.
- Entrar como `pincer_staff` a un demo y usar el chatbot AI del dashboard (`/api/chat`) → debe responder normal, no 503. Confirma que el fail-closed del commit `2b8dcb2` no se activa en status='demo'.
- Suspender restaurante → badge rojo, menú `/elsuspendido` devuelve "Restaurante no encontrado" (o outage fallback si es mrsandwich). Reactivar → vuelve visible.
- Mr. Sandwich y Square One siguen funcionando.
- `sessions_3ds` sigue poblando correctamente tras un pago de prueba (invariante del fix previo).

---

## 6. Sugerencias para futuro (fuera del scope)

1. **Audit log de impersonaciones.** Hoy no se registra quién entró como quién. Para cuando Pincer tenga más staff/soporte, `pincer_staff_audit` table (del plan multi-tenant v1) resuelve esto. Agregar al backlog.
2. **CHECK constraint en `restaurant_users.status`.** Hoy acepta cualquier string. Cuando los valores válidos se estabilicen (post-launch), añadir `CHECK (status IN ('active','demo','suspended'))` previene typos.
3. **UI de lista de demos expirados.** Si acumulas muchos demos sin cerrar ventas, ver cuáles tienen >30 días sin transferir. Trivial como query, bonito como vista.
4. **Transferir email del dueño mantiene contact_name.** Hoy el modal Transfer pide email + whatsapp nuevos, pero contact_name del dueño real se debería capturar también. Reusar el campo actual es simple.
5. **The Deck y el flujo OCR de cuentas abiertas** — proyecto separado, referenciar aquí para que no se olvide el link operacional.

---

## Decisiones tomadas sin preguntar (estándar)

- `is_pincer_staff` como BOOLEAN en `restaurant_users` (no columna en otra tabla). Consistente con el plan multi-tenant v1 §3.1.
- RLS anon amplía a `('active','demo')`. Demos son públicos por diseño — Tamayo los muestra al cliente.
- Impersonation usa `restaurant_sessions` + cookie `pincer_session` estándar — no nueva tabla.
- Transfer-to-prod reusa `api/send-email.js` + template welcome existente de signup. No nueva lógica de email.
- Commits granulares en `main` directo, no feature branch — cambios son aditivos y cada uno es reversible.
- No se toca APK Android: impersonation es feature de `/admin` web, APK nunca la usa.

---

## Username confirmado

Hay un único admin en el sistema con `username = 'admin'`. El UPDATE post-deploy es:

```sql
UPDATE restaurant_users SET is_pincer_staff = true WHERE username = 'admin';
```

Sin ambigüedad.
