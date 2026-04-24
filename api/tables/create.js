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

  // ── DEBUG 2026-04-24: logging temporal para diagnosticar 500 en INSERT.
  // Remover cuando el bug quede identificado.
  const keyType = supabaseKey
    ? (supabaseKey === process.env.SUPABASE_ANON_KEY ? 'ANON_KEY' : 'SERVICE_ROLE_KEY')
    : 'MISSING';
  console.log('[tables/create] env:', {
    supabaseUrl,
    key_type: keyType,
    key_length: supabaseKey ? supabaseKey.length : 0,
    has_service_role_env: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    has_anon_key_env: !!process.env.SUPABASE_ANON_KEY,
    base_url_env: process.env.BASE_URL || '(default)',
  });

  if (!supabaseKey) return res.status(500).json({ success: false, error: 'Error del servidor' });

  // Session auth — slug viene de la sesión, nunca del body.
  const token = getRestaurantToken(req);
  if (!token) return res.status(401).json({ success: false, error: 'Authentication required' });
  const session = await verifyRestaurantSession(token, supabaseUrl, supabaseKey);
  if (!session.valid) return res.status(403).json({ success: false, error: 'Sesion invalida o expirada' });

  // ── DEBUG: captura tipo/valor exacto de session.user_id y slug.
  console.log('[tables/create] session:', {
    valid: session.valid,
    slug: session.restaurant_slug,
    slug_type: typeof session.restaurant_slug,
    user_id: session.user_id,
    user_id_type: typeof session.user_id,
    user_id_is_integer: Number.isInteger(session.user_id),
    user_id_string_value: String(session.user_id),
  });

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
    // ── DEBUG: log del dup-check URL + resultado.
    const dupUrl = `${supabaseUrl}/rest/v1/tables?restaurant_slug=eq.${encodeURIComponent(slug)}&table_number=eq.${table_number}&active=eq.true&select=id&limit=1`;
    console.log('[tables/create] dupCheck URL:', dupUrl);

    const dupRes = await fetch(dupUrl, { headers: sbHeaders });
    const dupRawText = await dupRes.text();
    console.log('[tables/create] dupCheck response:', {
      status: dupRes.status,
      ok: dupRes.ok,
      raw_text: dupRawText.substring(0, 500),
    });

    if (!dupRes.ok) {
      console.error('tables/create: dup check error', dupRes.status, dupRawText);
      return res.status(500).json({ success: false, error: 'Error del servidor' });
    }

    let dupRows = [];
    try { dupRows = JSON.parse(dupRawText); } catch (pe) {
      console.error('[tables/create] dupCheck JSON parse failed:', pe.message);
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

    // ── DEBUG: log del INSERT URL, headers resumidos y body serializado.
    // qr_token redactado a los primeros 4 chars para no filtrar secretos.
    const insertUrl = `${supabaseUrl}/rest/v1/tables`;
    const serializedBody = JSON.stringify(insertBody);
    console.log('[tables/create] INSERT request:', {
      url: insertUrl,
      method: 'POST',
      headers_summary: {
        apikey: 'REDACTED',
        Authorization: 'Bearer REDACTED',
        'Content-Type': sbHeaders['Content-Type'],
        Prefer: 'return=representation',
        key_type_used: keyType,
      },
      body_preview: {
        restaurant_slug: slug,
        table_number,
        qr_token_first4: qrToken.substring(0, 4) + '...(28 more)',
        active: true,
        created_by_user_id: userId,
        created_by_user_id_type: typeof userId,
      },
      serialized_body_length: serializedBody.length,
      serialized_body_raw: serializedBody.replace(qrToken, qrToken.substring(0, 4) + '...REDACTED'),
    });

    const insertRes = await fetch(
      insertUrl,
      {
        method: 'POST',
        headers: { ...sbHeaders, 'Prefer': 'return=representation' },
        body: serializedBody,
      }
    );

    // ── DEBUG: SIEMPRE leer response como text primero, luego intentar JSON.
    // Evita el fallo silencioso si PostgREST devuelve HTML/empty/algo no-JSON.
    const insertRawText = await insertRes.text();
    console.log('[tables/create] INSERT response:', {
      status: insertRes.status,
      ok: insertRes.ok,
      content_type: insertRes.headers.get('content-type'),
      raw_text: insertRawText.substring(0, 1000),
      raw_text_length: insertRawText.length,
    });

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
