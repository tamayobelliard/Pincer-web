import { handleCors, requireJson } from './cors.js';

const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  if (handleCors(req, res, { headers: 'Content-Type, x-restaurant-token, x-admin-key' })) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (requireJson(req, res)) return;

  if (!supabaseKey) return res.status(500).json({ error: 'Server misconfigured' });

  const restaurantToken = req.headers['x-restaurant-token'];
  const adminToken = req.headers['x-admin-key'];

  if (!restaurantToken && !adminToken) {
    return res.status(400).json({ error: 'No session token provided' });
  }

  try {
    // Invalidate restaurant session
    if (restaurantToken) {
      const delRes = await fetch(
        `${supabaseUrl}/rest/v1/restaurant_sessions?token=eq.${encodeURIComponent(restaurantToken)}`,
        {
          method: 'DELETE',
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
          },
        }
      );
      if (!delRes.ok) {
        console.error('[logout] Failed to delete restaurant session:', delRes.status);
      }
    }

    // Invalidate admin session
    if (adminToken) {
      const delRes = await fetch(
        `${supabaseUrl}/rest/v1/admin_sessions?token=eq.${encodeURIComponent(adminToken)}`,
        {
          method: 'DELETE',
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
          },
        }
      );
      if (!delRes.ok) {
        console.error('[logout] Failed to delete admin session:', delRes.status);
      }
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('[logout] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
