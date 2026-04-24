# Chatbot — Persistencia de selección de idioma

## Problema
Cada vez que el cliente abre el chatbot, le pregunta el idioma
(ES/EN). Si lo respondió antes en la misma sesión o visita
anterior, no debería volver a preguntarlo.

## Comportamiento esperado
- Primera vez que cliente abre chatbot en un restaurante → pregunta idioma
- Selección se guarda en localStorage scoped por slug:
  pincer_chatbot_lang_<slug> = 'es' | 'en'
- Próximas aperturas en la misma sesión o futuras → idioma
  recordado, chatbot abre directo en saludo
- Botón sutil "Cambiar idioma" dentro del chatbot por si quiere
  cambiarlo después

## Scope
- menu/index.html (chatbot genérico)
- menu/templates/thedeck/index.html (custom)
- Backward compat: clientes existentes que abran chatbot
  por primera vez después del fix → flujo igual a hoy
  (pregunta + guarda)

## Detección automática (mejora futura)
- Si navigator.language indica ES → preseleccionar ES sin
  preguntar (con opción de cambiar)
- Si EN → preseleccionar EN
- Si otro → preguntar ambos

## Prioridad
Baja. UX improvement post-Sprint-3.

## Reportado por
Founder durante validación de Etapa 3 / Commit 4 hotfix
(lockdown checkout).
