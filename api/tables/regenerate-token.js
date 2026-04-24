import { rateLimit } from '../rate-limit.js';
import { handleCors, requireJson } from '../cors.js';
import { verifyRestaurantSession, getRestaurantToken } from '../verify-session.js';
import { generateQrToken } from './_token.js';

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  if (handleCors(req, res, { methods: 'POST, OPTIONS', headers: 'Content-Type, x-restaurant-token' })) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (requireJson(req, res)) return;

  if (rateLimit(req, res, { max: 30, windowMs: 60000, prefix: 'tables-regen' })) return;

  const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseKey) return res.status(500).json({ success: false, error: 'Error del servidor' });

  const token = getRestaurantToken(req);
  if (!token) return res.status(401).json({ success: false, error: 'Authentication required' });
  const session = await verifyRestaurantSession(token, supabaseUrl, supabaseKey);
  if (!session.valid) return res.status(403).json({ success: false, error: 'Sesion invalida o expirada' });

  const { table_id } = req.body || {};
  if (!Number.isInteger(table_id) || table_id <= 0) {
    return res.status(400).json({ success: false, error: 'table_id requerido (entero positivo)' });
  }

  const slug = session.restaurant_slug;
  const sbHeaders = {
    'apikey': supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
  };

  try {
    // Scoping crítico: buscamos la mesa por id + slug de la sesión. Nunca
    // por id solo — eso permitiría a un restaurante rotar tokens de otro.
    const findRes = await fetch(
      `${supabaseUrl}/rest/v1/tables?id=eq.${table_id}&restaurant_slug=eq.${encodeURIComponent(slug)}&active=eq.true&select=id,table_number&limit=1`,
      { headers: sbHeaders }
    );
    if (!findRes.ok) {
      console.error('tables/regenerate-token: find error', findRes.status);
      return res.status(500).json({ success: false, error: 'Error del servidor' });
    }
    const rows = await findRes.json();
    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Mesa no encontrada' });
    }
    const existing = rows[0];
    const newToken = generateQrToken(32);

    const patchRes = await fetch(
      `${supabaseUrl}/rest/v1/tables?id=eq.${table_id}`,
      {
        method: 'PATCH',
        headers: { ...sbHeaders, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ qr_token: newToken }),
      }
    );
    if (!patchRes.ok) {
      console.error('tables/regenerate-token: patch error', patchRes.status, await patchRes.text());
      return res.status(500).json({ success: false, error: 'Error al regenerar token' });
    }

    const baseUrl = process.env.BASE_URL || 'https://www.pincerweb.com';
    const qrUrl = `${baseUrl}/${slug}?table=${existing.table_number}&t=${newToken}`;

    return res.status(200).json({
      success: true,
      table_number: existing.table_number,
      new_qr_token: newToken,
      new_qr_url: qrUrl,
    });
  } catch (e) {
    console.error('tables/regenerate-token error:', e);
    return res.status(500).json({ success: false, error: 'Error del servidor' });
  }
}
