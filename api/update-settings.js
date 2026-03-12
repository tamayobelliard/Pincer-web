import { rateLimit } from './rate-limit.js';
import { handleCors, requireJson } from './cors.js';
import { verifyRestaurantSession, getRestaurantToken } from './verify-session.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (handleCors(req, res, { methods: 'PATCH, OPTIONS', headers: 'Content-Type, x-restaurant-token' })) return;
  if (req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' });
  if (requireJson(req, res)) return;

  // Rate limit: 10 per minute per IP
  if (rateLimit(req, res, { max: 10, windowMs: 60000, prefix: 'settings' })) return;

  const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseKey) {
    return res.status(500).json({ success: false, error: 'Error del servidor' });
  }

  // Verify restaurant session token — MANDATORY
  const token = getRestaurantToken(req);
  if (!token) {
    return res.status(401).json({ success: false, error: 'Authentication required' });
  }
  const session = await verifyRestaurantSession(token, supabaseUrl, supabaseKey);
  if (!session.valid) {
    return res.status(403).json({ success: false, error: 'Sesion invalida o expirada' });
  }

  const body = req.body || {};
  const { logo_base64 } = body;

  // Use slug from authenticated session — never trust client-sent slug
  const restaurant_slug = session.restaurant_slug;

  console.log('update-settings: received body keys:', Object.keys(body).join(', '));
  console.log('update-settings: restaurant_slug:', restaurant_slug, '| logo_base64:', !!logo_base64);

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

    // Upload logo to Supabase Storage if base64 provided
    if (logo_base64) {
      try {
        const match = logo_base64.match(/^data:(image\/\w+);base64,(.+)$/);
        if (!match) {
          console.error('update-settings: invalid logo_base64 format');
          return res.status(400).json({ success: false, error: 'Formato de logo invalido' });
        }
        const contentType = match[1];
        const buffer = Buffer.from(match[2], 'base64');
        const storagePath = `logos/${restaurant_slug}.jpg`;

        console.log('update-settings: uploading logo to Storage, size:', buffer.length);
        const uploadRes = await fetch(
          `${supabaseUrl}/storage/v1/object/product-images/${storagePath}`,
          {
            method: 'PUT',
            headers: {
              'apikey': supabaseKey,
              'Authorization': `Bearer ${supabaseKey}`,
              'Content-Type': contentType,
              'x-upsert': 'true',
            },
            body: buffer,
          }
        );
        if (!uploadRes.ok) {
          const errText = await uploadRes.text();
          console.error('update-settings: Storage upload failed:', uploadRes.status, errText);
        } else {
          body.logo_url = `${supabaseUrl}/storage/v1/object/public/product-images/${storagePath}?t=${Date.now()}`;
          console.log('update-settings: logo uploaded, URL:', body.logo_url);
        }
      } catch (e) {
        console.error('update-settings: logo upload error:', e.message);
      }
    }

    // Whitelist of allowed fields with type validation
    const ALLOWED = {
      business_type: 'string',
      address: 'string',
      phone: 'string',
      contact_name: 'string',
      hours: 'string',
      website: 'string',
      notes: 'string',
      chatbot_personality: 'string',
      order_types: 'string',
      delivery_fee: 'number',
      logo_url: 'string',
    };

    const update = {};
    for (const [key, expectedType] of Object.entries(ALLOWED)) {
      if (body[key] !== undefined) {
        if (body[key] !== null && typeof body[key] !== expectedType) {
          return res.status(400).json({ success: false, error: `Campo '${key}' debe ser tipo ${expectedType}` });
        }
        if (typeof body[key] === 'string' && body[key].length > 2000) {
          return res.status(400).json({ success: false, error: `Campo '${key}' excede el limite de 2000 caracteres` });
        }
        update[key] = body[key];
      }
    }

    console.log('update-settings: fields to update:', JSON.stringify(update));

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

    console.log('update-settings: Supabase PATCH status:', patchRes.status);

    if (!patchRes.ok) {
      const errText = await patchRes.text();
      console.error('update-settings: patch error', patchRes.status, errText);
      return res.status(500).json({ success: false, error: 'Error al guardar los cambios' });
    }

    console.log('update-settings: SUCCESS for', restaurant_slug, '- fields:', Object.keys(update).join(', '));
    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('update-settings error:', error);
    return res.status(500).json({ success: false, error: 'Error del servidor' });
  }
}
