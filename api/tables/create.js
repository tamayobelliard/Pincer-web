import { rateLimit } from '../rate-limit.js';
import { handleCors, requireJson } from '../cors.js';
import { verifyRestaurantSession, getRestaurantToken } from '../verify-session.js';
import { generateQrToken } from './_token.js';

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  if (handleCors(req, res, { methods: 'POST, OPTIONS', headers: 'Content-Type, x-restaurant-token' })) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (requireJson(req, res)) return;

  // Strict-ish rate limit — crear mesas es operación infrecuente por UX.
  if (rateLimit(req, res, { max: 30, windowMs: 60000, prefix: 'tables-create' })) return;

  const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseKey) return res.status(500).json({ success: false, error: 'Error del servidor' });

  // Session auth — slug viene de la sesión, nunca del body.
  const token = getRestaurantToken(req);
  if (!token) return res.status(401).json({ success: false, error: 'Authentication required' });
  const session = await verifyRestaurantSession(token, supabaseUrl, supabaseKey);
  if (!session.valid) return res.status(403).json({ success: false, error: 'Sesion invalida o expirada' });

  const { table_number } = req.body || {};

  // Validación estricta: entero > 0. Rechazamos string, float, negativo, cero.
  if (!Number.isInteger(table_number) || table_number <= 0) {
    return res.status(400).json({ success: false, error: 'table_number debe ser entero positivo' });
  }
  if (table_number > 9999) {
    return res.status(400).json({ success: false, error: 'table_number fuera de rango (max 9999)' });
  }

  const slug = session.restaurant_slug;
  const userId = session.user_id;
  const sbHeaders = {
    'apikey': supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
  };

  try {
    // Verificación explícita: ¿existe mesa activa con ese número? Usamos
    // el índice parcial (restaurant_slug, table_number) WHERE active=true.
    // Consultamos antes del INSERT para devolver 409 limpio; si hay carrera
    // el UNIQUE constraint cacha el duplicado y respondemos 409 igualmente.
    const dupRes = await fetch(
      `${supabaseUrl}/rest/v1/tables?restaurant_slug=eq.${encodeURIComponent(slug)}&table_number=eq.${table_number}&active=eq.true&select=id&limit=1`,
      { headers: sbHeaders }
    );

    // Pattern text() → JSON.parse: siempre leer response como text primero,
    // luego intentar JSON. Se mantuvo post-debug porque es más robusto ante
    // respuestas no-JSON (HTML de error del proxy, empty body, etc.) y
    // preserva el raw text para el console.error en caso de fallo.
    const dupRawText = await dupRes.text();

    if (!dupRes.ok) {
      console.error('tables/create: dup check error', dupRes.status, dupRawText);
      return res.status(500).json({ success: false, error: 'Error del servidor' });
    }

    let dupRows = [];
    try { dupRows = JSON.parse(dupRawText); } catch (pe) {
      console.error('[tables/create] dupCheck JSON parse failed:', pe.message, 'raw:', dupRawText);
      return res.status(500).json({ success: false, error: 'Error del servidor' });
    }
    if (dupRows.length > 0) {
      return res.status(409).json({ success: false, error: `Mesa ${table_number} ya existe` });
    }

    const qrToken = generateQrToken(32);
    const insertBody = {
      restaurant_slug: slug,
      table_number,
      qr_token: qrToken,
      active: true,
      created_by_user_id: userId,
    };

    const insertRes = await fetch(
      `${supabaseUrl}/rest/v1/tables`,
      {
        method: 'POST',
        headers: { ...sbHeaders, 'Prefer': 'return=representation' },
        body: JSON.stringify(insertBody),
      }
    );

    // Mismo pattern text() → JSON.parse. Si PostgREST falla, el raw_text
    // lleva el mensaje exacto (ej. "invalid input syntax for type X: 'Y'")
    // que es lo único útil para diagnosticar.
    const insertRawText = await insertRes.text();

    if (!insertRes.ok) {
      // Duplicate key violation (race condition con el dupRes de arriba).
      if (insertRes.status === 409 || insertRawText.includes('duplicate key')) {
        return res.status(409).json({ success: false, error: `Mesa ${table_number} ya existe` });
      }
      console.error('tables/create: insert error', insertRes.status, insertRawText);
      return res.status(500).json({ success: false, error: 'Error al crear mesa' });
    }

    let rows;
    try { rows = JSON.parse(insertRawText); }
    catch (pe) {
      console.error('[tables/create] INSERT JSON parse failed:', pe.message, 'raw:', insertRawText);
      return res.status(500).json({ success: false, error: 'Error del servidor' });
    }
    const row = Array.isArray(rows) ? rows[0] : rows;

    const baseUrl = process.env.BASE_URL || 'https://www.pincerweb.com';
    const qrUrl = `${baseUrl}/${slug}?table=${table_number}&t=${qrToken}`;

    return res.status(200).json({
      success: true,
      id: row.id,
      table_number: row.table_number,
      qr_token: row.qr_token,
      qr_url: qrUrl,
    });
  } catch (e) {
    console.error('tables/create error:', e.message, '\nstack:', e.stack);
    return res.status(500).json({ success: false, error: 'Error del servidor' });
  }
}
