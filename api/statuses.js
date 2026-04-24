// Central list of "operational" restaurant statuses.
//
// Context — 2026-04-24 lifecycle refactor:
// Originalmente el único status operativo era 'active' (legacy). El ciclo
// de vida real del restaurante pasa por:
//   demo     → Tamayo lo arma antes de cerrar venta
//   trial    → 30 días de premium gratis tras entregar al cliente
//   premium  → cliente paga post-trial
//   basic    → cliente no paga post-trial (features limitados)
//   active   → legacy (Mr. Sandwich, Square One, Hummus) — mantener por compat
//
// Status NO operativos (bloquean acceso deliberadamente):
//   suspended — admin lo pausó
//   disabled  — legacy, equivalente a suspended
//   pending   — legacy, equivalente a demo pero sin uso hoy
//
// Antes de esta constante, 11 endpoints filtraban por `status=eq.active`
// hardcoded. Eso rompió update-settings para The Deck (demo) hasta que
// founder le dio click a "Reactivar". Al centralizar aquí, el próximo
// status que aparezca (ej. 'grace' para periodo de gracia post-trial)
// solo se toca en un archivo.
//
// Uso:
//   import { OPERATIONAL_STATUSES_FILTER } from './statuses.js';
//   // En una query PostgREST:
//   `...?restaurant_slug=eq.${slug}&status=${OPERATIONAL_STATUSES_FILTER}`
//
// IMPORTANTE: este filtro es para READS que gatean "este restaurante puede
// operar". NO usar para writes que setean status (esos tienen su propia
// lógica de transición). No usar en crons cuyo target es un subset específico
// (ver cron/downgrade-trials.js — caso especial).

export const OPERATIONAL_STATUSES = ['active', 'demo', 'trial', 'premium', 'basic'];

// Formato PostgREST ya armado. Ejemplo de uso:
//   `${url}/rest/v1/restaurant_users?status=${OPERATIONAL_STATUSES_FILTER}`
export const OPERATIONAL_STATUSES_FILTER = 'in.(' + OPERATIONAL_STATUSES.join(',') + ')';
