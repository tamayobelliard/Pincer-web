import crypto from 'crypto';

/**
 * Structured log emitter for AI-endpoint fail-closed events.
 *
 * When an AI-facing endpoint (waiter-chat, chat, pincer-chat) cannot load the
 * context it needs from Supabase — or receives a client-provided context that
 * doesn't pass validation — it MUST return 503 instead of calling Claude with
 * partial/missing data (which produces hallucinated menu items).
 *
 * Every such 503 should be logged via this helper so we can:
 *   1. Alert on >N fail-closed events/minute (Vercel log drain).
 *   2. Distinguish root causes in incidents: supabase_unreachable vs
 *      context_invalid vs menu_empty — they point to different problems.
 *   3. Correlate a user-visible 503 with a specific log entry via
 *      correlation_id returned in the response body.
 *
 * Emitted as JSON on a single stderr line so Vercel log drains parse cleanly.
 */
export function logFailClosed({ endpoint, restaurant_slug, reason, extra }) {
  const correlation_id = crypto.randomUUID();
  const entry = {
    event: 'ai_endpoint_failed_closed',
    endpoint,
    restaurant_slug: restaurant_slug || null,
    reason,
    correlation_id,
    timestamp: new Date().toISOString(),
    ...(extra || {}),
  };
  console.error(JSON.stringify(entry));
  return correlation_id;
}
