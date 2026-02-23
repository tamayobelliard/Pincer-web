import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://www.pincerweb.com';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Verify admin access
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey || req.headers['x-admin-key'] !== adminKey) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { name, business_type, address, phone, contact_name, email, hours, website, notes } = req.body;

  if (!name) {
    return res.status(400).json({ success: false, error: 'El nombre es requerido' });
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    // Generate username from name (slugify)
    const username = name
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '')
      .slice(0, 20);

    // Cryptographically secure password generation
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const bytes = randomBytes(8);
    let temp_password = '';
    for (let i = 0; i < 8; i++) {
      temp_password += chars.charAt(bytes[i] % chars.length);
    }

    const password_hash = await bcrypt.hash(temp_password, 10);

    // Insert into restaurant_users
    const insertRes = await fetch(
      `${supabaseUrl}/rest/v1/restaurant_users`,
      {
        method: 'POST',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation',
        },
        body: JSON.stringify({
          username,
          password_hash,
          restaurant_slug: username,
          display_name: name,
          role: 'restaurant',
          status: 'pending',
        }),
      }
    );

    if (!insertRes.ok) {
      const errText = await insertRes.text();
      console.error('Failed to create restaurant user:', errText);
      if (errText.includes('duplicate') || errText.includes('unique')) {
        return res.status(409).json({ success: false, error: 'Ya existe un usuario con ese nombre' });
      }
      return res.status(500).json({ success: false, error: 'Error al crear usuario' });
    }

    return res.status(200).json({
      success: true,
      username,
      temp_password,
      display_name: name,
    });

  } catch (error) {
    console.error('create-restaurant error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}
