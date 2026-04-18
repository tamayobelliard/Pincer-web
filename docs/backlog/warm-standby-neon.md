# Warm Standby con Neon Postgres

## Status
Planned. Depende de: multi-tenant en producción estable por 7+ días.

## Motivación
Incident de Supabase del 17 abril 2026 demostró que 6 horas de caída es realista. Con 20+ clientes pagando, un incident similar podría causar cancelaciones masivas. Necesitamos capacidad de failover manual a un Postgres en otra infraestructura.

## Objetivo
Tener un Postgres gestionado secundario (Neon) replicando Supabase en tiempo real vía logical replication. En caso de incident de Supabase, cambio manual de env var DATABASE_URL en Vercel y redeploy devuelve el servicio en ~3 minutos.

## Por qué Neon específicamente
- Postgres nativo, misma compatibilidad que Supabase a nivel de queries.
- Infraestructura totalmente independiente (AWS us-east-2).
- Soporta logical replication como consumer.
- Plan Launch: $19/mes, suficiente para nuestro volumen actual y próximos 12 meses.
- Setup simple, failover simple, runbook claro.

## Alternativas descartadas y por qué
- **Mac Mini self-hosted**: dependencia de internet casero, UPS, mantenimiento continuo. Si se daña hay que reemplazar hardware físicamente. Descarto.
- **Supabase en otra región como secundario**: mismo proveedor, si tienen incident global ambos caen. Descarto.
- **AWS RDS / Render / Railway**: viables pero más complejos que Neon para este caso de uso. Neon tiene mejor DX para replicación.
- **Firebase / Appwrite / Convex**: arquitectura distinta, requeriría mantener dos codebases. Descarto.
- **Failover automático**: detección confiable de "Supabase caído" es difícil, riesgo de split-brain. Mantener failover manual con runbook claro.

## Pre-requisitos antes de implementar
1. Multi-tenant en producción estable por 7+ días.
2. Fail-closed guards implementados en el chatbot (bloqueante — el chatbot alucinando durante el incident fue más peligroso que la caída misma).
3. Backup frío diario a Backblaze B2 (independiente, $2/mes, seguro de último recurso).

## Plan de implementación (cuando sea momento)

### Fase 1: Setup de Neon
- Crear cuenta Neon plan Launch ($19/mes)
- Crear proyecto con schema idéntico a Supabase production
- Configurar logical replication desde Supabase publication al consumer Neon
- Verificar que cambios en Supabase aparecen en Neon en <10 segundos

### Fase 2: Configuración de aplicación
- Agregar env var DATABASE_URL_SECONDARY en Vercel (URL de Neon)
- Crear scripts/failover-to-secondary.sh:
  - Cambia DATABASE_URL a DATABASE_URL_SECONDARY
  - Redeploya Vercel
  - Ejecuta smoke test (pincerweb.com/mrsandwich carga, menú aparece)
- Crear scripts/recovery-to-primary.sh:
  - Verifica que Supabase está recuperado (DNS resuelve, queries funcionan)
  - Sincroniza escrituras hechas durante failover (ver sección "Consideraciones")
  - Cambia DATABASE_URL de vuelta a Supabase
  - Redeploya

### Fase 3: Runbook
Crear docs/runbooks/failover-supabase.md con:
- Cómo detectar incident de Supabase (status.supabase.com, nslookup, curl a REST endpoint)
- Criterio de decisión: failover si >15 min de caída confirmada
- Pasos exactos con comandos copy-paste
- Smoke tests post-failover (list de URLs y resultados esperados)
- Cómo volver a primary (recovery)
- Qué comunicar a Chef Elly y demás clientes durante failover y recovery

### Fase 4: Test controlado
- Domingo madrugada (mínimo tráfico)
- Ejecutar failover completo
- Verificar funcionalidad en los 5 restaurantes test
- Cronometrar cada paso
- Ejecutar recovery
- Actualizar runbook con timings reales medidos
- Documentar cualquier problema encontrado

## Consideraciones técnicas críticas

### Escrituras durante failover
Durante el periodo en que la app apunta a Neon:
- Todos los INSERT/UPDATE/DELETE van a Neon
- Supabase sigue desactualizado (está caído)
- Al recovery: hay que sincronizar Neon→Supabase antes de cambiar DATABASE_URL de vuelta
- Decisión: durante failover, marcar writes como "sync pending" y al recovery correr script de sincronización
- ALTERNATIVA más simple: aceptar que durante failover las writes no se sincronizan de vuelta y se pierden. Solo viable si el tiempo de failover es corto y los writes no son críticos. A discutir cuando se implemente.

### Realtime
Neon NO tiene equivalente a Supabase Realtime. Durante failover:
- Dashboard del restaurante no recibe updates live
- Cambiar a polling cada 5 segundos en modo failover
- Aceptar que es experiencia degradada (es temporal y mejor que estar caído)

### Auth custom
La tabla restaurant_sessions se replica vía logical replication. Sesiones activas sobreviven al failover. Verificar en Fase 4.

### Pagos Azul
- Credenciales Azul viven en env vars de Vercel, no en DB. Seguras.
- El campo azul_merchant_id vive en restaurant_users, que se replica. Verificar.
- Webhooks 3DS Callback: el handler lee de sessions_3ds, que se replica. Verificar en Fase 4 con pago de prueba.

### Service role key
Neon no tiene el concepto de service_role vs anon. Usar:
- Connection string con usuario Postgres de permisos limitados para rutas públicas
- Connection string con usuario Postgres de permisos completos para rutas admin
- Replicar la separación lógica sin el mecanismo RLS de Supabase
- Alternativamente, usar RLS en Neon con usuarios Postgres distintos (soporta RLS nativo de Postgres)

### Costos
- Neon Launch: $19/mes
- Transferencia de data en replicación: ~$0-5/mes dependiendo de volumen
- Total: ~$20-25/mes adicionales a Supabase
- Comparación: riesgo de perder 5-10 clientes premium por un incident mal manejado = $250-500/mes perdidos. ROI claro.

## Criterios de éxito
- Failover completo ejecutado en <5 min desde decisión hasta Pincer recuperado
- Cero pérdida de data durante failover
- Cero pérdida de data durante recovery
- Runbook suficientemente claro para que Tamayo pueda ejecutar failover solo (sin asistencia de ingeniero)

## Cuándo ejecutar este proyecto
Después de:
- Multi-tenant estable en producción (7+ días sin issues)
- Fail-closed guards en chatbot implementados y verificados
- Backup frío diario a Backblaze B2 funcionando
- Hay 10+ restaurantes pagando (ROI claro para justificar el tiempo y los $19/mes)

Antes de:
- Expansión a US market (ahí ya tener resiliencia es no negociable)
- Crecer a 50+ restaurantes

Estimado de duración: 1 semana full-time de Claude Code + Tamayo para pruebas.
