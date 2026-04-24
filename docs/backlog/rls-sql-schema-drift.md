# Backlog — rls.sql desfasado respecto a producción

**Status:** Propuesta · **Autor:** 2026-04-24 · **Severidad:** Media · **Prioridad:** Media-alta (todo dev futuro tropezará con lo mismo)

## Contexto — el incidente que nos trajo acá

Sprint-3 Etapa 2 Commit 1 introdujo una nueva tabla `tables` con columna `created_by_user_id BIGINT`. El tipo se eligió leyendo `rls.sql:22`:

```sql
CREATE TABLE IF NOT EXISTS restaurant_sessions (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token           text NOT NULL UNIQUE,
  user_id         bigint NOT NULL,     ← dice bigint
  ...
);
```

La realidad en producción (confirmada via `information_schema` el 2026-04-24):

| Columna | rls.sql dice | Prod realmente es |
|---|---|---|
| `restaurant_users.id` | (no declarado explícito) | **uuid** |
| `restaurant_sessions.id` | bigint | bigint ✓ |
| `restaurant_sessions.user_id` | **bigint** | **text** (almacena UUIDs) |
| `admin_sessions.user_id` | (tabla entera ausente de rls.sql) | **uuid** |

Result: el endpoint `/api/tables/create` respondió 500 con `invalid input syntax for type bigint: '383f171a-5760-483c-8544-61981a4ae13e'`. La UUID del usuario impersonado cayó sobre una columna bigint. Fix en commit `abdf8e9`.

## Evidencias adicionales de drift

**rls.sql está incompleto:**
- `admin_sessions`: no hay `CREATE TABLE`. Solo aparece en `ALTER TABLE admin_sessions ENABLE RLS` (línea 184) y `ALTER TABLE admin_sessions RENAME COLUMN token TO token_hash` (línea 426). La tabla existe en prod pero su DDL nunca quedó en repo.
- Otras columnas agregadas vía Supabase UI o SQL Editor (ej. `failed_login_attempts`, `locked_until`, `reset_token_hash`, `reset_token_expires`, `must_change_password`, `email_verified`) están referenciadas por el código pero puede haber más que ni siquiera sabemos.

**rls.sql mezcla orígenes:**
- DDL real que se ejecutó contra la DB (source of truth histórica).
- Documentación aspiracional de qué DEBERÍA haber (`user_id bigint` nunca se ejecutó — prod fue creada con UUID).
- Patches ALTER incrementales agregados sobre el tiempo sin rebuild del archivo completo.

**Consecuencia:** cualquier dev que lea rls.sql para entender el schema toma decisiones incorrectas. Yo tropecé con esto en Etapa 2. El próximo dev (o yo mismo en un nuevo sprint) va a tropezar igual si no arreglamos la fuente de verdad.

## Opciones

### Opción A — Regenerar rls.sql via pg_dump (recomendado)

Correr `pg_dump --schema-only --no-owner --no-privileges` contra prod, reemplazar `rls.sql` con el output. Snapshot real del schema.

**Pros:**
- Single source of truth alineado con prod
- Trivial de rehacer trimestralmente
- Cualquier herramienta standard (Supabase CLI, psql) puede generar el dump

**Cons:**
- pg_dump output es verbose (incluye comentarios, defaults explícitos, set/unset role, etc.) — menos legible que rls.sql hand-written
- Pierde los comentarios explicativos del rls.sql actual (razones de diseño, contexto histórico)

**Mitigación:** mantener rls.sql como "snapshot canónico del schema actual" (generado) + crear `docs/schema-explanations.md` como "por qué está así cada tabla" (hand-written, narrativa).

### Opción B — Marcar rls.sql como reference histórico + schema-current.sql generado

Dejar rls.sql intocado como documento narrativo-histórico. Agregar `docs/schema-current.sql` regenerado periódicamente con `pg_dump`.

**Pros:**
- No rompe el archivo que la gente ya conoce
- Permite transición suave

**Cons:**
- Dos archivos de schema → confusión "cuál leo?"
- Probable que rls.sql siga siendo citado (como yo hice) y nunca se migre a consultar schema-current.sql

**Descartado** por ambigüedad duradera.

### Opción C — Supabase CLI + migraciones formales

Adoptar `supabase db diff` + `supabase migration new` para que cada cambio de schema pase por archivos versionados. Eliminar la costumbre de tocar DDL desde Supabase UI directamente.

**Pros:**
- Source-controlled migrations por diseño
- Previene drift futuro
- Rollback path claro

**Cons:**
- Cambio de workflow grande
- Requiere `supabase/` directory + CI integration
- El equipo (founder + yo) tenemos que dejar de tocar DDL via UI

**Aspiracional.** Útil a mediano plazo (3-6 meses), pero costoso de adoptar ahora.

## Recomendación

**Opción A, como one-shot inmediato.** Repetir trimestralmente (calendario o al cierre de cada Sprint mayor).

Timeline sugerido:
- **Hoy (Etapa 2 Commit 3):** este doc de backlog creado.
- **Fin de Sprint-3 (estimado 2026-05-xx):** correr A por primera vez. Commit el rls.sql generado.
- **Trimestral:** review del schema + regeneración.
- **Eventual (6-12 meses):** evaluar opción C cuando el equipo crezca o el ritmo de cambios de schema aumente.

## Action items concretos para Opción A

1. **Instalar Supabase CLI** (si no está): `npm install -g supabase`.
2. **Obtener connection string prod** de Supabase Dashboard → Project Settings → Database.
3. **Correr dump** (excluye esquemas de Supabase internos):
   ```bash
   pg_dump --schema-only --no-owner --no-privileges \
     --schema=public \
     --exclude-table-data='*' \
     "postgresql://...@db.tcwujslibopzfyufhjsr.supabase.co:5432/postgres" \
     > docs/rls-pgdump-2026-04-xx.sql
   ```
4. **Review del output:** sanity-check que incluye todas las tablas que el código referencia (`restaurant_users`, `restaurant_sessions`, `admin_sessions`, `products`, `orders`, `shifts`, `store_settings`, `fcm_tokens`, `promotions`, `page_events`, `chat_messages`, `restaurant_insights`, `rate_limits`, `payment_audit`, `sessions_3ds`, `tables`, plus cualquier otra que aparezca).
5. **Reemplazar rls.sql** con el dump + header explicativo al inicio:
   ```
   -- Schema snapshot generado via pg_dump YYYY-MM-DD.
   -- NO editar a mano — regenerar via `pg_dump` en su lugar.
   -- Narrativa/explicaciones en docs/schema-explanations.md.
   ```
6. **Crear `docs/schema-explanations.md`** con el contenido narrativo histórico del rls.sql actual (comentarios, diseño, RLS rationale). Este archivo SÍ se edita a mano.
7. **Commit:** `refactor(schema): regenerate rls.sql from prod pg_dump (drift fix)`.
8. **Documentar el proceso** en un `docs/schema-regeneration-runbook.md` (3-5 líneas: cómo correr el dump, qué revisar, cómo committear).

## Anti-patterns a evitar en el futuro

- **No editar rls.sql a mano** post-regeneración. Si hay un cambio de schema, corre la migración en Supabase SQL Editor + regenera rls.sql vía dump, NO edites ambos.
- **No crear `CREATE TABLE`s aspiracionales en rls.sql** que describan "cómo debería ser". Aspiracional va a `docs/backlog/*.md` o `docs/migrations/*.sql` (con nombre fecha).
- **Corregir drift retroactivo cuando se detecta**. Si tropezás con un mismatch entre rls.sql y prod (como tables.created_by_user_id), abre un issue y agrega a esta lista.

## Otros drifts detectados hoy (para fixearlos eventualmente)

No son críticos (no causan bugs hoy), pero vale anotar:

1. **`restaurant_sessions.user_id` es TEXT, debería ser UUID.** Almacena UUIDs vía coerción. Alinear al tipo correcto requeriría ALTER COLUMN con data migration. No crítico porque funciona, pero la consistencia con `admin_sessions.user_id UUID` sería más limpia.

2. **`admin_sessions` sin CREATE TABLE en rls.sql.** Solo existen los ALTER en rls.sql. Opción A resuelve esto porque pg_dump va a generar el CREATE TABLE completo.

3. **Posibles columnas no documentadas** en `restaurant_users` (trial_starts_at?, features flags?) que podrían existir en prod y no en rls.sql. El pg_dump es el único path confiable para enumerarlas.

## No hacer

- **No bloquear Sprint-3 por esto.** Etapa 2 sigue, Etapa 3 sigue. El fix del drift es paralelo.
- **No parar a arreglar cada drift al momento.** Aggrupa al final de Sprint o al runbook trimestral.
- **No migrar a opción C hoy.** Es el norte, no el siguiente paso.
