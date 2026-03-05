import bcrypt from 'bcryptjs';
import { rateLimit } from './rate-limit.js';
import { handleCors } from './cors.js';
import { verifyRestaurantSession } from './verify-session.js';

export default async function handler(req, res) {
  if (handleCors(req, res, { headers: 'Content-Type, x-restaurant-token' })) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Rate limit: 5 attempts per minute per IP
  if (rateLimit(req, res, { max: 5, windowMs: 60000, prefix: 'change-pw' })) return;

  const { username, newPassword, currentPassword } = req.body || {};

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
    // Two modes: forced (no currentPassword) vs voluntary (currentPassword provided)
    const isVoluntary = !!currentPassword;

    // Voluntary mode requires a valid session token
    if (isVoluntary) {
      const token = req.headers['x-restaurant-token'];
      const session = await verifyRestaurantSession(token, supabaseUrl, supabaseKey);
      if (!session.valid) {
        return res.status(403).json({ success: false, error: 'Sesion invalida o expirada' });
      }
    }

    let userQuery;
    if (isVoluntary) {
      // Voluntary: fetch by username + active, will verify currentPassword
      userQuery = `${supabaseUrl}/rest/v1/restaurant_users?username=eq.${encodeURIComponent(username)}&status=eq.active&select=id,password_hash&limit=1`;
    } else {
      // Forced: MUST have must_change_password = true (security gate)
      userQuery = `${supabaseUrl}/rest/v1/restaurant_users?username=eq.${encodeURIComponent(username)}&must_change_password=eq.true&status=eq.active&select=id&limit=1`;
    }

    const userRes = await fetch(userQuery, { headers: sbHeaders });

    if (!userRes.ok) {
      console.error('change-password: lookup error', userRes.status);
      return res.status(500).json({ success: false, error: 'Error del servidor' });
    }

    const users = await userRes.json();
    if (users.length === 0) {
      return res.status(403).json({ success: false, error: 'No se puede cambiar la contrasena' });
    }

    const user = users[0];

    // Voluntary mode: verify current password
    if (isVoluntary) {
      const valid = await bcrypt.compare(currentPassword, user.password_hash);
      if (!valid) {
        return res.status(401).json({ success: false, error: 'Contrasena actual incorrecta' });
      }
    }

    const password_hash = await bcrypt.hash(newPassword, 10);

    // Update password (and clear forced flag if it was a forced change)
    const patchBody = { password_hash };
    if (!isVoluntary) {
      patchBody.must_change_password = false;
    }

    const patchRes = await fetch(
      `${supabaseUrl}/rest/v1/restaurant_users?id=eq.${user.id}`,
      {
        method: 'PATCH',
        headers: { ...sbHeaders, 'Prefer': 'return=minimal' },
        body: JSON.stringify(patchBody),
      }
    );

    if (!patchRes.ok) {
      console.error('change-password: patch error', patchRes.status);
      return res.status(500).json({ success: false, error: 'Error al actualizar la contrasena' });
    }

    console.log('change-password: password updated for', username, isVoluntary ? '(voluntary)' : '(forced)');
    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('change-password error:', error);
    return res.status(500).json({ success: false, error: 'Error del servidor' });
  }
}
