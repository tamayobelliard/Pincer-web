import { rateLimit } from './rate-limit.js';
import { handleCors, requireJson } from './cors.js';
import { verifyRestaurantSession, getRestaurantToken } from './verify-session.js';
import { stripExif } from './strip-exif.js';

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
        const rawBuffer = Buffer.from(match[2], 'base64');
        const buffer = stripExif(rawBuffer);
        const storagePath = `logos/${restaurant_slug}.jpg`;

        console.log('update-settings: uploading logo to Storage, size:', buffer.length, '(stripped EXIF)');
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

    // Whitelist of allowed fields with type validation.
    // Types: 'string' | 'number' | 'boolean' | 'array'.
    // Hotfix #1.1 (2026-04-22): order_types was declared 'string' but the
    // dashboard sends it as an array → all saves silently failed with 400.
    // Root cause of data drift across restaurants (see thedeck, hummus,
    // tastystoriescafe all stuck with signup default ['dine_in']).
    const ALLOWED = {
      business_type: 'string',
      address: 'string',
      phone: 'string',
      contact_name: 'string',
      hours: 'string',
      website: 'string',
      notes: 'string',
      chatbot_personality: 'string',
      order_types: 'array',
      delivery_fee: 'number',
      logo_url: 'string',
    };

    // order_types only accepts these three enum values (mirrors the UI).
    const ORDER_TYPE_VALUES = ['dine_in', 'take_out', 'delivery'];

    const update = {};
    for (const [key, expectedType] of Object.entries(ALLOWED)) {
      if (body[key] === undefined) continue;

      // null is always acceptable (clears an optional field)
      if (body[key] === null) { update[key] = null; continue; }

      // Type validation via isValidType (see bottom of this file)
      if (!isValidType(body[key], expectedType)) {
        const receivedType = Array.isArray(body[key]) ? 'array' : typeof body[key];
        console.error(JSON.stringify({
          event: 'update_settings_validation_rejected',
          reason: 'wrong_type',
          restaurant_slug,
          field: key,
          expected_type: expectedType,
          received_type: receivedType,
          received_value: safeValueForLog(body[key]),
        }));
        return res.status(400).json({ success: false, error: `Campo '${key}' debe ser tipo ${expectedType}` });
      }

      // Length check for strings
      if (expectedType === 'string' && body[key].length > 2000) {
        console.error(JSON.stringify({
          event: 'update_settings_validation_rejected',
          reason: 'length_exceeded',
          restaurant_slug,
          field: key,
          expected_type: expectedType,
          received_type: 'string',
          received_value: safeValueForLog(body[key]),
          length: body[key].length,
          max_length: 2000,
        }));
        return res.status(400).json({ success: false, error: `Campo '${key}' excede el limite de 2000 caracteres` });
      }

      // Per-field semantic validation
      if (key === 'order_types') {
        const r = validateOrderTypes(body[key], ORDER_TYPE_VALUES);
        if (!r.ok) {
          console.error(JSON.stringify({
            event: 'update_settings_validation_rejected',
            reason: r.reason,
            restaurant_slug,
            field: key,
            expected_type: expectedType,
            received_type: Array.isArray(body[key]) ? 'array' : typeof body[key],
            received_value: safeValueForLog(body[key]),
            invalid_items: r.invalid,
            allowed_values: ORDER_TYPE_VALUES,
          }));
          return res.status(400).json({ success: false, error: `Campo 'order_types' invalido: ${r.reason}` });
        }
      }

      update[key] = body[key];
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

// ── Validation helpers (hotfix #1.1) ───────────────────────────────────────
// isValidType accepts the four primitives the whitelist uses. NaN and
// Infinity are rejected for 'number' because they round-trip as null in JSON
// and are never valid settings values.
function isValidType(value, expected) {
  if (expected === 'string')  return typeof value === 'string';
  if (expected === 'number')  return typeof value === 'number' && Number.isFinite(value);
  if (expected === 'boolean') return typeof value === 'boolean';
  if (expected === 'array')   return Array.isArray(value);
  return false;
}

// order_types must be a non-empty array of strings drawn from allowedValues.
function validateOrderTypes(value, allowedValues) {
  if (!Array.isArray(value)) return { ok: false, reason: 'not_array' };
  if (value.length === 0)    return { ok: false, reason: 'empty_array' };
  const invalid = value.filter(v => typeof v !== 'string' || !allowedValues.includes(v));
  if (invalid.length > 0)    return { ok: false, reason: 'invalid_values', invalid };
  return { ok: true };
}

// Serialize a rejected value into a bounded, JSON-safe form for structured
// logs. Strings truncated to 60 chars. Objects/arrays JSON'd; if the JSON
// exceeds 200 chars, the truncated string preview is returned instead of
// the raw reference. Primitives pass through. Defensive against unexpected
// types (functions, symbols, circular refs) even though JSON.parse can't
// produce them from a client body — future-proofing.
function safeValueForLog(value) {
  if (typeof value === 'string') {
    return value.length > 60 ? value.substring(0, 60) + '…' : value;
  }
  if (value !== null && typeof value === 'object') {
    try {
      const json = JSON.stringify(value);
      if (typeof json !== 'string') return '[unloggable:' + (typeof value) + ']';
      if (json.length > 200) return json.substring(0, 200) + '…';
      return value;
    } catch (e) {
      return '[unloggable:' + (typeof value) + ']';
    }
  }
  // primitives (number, boolean, null, undefined) and bigint/symbol fallback
  if (typeof value === 'bigint' || typeof value === 'symbol') {
    return String(value);
  }
  return value;
}
