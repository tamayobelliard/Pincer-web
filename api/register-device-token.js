import { handleCors, requireJson } from './cors.js';
import { verifyRestaurantSession, getRestaurantToken } from './verify-session.js';

const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  if (handleCors(req, res, { headers: 'Content-Type, x-restaurant-token' })) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (requireJson(req, res)) return;

  if (!supabaseKey) return res.status(500).json({ error: 'Server misconfigured' });

  // Verify restaurant session token
  const sessionToken = getRestaurantToken(req);
  if (!sessionToken) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const session = await verifyRestaurantSession(sessionToken, supabaseUrl, supabaseKey);
  if (!session.valid) {
    return res.status(403).json({ error: 'Invalid or expired session' });
  }

  const { token, restaurantSlug, platform } = req.body || {};

  // Validate input types
  if (!token || typeof token !== 'string' || token.length < 10 || token.length > 500) {
    return res.status(400).json({ error: 'token debe ser un string valido (10-500 caracteres)' });
  }
  if (!restaurantSlug || typeof restaurantSlug !== 'string' || !/^[a-z0-9_-]{2,50}$/.test(restaurantSlug)) {
    return res.status(400).json({ error: 'restaurantSlug debe ser un slug valido (letras minusculas, numeros, guiones)' });
  }
  if (platform !== undefined && (typeof platform !== 'string' || platform.length > 50)) {
    return res.status(400).json({ error: 'platform debe ser un string de hasta 50 caracteres' });
  }

  // Verify the slug matches the authenticated session
  if (restaurantSlug !== session.restaurant_slug) {
    return res.status(403).json({ error: 'Slug mismatch with session' });
  }

  try {
    const payload = {
      token,
      restaurant_slug: restaurantSlug,
      device_info: platform || 'android-native',
      active: true,
      updated_at: new Date().toISOString(),
    };

    const upsertRes = await fetch(
      `${supabaseUrl}/rest/v1/fcm_tokens?on_conflict=token`,
      {
        method: 'POST',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates',
        },
        body: JSON.stringify(payload),
      }
    );

    if (!upsertRes.ok) {
      const errText = await upsertRes.text();
      console.error('[register-device-token] Upsert failed:', upsertRes.status, errText);
      return res.status(500).json({ error: 'Error guardando token' });
    }

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('[register-device-token] Error:', error.message);
    return res.status(500).json({ error: 'Error interno' });
  }
}
