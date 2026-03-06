import { rateLimit } from './rate-limit.js';
import { handleCors } from './cors.js';
import { verifyRestaurantSession } from './verify-session.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' });
  if (rateLimit(req, res, { max: 10, windowMs: 60000, prefix: 'toggle-promo' })) return;

  const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = {
    'apikey': supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
  };

  // Verify restaurant session
  const token = req.headers['x-restaurant-token'];
  const session = await verifyRestaurantSession(token, supabaseUrl, supabaseKey);
  if (!session.valid) {
    return res.status(403).json({ error: 'Sesión inválida' });
  }

  try {
    const { is_active } = req.body;
    const active = !!is_active;
    const slug = session.restaurant_slug;

    // Toggle promo and get back the affected rows (need product_id)
    const promoUrl = `${supabaseUrl}/rest/v1/promotions?restaurant_slug=eq.${encodeURIComponent(slug)}` +
      (active ? '&is_active=eq.false&order=created_at.desc&limit=1' : '&is_active=eq.true');

    const patchRes = await fetch(promoUrl, {
      method: 'PATCH',
      headers: { ...headers, 'Prefer': 'return=representation' },
      body: JSON.stringify({ is_active: active }),
      signal: AbortSignal.timeout(5000),
    });

    if (!patchRes.ok) {
      console.error('[toggle-promo] Patch error:', patchRes.status);
      return res.status(500).json({ error: 'Error actualizando promo' });
    }

    // Extract product_ids from toggled promos to sync product visibility
    const toggled = await patchRes.json();
    const productIds = toggled
      .map(p => p.product_id)
      .filter(Boolean);

    if (productIds.length) {
      // Toggle products.active to match promo state
      const prodUrl = `${supabaseUrl}/rest/v1/products?id=in.(${productIds.map(id => encodeURIComponent(id)).join(',')})`;
      const prodRes = await fetch(prodUrl, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ active: active }),
        signal: AbortSignal.timeout(5000),
      });
      if (!prodRes.ok) {
        console.error('[toggle-promo] Product sync error:', prodRes.status);
      }
      console.log(`[toggle-promo] ${slug}: promo is_active=${active}, synced products: ${productIds.join(', ')}`);
    } else {
      console.log(`[toggle-promo] ${slug}: promo is_active=${active} (no linked products)`);
    }

    return res.status(200).json({ success: true, is_active: active });

  } catch (error) {
    console.error('[toggle-promo] error:', error);
    return res.status(500).json({ error: error.message });
  }
}
