import { rateLimit } from '../rate-limit.js';
import { handleCors } from '../cors.js';
import { verifyRestaurantSession, getRestaurantToken } from '../verify-session.js';

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  if (handleCors(req, res, { methods: 'GET, OPTIONS', headers: 'Content-Type, x-restaurant-token' })) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (rateLimit(req, res, { max: 60, windowMs: 60000, prefix: 'tables-list' })) return;

  const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseKey) return res.status(500).json({ success: false, error: 'Error del servidor' });

  const token = getRestaurantToken(req);
  if (!token) return res.status(401).json({ success: false, error: 'Authentication required' });
  const session = await verifyRestaurantSession(token, supabaseUrl, supabaseKey);
  if (!session.valid) return res.status(403).json({ success: false, error: 'Sesion invalida o expirada' });

  // Ignora cualquier ?slug= que venga en el query — usamos el slug de la
  // sesión siempre. El query param solo existe para URL legibility.
  const slug = session.restaurant_slug;
  const sbHeaders = {
    'apikey': supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
  };

  try {
    const listRes = await fetch(
      `${supabaseUrl}/rest/v1/tables?restaurant_slug=eq.${encodeURIComponent(slug)}&active=eq.true&select=id,table_number,qr_token,created_at&order=table_number.asc`,
      { headers: sbHeaders }
    );
    if (!listRes.ok) {
      console.error('tables/list: fetch error', listRes.status);
      return res.status(500).json({ success: false, error: 'Error del servidor' });
    }
    const rows = await listRes.json();
    const baseUrl = process.env.BASE_URL || 'https://www.pincerweb.com';
    const tables = rows.map((r) => ({
      id: r.id,
      table_number: r.table_number,
      qr_token: r.qr_token,
      qr_url: `${baseUrl}/${slug}?table=${r.table_number}&t=${r.qr_token}`,
      created_at: r.created_at,
    }));

    return res.status(200).json({ success: true, tables });
  } catch (e) {
    console.error('tables/list error:', e);
    return res.status(500).json({ success: false, error: 'Error del servidor' });
  }
}
