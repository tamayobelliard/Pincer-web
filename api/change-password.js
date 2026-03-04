import bcrypt from 'bcryptjs';
import { rateLimit } from './rate-limit.js';

export default async function handler(req, res) {
  const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://www.pincerweb.com';
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Rate limit: 5 attempts per minute per IP
  if (rateLimit(req, res, { max: 5, windowMs: 60000, prefix: 'change-pw' })) return;

  const { username, newPassword } = req.body || {};

  if (!username || !newPassword) {
    return res.status(400).json({ success: false, error: 'Datos requeridos' });
  }

  if (newPassword.length < 8) {
    return res.status(400).json({ success: false, error: 'La contrasena debe tener al menos 8 caracteres' });
  }

  const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseKey) {
    return res.status(500).json({ success: false, error: 'Error del servidor' });
  }

  const sbHeaders = {
    'apikey': supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
  };

  try {
    // Fetch user — MUST have must_change_password = true (security gate)
    const userRes = await fetch(
      `${supabaseUrl}/rest/v1/restaurant_users?username=eq.${encodeURIComponent(username)}&must_change_password=eq.true&status=eq.active&select=id&limit=1`,
      { headers: sbHeaders }
    );

    if (!userRes.ok) {
      console.error('change-password: lookup error', userRes.status);
      return res.status(500).json({ success: false, error: 'Error del servidor' });
    }

    const users = await userRes.json();
    if (users.length === 0) {
      return res.status(403).json({ success: false, error: 'No se puede cambiar la contrasena' });
    }

    const user = users[0];
    const password_hash = await bcrypt.hash(newPassword, 10);

    // Update password and clear the flag
    const patchRes = await fetch(
      `${supabaseUrl}/rest/v1/restaurant_users?id=eq.${user.id}`,
      {
        method: 'PATCH',
        headers: { ...sbHeaders, 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          password_hash,
          must_change_password: false,
        }),
      }
    );

    if (!patchRes.ok) {
      console.error('change-password: patch error', patchRes.status);
      return res.status(500).json({ success: false, error: 'Error al actualizar la contrasena' });
    }

    console.log('change-password: password updated for', username);
    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('change-password error:', error);
    return res.status(500).json({ success: false, error: 'Error del servidor' });
  }
}
