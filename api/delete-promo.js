import { rateLimit } from './rate-limit.js';
import { handleCors, requireJson } from './cors.js';
import { verifyRestaurantSession, getRestaurantToken } from './verify-session.js';

/**
 * Delete a promo from the restaurant's library.
 * Also removes the linked product so it stops appearing in the menu.
 *
 * Body: { promoId: number }
 * Auth: restaurant session.
 */
export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (requireJson(req, res)) return;
  if (rateLimit(req, res, { max: 10, windowMs: 60000, prefix: 'delete-promo' })) return;

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
    const { promoId } = req.body;
    if (!promoId || !Number.isInteger(Number(promoId))) {
      return res.status(400).json({ error: 'promoId requerido' });
    }
    const slug = session.restaurant_slug;

    // Fetch the promo first so we can grab product_id before deleting
    const fetchRes = await fetch(
      `${supabaseUrl}/rest/v1/promotions?id=eq.${encodeURIComponent(promoId)}&restaurant_slug=eq.${encodeURIComponent(slug)}&select=id,product_id`,
      { headers, signal: AbortSignal.timeout(5000) }
    );
    if (!fetchRes.ok) {
      return res.status(500).json({ error: 'Error consultando la promo' });
    }
    const rows = await fetchRes.json();
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Promo no encontrada' });
    }
    const promo = rows[0];

    // Delete the promotion row
    const delRes = await fetch(
      `${supabaseUrl}/rest/v1/promotions?id=eq.${encodeURIComponent(promoId)}&restaurant_slug=eq.${encodeURIComponent(slug)}`,
      {
        method: 'DELETE',
        headers: { ...headers, 'Prefer': 'return=minimal' },
        signal: AbortSignal.timeout(5000),
      }
    );
    if (!delRes.ok) {
      console.error('[delete-promo] Delete error:', delRes.status, await delRes.text().catch(() => ''));
      return res.status(500).json({ error: 'Error eliminando la promo' });
    }

    // Also delete the linked product if there is one (so it stops appearing in the menu)
    if (promo.product_id) {
      await fetch(
        `${supabaseUrl}/rest/v1/products?id=eq.${encodeURIComponent(promo.product_id)}&restaurant_slug=eq.${encodeURIComponent(slug)}`,
        {
          method: 'DELETE',
          headers: { ...headers, 'Prefer': 'return=minimal' },
          signal: AbortSignal.timeout(5000),
        }
      ).catch(() => {});
    }

    console.log(`[delete-promo] ${slug}: deleted promo ${promoId}${promo.product_id ? ' and product ' + promo.product_id : ''}`);
    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('[delete-promo] error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
