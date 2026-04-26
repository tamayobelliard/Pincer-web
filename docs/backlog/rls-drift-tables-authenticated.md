# RLS Drift — tables sin policies para authenticated

## Incidente (2026-04-24)

Founder reportó que las 3 mesas creadas en The Deck
(Mesa 1, 2, 3) desaparecieron del dashboard durante validación
de Etapa 3.

## Diagnóstico

Las mesas existían en DB con active=true. El problema era que
la tabla `tables` tenía solo 4 policies, todas para rol `anon`:
- anon_select_tables (active=true)
- deny_anon_insert/update/delete

NO había policies para rol `authenticated` (el rol del
dashboard logueado de la cajera).

Resultado silencioso: el dashboard intentaba SELECT sobre
tables como authenticated, RLS lo bloqueaba sin error
explícito, query devolvía 0 filas, dashboard mostraba "Aún
no hay mesas".

## Fix aplicado

SQL agregado durante validación:
- authenticated_select_tables (USING true)
- authenticated_insert_tables (WITH CHECK true)
- authenticated_update_tables (USING true, WITH CHECK true)

## Causa raíz hipotética

Probablemente Etapa 2 creó la tabla con policies solo para
anon (orientadas a cliente escaneando QR). El dashboard
pre-Sprint-3 usaba endpoints /api/tables/* que corren con
service-role (bypassan RLS). Cuando algo cambió y dashboard
empezó a consultar tables directamente con JWT del usuario,
no había policy aplicable y falló silenciosamente.

## Patrón de bug a prevenir

RLS y código pueden desincronizarse silenciosamente. PostgREST
NO devuelve error cuando una policy bloquea filas — solo
devuelve menos resultados (potencialmente cero).

## Recomendaciones para futuro

1. Cuando se cree una tabla nueva, definir desde el inicio:
   - Policies para anon (clientes públicos)
   - Policies para authenticated (dashboard cajera)
   - Policies para service_role (no necesarias, bypassa RLS)

2. Cuando se agreguen columnas nuevas, verificar si las
   policies de UPDATE existentes las cubren (caso
   bill_requested_at, paid_at, close_reason, close_note
   funcionaron porque anon_update_orders era USING(true))

3. Cuando se cambia código que consulta tablas (de endpoint
   service-role a direct SELECT), verificar que las policies
   permitan al rol del frontend leer las filas esperadas

4. Consideración: agregar tests automáticos que verifiquen
   que cada rol puede leer las filas que debería poder leer.

## Estado

Resuelto. SQL aplicado en producción 2026-04-24 ~19:00.

## Prioridad

Media. No urgente, pero patrón de bug recurrente en Sprint-3
(este es el segundo caso documentado tras el de Etapa 1 /
operational_statuses_filter).
