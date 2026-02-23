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
  res.setHeader('Access-Control-Allow-Methods', 'PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' });

  const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Verify admin session token
  const isAdmin = await verifyAdmin(req.headers['x-admin-key'], supabaseUrl, supabaseKey);
  if (!isAdmin) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { id, display_name, business_type, address, phone, contact_name, email, hours, website, notes } = req.body;

  if (!id) {
    return res.status(400).json({ error: 'id is required' });
  }

  // Build partial update object from provided fields only
  const update = {};
  if (display_name !== undefined) update.display_name = display_name || null;
  if (business_type !== undefined) update.business_type = business_type || null;
  if (address !== undefined) update.address = address || null;
  if (phone !== undefined) update.phone = phone || null;
  if (contact_name !== undefined) update.contact_name = contact_name || null;
  if (email !== undefined) update.email = email || null;
  if (hours !== undefined) update.hours = hours || null;
  if (website !== undefined) update.website = website || null;
  if (notes !== undefined) update.notes = notes || null;

  if (Object.keys(update).length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  try {
    const r = await fetch(
      `${supabaseUrl}/rest/v1/restaurant_users?id=eq.${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(update),
      }
    );

    if (!r.ok) {
      const errText = await r.text();
      console.error('Supabase PATCH error:', errText);
      return res.status(r.status).json({ error: 'Failed to update restaurant' });
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('update-restaurant error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
