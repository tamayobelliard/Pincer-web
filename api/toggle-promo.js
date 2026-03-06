import { rateLimit } from './rate-limit.js';
import { handleCors } from './cors.js';
import { verifyRestaurantSession } from './verify-session.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' });
  if (rateLimit(req, res, { max: 10, windowMs: 60000, prefix: 'toggle-promo' })) return;

  const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Verify restaurant session
  const token = req.headers['x-restaurant-token'];
  const session = await verifyRestaurantSession(token, supabaseUrl, supabaseKey);
  if (!session.valid) {
    return res.status(403).json({ error: 'Sesión inválida' });
  }

  try {
    const { is_active } = req.body;
    const slug = session.restaurant_slug;

    // Update all promos for this restaurant to the desired state
    const patchRes = await fetch(
      `${supabaseUrl}/rest/v1/promotions?restaurant_slug=eq.${encodeURIComponent(slug)}` +
        (is_active ? '&is_active=eq.false&order=created_at.desc&limit=1' : '&is_active=eq.true'),
      {
        method: 'PATCH',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ is_active: !!is_active }),
        signal: AbortSignal.timeout(5000),
      }
    );

    if (!patchRes.ok) {
      console.error('[toggle-promo] Patch error:', patchRes.status);
      return res.status(500).json({ error: 'Error actualizando promo' });
    }

    console.log(`[toggle-promo] ${slug}: is_active=${!!is_active}`);
    return res.status(200).json({ success: true, is_active: !!is_active });

  } catch (error) {
    console.error('[toggle-promo] error:', error);
    return res.status(500).json({ error: error.message });
  }
}
