const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://www.pincerweb.com';

// Verify admin session token against Supabase
async function verifyAdmin(token, supabaseUrl, supabaseKey) {
  if (!token) return false;
  try {
    const r = await fetch(
      `${supabaseUrl}/rest/v1/admin_sessions?token=eq.${encodeURIComponent(token)}&expires_at=gt.${new Date().toISOString()}&select=user_id`,
      {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
        },
        signal: AbortSignal.timeout(3000),
      }
    );
    if (!r.ok) return false;
    const rows = await r.json();
    return rows.length > 0;
  } catch { return false; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Verify admin session token
  const isAdmin = await verifyAdmin(req.headers['x-admin-key'], supabaseUrl, supabaseKey);
  if (!isAdmin) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // GET — list restaurant users
  if (req.method === 'GET') {
    try {
      const r = await fetch(
        `${supabaseUrl}/rest/v1/restaurant_users?role=eq.restaurant&select=*&order=created_at.desc`,
        {
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
          },
        }
      );
      if (!r.ok) {
        console.error('Supabase GET error:', await r.text());
        return res.status(r.status).json({ error: 'Failed to load restaurants' });
      }
      const raw = await r.json();
      const data = raw.map(({ password_hash, ...rest }) => rest);
      return res.status(200).json(data);
    } catch (error) {
      console.error('restaurants GET error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  // PATCH — toggle status
  if (req.method === 'PATCH') {
    const { id, status } = req.body;
    if (!id || !status || !['active', 'pending', 'disabled'].includes(status)) {
      return res.status(400).json({ error: 'Valid id and status required' });
    }
    try {
      const r = await fetch(
        `${supabaseUrl}/rest/v1/restaurant_users?id=eq.${id}`,
        {
          method: 'PATCH',
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ status }),
        }
      );
      if (!r.ok) {
        console.error('Supabase PATCH error:', await r.text());
        return res.status(r.status).json({ error: 'Failed to update' });
      }
      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('restaurants PATCH error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
