import { rateLimit } from './rate-limit.js';
import { handleCors, requireJson } from './cors.js';
import { verifyRestaurantSession, getRestaurantToken } from './verify-session.js';

/**
 * Toggle a single promo's is_active state (and mirror it on the linked product).
 *
 * Body: { promoId: number, is_active: boolean }
 * Auth: restaurant session (x-restaurant-token header or pincer_session cookie).
 *
 * The old behavior (toggle ALL promos at once, no id) is gone — each special now
 * lives in a persistent library the owner manages from the dashboard, and
 * multiple can be active simultaneously.
 */
export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' });
  if (requireJson(req, res)) return;
  if (rateLimit(req, res, { max: 20, windowMs: 60000, prefix: 'toggle-promo' })) return;

  const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = {
    'apikey': supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
  };

  const token = getRestaurantToken(req);
  const session = await verifyRestaurantSession(token, supabaseUrl, supabaseKey);
  if (!session.valid) return res.status(403).json({ error: 'Sesión inválida' });

  try {
    const { promoId, is_active } = req.body;
    if (!promoId || !Number.isInteger(Number(promoId))) {
      return res.status(400).json({ error: 'promoId requerido' });
    }
    const active = !!is_active;
    const slug = session.restaurant_slug;

    // Scope the PATCH by both id AND restaurant_slug so a restaurant cannot
    // toggle another restaurant's promo even with a valid session.
    const promoUrl = `${supabaseUrl}/rest/v1/promotions?id=eq.${encodeURIComponent(promoId)}&restaurant_slug=eq.${encodeURIComponent(slug)}`;

    const patchRes = await fetch(promoUrl, {
      method: 'PATCH',
      headers: { ...headers, 'Prefer': 'return=representation' },
      body: JSON.stringify({ is_active: active }),
      signal: AbortSignal.timeout(5000),
    });

    if (!patchRes.ok) {
      console.error('[toggle-promo] Patch error:', patchRes.status, await patchRes.text().catch(() => ''));
      return res.status(500).json({ error: 'Error actualizando promo' });
    }

    const toggled = await patchRes.json();
    if (toggled.length === 0) {
      return res.status(404).json({ error: 'Promo no encontrada' });
    }

    // Mirror the active state on the linked product so it shows/hides from the menu
    const productId = toggled[0].product_id;
    if (productId) {
      await fetch(
        `${supabaseUrl}/rest/v1/products?id=eq.${encodeURIComponent(productId)}&restaurant_slug=eq.${encodeURIComponent(slug)}`,
        {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ active: active }),
          signal: AbortSignal.timeout(5000),
        }
      ).catch(() => {});
    }

    console.log(`[toggle-promo] ${slug}: promo ${promoId} is_active=${active}`);
    return res.status(200).json({ success: true, is_active: active });

  } catch (error) {
    console.error('[toggle-promo] error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
