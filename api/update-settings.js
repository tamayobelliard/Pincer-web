import { rateLimit } from './rate-limit.js';

export default async function handler(req, res) {
  const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://www.pincerweb.com';
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' });

  // Rate limit: 10 per minute per IP
  if (rateLimit(req, res, { max: 10, windowMs: 60000, prefix: 'settings' })) return;

  const body = req.body || {};
  const { restaurant_slug } = body;

  if (!restaurant_slug) {
    return res.status(400).json({ success: false, error: 'restaurant_slug requerido' });
  }

  const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseKey) {
    return res.status(500).json({ success: false, error: 'Error del servidor' });
  }

  const sbHeaders = {
    'apikey': supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
  };

  try {
    // Verify restaurant exists and is active
    const checkRes = await fetch(
      `${supabaseUrl}/rest/v1/restaurant_users?restaurant_slug=eq.${encodeURIComponent(restaurant_slug)}&status=eq.active&select=id&limit=1`,
      { headers: sbHeaders }
    );

    if (!checkRes.ok) {
      console.error('update-settings: lookup error', checkRes.status);
      return res.status(500).json({ success: false, error: 'Error del servidor' });
    }

    const rows = await checkRes.json();
    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Restaurante no encontrado' });
    }

    const restaurantId = rows[0].id;

    // Whitelist of allowed fields
    const ALLOWED = [
      'business_type', 'address', 'phone', 'contact_name',
      'hours', 'website', 'notes', 'chatbot_personality',
      'order_types', 'delivery_fee', 'logo_url',
    ];

    const update = {};
    for (const key of ALLOWED) {
      if (body[key] !== undefined) {
        update[key] = body[key];
      }
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ success: false, error: 'No hay campos para actualizar' });
    }

    const patchRes = await fetch(
      `${supabaseUrl}/rest/v1/restaurant_users?id=eq.${restaurantId}`,
      {
        method: 'PATCH',
        headers: { ...sbHeaders, 'Prefer': 'return=minimal' },
        body: JSON.stringify(update),
      }
    );

    if (!patchRes.ok) {
      const errText = await patchRes.text();
      console.error('update-settings: patch error', patchRes.status, errText);
      return res.status(500).json({ success: false, error: 'Error al guardar los cambios' });
    }

    console.log('update-settings: updated', restaurant_slug, Object.keys(update).join(', '));
    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('update-settings error:', error);
    return res.status(500).json({ success: false, error: 'Error del servidor' });
  }
}
