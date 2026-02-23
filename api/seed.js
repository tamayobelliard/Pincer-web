import bcrypt from 'bcryptjs';

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://www.pincerweb.com';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-seed-secret');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Require seed secret to prevent unauthorized access
  const seedSecret = process.env.SEED_SECRET;
  if (!seedSecret || req.headers['x-seed-secret'] !== seedSecret) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    const users = [
      {
        username: 'admin',
        password: process.env.SEED_ADMIN_PASSWORD || 'Admin2025!',
        role: 'admin',
        restaurant_slug: null,
        display_name: 'Pincer Admin',
      },
      {
        username: 'mrsandwich',
        password: process.env.SEED_RESTAURANT_PASSWORD || 'chef2025',
        role: 'restaurant',
        restaurant_slug: 'mrsandwich',
        display_name: 'Mr. Sandwich by Chef Elly',
      },
    ];

    const results = [];

    for (const u of users) {
      const password_hash = await bcrypt.hash(u.password, 10);

      const upsertRes = await fetch(
        `${supabaseUrl}/rest/v1/restaurant_users`,
        {
          method: 'POST',
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates',
          },
          body: JSON.stringify({
            username: u.username,
            password_hash,
            role: u.role,
            restaurant_slug: u.restaurant_slug,
            display_name: u.display_name,
            status: 'active',
          }),
        }
      );

      if (!upsertRes.ok) {
        const errText = await upsertRes.text();
        console.error(`Failed to upsert ${u.username}:`, errText);
        results.push({ username: u.username, success: false, error: errText });
      } else {
        results.push({ username: u.username, success: true });
      }
    }

    // Clean up: delete test product if it exists
    await fetch(
      `${supabaseUrl}/rest/v1/products?id=eq.mrsandwich-mini-sandwich-de-prueba-test`,
      {
        method: 'DELETE',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
        },
      }
    ).catch(() => {});

    return res.status(200).json({ success: true, results });

  } catch (error) {
    console.error('seed error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}
