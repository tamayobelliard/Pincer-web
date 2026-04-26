# Auth — sliding refresh para sesiones largas

## Contexto

Hotfix 2026-04-26 (commit `53f5bf5`) bumpó el lifetime de session
del dashboard de 24h → 30d. Resuelve el caso founder de tableta
encendida 24/7 que veía "Authentication required" en Mesas
después de varias horas.

Trade-off aceptado: hard expiration a los 30 días. Si la tableta
permanece encendida 30+ días sin login (caso real en restaurantes
con poco rotación de personal), el bug volverá a aparecer.

## Comportamiento esperado (Plan C)

Mientras la tableta esté activa con la pestaña del dashboard
abierta, la sesión nunca expira. Se renueva en background.

Hard expiration solo si:
- Tableta apagada/cerrada por más de N días (la cookie expira
  por inactividad)
- Logout manual

## Diseño propuesto

1. Nuevo endpoint `POST /api/refresh-session`:
   - Lee el cookie `pincer_session` actual
   - Si válido (verifyRestaurantSession devuelve valid=true):
     * UPDATE `restaurant_sessions SET expires_at = NOW() + INTERVAL '30 days'`
     * Set-Cookie con nuevo Max-Age=30d
   - Si no válido: 401 (cliente debe re-loguear)
   - Idempotente, fire-and-forget

2. Dashboard:
   ```js
   // Renovar cada hora mientras esté activa la pestaña
   setInterval(() => {
     fetch('/api/refresh-session', { method: 'POST' })
       .catch(() => {});
   }, 60 * 60 * 1000);
   ```

3. Considerar también renovar sobre `visibilitychange`
   (cuando user vuelve a la tab después de horas):
   ```js
   document.addEventListener('visibilitychange', () => {
     if (!document.hidden) refreshSession();
   });
   ```

## Costo estimado

~30 líneas:
- 15 líneas: nuevo endpoint api/refresh-session.js
- 10 líneas: setInterval + visibilitychange handler en dashboard
- 5 líneas: rate-limit defensa (1 request/min por IP)

## Cuándo implementar

NO ahora. Trigger: si vuelve a aparecer el bug "Authentication
required" después del 30d de la sesión inicial. O si el founder
agrega más restaurantes con tabletas dedicadas y se quiere
optimizar UX preventivamente.

## Alternativas consideradas

- **Migrar a Supabase Auth con autoRefreshToken:** out of scope.
  Refactor masivo del custom auth (9+ endpoints custom + verify-
  session.js + login flow + sessionStorage approach).
- **Bump a 90 días o 1 año:** cookie robada vale demasiado tiempo
  si el risk model cambia (ej. tabletas en lugares semi-públicos).

## Prioridad

Baja. Sliding refresh es UX optimization, no security fix. Plan A
del hotfix actual (30d hard) cubre el caso operativo conocido.

## Reportado por

Founder durante diagnóstico de "Authentication required" en Mesas
2026-04-26 (commit `53f5bf5`).
