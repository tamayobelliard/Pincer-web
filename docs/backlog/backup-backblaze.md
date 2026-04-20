# Backup frío diario a Backblaze B2

## Status
Planned — low effort, high value, do before warm standby.

## Motivación
El incident de Supabase del 17 abril 2026 (incident `kj2hm399j9cw`, 6+ horas caído) demostró que la dependencia de un único proveedor es un single point of failure operacional. El warm standby con Neon (`warm-standby-neon.md`) resuelve el caso de "Supabase operacional pero caído". Pero no cubre escenarios más graves: corrupción lógica, borrado accidental, error de migración que destruye data, o — peor — el proyecto de Supabase siendo suspendido o perdido por algún motivo administrativo.

Un backup frío externo resuelve TODO eso por $2-5/mes. Es el seguro de último recurso: infraestructura totalmente separada, sin acceso programático al sistema productivo, requiere intervención manual para restaurar — precisamente lo que queremos de un "break glass in case of emergency".

## Objetivo
Export diario completo de la base de datos de Supabase a Backblaze B2, retenido 30 días mínimo. Si algo catastrófico le pasa a Supabase (o a nuestro trabajo sobre Supabase), podemos restaurar un snapshot de no más de 24h de antigüedad en un ambiente nuevo.

## Por qué Backblaze B2 específicamente
- **Costo:** $0.006/GB/mes storage + $0.01/GB download. Para Pincer (DB estimada <2GB en 2026, proyección <10GB en 2 años) = **$2-5/mes all-in**.
- **S3-compatible API:** herramientas estándar (`aws` CLI, `s3cmd`, `rclone`) funcionan sin cambios. No lock-in.
- **Infraestructura independiente:** B2 corre en Sacramento/Phoenix, no comparte nada con Supabase (Cloudflare) ni Vercel (AWS). Resiliencia real.
- **Encryption at rest (SSE-B2) gratis:** cifrado transparente del lado del servidor sin extra configuración.
- **Retention / Lifecycle policies nativas:** regla "borrar archivos >30 días" sin código nuestro.
- **Cuenta gratis de setup:** primeros 10GB storage son free (aunque ya los ocuparemos pronto).

## Alternativas descartadas y por qué
- **Supabase native daily backups:** ya existen (en el plan Pro, no en free — verificar nuestro plan). Pero viven dentro del mismo proveedor; si Supabase-la-empresa tiene problema grande, los backups son igualmente inalcanzables. Son útiles como primer nivel pero NO como seguro de último recurso. No los sustituimos — los complementamos.
- **AWS S3:** similar precio storage ($0.023/GB Standard, $0.004/GB Glacier Deep), pero IAM más complejo para setup seguro. Más overhead operacional.
- **Cloudflare R2:** muy comparable (gratis los primeros 10GB, sin egress fees). Tie técnico con B2. Rechazado porque Supabase ya está en Cloudflare — mismo proveedor de red = menos resiliencia ante incidents del proveedor upstream (que es exactamente lo que queremos evitar — referencia: el incident del 17 de abril fue por el upstream de Cloudflare).
- **iDrive e2 / Wasabi:** similar precio, menor reputación / documentación. No hay razón para preferirlos sobre B2.
- **Local disk / pendrive manual:** no automatizado, requiere acción manual de Tamayo. Garantizado a fallar porque se olvida. Descartado.
- **Google Cloud Storage / Azure Blob:** precios más altos, más complejidad sin beneficio claro.

## Pre-requisitos antes de implementar
Ninguno. Este es uno de los pre-requisitos del warm standby Neon, no al revés. Se puede ejecutar cuando haya un par de horas libres.

## Plan de implementación (cuando sea momento)

### Fase 1: Setup de Backblaze B2
1. Crear cuenta en Backblaze B2 (gratis, email + password).
2. Crear bucket `pincer-supabase-backup` con:
   - Type: **Private** (no listado, requiere auth).
   - SSE-B2 encryption: **enabled**.
   - Lifecycle rule: borrar archivos >45 días (ventana de 30 días + margen).
3. Crear application key con permisos `readFiles + writeFiles` limitados a ese bucket (no permiso de delete, de borrado se encarga la lifecycle rule).
4. Anotar `keyID`, `applicationKey`, `endpoint` (S3-compatible: `https://s3.us-west-002.backblazeb2.com` o según región).

### Fase 2: Script de backup
Crear `scripts/backup-supabase-to-b2.sh`:

```bash
#!/bin/bash
set -euo pipefail

DATE=$(date -u +%Y-%m-%d)
TMP_FILE="/tmp/pincer-supabase-${DATE}.sql.gz"

# Dump con Supabase CLI (o pg_dump directo con DATABASE_URL)
supabase db dump \
  --db-url "${SUPABASE_DB_URL}" \
  --data-only=false \
  | gzip -9 > "${TMP_FILE}"

# Verificar que el dump no esté vacío
SIZE=$(stat -f%z "${TMP_FILE}" 2>/dev/null || stat -c%s "${TMP_FILE}")
if [ "${SIZE}" -lt 1000 ]; then
  echo "ERROR: dump file suspiciously small (${SIZE} bytes)" >&2
  exit 1
fi

# Upload a B2 via S3-compatible API
aws s3 cp "${TMP_FILE}" "s3://pincer-supabase-backup/${DATE}/pincer-supabase-${DATE}.sql.gz" \
  --endpoint-url "${B2_ENDPOINT}" \
  --no-progress

# Cleanup local
rm "${TMP_FILE}"

echo "Backup ${DATE} uploaded OK (${SIZE} bytes compressed)"
```

### Fase 3: Scheduling
**Opción A (recomendada): GitHub Actions.** Gratis para repos públicos, corre cron 100% independiente de Vercel/Supabase.

Crear `.github/workflows/daily-backup.yml`:
```yaml
name: Daily Supabase backup to B2
on:
  schedule:
    - cron: '0 6 * * *'  # 06:00 UTC = 02:00 DR
  workflow_dispatch:     # manual trigger disponible
jobs:
  backup:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install Supabase CLI
        run: npm i -g supabase
      - name: Install awscli
        run: pip install awscli
      - name: Run backup
        env:
          SUPABASE_DB_URL: ${{ secrets.SUPABASE_DB_URL }}
          B2_ENDPOINT: ${{ secrets.B2_ENDPOINT }}
          AWS_ACCESS_KEY_ID: ${{ secrets.B2_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.B2_APPLICATION_KEY }}
          AWS_DEFAULT_REGION: us-west-002
        run: bash scripts/backup-supabase-to-b2.sh
```

**Opción B (alternativa): Vercel Cron.** Ya lo usamos para otros crons del proyecto. Ventaja: consolidación de infra. Desventaja: si Vercel-la-plataforma tiene problema, perdemos el backup justo cuando más lo necesitamos. Opción A es estricamente mejor para resiliencia.

### Fase 4: Alerting
Cuando el job falle (dump vacío, upload timeout, credenciales expiradas):
- GitHub Actions manda email automático al owner del repo por defecto.
- Agregar un step final que envíe WhatsApp vía Twilio (ya integrado) al número del owner si el job falla dos días seguidos. Preservar del spam de falsas alarmas.

### Fase 5: Test de restore
**Backups no probados no son backups.** Una vez al mes (primer domingo): descargar el backup más reciente, restaurarlo a un proyecto Supabase temporal, correr queries de sanidad:
- `SELECT count(*) FROM restaurant_users` — confirmar que coincide con prod.
- `SELECT count(*) FROM orders WHERE created_at > now() - interval '30 days'` — data fresca presente.
- `SELECT azul_merchant_id FROM restaurant_users WHERE restaurant_slug = 'squareone'` — campo sensible presente.

Automatizable como segundo GitHub Action mensual. No es bloqueante para la primera entrega pero sí para considerarlo "done".

## Consideraciones técnicas críticas

### Tamaño y frecuencia
- Backup inicial de la DB actual: estimado <100MB comprimido (5 restaurantes, ~500 órdenes, productos, eventos).
- Crecimiento mensual: ~10-50MB depende de volumen de órdenes y page_events.
- Diario es suficiente. No necesitamos incrementales ni WAL archiving — la DB no es lo bastante grande.

### Secrets
- `SUPABASE_DB_URL` contiene credenciales de la DB (postgres password). Solo en GitHub Secrets, nunca commit.
- Mismo para `B2_KEY_ID` / `B2_APPLICATION_KEY`.
- Si estas credenciales se rotan, actualizar el secret y correr `workflow_dispatch` para verificar.

### Data sensible
Los backups contienen:
- Password hashes bcrypt de `restaurant_users`.
- Teléfonos de clientes en `orders`.
- Tokens FCM (aunque estos rotan).
- Azul merchant IDs (no los AUTH secrets, eso está en env vars de Vercel).
- NO tarjetas: Pincer nunca almacena PAN/CVC.

El bucket B2 debe estar privado y con SSE-B2. Si algún día se hace público por error, los password hashes son bcrypt cost 12 — seguros a mediano plazo pero no ideal. Monitorear bucket permissions.

### Coordinación con warm standby
Cuando se implemente el warm standby Neon, la estrategia de backup consolida:
- **Nivel 1 (warm standby Neon):** replicación en vivo, RPO <10s. Para fallas de Supabase infraestructurales.
- **Nivel 2 (backup frío B2):** snapshot diario, RPO 24h. Para corrupción lógica, errores humanos destructivos, pérdida de cuenta.
- **Nivel 3 (Supabase native backups):** snapshots del proveedor primario. Cómodo para restores pequeños / rápidos.

Los tres son complementarios, no sustitutos.

### Costo real estimado
- Storage: <2GB × $0.006 = $0.012/mes inicialmente. <10GB × $0.006 = $0.06/mes en un año.
- Egress (solo cuando restauramos, raro): ~$0.01/GB.
- Operaciones API (uploads + listings): negligible.
- Total realista: **$0.10-2.00/mes**. Redondeando a `$2-5/mes` da margen para crecimiento.

## Criterios de éxito
- Backup diario corre sin intervención por 30 días seguidos.
- Tamaño del dump crece monotónicamente con volumen de órdenes (si baja, algo falla).
- Test mensual de restore en Supabase temporal devuelve data consistente con prod.
- Runbook de restore documentado en `docs/runbooks/restore-from-b2-backup.md` (crear cuando se implemente).
- Tamayo puede ejecutar restore desde cero siguiendo el runbook, sin asistencia.

## Cuándo ejecutar este proyecto
ASAP. Es low effort (~2-4 horas setup inicial + 1h para el runbook), low risk (no toca producción), low cost ($2-5/mes), high value (seguro de último recurso).

Orden natural en el backlog:
1. **Backup frío B2** (este proyecto) — fundación.
2. **Warm standby Neon** (`warm-standby-neon.md`) — ya depende de que este esté.
3. **Multi-tenant Fase 4** (`multi-tenant-plan.md`) — ortogonal a ambos, pero conviene tener ambos antes para mitigar riesgos de la migración grande.

Estimado de duración: 1 día full-time incluyendo setup B2 + script + GitHub Action + primer test de restore.
