export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

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
        const err = await r.text();
        console.error('Supabase GET error:', err);
        return res.status(r.status).json({ error: 'Failed to load restaurants' });
      }
      const data = await r.json();
      return res.status(200).json(data);
    } catch (error) {
      console.error('restaurants GET error:', error);
      return res.status(500).json({ error: error.message });
    }
  }

  // PATCH — toggle status
  if (req.method === 'PATCH') {
    const { id, status } = req.body;
    if (!id || !status) {
      return res.status(400).json({ error: 'id and status required' });
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
        const err = await r.text();
        console.error('Supabase PATCH error:', err);
        return res.status(r.status).json({ error: 'Failed to update' });
      }
      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('restaurants PATCH error:', error);
      return res.status(500).json({ error: error.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
