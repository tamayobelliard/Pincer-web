# Pincer — Plan de migración multi-tenant con roles

**Autor:** Claude (Fase 2, plan previo a implementación)
**Fecha del plan:** 2026-04-17
**Estado:** PENDIENTE DE APROBACIÓN — no codificar hasta que el owner diga "aprobado, procede"
**Ramas:** trabajo en `multi-tenant` (larga, no mergear a `main` hasta Fase 4 completa)

> **Documentación viva:** este archivo debe actualizarse durante la implementación con cualquier desviación del plan. Si algo cambia, se edita aquí mismo con un bloque `## Cambios durante implementación` al final.

---

## 1. Resumen ejecutivo

Pincer hoy asume 1 usuario = 1 restaurante. La tabla `restaurant_users` mezcla tres conceptos: identidad (email, password_hash), configuración del negocio (slug, plan, azul_merchant_id, menú, horario) y relación (implícita 1:1).

Se va a separar en tres entidades limpias:

| Entidad | Qué contiene | Ejemplos de columnas |
|---|---|---|
| `users` | Identidad personal + auth | email, password_hash, reset_token, failed_login_attempts, locked_until |
| `restaurants` | Config del negocio | restaurant_slug, display_name, plan, azul_merchant_id, menu_style, hours |
| `restaurant_members` | Junction | user_id, restaurant_id, role, status, invited_by, created_at |

Con roles en `restaurant_members`:
- `owner` — dueño, acceso total al restaurante, puede gestionar usuarios.
- `admin` — como owner pero no puede eliminar el restaurante ni transferir ownership.
- `manager` — dashboard, reportes, menú. No gestiona usuarios ni config crítica (Azul, billing).
- `cashier` — solo dashboard operacional del día.

Más un flag a nivel `users` (no en la junction):
- `is_pincer_staff BOOLEAN` — acceso global a CUALQUIER restaurante sin membership explícita. Solo asignable por SQL. Se modela como flag, no como role, porque no pertenece a un restaurante específico (ver §3.2).

Se mantiene el `admin_sessions` + panel `/admin` existente (sin cambios en este PR). Los usuarios con `role='admin'` actuales migran a `users.is_pincer_admin = true`.

**Restricciones operacionales (reconfirmadas):**
- No deploys a producción durante horas de servicio de Mr. Sandwich (aprox. 11am-10pm DR).
- Mr. Sandwich y Square One **no se pueden romper** bajo ninguna circunstancia. Square One tiene pagos Azul en vivo.
- Sin deadline duro — prioridad hacerlo bien, no rápido.
- El APK de Android es inmutable en este PR (no se re-publica), así que **el flujo post-login desde la perspectiva del WebView no puede cambiar**.

---

## 2. Estado actual (Fase 1 — hallazgos)

### 2.1 Schema relevante

Todo en `rls.sql`. Tablas que participan o se ven afectadas:

| Tabla | Rol en la migración | RLS actual |
|---|---|---|
| `restaurant_users` | Se **renombra** a `restaurant_users_legacy`, eventualmente se elimina | Anon SELECT si `status='active'`, sin writes |
| `restaurant_sessions` | Se modifica: añadir `restaurant_id`, `user_id` cambia a FK | Sin políticas anon (service role only) |
| `admin_sessions` | **Sin cambios** | Sin políticas anon |
| `products` | Sin cambios estructurales. Sigue keyed por `restaurant_slug` (→ mapea a `restaurants.restaurant_slug`) | Anon full CRUD (tech debt documentada en CLAUDE.md) |
| `orders` | Sin cambios estructurales | Anon SELECT + INSERT (pending/paid) + UPDATE |
| `store_settings` | Sin cambios | Anon full (tech debt) |
| `fcm_tokens` | **Schema change:** unique key cambia de `token` a `(token, restaurant_slug)` | Anon INSERT/UPDATE (no SELECT) |
| `payment_audit` | Sin cambios estructurales | Sin anon |
| `sessions_3ds` | **No está en `rls.sql`** — schema drift a corregir como sub-fix | Desconocido (existe en Supabase) |
| `promotions`, `shifts`, `loyalty_config`, `loyalty_balance`, `restaurant_insights`, `chat_messages`, `page_events`, `rate_limits` | Sin cambios; todos keyed por `restaurant_slug` que sigue mapeando a `restaurants.restaurant_slug` | Variado |

**Hallazgo clave — schema drift:** `sessions_3ds` se usa en código pero no existe su CREATE TABLE en `rls.sql`. Parte del PR incluirá documentar el schema real en `rls.sql`.

### 2.2 Auth flow actual

1. `/api/auth` (POST, reCAPTCHA): busca `restaurant_users` por `username`, verifica bcrypt, chequea lockout, crea fila en `restaurant_sessions` con `user_id` + `restaurant_slug` + `token_hash`, devuelve cookie `pincer_session` httpOnly.
2. Si `user.role === 'admin'`, crea fila en `admin_sessions` y usa cookie `pincer_admin`. Redirige a `/admin`.
3. Si `user.role === 'restaurant'`, redirige a `/{restaurant_slug}/dashboard`.
4. Todo endpoint con `verifyRestaurantSession(token)` obtiene `{valid, restaurant_slug, user_id}` y filtra queries por `restaurant_slug`.

Puntos de interés:
- `user.role` en `restaurant_users` es hoy binario: `'admin'` o `'restaurant'`. No confundir con los roles nuevos de `restaurant_members`.
- `password_hash`, `failed_login_attempts`, `locked_until`, `reset_token_*`, `email_verified`, `must_change_password` viven en `restaurant_users` pero conceptualmente son del **usuario**, no del restaurante.

### 2.3 Lugares que asumen 1:1 user ↔ restaurant

Mapeados exhaustivamente por el agente Explore. Resumen:

**22 archivos API** tocan `restaurant_users`:
- Auth: `auth.js`, `signup.js`, `logout.js`, `change-password.js`, `forgot-password.js`, `reset-password.js`, `verify-email.js`, `send-confirmation-email.js`
- Dashboard: `update-settings.js`, `create-promo.js`, `delete-promo.js`, `update-promo.js`, `toggle-promo.js`, `download-report.js`, `shift-report.js`, `generate-insights.js`, `void-payment.js`
- Pagos: `payment.js` (lee `azul_merchant_id`), `3ds.js` (usa env var — bug, ver §7)
- AI: `waiter-chat.js` (público, lee config por slug), `pincer-chat.js` (público, lee todos los restaurantes activos), `chat.js`
- Notif: `register-device-token.js`, `send-notification.js`
- Webhooks: `whatsapp-webhook.js` (mapea teléfono → `restaurant_slug`)
- Admin: `admin.js` (lista, crea, togglea restaurantes)
- Cron: `cron/downgrade-trials.js` (expira trials de 30 días)
- Meta: `og.js`, `parse-menu.js`, `dashboard-manifest.js`

**3 HTMLs** con dependencia explícita:
- `login/index.html:222-246` — guarda `restaurant_slug` en `sessionStorage`, redirige a `/{slug}/dashboard`.
- `dashboard/index.html` — lee slug del path URL, carga manifest por slug.
- `menu/index.html` — carga menú por slug vía anon key.

**1 vista** (`restaurant_users_public`) que expone columnas públicas. Se va a redefinir sobre `restaurants`.

### 2.4 Sesión custom (confirmado: no Supabase Auth)

`restaurant_sessions`:
- `token_hash` (SHA-256 del token real)
- `user_id` (bigint, hoy es el id de `restaurant_users`)
- `restaurant_slug` (text, redundante con user)
- `expires_at` (24h por default)

Cookie `pincer_session` httpOnly, Secure, SameSite=Strict. En Android WebView funciona igual (el APK no lee la cookie, solo navega URLs).

---

## 3. Estado objetivo

### 3.1 Schema nuevo

```sql
-- ════════════════════════════════════════════════════════
-- users — identidad + credenciales
-- ════════════════════════════════════════════════════════
CREATE TABLE users (
  id                        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email                     text NOT NULL UNIQUE,
  username                  text UNIQUE,                  -- legacy, usado por /api/auth
  password_hash             text NOT NULL,
  display_name              text,                         -- nombre de la persona, no del restaurante
  phone                     text,
  email_verified            boolean NOT NULL DEFAULT false,
  email_verification_token  text,
  reset_token_hash          text,
  reset_token_expires       timestamptz,
  failed_login_attempts     int NOT NULL DEFAULT 0,
  locked_until              timestamptz,
  must_change_password      boolean NOT NULL DEFAULT false,
  welcome_email_sent        boolean NOT NULL DEFAULT false,
  is_pincer_admin           boolean NOT NULL DEFAULT false,  -- migra de role='admin'
  is_pincer_staff           boolean NOT NULL DEFAULT false,  -- NUEVO. Acceso global.
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_username ON users(username);

-- ════════════════════════════════════════════════════════
-- restaurants — config del negocio
-- ════════════════════════════════════════════════════════
CREATE TABLE restaurants (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_slug      text NOT NULL UNIQUE,
  display_name         text NOT NULL,
  status               text NOT NULL DEFAULT 'active',   -- active | suspended | deleted
  plan                 text NOT NULL DEFAULT 'free',     -- free | premium
  trial_expires_at     timestamptz,
  logo_url             text,
  menu_style           jsonb,
  menu_groups          jsonb,
  order_types          text[],
  delivery_fee         int DEFAULT 0,
  business_type        text,
  address              text,
  phone                text,
  hours                text,
  website              text,
  notes                text,
  chatbot_personality  text,
  azul_merchant_id     text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_restaurants_slug ON restaurants(restaurant_slug);
CREATE INDEX idx_restaurants_status ON restaurants(status) WHERE status = 'active';

-- ════════════════════════════════════════════════════════
-- restaurant_members — junction con rol
-- ════════════════════════════════════════════════════════
CREATE TYPE restaurant_role AS ENUM ('owner', 'admin', 'manager', 'cashier');

CREATE TABLE restaurant_members (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id        bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  restaurant_id  bigint NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  role           restaurant_role NOT NULL,
  status         text NOT NULL DEFAULT 'active',  -- active | invited | suspended
  invited_by     bigint REFERENCES users(id),
  invited_at     timestamptz,
  accepted_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, restaurant_id)
);

CREATE INDEX idx_rm_user ON restaurant_members(user_id);
CREATE INDEX idx_rm_restaurant ON restaurant_members(restaurant_id);

-- Un solo owner por restaurante (se puede relajar después si se necesita co-ownership)
CREATE UNIQUE INDEX idx_rm_single_owner
  ON restaurant_members(restaurant_id)
  WHERE role = 'owner';
```

**Decisión: `pincer_staff` como flag, no como role.**

`pincer_staff` no está en el enum de `restaurant_role` porque semánticamente **no es miembro de un restaurante específico** — es acceso transversal. Ponerlo en la junction obligaría a tener una fila por cada restaurante que existe en el sistema o inventar un `restaurant_id = null`. En cambio, `users.is_pincer_staff = true` es un flag global que el código de autorización interpreta como "puede entrar a cualquier restaurant como si fuera `owner`, pero con flag adicional para logging/auditoría".

Si quieres que pincer_staff pueda tener rol diferente por restaurante (ej: solo cashier en algunos), el modelo cambia a: flag + opcionalmente filas en `restaurant_members` con rol específico que ANULA el default global. No propongo esto ahora — el caso de uso es "yo, Tamayo, quiero ver y crear todo". Flag simple es suficiente.

**Diferencia operacional `is_pincer_admin` vs `is_pincer_staff` (crítica — dos flags con nombres parecidos son fuente clásica de bugs):**

Son dimensiones ortogonales. Un user puede tener ninguno, uno, o ambos.

| Flag | Da acceso a | NO da acceso a |
|---|---|---|
| `is_pincer_admin` | Panel `/admin` y todos sus endpoints (`/api/admin?action=...`). Cosas cross-tenant: listar todos los restaurantes, togglear status, ver métricas globales. | Entrar al dashboard operacional de un restaurante específico (`/{slug}/dashboard`). |
| `is_pincer_staff` | `/{slug}/dashboard` de CUALQUIER restaurante (como si fuera `owner`), loggeado en `pincer_staff_audit`. Puede crear menús, ver órdenes, editar config, simular flujos. | Panel `/admin`. Decisiones cross-tenant. |

**Caso de Tamayo:** `is_pincer_admin = true` + `is_pincer_staff = true`. Full access.

**Caso de soporte técnico futuro contratado (hipotético):** `is_pincer_staff = true`, `is_pincer_admin = false`. Puede dar soporte a clientes sin poder crear/eliminar restaurantes.

**Caso de admin de billing futuro (hipotético):** `is_pincer_admin = true`, `is_pincer_staff = false`. Puede gestionar metadata cross-tenant sin poder entrar a operar un restaurante.

Ambos flags se documentan explícitamente en el código cada vez que se leen, con el nombre exacto, para evitar confusión.

### 3.2 Matrix de permisos por rol

| Acción | pincer_staff | owner | admin | manager | cashier |
|---|---|---|---|---|---|
| Ver dashboard operacional (órdenes del día) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Ver reportes históricos | ✓ | ✓ | ✓ | ✓ | ✗ |
| Editar menú (CRUD productos) | ✓ | ✓ | ✓ | ✓ | ✗ |
| Editar config no-crítica (horario, dirección, logo) | ✓ | ✓ | ✓ | ✓ | ✗ |
| Editar config crítica (Azul, billing, plan) | ✓ | ✓ | ✗ | ✗ | ✗ |
| Invitar/editar/remover miembros | ✓ | ✓ | ✓ | ✗ | ✗ |
| Eliminar el restaurante | ✗ | ✓ | ✗ | ✗ | ✗ |
| Transferir ownership | ✗ | ✓ | ✗ | ✗ | ✗ |
| Crear restaurantes nuevos | ✓ | ✗ | ✗ | ✗ | ✗ |
| Acceso a `/admin` super-admin panel | Solo si `is_pincer_admin=true` también | ✗ | ✗ | ✗ | ✗ |

Nota: `pincer_staff` NO puede eliminar ni transferir ownership. Eso es una acción del dueño real, no de soporte.

### 3.3 Auth flow objetivo

1. `/api/auth` POST (igual signatura). Busca `users` por username, verifica bcrypt + lockout. Al validar:
   a. Consulta `restaurant_members WHERE user_id=? AND status='active'`.
   b. **Si no hay memberships** y `is_pincer_admin=true`: crea `admin_sessions`, redirige `/admin`.
   c. **Si no hay memberships** y `is_pincer_staff=true`: crea `restaurant_sessions` con `active_restaurant_id = NULL`, redirige a nuevo `/pincer-staff` (picker de TODOS los restaurantes).
   d. **Si hay 1 membership**: crea `restaurant_sessions` con `user_id + active_restaurant_id`, redirige `/{slug}/dashboard`. **Este es el 95% de casos y mantiene compatibilidad exacta con el APK.**
   e. **Si hay >1 memberships**: usa `users.last_active_restaurant_id` si existe, si no el primero alfabético. Redirige `/{slug}/dashboard`. Dashboard muestra switcher UI.
   f. **Si tiene tanto memberships como is_pincer_admin**: prioriza memberships (flujo normal de restaurante). Puede ir a `/admin` manualmente.

2. Nuevo endpoint `/api/switch-restaurant` (POST, cookie session required):
   - Body: `{ slug: "otherrestaurant" }`
   - Valida que el user sea miembro (o tenga `is_pincer_staff`).
   - Invalida la sesión vieja (delete `restaurant_sessions WHERE token_hash=?`).
   - Crea nueva sesión con el `active_restaurant_id` nuevo.
   - Actualiza `users.last_active_restaurant_id`.
   - Responde con Set-Cookie nueva (token nuevo).

3. `verifyRestaurantSession()` en `verify-session.js`:
   - Devuelve ahora `{valid, user_id, active_restaurant_id, restaurant_slug, role, is_pincer_staff}`.
   - Todo endpoint consumidor recibe suficiente info para autorizar.

4. Nueva util `authorize(session, { requires: 'manager' })`:
   - Centraliza la lógica de "qué puede hacer este user en este restaurante".
   - pincer_staff → siempre true.
   - Si no, busca `restaurant_members` del user + restaurante activo y compara role vs requires.

### 3.4 Schema de `restaurant_sessions` (cambios)

```sql
-- ANTES
-- user_id (FK implícito a restaurant_users.id)
-- restaurant_slug text

-- DESPUÉS
ALTER TABLE restaurant_sessions
  ADD COLUMN active_restaurant_id bigint REFERENCES restaurants(id),
  ADD COLUMN user_id_new bigint REFERENCES users(id);

-- Migrar user_id (de restaurant_users.id a users.id):
UPDATE restaurant_sessions rs
SET user_id_new = u.id,
    active_restaurant_id = r.id
FROM restaurant_users_legacy ru
JOIN users u ON u.email = ru.email
JOIN restaurants r ON r.restaurant_slug = ru.restaurant_slug
WHERE rs.user_id = ru.id;

-- Swap:
ALTER TABLE restaurant_sessions DROP COLUMN user_id;
ALTER TABLE restaurant_sessions RENAME COLUMN user_id_new TO user_id;
ALTER TABLE restaurant_sessions ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE restaurant_sessions ALTER COLUMN active_restaurant_id SET NOT NULL;

-- restaurant_slug se queda como columna redundante (cacheada para no joinear en cada verify).
-- Se actualiza al cambiar active_restaurant_id.
```

Sesiones existentes migran sin invalidarse (importante: si hubiera que invalidar, se haría un `TRUNCATE restaurant_sessions` en la ventana de mantenimiento — propuesta en §12).

### 3.5 URL y sessionStorage (frontend)

**Sin cambios en URLs principales** — `/{slug}/dashboard` sigue funcionando idéntico. Esto es crítico para el APK.

**Nuevas rutas:**
- `/pincer-staff` — picker para users con `is_pincer_staff` y sin membership directa (o que quieran ver TODOS los restaurantes).
- `/{slug}/dashboard/users` — gestión de miembros del restaurante (owner/admin only).
- `/{slug}/dashboard/switch` — UI del switcher si user tiene >1 membership.

**`sessionStorage` (en `login/index.html`):**
- Mantiene `dashboard_session` y `dashboard_session_{slug}` para compat.
- Añade `pincer_user_id` y opcionalmente `pincer_restaurants` (array de slugs del user).
- Sin cambios de formato en las existentes (el APK no las lee, pero por seguridad no tocar).

---

## 4. Cambios en `rls.sql` — SQL exacto

### 4.1 Orden de ejecución

Se agrega al final de `rls.sql` en un bloque marcado:

```sql
-- ══════════════════════════════════════════════════════════════
-- MULTI-TENANT MIGRATION (2026-04-XX)
-- Split restaurant_users into users + restaurants + restaurant_members.
-- Reversible: ver docs/multi-tenant-plan.md §10.
-- ══════════════════════════════════════════════════════════════

-- 1. Rename legacy table (falla ruidosamente si algún código viejo la queries)
ALTER TABLE restaurant_users RENAME TO restaurant_users_legacy;

-- 2. Create new tables (schemas completos en §3.1)
-- [CREATE TABLE users ...]
-- [CREATE TABLE restaurants ...]
-- [CREATE TABLE restaurant_members ...]

-- 3. Backfill
INSERT INTO users (id, email, username, password_hash, display_name, phone,
                   email_verified, email_verification_token, reset_token_hash,
                   reset_token_expires, failed_login_attempts, locked_until,
                   must_change_password, welcome_email_sent,
                   is_pincer_admin, is_pincer_staff,
                   created_at)
SELECT id, email, username, password_hash, contact_name, phone,
       email_verified, email_verification_token, reset_token_hash,
       reset_token_expires, failed_login_attempts, locked_until,
       must_change_password, welcome_email_sent,
       (role = 'admin'), false,
       created_at
FROM restaurant_users_legacy;

-- Preservar los ids originales para no invalidar sesiones
SELECT setval('users_id_seq', (SELECT MAX(id) FROM users));

INSERT INTO restaurants (restaurant_slug, display_name, status, plan, trial_expires_at,
                         logo_url, menu_style, menu_groups, order_types, delivery_fee,
                         business_type, address, phone, hours, website, notes,
                         chatbot_personality, azul_merchant_id, created_at)
SELECT restaurant_slug, display_name, status, plan, trial_expires_at,
       logo_url, menu_style, menu_groups, order_types, delivery_fee,
       business_type, address, phone, hours, website, notes,
       chatbot_personality, azul_merchant_id, created_at
FROM restaurant_users_legacy
WHERE role = 'restaurant';

-- Crear memberships como owner para cada user-restaurant
INSERT INTO restaurant_members (user_id, restaurant_id, role, status, created_at)
SELECT ru.id,
       r.id,
       'owner',
       'active',
       ru.created_at
FROM restaurant_users_legacy ru
JOIN restaurants r ON r.restaurant_slug = ru.restaurant_slug
WHERE ru.role = 'restaurant';

-- 4. Schema de sessions_3ds (fix schema drift detectado en Fase 1)
-- Documentar el CREATE TABLE real (copiar desde Supabase) en rls.sql como migración retroactiva

-- 5. fcm_tokens — cambiar unique key para soportar 1 device en N restaurantes
ALTER TABLE fcm_tokens DROP CONSTRAINT IF EXISTS fcm_tokens_token_key;
-- (el nombre exacto depende del estado real; verificar antes)
ALTER TABLE fcm_tokens ADD CONSTRAINT fcm_tokens_token_restaurant_key UNIQUE (token, restaurant_slug);

-- 6. last_active_restaurant_id
ALTER TABLE users ADD COLUMN last_active_restaurant_id bigint REFERENCES restaurants(id);
```

### 4.2 Migración reversible

```sql
-- ROLLBACK (ejecutar si la migración sale mal en cualquier momento)
DROP TABLE IF EXISTS restaurant_members CASCADE;
DROP TABLE IF EXISTS restaurants CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TYPE IF EXISTS restaurant_role;
ALTER TABLE restaurant_users_legacy RENAME TO restaurant_users;
-- restaurant_sessions ya tiene user_id y restaurant_slug originales (no se droppean durante migration)
-- Revert fcm_tokens:
ALTER TABLE fcm_tokens DROP CONSTRAINT fcm_tokens_token_restaurant_key;
ALTER TABLE fcm_tokens ADD CONSTRAINT fcm_tokens_token_key UNIQUE (token);
```

El único riesgo del rollback es si ya hubo escrituras a `users`/`restaurants`/`restaurant_members` que no existían en `restaurant_users`. Mitigación: durante la ventana de cutover los writes se bloquean (ver §12).

---

## 5. RLS policies — antes/después

### 5.1 Helper functions (nuevas)

```sql
-- Verifica si el user del JWT actual es pincer_staff.
-- (NO SE USA EN ESTE PR — anon key no lleva JWT. Ver nota abajo.)
CREATE OR REPLACE FUNCTION is_pincer_staff_user()
RETURNS BOOLEAN
LANGUAGE sql STABLE
AS $$
  SELECT false;  -- placeholder; solo tiene sentido si migramos a Supabase Auth
$$;
```

**Nota importante sobre RLS + custom auth:**

Las políticas RLS actuales de Pincer usan `TO anon` porque:
- El frontend del dashboard escribe productos/órdenes con el anon key directamente (tech debt conocida, documentada en CLAUDE.md §2 de technical-debt).
- Las APIs en `api/*.js` usan el **service role key** que bypassa RLS.

Por lo tanto, las políticas RLS en este PR **no van a usar helper functions de roles** — la autorización por rol vive en los endpoints Node.js (service role). Las policies anon solo controlan qué puede leer/escribir una tarjeta QR pública.

Esto es deuda técnica conocida pero no se resuelve aquí. Resolverla = migrar dashboard writes a endpoints autenticados = scope aparte (ya está en el backlog de CLAUDE.md).

### 5.2 Policies nuevas

```sql
-- users: totalmente privada al anon key
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "deny_anon_all_users" ON users FOR ALL TO anon USING (false);

-- restaurants: igual patrón que restaurant_users hoy (anon lee activos)
ALTER TABLE restaurants ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_select_restaurants"
  ON restaurants FOR SELECT TO anon
  USING (status = 'active');

CREATE POLICY "deny_anon_insert_restaurants" ON restaurants FOR INSERT TO anon WITH CHECK (false);
CREATE POLICY "deny_anon_update_restaurants" ON restaurants FOR UPDATE TO anon USING (false);
CREATE POLICY "deny_anon_delete_restaurants" ON restaurants FOR DELETE TO anon USING (false);

-- Recrear la vista pública sobre restaurants (drop el viejo restaurant_users_public después)
CREATE OR REPLACE VIEW restaurants_public AS
SELECT
  id, restaurant_slug, display_name, status, plan, trial_expires_at,
  logo_url, menu_style, menu_groups, order_types, delivery_fee,
  business_type, address, phone, hours, website, notes,
  chatbot_personality, created_at,
  (azul_merchant_id IS NOT NULL AND azul_merchant_id != '') AS payment_enabled
FROM restaurants
WHERE status = 'active';

GRANT SELECT ON restaurants_public TO anon;

-- restaurant_members: totalmente privada (solo service role)
ALTER TABLE restaurant_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY "deny_anon_all_members" ON restaurant_members FOR ALL TO anon USING (false);
```

### 5.3 Policies que no cambian

- `products`, `orders`, `store_settings`, `fcm_tokens`, `shifts`, `promotions` — siguen keyed por `restaurant_slug` texto. Como `restaurants.restaurant_slug` es único y estable, los queries existentes siguen funcionando. Sus policies anon (tech debt) quedan igual por ahora.
- `admin_sessions`, `restaurant_sessions`, `payment_audit`, `page_events`, `chat_messages`, `rate_limits`, `loyalty_*` — todas service-role only.

### 5.4 Tablas de auditoría nuevas

Tres tablas, tres propósitos distintos. Todas service-role only (ningún acceso anon).

**`restaurant_members_audit`** — cambios de membresía (alta, cambio de rol, cambio de status, baja):

```sql
CREATE TABLE restaurant_members_audit (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  member_id       bigint,                                 -- FK lógico a restaurant_members.id (nullable: el member puede haber sido eliminado)
  restaurant_id   bigint NOT NULL REFERENCES restaurants(id),
  target_user_id  bigint NOT NULL REFERENCES users(id),   -- user afectado
  actor_user_id   bigint REFERENCES users(id),            -- user que hizo el cambio (nullable si fue SQL manual)
  action          text NOT NULL,                          -- 'added' | 'role_changed' | 'status_changed' | 'removed'
  old_role        text,                                   -- valor anterior (si aplica)
  new_role        text,
  old_status      text,
  new_status      text,
  ip              text,
  user_agent      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_rma_restaurant ON restaurant_members_audit(restaurant_id, created_at DESC);
CREATE INDEX idx_rma_target_user ON restaurant_members_audit(target_user_id, created_at DESC);

ALTER TABLE restaurant_members_audit ENABLE ROW LEVEL SECURITY;
-- sin policies anon = service role only
```

Se escribe desde los endpoints `api/members-*.js` explícitamente (no trigger) porque necesitamos capturar `ip` y `user_agent` del request, cosa que los triggers de Postgres no ven.

**`users_flags_audit`** — cambios de `is_pincer_staff` y `is_pincer_admin`. Se escribe vía Postgres trigger para capturar INCLUSO cambios manuales por SQL:

```sql
CREATE TABLE users_flags_audit (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target_user_id  bigint NOT NULL,                        -- no FK: capturamos también si el user es eliminado
  flag_name       text NOT NULL,                          -- 'is_pincer_staff' | 'is_pincer_admin'
  old_value       boolean,
  new_value       boolean,
  changed_by_db_user text NOT NULL DEFAULT current_user,  -- rol de Postgres que hizo el cambio
  changed_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ufa_target ON users_flags_audit(target_user_id, changed_at DESC);

ALTER TABLE users_flags_audit ENABLE ROW LEVEL SECURITY;

-- Trigger que dispara en UPDATE de esos dos flags
CREATE OR REPLACE FUNCTION log_users_flags_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.is_pincer_staff IS DISTINCT FROM NEW.is_pincer_staff THEN
    INSERT INTO users_flags_audit (target_user_id, flag_name, old_value, new_value)
    VALUES (NEW.id, 'is_pincer_staff', OLD.is_pincer_staff, NEW.is_pincer_staff);
  END IF;
  IF OLD.is_pincer_admin IS DISTINCT FROM NEW.is_pincer_admin THEN
    INSERT INTO users_flags_audit (target_user_id, flag_name, old_value, new_value)
    VALUES (NEW.id, 'is_pincer_admin', OLD.is_pincer_admin, NEW.is_pincer_admin);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_users_flags_audit
  AFTER UPDATE OF is_pincer_staff, is_pincer_admin ON users
  FOR EACH ROW EXECUTE FUNCTION log_users_flags_change();
```

Esto cubre el requerimiento del owner: "log cada vez que se setea/quita, con timestamp y por quién (aunque sea por SQL manual)". El campo `changed_by_db_user` distingue entre cambios vía API (rol `service_role`) y cambios vía SQL Editor (rol de la cuenta Supabase del admin humano).

**`pincer_staff_audit`** — ya propuesta en §8.3. Registra cuándo un user con `is_pincer_staff=true` ACCEDE a un restaurante del que NO es miembro. Log de uso del privilegio elevado, no log de cambios.

Resumen de las tres:

| Tabla | Qué registra | Cómo se escribe |
|---|---|---|
| `restaurant_members_audit` | Cambios en la junction (add/remove/role change) | Endpoint Node explícito, con IP y UA |
| `users_flags_audit` | Set/unset de `is_pincer_staff`, `is_pincer_admin` | Trigger Postgres (captura todo, incluso SQL manual) |
| `pincer_staff_audit` | Accesos elevados a restaurantes donde el user NO es miembro real | `verifyRestaurantSession()` fire-and-forget |

---

## 6. Cambios en código

### 6.1 Utilidades nuevas

**`api/authorize.js` (nuevo)**
```js
// Helpers centralizados de autorización.
export async function requireRole(session, minRole /* 'owner' | 'admin' | 'manager' | 'cashier' */, supabaseUrl, supabaseKey) { ... }
export function isPincerStaff(session) { ... }
export async function isMember(userId, restaurantId, supabaseUrl, supabaseKey) { ... }
```

**`api/verify-session.js` (modificado)**
- `verifyRestaurantSession()` ahora hace JOIN con `users` y `restaurant_members` y `restaurants` para devolver: `{valid, user_id, email, active_restaurant_id, restaurant_slug, role, is_pincer_staff}`.
- Mantiene API backward-compat: sigue devolviendo `restaurant_slug` y `user_id` para que endpoints no migrados sigan funcionando.

### 6.2 Auth & sesión

**`api/auth.js`** — reescribir la parte que consulta `restaurant_users`:
- Buscar en `users` por username.
- Verificar bcrypt, lockout, must_change_password.
- Consultar memberships. Aplicar la lógica de §3.3.
- Crear `restaurant_sessions` con `user_id + active_restaurant_id`.
- Response sigue siendo `{success, role, restaurant_slug, display_name, username}` para no romper el APK. Pero si `role === 'restaurant'` y hay >1 membership, incluir `available_restaurants: [{slug, display_name}, ...]` (el dashboard lo renderea; APK ignora campos extra).

**`api/switch-restaurant.js`** (nuevo)
- POST con cookie session.
- Invalida sesión vieja, crea nueva con nuevo `active_restaurant_id`.
- Actualiza `users.last_active_restaurant_id`.

**`api/logout.js`** — sin cambios (sigue borrando por token_hash).

### 6.3 Signup

**`api/signup.js`** — dividir la creación del row monolítico en 3 writes atómicos:
1. INSERT `users` (email, password_hash, username, ...) → devuelve `user_id`.
2. INSERT `restaurants` (restaurant_slug, display_name, plan='premium', trial_expires_at, ...) → devuelve `restaurant_id`.
3. INSERT `restaurant_members` (user_id, restaurant_id, role='owner', status='active').

**Atomicidad:** Supabase REST no soporta transacciones entre requests. Opciones:
- (a) Crear una RPC `create_restaurant_with_owner(...)` en Postgres que haga los 3 inserts en una transacción real.
- (b) Hacer los 3 requests secuenciales con manejo manual de rollback (si falla el 3, borrar el 2 y el 1). Frágil.

**Recomendación: opción (a).** Es lo más limpio y Supabase lo soporta nativamente.

```sql
CREATE FUNCTION create_restaurant_with_owner(
  p_email text,
  p_username text,
  p_password_hash text,
  p_display_name text,
  p_restaurant_slug text,
  p_restaurant_display_name text,
  -- ... todos los campos
) RETURNS json LANGUAGE plpgsql AS $$
DECLARE
  new_user_id bigint;
  new_restaurant_id bigint;
BEGIN
  -- Pre-flight checks con mensajes específicos (mejor UX que depender del SQLSTATE raw)
  IF EXISTS(SELECT 1 FROM users WHERE email = p_email) THEN
    RETURN json_build_object('error', 'email_taken');
  END IF;
  IF EXISTS(SELECT 1 FROM users WHERE username = p_username) THEN
    RETURN json_build_object('error', 'username_taken');
  END IF;
  IF EXISTS(SELECT 1 FROM restaurants WHERE restaurant_slug = p_restaurant_slug) THEN
    RETURN json_build_object('error', 'slug_taken');
  END IF;

  -- Insert atómico dentro de la función (transacción implícita)
  INSERT INTO users (email, username, password_hash, display_name, ...)
    VALUES (p_email, p_username, p_password_hash, p_display_name, ...)
    RETURNING id INTO new_user_id;

  INSERT INTO restaurants (restaurant_slug, display_name, ...)
    VALUES (p_restaurant_slug, p_restaurant_display_name, ...)
    RETURNING id INTO new_restaurant_id;

  INSERT INTO restaurant_members (user_id, restaurant_id, role, status)
    VALUES (new_user_id, new_restaurant_id, 'owner', 'active');

  -- Audit trail
  INSERT INTO restaurant_members_audit (restaurant_id, target_user_id, actor_user_id, action, new_role, new_status)
    VALUES (new_restaurant_id, new_user_id, new_user_id, 'added', 'owner', 'active');

  RETURN json_build_object(
    'success', true,
    'user_id', new_user_id,
    'restaurant_id', new_restaurant_id,
    'restaurant_slug', p_restaurant_slug
  );
EXCEPTION
  -- Defensa: si algo raro escapa los pre-flight checks (race condition entre SELECT y INSERT),
  -- capturamos los unique_violation y devolvemos el error apropiado en lugar de 500
  WHEN unique_violation THEN
    -- Esto puede pasar si dos signups llegan exactamente al mismo tiempo con mismo slug/email.
    -- El constraint de DB los salva (solo uno gana), pero la función debe devolver algo estructurado.
    RETURN json_build_object('error', 'conflict_race_condition', 'detail', SQLERRM);
  WHEN OTHERS THEN
    -- Cualquier otro error → no filtrar detalles a producción, loguear en server
    RAISE NOTICE 'create_restaurant_with_owner failed: % %', SQLSTATE, SQLERRM;
    RETURN json_build_object('error', 'internal');
END;
$$;
```

Nuevo signup flow llama esta RPC vía Supabase REST (`POST /rest/v1/rpc/create_restaurant_with_owner`). El endpoint `api/signup.js` mapea los `error` strings a mensajes en español para la UI (`"Ese email ya tiene cuenta"`, `"Ese nombre de restaurante ya existe"`, etc.).

**Casos de error especificados explícitamente (respuesta al punto Q2 del owner):**

| Escenario | Resultado de la RPC | Mensaje UI (ES) |
|---|---|---|
| Email ya en `users` | `{error: 'email_taken'}` | "Ya existe una cuenta con este email. Inicia sesión." |
| Username/slug ya en `users` (colisión rara porque lo generamos de restaurant_name) | `{error: 'username_taken'}` | "Intenta con un nombre de restaurante ligeramente diferente." |
| `restaurant_slug` ya en `restaurants` | `{error: 'slug_taken'}` | "Ya existe un restaurante con ese nombre." |
| Owner ya es miembro de otro restaurante | **No es error.** La RPC crea el nuevo user/restaurant/membership sin problemas. Este es el caso multi-tenant normal. En v1 esto no ocurre porque `email` es único por usuario (un email = un user), pero el modelo lo soporta para cuando agreguemos "agregar segundo restaurante a mi cuenta". | — |
| Race condition (dos signups simultáneos con mismo slug) | `{error: 'conflict_race_condition'}` | "Intenta de nuevo en unos segundos." |
| Cualquier otro fallo Postgres | `{error: 'internal'}` | "Error interno. Intenta de nuevo." |

**Nota sobre el signup v1:** el flujo de "agregar segundo restaurante a cuenta existente" NO se construye en este PR. El signup público sigue creando siempre un user nuevo. La capacidad multi-tenant vive en que un user (creado manualmente vía SQL o admin panel futuro) PUEDE tener >1 membership, pero el signup público no expone esa ruta.

### 6.4 Endpoints que filtran por `restaurant_slug`

**Todos los endpoints de dashboard** (`update-settings`, `create-promo`, `download-report`, `shift-report`, `generate-insights`, `toggle-promo`, `void-payment`, etc.):
- Cambio mínimo: `session.restaurant_slug` sigue existiendo (por compat) + nuevo check con `requireRole(session, 'manager', ...)` antes de writes.
- `update-settings` en particular: separar qué campos puede tocar cada role. `manager` puede actualizar `hours`, `address`, `chatbot_personality`; solo `owner/admin` puede cambiar `plan`, `delivery_fee`, `azul_merchant_id`.

**Ejemplo concreto — `api/update-settings.js`:**
```js
// Antes: update restaurant_users where restaurant_slug = session.restaurant_slug
// Después:
const session = await verifyRestaurantSession(token, ...);
if (!session.valid) return 401;
if (!await requireRole(session, 'manager', ...)) return 403;

// Campos que requieren owner:
const OWNER_ONLY_FIELDS = ['plan', 'azul_merchant_id', 'delivery_fee'];
const attemptedOwnerFields = Object.keys(req.body).filter(f => OWNER_ONLY_FIELDS.includes(f));
if (attemptedOwnerFields.length > 0 && !await requireRole(session, 'owner', ...)) {
  return 403;
}

// UPDATE restaurants SET ... WHERE id = session.active_restaurant_id
```

### 6.5 Endpoints públicos

**`api/waiter-chat.js`**: lee `restaurants` en vez de `restaurant_users`. Sin cambios de auth. El "spoofing" que el agente marcó (cliente pasa slug por query) **no es vulnerabilidad en sí** — los menús son públicos por diseño. Se ignora como no-issue.

**`api/og.js`, `api/pincer-chat.js`, `api/dashboard-manifest.js`, `api/parse-menu.js`**: cambio similar, solo la tabla leída.

**`api/whatsapp-webhook.js`**: hoy busca `restaurant_users` por `phone`. Nuevo: busca `restaurants` por `phone` (columna `phone` migra a la tabla de restaurants). Nota: el `phone` del restaurante es el que se usa para mapear WhatsApp. Si un owner tiene 2 restaurantes con el mismo número, hay que decidir cuál recibe. Recomendación: añadir `restaurants.whatsapp_phone` como columna explícita separada del `phone` de contacto, y exigir unicidad.

### 6.6 Flujo de pago Azul

**`api/payment.js`**: reemplazar `restaurant_users?slug=eq.X&select=azul_merchant_id` → `restaurants?slug=eq.X&select=azul_merchant_id,id`. Seguir guardando `restaurant_slug` en `sessions_3ds` para compat.

**`api/3ds.js` — FIX del bug pre-existente (§7):**

Líneas 112 y 218 hoy dicen `Store: process.env.AZUL_MERCHANT_ID`. Cambio:
- En el `POST /api/payment` inicial, al crear la fila `sessions_3ds`, guardar `azul_merchant_id` del restaurante.
- En `handleContinue()` y `handleCallback()`, leer `sessions_3ds.azul_merchant_id` y usarlo como `Store`.

Este fix se hace **antes** del resto de la migración multi-tenant (como sub-PR aparte o commit aislado dentro de la rama). Razón: es un bug latente hoy mismo, y arreglarlo antes reduce el riesgo de regresión durante el cutover.

### 6.7 FCM tokens — fix del bug pre-existente (§7)

**`api/register-device-token.js`**:
- Línea 52: `on_conflict=token` → `on_conflict=token,restaurant_slug` (ya habrá nuevo índice UNIQUE `(token, restaurant_slug)`).
- Semántica: un device FCM se registra **una vez por restaurante**. Un user con acceso a 2 restaurantes en el mismo device tendrá 2 filas en `fcm_tokens`.

**`api/send-notification.js`**: sin cambios — ya filtra por `restaurant_slug`.

**Efecto en el APK:** el APK registra su token FCM cada vez que abre la app (con el slug del user actual). Si el user cambia de restaurante vía `/api/switch-restaurant`, el dashboard debería re-llamar `/api/register-device-token` con el nuevo slug para crear la segunda fila.

### 6.8 Admin panel (`/admin`)

**Sin cambios** en este PR. `admin_sessions` sigue funcionando. Usuarios con `is_pincer_admin=true` hacen login normal y son redirigidos a `/admin` (igual que hoy con `role='admin'`).

Deuda técnica documentada: unificar `/admin` con `pincer_staff` es un PR posterior.

### 6.9 Cron jobs

**`api/cron/downgrade-trials.js`**: cambiar query de `restaurant_users` → `restaurants` (mismo filtro: `plan='premium' AND trial_expires_at < now AND status='active'`).

**`api/cron/chatbot-learnings.js`, `api/cron/cleanup-rate-limits.js`**: sin cambios.

### 6.10 UI nueva

**`dashboard/users/` (nueva ruta) o sección dentro de dashboard:**
- Listar miembros del restaurante activo.
- Invitar por email (crea `restaurant_members.status='invited'`, envía email con link de activación).
- Cambiar rol de miembro (owner/admin only).
- Remover miembro (owner/admin only, no puede remover al único owner).
- Endpoints backing: `api/members-list.js`, `api/members-invite.js`, `api/members-update-role.js`, `api/members-remove.js`.

**Switcher de restaurante (si user tiene >1):**
- Pequeño dropdown en el header del dashboard.
- Llama `/api/switch-restaurant` y recarga.

**`/pincer-staff` (para Tamayo):**
- Lista todos los restaurantes del sistema con buscador.
- Click en uno → `/api/switch-restaurant` con ese slug (backend permite porque `is_pincer_staff=true`) → redirige a `/{slug}/dashboard`.

**Signup no cambia visualmente.** El flujo sigue igual; internamente crea user + restaurant + membership.

---

## 7. Bugs pre-existentes a arreglar como parte del PR

Estos no son estrictamente parte del cambio multi-tenant, pero el multi-tenant los expone. Se arreglan en **commits aislados a `main` ANTES de arrancar la rama larga** (decisión confirmada por el owner), para que:
- Cualquier bug futuro sea atribuible a la migración o al fix, no a ambos mezclados.
- El fix #2 (data loss latente) salga a prod lo antes posible.
- La rama `multi-tenant` arranque de un `main` ya saneado.

1. **Azul `Store` hardcoded en 3DS continue/callback** (`api/3ds.js:112,218`). Hoy funciona por casualidad (Square One = el único con pagos vivos = el env var). Fix en §6.6. **Bloquea la aceptación de un segundo restaurante con Azul.**

   **Directriz explícita del owner sobre este fix:** si un restaurante no tiene `azul_merchant_id` configurado, la función debe **fallar ruidosamente** con un mensaje claro (`"Payment not configured for this restaurant"`), NO hacer fallback silencioso al env var. El fallback silencioso es exactamente lo que escondió este bug durante meses — por eso hay que eliminarlo.

   Checklist manual post-fix:
   - [ ] Pago con Square One (tiene `azul_merchant_id` configurado) → approved.
   - [ ] Pago con Mr. Sandwich (sin `azul_merchant_id`) → 400 explícito con `{error: 'payment_not_configured'}`, sin tocar Azul.
   - [ ] `Store` en el request a Azul coincide con el merchant del restaurante, no con el env var. Verificar con un `console.log` temporal en preview deploy (luego remover).

2. **FCM `on_conflict=token`** (`api/register-device-token.js:52`). Hoy silencioso. Fix en §6.7. **Se vuelve data loss real en cuanto alguien tenga acceso a 2 restaurantes en el mismo device.**

   El fix requiere cambio de schema (`fcm_tokens` unique key (token) → (token, restaurant_slug)) y el endpoint actualizado al mismo tiempo. Como el cambio es compatible con el modelo actual (1:1), se puede deployar antes del multi-tenant.

3. **Schema drift de `sessions_3ds`**: existe en Supabase pero no en `rls.sql`. Documentarlo en el PR como medida higiénica. No cambia nada funcionalmente — solo añade el `CREATE TABLE IF NOT EXISTS` al archivo con el schema real observado en Supabase.

---

## 8. Análisis de seguridad

### 8.1 IDOR (Insecure Direct Object Reference)

**Vector:** un user de restaurante A hace un request cambiando `restaurant_slug` o `restaurant_id` en el body/URL para tocar restaurante B.

**Mitigación:** **ignorar completamente cualquier `restaurant_slug` o `restaurant_id` del body/query**. Todo endpoint de dashboard deriva el restaurante activo desde `session.active_restaurant_id` (sacado del cookie, no manipulable). Esto ya es el patrón actual; se refuerza.

Excepciones: endpoints públicos (`waiter-chat`, `og`, `menu/*`) SÍ toman slug del URL porque no hay sesión. Esos endpoints son read-only sobre campos públicos, así que IDOR no aplica.

Endpoints que ACTUALMENTE aceptan slug en body y requieren fix defensivo:
- `api/register-device-token.js` — ya valida `restaurantSlug === session.restaurant_slug` (línea 38). Mantener.
- Revisar todos los endpoints de dashboard en el PR — si alguno usa `req.body.slug` en vez de `session.restaurant_slug`, eso es bug.

### 8.2 Privilege escalation

**Vector:** un cashier hace PATCH a su propio `restaurant_members.role` para subirse a owner.

**Mitigación:**
- Endpoint `api/members-update-role.js` valida `requireRole(session, 'admin')` antes de cualquier write.
- Además, un user NUNCA puede modificar su propia fila de membership (check: `if (target_user_id === session.user_id) return 403`).
- Solo `owner` puede promover a otro `admin` o `owner` (no los `admin` existentes, para evitar que un admin autopromoeva a owner y robe el restaurante).

### 8.3 pincer_staff auditoría

Todo acceso vía `is_pincer_staff=true` debe loggear a una tabla `pincer_staff_audit`:

```sql
CREATE TABLE pincer_staff_audit (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       bigint NOT NULL REFERENCES users(id),
  restaurant_id bigint NOT NULL REFERENCES restaurants(id),
  action        text NOT NULL,         -- 'viewed_dashboard', 'edited_menu', 'switched_in', etc.
  endpoint      text,
  ip            text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
```

Log se escribe fire-and-forget desde `verifyRestaurantSession()` cuando detecta `is_pincer_staff=true && no es miembro real`. Retention: 1 año.

Esto protege legalmente ante disputas ("¿Pincer entró sin permiso?") y da señal de uso para saber si el rol se está abusando.

### 8.4 Rotación de sesiones post-migración

**Decisión:** NO invalidar sesiones durante cutover. Razones:
- La migración preserva `user_id` (mismo valor, ahora apunta a `users.id` que es el mismo id heredado).
- `restaurant_sessions.restaurant_slug` sigue siendo válido post-migración.
- Mr. Sandwich y Square One staff siguen logueados sin interrupción.

Alternativa si algo sale mal: `TRUNCATE restaurant_sessions` fuerza re-login de todos. Último recurso.

### 8.5 Cobertura RLS: INSERT/UPDATE/DELETE además de SELECT

Revisión de `rls.sql` existente (hecha en Fase 1): todas las tablas sensibles (users, restaurants, restaurant_members, admin_sessions, restaurant_sessions, payment_audit, loyalty_*, rate_limits, chat_messages, page_events) tienen solo acceso service-role. `products`/`orders`/`store_settings`/`fcm_tokens`/`shifts` tienen policies anon permissive (tech debt pre-existente, NO se toca en este PR).

### 8.6 Signup público y pincer_staff

`api/signup.js` NUNCA debe setear `is_pincer_staff` ni `is_pincer_admin`. El código nuevo de signup ni siquiera recibe esos campos del body. Solo asignables manualmente vía SQL en Supabase.

---

## 9. Qué puede romperse (y cómo lo verifico)

| Funcionalidad | Riesgo | Verificación |
|---|---|---|
| Login de Mr. Sandwich / Square One | Alto | Post-cutover: login con cada cuenta, verificar redirect a `/{slug}/dashboard`, cookie presente. |
| Signup nuevo restaurante | Alto | Crear restaurante de prueba end-to-end desde `/signup`. |
| Pago con tarjeta (Azul, Square One) | Crítico | Test transaction de RD$1 con card propia en preview deploy antes de prod. El 3DS fix puede regresionar pagos frictionless. |
| Pago 3DS Challenge | Alto | Mismo test con card que requiera 3DS Challenge (una de prueba de Tamayo). |
| Chatbot de pedido (waiter-chat) | Medio | Escanear QR → ver menú, horario, personalidad. Hacer pedido de prueba. |
| Push notifications FCM Android | Alto | Dispositivo con APK logueado a Mr. Sandwich → crear orden desde otro device → verificar notificación. |
| Push notifications Web dashboard | Medio | Igual, en tab Chrome. |
| APK Android en general | Alto | Abrir APK, login, ver dashboard. Todo URL debe resolver igual que antes. |
| Webhook Twilio WhatsApp | Medio | Enviar mensaje WA de prueba al número de Mr. Sandwich, verificar que el mapeo phone→restaurant sigue. |
| Cron downgrade-trials | Bajo | Forzar ejecución manual con `curl` + CRON_SECRET, verificar que Square One no se degrada (si aplica su fecha). |
| OG image | Bajo | Compartir link `/mrsandwich` en WhatsApp, verificar preview. |
| Admin panel `/admin` | Bajo | Login con cuenta admin actual, hacer CRUD básico. |
| Forgot password + reset | Medio | Flujo completo con email real. |
| Change password forced | Bajo | Crear cuenta de prueba con `must_change_password=true`, verificar gate. |

---

## 10. Plan de rollback y limpieza de legacy

### 10.1 Ventanas de rollback (en orden de cuán limpio)

**Ventana A — Primeros 15-30 minutos post-cutover (smoke test):**
- Si el smoke test falla (login, pagos, FCM, dashboard): flip `PINCER_MULTI_TENANT=false`, re-grant INSERT/UPDATE/DELETE a `restaurant_users_legacy`, revert del código (git revert del merge).
- Rollback casi limpio: los únicos writes perdidos son los de staff probando durante el smoke test.
- Vercel redeploya en ~30s tras flip de env var.

**Ventana B — Primeros 7 días post-cutover:**
- Si aparece bug en días 1-7: se arregla forward (no se hace rollback completo). Legacy table sigue como read-only, disponible para consultas comparativas si hay sospecha de data corruption.
- Si el bug es crítico: opción nuclear es restaurar desde backup (§12.1), pero pierde writes de los días transcurridos.

**Ventana C — Día 7+:**
- Rollback completo ya no es viable. Forward fixes only. Esto es normal en cualquier migración grande.

### 10.2 SQL de rollback (solo Ventana A)

```sql
-- EJECUTAR SOLO SI SE DECIDE ROLLBACK EN VENTANA A
-- Paso 1: restaurar writes a legacy
GRANT INSERT, UPDATE, DELETE ON restaurant_users_legacy TO service_role;

-- Paso 2: rename back
ALTER TABLE restaurant_users_legacy RENAME TO restaurant_users;

-- Paso 3: drop nuevas tablas
DROP TABLE IF EXISTS restaurant_members_audit CASCADE;
DROP TABLE IF EXISTS users_flags_audit CASCADE;
DROP TABLE IF EXISTS pincer_staff_audit CASCADE;
DROP TABLE IF EXISTS restaurant_members CASCADE;
DROP TABLE IF EXISTS restaurants CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TYPE IF EXISTS restaurant_role;
DROP FUNCTION IF EXISTS create_restaurant_with_owner CASCADE;
DROP FUNCTION IF EXISTS log_users_flags_change CASCADE;

-- Paso 4: revert fcm_tokens (si se aplicó el cambio de unique key)
ALTER TABLE fcm_tokens DROP CONSTRAINT IF EXISTS fcm_tokens_token_restaurant_key;
ALTER TABLE fcm_tokens ADD CONSTRAINT fcm_tokens_token_key UNIQUE (token);

-- Paso 5: revert restaurant_sessions (si se modificó)
ALTER TABLE restaurant_sessions DROP COLUMN IF EXISTS active_restaurant_id;
-- user_id y restaurant_slug originales ya están, no se tocaron
```

### 10.3 Política de limpieza de `restaurant_users_legacy` (respuesta al punto Q3 del owner)

Legacy se mantiene durante 30 días post-cutover como safety net:

| Día | Acción |
|---|---|
| **Cutover (D0)** | `ALTER TABLE restaurant_users RENAME TO restaurant_users_legacy`. Los queries viejos que la referencien fallan ruidosamente. |
| **D0 + 1h** (post smoke test exitoso) | `REVOKE INSERT, UPDATE, DELETE ON restaurant_users_legacy FROM service_role`. Solo SELECT, para consultas comparativas o forensics. |
| **D0 + 1h** | Instalar trigger de log en SELECT para detectar código que aún consulta legacy: `CREATE EVENT TRIGGER` no soporta SELECT, pero se puede simular con una vista wrapper o pg_stat_statements. Alternativa pragmática: revisar manualmente `pg_stat_user_tables.seq_scan + idx_scan` en `restaurant_users_legacy` durante la semana 1. Si el contador sube, hay código leyendo legacy (bug). |
| **D30** | Export completo a archivo `.sql.gz` guardado fuera de Supabase (S3 personal o local). **Verificar que el export se puede restaurar** en una DB temporal ANTES de droppear el original. |
| **D30 + export verificado** | `DROP TABLE restaurant_users_legacy CASCADE`. |
| **D30+** | Remover feature flag del código (§13). Cerrar la deuda. |

Si entre D0 y D30 aparece un bug que requiere consultar data histórica, la data está disponible read-only.

---

## 11. Plan de testing

### 11.0 Staging Supabase — setup (confirmado por el owner)

Staging Supabase **separado** (no preview contra prod). Setup:

1. Crear proyecto Supabase nuevo: `pincer-staging` (plan free es suficiente para testing).
2. Exportar schema de prod: Supabase Dashboard → Database → Backups → Download SQL schema only (sin data).
3. Aplicar schema a staging.
4. Generar data de prueba realista:
   - 3 users: `staff@pincer.test` (con `is_pincer_staff=true`), `owner_ms@test.com` (owner de Mr. Sandwich clon), `owner_so@test.com` (owner de Square One clon).
   - 2 restaurants: `mrsandwich-test`, `squareone-test` (con mismos slugs + `-test` sufijo para no confundir).
   - ~20 products por restaurant (copiar de prod vía script, **sin data de ventas/órdenes reales**).
   - **NO copiar:** `orders`, `payment_audit`, `chat_messages`, `page_events`, tokens FCM reales, certs Azul reales. Solo schema + config mínima.
5. Env vars en Vercel para el preview deploy:
   - `SUPABASE_URL_STAGING=https://<staging-ref>.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY_STAGING=<staging service role key>`
   - `PINCER_USE_STAGING=true` → el código, si ve este flag, usa las env vars `_STAGING`.
6. **Credenciales sandbox Azul** (obligatorio — el pago end-to-end se valida aquí, no en prod):
   - Solicitar a Azul (o reutilizar si existen) credenciales de ambiente de desarrollo.
   - Certificados en `certs/azul-cert-staging.pem`, `certs/azul-key-staging.pem`, `certs/azul-chain-staging.pem` (gitignored, no commitear).
   - Env vars `_STAGING` correspondientes: `AZUL_URL_STAGING`, `AZUL_AUTH1_STAGING`, `AZUL_AUTH2_STAGING`, `AZUL_MERCHANT_ID_STAGING`.
   - Asignar el `azul_merchant_id` sandbox al restaurante `squareone-test` en staging para probar el flujo completo.
   - **Si estas credenciales no están listas ANTES del inicio de Fase D (cutover), el cutover se pospone.** Sin sandbox Azul no hay forma no-destructiva de validar pagos end-to-end en el nuevo modelo.

Con staging listo (incluyendo Azul sandbox), todo el trabajo de la rama `multi-tenant` se prueba ahí primero.

### 11.1 Pre-merge (en rama `multi-tenant`, preview deploy contra staging)

Usar `vercel` CLI para preview deploy, con `PINCER_USE_STAGING=true`:

Checklist:
- [ ] Login como cuenta migrada de Mr. Sandwich → redirect correcto a `/mrsandwich/dashboard`.
- [ ] Login como cuenta migrada de Square One → redirect correcto.
- [ ] Login como cuenta admin → `/admin`.
- [ ] Crear cuenta nueva de prueba vía `/signup` → verifica 3 inserts (users, restaurants, restaurant_members).
- [ ] Como owner: invitar manager por email, aceptar invitación, login como manager, verificar permisos.
- [ ] Como manager: intentar editar `delivery_fee` → 403.
- [ ] Como cashier: intentar ver reportes históricos → 403.
- [ ] Como `is_pincer_staff`: entrar a cualquier restaurante vía `/pincer-staff`.
- [ ] Crear 2 restaurantes con un mismo user (vía SQL, simula caso futuro). Login → verifica picker o redirect a last_active.
- [ ] `/api/switch-restaurant` → sesión rotada, redirect al nuevo dashboard.
- [ ] Pago Azul frictionless contra sandbox (card de prueba del ambiente dev Azul) → approved. Verifica que `Store` enviado a Azul coincide con `restaurants.azul_merchant_id` del slug, no con el env var.
- [ ] Pago Azul 3DS Challenge contra sandbox → approved (prueba el fix del bug pre-existente §6.6).
- [ ] Pago a restaurante sin `azul_merchant_id` (ej: `mrsandwich-test` sin configurar) → rechazado con 400 `{error: 'payment_not_configured'}`. Valida la directriz "fallar ruidosamente" del §7.
- [ ] FCM: device Android con 2 memberships recibe notifs de ambos restaurantes (la del activo primero, pero ambas filas existen).
- [ ] waiter-chat: escanear QR de Mr. Sandwich, pedir items, verificar pedido aparece en el dashboard.

### 11.2 Post-merge (en main, sin mergear otros PRs hasta verificar)

Todo no-destructivo. **Cero pagos reales** en esta fase — su validación está cubierta por §11.1 contra el sandbox de Azul en staging.

- [ ] Login Mr. Sandwich en prod → redirect a `/mrsandwich/dashboard`, dashboard carga.
- [ ] Login Square One en prod → redirect a `/squareone/dashboard`, dashboard carga.
- [ ] Dashboard de cada restaurante: ver órdenes del día previo (read-only), ver menú, ver config. Todo data propia, nada cruzado.
- [ ] FCM: crear orden de prueba via SQL INSERT directo en `orders` (con `restaurant_slug='mrsandwich'`, total pequeño, status='pending') → verificar push en el APK Android del owner. Luego DELETE la orden para no ensuciar reportes.
- [ ] Monitor de Vercel logs por 24h — cero 500s relacionados a auth.
- [ ] **Primer pago orgánico real post-cutover:** monitoreo reforzado. Cuando un cliente real haga un pago (sin intervenir), verificar en vivo que approved → order creada → push recibido → `Store` en el request a Azul fue el merchant correcto. Este es el verdadero end-to-end en prod, pero el riesgo está acotado porque Azul sandbox ya validó todo el camino en staging.

### 11.3 Monitoreo activo post-cutover (primeras 24h)

El owner flagó esto explícitamente: bugs sutiles de RLS pueden no generar errores ruidosos, sino comportamiento incorrecto silencioso (ej: alguien viendo data que no le toca). Por eso los primeros 24h se hacen **revisiones activas cada 2-3h**, no solo respuesta a alertas.

Checklist por cada ventana de revisión:
- [ ] Vercel logs: filtrar por status 500 y status 403 en endpoints `/api/...`. Un 403 normal es OK; un spike de 403 puede indicar bug de autorización.
- [ ] Supabase logs: queries con error. Busca patrones "permission denied", "column does not exist", "relation does not exist" (este último detectaría código todavía querying `restaurant_users` sin el `_legacy`).
- [ ] `pg_stat_user_tables` del Dashboard Supabase: `seq_scan` en `restaurant_users_legacy`. Debería ser 0 (o muy bajo, solo de mi review manual). Si sube, hay código leyendo tabla vieja.
- [ ] `restaurant_members_audit` count: debería subir solo por mis acciones de prueba. Si sube por algo que no reconozco, investigar.
- [ ] `pincer_staff_audit` count: igual.
- [ ] Spot-check: entrar al dashboard de Mr. Sandwich y Square One como sus owners reales (vía SSH de Tamayo, no vía pincer_staff), verificar que la data que ven es solo la suya.

Cadencia: cada 2-3h las primeras 12h, cada 6h las siguientes 12h. Total ~6-8 checks en el primer día.

**Alerting proactivo (además de la revisión manual):**

La revisión manual es necesaria pero no suficiente — algo puede romperse entre chequeos. Complemento:

1. **Baseline pre-cutover:** una semana antes del cutover, capturar el count diario promedio de errores en Vercel logs (filtrar por status 500 y status 403 en `/api/...`). Ese es el baseline.
2. **Cronjob de alerta** (nuevo endpoint `api/cron/alert-error-spike.js` o script externo que cron Vercel):
   - Corre cada hora durante las primeras 48h post-cutover.
   - Cuenta errores 500 y 403 de la última hora en Vercel logs (via API o log export).
   - Compara contra baseline hourly rate.
   - Si el count supera `baseline × 3` (o cualquier 500 que contenga keywords como "permission denied", "relation does not exist", "column does not exist"), envía mensaje vía Resend al email del owner con los primeros 10 errores y link a Vercel Dashboard.
3. **Umbral adicional de "silencio sospechoso":** si el count de `orders` insertadas cae >50% respecto del mismo día de la semana anterior durante horas de operación, también alerta. Este detecta el peor caso: "todo parece estar OK pero los clientes no pueden pedir".
4. **Canal de alerta:** email (Resend, ya configurado) + WhatsApp opcional vía Twilio (ya integrado) al número del owner.

Si el setup del cronjob de alerta toma tiempo adicional, se construye como parte de Fase A (antes del cutover), no después. Sin alerting proactivo, 6-8 horas entre chequeos manuales es demasiada ventana ciega para un cutover de este tamaño.

---

## 12. Orden de implementación

### Fase A — preparación (sin tocar prod)

1. Crear rama `multi-tenant`.
2. Fix de los 2 bugs pre-existentes (§7) como commits aislados. Revisar y mergear a `multi-tenant` pero NO a main todavía.
   - Commit 1: Azul Store per-restaurant en 3DS continue/callback.
   - Commit 2: FCM token unique key `(token, restaurant_slug)`.
   - Commit 3: `sessions_3ds` documentado en `rls.sql`.
3. Crear Supabase staging (o branch de Supabase si existe). Copiar schema.

### Fase B — schema y migración

4. Crear tablas nuevas (users, restaurants, restaurant_members) en staging.
5. Ejecutar backfill desde `restaurant_users_legacy`. Verificar counts.
6. Verificar que queries directas funcionan contra las nuevas tablas.

### Fase C — código

7. Feature flag en env: `PINCER_MULTI_TENANT=true|false`. Cuando `false`, endpoints usan `restaurant_users` (legacy). Cuando `true`, usan las nuevas.
8. Refactorizar `verify-session.js`, `authorize.js`, `auth.js`, `signup.js` con branching por feature flag.
9. Refactorizar endpoints dashboard/públicos uno por uno. Cada uno con su commit.
10. Nueva UI (gestión de miembros, switcher, `/pincer-staff`).
11. En staging, toggle `PINCER_MULTI_TENANT=true` → correr checklist §11.1.

### Fase D — cutover

12. **D-1 (sábado):** backup completo verificado (§12.1 abajo). Sin este paso, no se arranca el cutover.
13. **Domingo temprano (5-7am DR):** Mr. Sandwich y Square One cerrados. Tamayo disponible. Owner avisado con 1h de anticipación.
14. **T0:** checklist paso a paso enviado al owner para revisión final (§12.2) — esperar su OK antes de seguir.
15. **T0 + owner OK:** ejecutar migración SQL en prod Supabase (§4.1).
16. Verificar counts: `users`, `restaurants`, `restaurant_members` == expected (mismo count que `restaurant_users_legacy`).
17. Cambiar `PINCER_MULTI_TENANT=true` en Vercel (env var, no requiere redeploy manual si el código lo lee por request).
18. Forzar redeploy por seguridad (push vacío o re-deploy manual via CLI). ~30-60s.
19. Smoke test: login Mr. Sandwich → dashboard carga → ver órdenes del día previo. Login Square One → igual. Pago de RD$5 de prueba a Square One (con tarjeta propia del owner, si aprueba).
20. Si OK, merge `multi-tenant` a `main` (trigger redeploy, debería ser no-op si ya deployamos con el mismo HEAD).
21. Arrancar monitoreo activo 24h (§11.3).

### Fase E — limpieza (PR separado, ~30 días después)

22. Remover feature flag (todo el branching queda hardcoded al camino nuevo).
23. Export de `restaurant_users_legacy` a archivo externo + verificar restore en DB temporal.
24. Drop `restaurant_users_legacy` en Supabase.
25. Drop vista `restaurant_users_public` (reemplazada por `restaurants_public`).
26. Documentar todo en CLAUDE.md.

### 12.1 Backup verificado pre-cutover (requisito explícito del owner)

> "Backups no probados no son backups." — owner feedback

Sábado, idealmente 6-12h antes del cutover:

1. **Backup automático Supabase:** confirmar que el snapshot nocturno del sábado existe en el dashboard de Supabase (Dashboard → Database → Backups).
2. **Export manual adicional:** via `supabase db dump --data-only --schema public` (o equivalente vía Supabase CLI) → archivo `.sql.gz` guardado en disco local Y en una ubicación externa (pendrive, iCloud, S3 personal — cualquiera que no sea Supabase).
3. **Prueba de restore:** crear proyecto Supabase temporal nuevo (o reutilizar staging), restaurar el dump, verificar:
   - [ ] `SELECT count(*) FROM restaurant_users` devuelve el count esperado.
   - [ ] `SELECT count(*) FROM orders WHERE created_at > now() - interval '7 days'` tiene data fresca.
   - [ ] `SELECT azul_merchant_id FROM restaurant_users WHERE restaurant_slug = 'squareone'` devuelve el merchant ID real.
4. Si el restore falla, NO arrancar el cutover. Regenerar backup hasta que funcione.

### 12.2 Checklist final pre-cutover (compromiso con el owner)

**Antes de tocar prod el domingo, el implementador envía al owner un checklist paso-a-paso con timing estimado de cada operación.** El owner lo revisa y aprueba antes de que nada pase en prod.

Template (se instancia con datos reales el día del cutover):

```
CUTOVER MULTI-TENANT — DOMINGO [FECHA] 05:30-07:30 DR

00:00 (05:30) - Verificar backup pre-cutover presente y restaurable (§12.1)    [5 min]
00:05 (05:35) - Ventana de mantenimiento: pausa cron jobs en Vercel             [2 min]
00:07 (05:37) - Enviar notif a Tamayo "arrancando"                              [0 min]
00:07 (05:37) - Ejecutar migración SQL en prod Supabase (§4.1)                  [10 min]
00:17 (05:47) - Verificar counts de tablas nuevas vs legacy                     [3 min]
00:20 (05:50) - Flip PINCER_MULTI_TENANT=true en Vercel env                     [1 min]
00:21 (05:51) - Redeploy Vercel (manual o push vacío)                           [1 min]
00:22 (05:52) - Esperar deploy complete                                          [~60s]
00:23 (05:53) - Smoke test login Mr. Sandwich (no destructivo)                  [2 min]
00:25 (05:55) - Smoke test login Square One (no destructivo)                    [2 min]
00:27 (05:57) - Smoke test dashboard: ver órdenes del día previo, menú, config  [3 min]
00:30 (06:00) - Smoke test FCM: crear orden fake desde SQL, verificar push      [3 min]
00:33 (06:03) - Merge multi-tenant → main                                       [1 min]
00:34 (06:04) - Re-habilitar cron jobs                                          [2 min]
00:36 (06:06) - Arrancar monitoreo activo                                       [24h]

TOTAL: ~35 min de ventana de riesgo. Mr. Sandwich reabre 11am. Margen ~5h.

SMOKE TEST ES NO-DESTRUCTIVO. Ningún pago real se procesa en producción como parte del
cutover. Validación de pagos se hace 100% en staging con credenciales sandbox Azul antes
del cutover (ver §11.0 y §11.1). Post-cutover, el primer pago orgánico real es el
trigger de monitoreo reforzado (§11.3) — si algo se rompe con pagos, el feature flag y
el plan de rollback del §10 están listos como escape.

ROLLBACK SI ALGO FALLA ENTRE 05:53 Y 06:03:
- Flip PINCER_MULTI_TENANT=false                                                 [1 min]
- Re-grant writes a restaurant_users_legacy                                      [1 min]
- git revert del merge (si ya se hizo)                                           [2 min]
- Redeploy                                                                       [1 min]
TOTAL rollback: ~5 min
```

Este checklist va en un mensaje separado al owner la noche del sábado (o la mañana del domingo antes de arrancar) con datos concretos: fecha exacta, cuenta Vercel, steps de smoke test, etc.

**Por qué no hay pago real en el checklist de producción (decisión del owner):**

1. Los smoke tests en producción deben ser no-destructivos. Dinero real queda fuera.
2. Para validar Azul end-to-end existe staging — es el único propósito defendible de tenerlo.
3. La validación final en producción se hace monitoreando el primer pago orgánico real post-cutover, con el feature flag y el rollback listos como escape si algo se rompe.

**Pre-requisito para esto:** credenciales sandbox Azul configuradas en staging ANTES del cutover. Si no están listas, se configuran como parte del setup de staging (§11.0). Si por cualquier razón no es viable configurarlas, se re-evalúa con el owner antes de programar el cutover — no es justificación para meter pagos reales al checklist de prod.

---

## 13. Feature flag — mecanismo detallado (respuesta a pregunta del owner)

### 13.1 Qué hace el flag exactamente en cada estado

`PINCER_MULTI_TENANT` es una env var en Vercel (string `'true'` | `'false'`). Se lee en **cada request** (no solo al boot):

```js
function useNewModel() {
  return process.env.PINCER_MULTI_TENANT === 'true';
}
```

Se llama `useNewModel()` en cada handler que tiene branching. No se cachea en una const al boot — cambiar la env var + redeploy (~30s) hace efecto sin reiniciar nada más. (Vercel Fluid Compute reinicia la instancia cuando cambia una env var; igual es rápido.)

**Cuando `useNewModel() === true`:**
- `auth.js` → query `users` + `restaurant_members`, crea `restaurant_sessions` con `active_restaurant_id`.
- `signup.js` → llama RPC `create_restaurant_with_owner`.
- `update-settings.js`, `waiter-chat.js`, `og.js`, etc. → queries a `restaurants`.
- `payment.js` → lee `azul_merchant_id` de `restaurants`.

**Cuando `useNewModel() === false`:**
- `auth.js` → query `restaurant_users_legacy` (tabla renombrada, todavía accesible por SELECT).
- `signup.js` → ... **aquí está el punto crítico.** El signup legacy hace `INSERT INTO restaurant_users` pero esa tabla fue renombrada a `restaurant_users_legacy` **Y** tiene `REVOKE INSERT` post-cutover. Por lo tanto, el modo OFF **no puede hacer writes nuevos de signup**.
- `update-settings.js` → lee de legacy. Los UPDATEs fallan si legacy está read-only.
- Todo endpoint que escribe: falla con error de permisos si intenta tocar legacy.

### 13.2 Por qué el flag OFF NO es un rollback limpio post-cutover

**Decisión explícita:** el flag no está diseñado para dual-write ni para toggle libre entre modos. Es una **salida de emergencia en la ventana de smoke test inmediato.**

Razones para no hacer dual-write:
- Mantener dos caminos de escritura sincronizados es frágil. Un bug en el código de sync silenciosamente divergería los datos.
- El test matrix se duplica. Cada bug podría venir de cualquiera de los dos caminos.
- El objetivo es migrar, no coexistir indefinidamente.

### 13.3 Qué hace el flag en la práctica

| Fase | `PINCER_MULTI_TENANT` | `restaurant_users_legacy` | Cuándo aplica |
|---|---|---|---|
| Pre-cutover (prod) | `false` | Tabla original `restaurant_users`, RW | Producción normal hoy |
| Migración ejecutándose | `false` | Renombrada, RW | Ventana de ~5 min durante SQL migration |
| Post-migración, pre-flip | `false` | Renombrada + REVOKE writes | Ventana de ~1 min entre end of SQL y flag flip |
| Post-flip, smoke test | `true` | Renombrada + RO | 15-30 min de smoke test |
| **Smoke test OK → steady state** | `true` | Renombrada + RO | Día 0 → Día 30 |
| **Smoke test FAIL → rollback de emergencia** | `false` + re-grant writes a legacy + git revert | Renombrada + RW restaurada | Solo si smoke test falla |
| D30+ cleanup | Flag removido del código | DROP | PR separado |

### 13.4 Ventaja real del flag

El flag permite dos cosas útiles, no un rollback continuo:

1. **Smoke test rollback de 30s (Ventana A en §10.1).** Si el login falla inmediatamente después del flip, flip OFF + re-grant + revert. Limpio porque no hubo writes significativos en el modo nuevo todavía.

2. **Desarrollo en staging.** El mismo deploy puede correr en staging con flag ON (nuevo modelo) y en prod con flag OFF (legacy), usando las mismas env vars pero con el toggle por proyecto.

Fuera de esos dos usos, flag OFF post-cutover no es rollback automático — requiere el procedimiento completo del §10.

### 13.5 Por qué esto es aceptable

La alternativa (dual-write) agregaría riesgo neto, no lo quitaría. La alternativa (transacción SQL única sin flag) quita el margen de rollback rápido que sí necesitamos en el smoke test. El flag en su forma actual es el balance correcto.

El owner flagó que el flag "debe funcionar en ambos sentidos sin requerir restart". Se cumple esa parte: leer por request + cambiar env var en Vercel + redeploy (30s) funciona en ambos sentidos. La limitación no es técnica del flag sino del estado de la base de datos — post-cutover el schema ya cambió y las tablas viejas están read-only, entonces flag OFF no produce un sistema funcional completo sin los pasos adicionales del §10.2.

---

## 14. Deuda técnica documentada (para post-migración)

Cosas que NO se resuelven en este PR y quedan para después:

1. **Unificar `/admin` con `pincer_staff`** — eliminar `admin_sessions`, usar solo `is_pincer_admin` flag + `restaurant_sessions` estilo especial.
2. **Migrar dashboard writes a endpoints autenticados** — hoy `products`/`orders`/`store_settings` escriben con anon key. Al tener el modelo de roles nuevo, es natural mover estas writes a endpoints con `requireRole()`.
3. **Migrar auth a Supabase Auth** — dejaría de necesitar `users.password_hash`, bcrypt, reset_tokens, lockout. Scope grande, PR aparte.
4. **RLS helper functions con JWT** — solo tendría sentido junto con #2 o #3.
5. **Logs paths y assets con `restaurant_id`** — hoy `product-images/logos/{slug}.jpg`. Mejor `logos/{restaurant_id}.jpg` para que rename de slug no orfaneos.
6. **UI de transferencia de ownership** — flujo completo con confirmación del nuevo owner.
7. **Invitación de pincer_staff vía UI** — aunque no sea asignable desde UI pública, un admin panel podría exponerlo para el super-admin.

---

## 15. Decisiones confirmadas por el owner (2026-04-17)

Las 6 preguntas de diseño originales + las 3 preguntas de follow-up quedaron resueltas:

| # | Pregunta | Respuesta | Sección |
|---|---|---|---|
| 1 | `pincer_staff` como flag o role | Flag en `users.is_pincer_staff`. Con auditoría via trigger. | §3.1, §5.4 |
| 2 | `role='admin'` actual → `is_pincer_admin`, `/admin` sin tocar | Confirmado. Tabla comparativa con `is_pincer_staff`. | §3.1 |
| 3 | Single owner por restaurante | UNIQUE index, se relaja cuando aparezca co-ownership real | §3.1 |
| 4 | Feature flag mechanics | Env var, lectura por request, ventana de rollback limpio solo en smoke test | §13 |
| 5 | No invalidar sesiones en cutover | Confirmado. Ids preservados. | §8.4 |
| 6 | Signup atómico vía RPC | Confirmado con error handling explícito | §6.3 |
| 7 | Auditoría de cambios de roles | 3 tablas: `restaurant_members_audit`, `users_flags_audit` (trigger), `pincer_staff_audit` | §5.4, §8.3 |
| 8 | Error cases de la RPC | Tabla de 6 escenarios con respuesta específica | §6.3 |
| 9 | Cleanup de legacy | D0 rename, D0+1h REVOKE writes, D30 export verificado + DROP | §10.3 |
| 10 | Staging Supabase | Separado. Setup detallado. | §11.0 |
| 11 | Backup verificado pre-cutover | Export + prueba de restore en DB temporal | §12.1 |
| 12 | Checklist pre-cutover al owner | Template con timing de cada paso, se envía antes de tocar prod | §12.2 |
| 13 | Monitoreo activo primeras 24h | Cadencia cada 2-3h, checklist específico | §11.3 |
| 14 | Fix de AZUL_MERCHANT_ID | Fallar ruidosamente si el merchant falta (no fallback a env var) | §7 |

---

## 16. Resumen de entregables del PR

Cuando aprobes, el PR incluirá:

- Rama `multi-tenant` con ~15-25 commits atómicos.
- Schema SQL en `rls.sql` (reversible, documentado).
- Nuevos endpoints API: `switch-restaurant`, `members-*`, `pincer-staff-*`.
- Modificaciones en ~22 endpoints existentes.
- Nueva UI: gestión de miembros, switcher, `/pincer-staff`.
- `docs/multi-tenant-plan.md` (este archivo) actualizado con desviaciones reales durante implementación.
- `CLAUDE.md` actualizado con el nuevo modelo.
- Checklist de testing ejecutado y reportado en el PR description.

Estimación: 4-7 días de trabajo concentrado, no calendar days. Bloqueado por aprobación y disponibilidad de ventana de cutover (domingo temprano).

---

## 17. Cambios durante implementación

*(este bloque se llena durante Fase 4 con cualquier desviación del plan original)*

**Entradas esperadas:** formato `YYYY-MM-DD — [sección del plan afectada] — qué cambió y por qué`. Si una decisión del plan resulta inviable o insuficiente al implementar, se documenta aquí antes de proceder, no después.

