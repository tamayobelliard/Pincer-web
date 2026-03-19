import bcrypt from 'bcryptjs';
import { rateLimit } from './rate-limit.js';
import { handleCors, requireJson } from './cors.js';
import { checkEnvSafety } from './env-check.js';
import { hashToken } from './verify-session.js';

export default async function handler(req, res) {
  checkEnvSafety();
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (requireJson(req, res)) return;

  // Rate limit: 5 attempts per 15 minutes per IP
  if (rateLimit(req, res, { max: 5, windowMs: 15 * 60 * 1000, prefix: 'reset-pw' })) return;

  const { token, newPassword } = req.body;

  if (!token || typeof token !== 'string') {
    return res.status(400).json({ success: false, error: 'Token requerido' });
  }

  if (!newPassword || typeof newPassword !== 'string') {
    return res.status(400).json({ success: false, error: 'Nueva contrasena requerida' });
  }

  // Password strength validation (same rules as change-password.js)
  if (newPassword.length < 8) {
    return res.status(400).json({ success: false, error: 'La contrasena debe tener al menos 8 caracteres' });
  }
  if (!/[A-Z]/.test(newPassword)) {
    return res.status(400).json({ success: false, error: 'La contrasena debe incluir al menos una letra mayuscula' });
  }
  if (!/[0-9]/.test(newPassword)) {
    return res.status(400).json({ success: false, error: 'La contrasena debe incluir al menos un numero' });
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
    // Look up user by hashed token + check expiration
    const tokenHash = hashToken(token);
    const now = new Date().toISOString();

    const userRes = await fetch(
      `${supabaseUrl}/rest/v1/restaurant_users?reset_token_hash=eq.${encodeURIComponent(tokenHash)}&reset_token_expires=gt.${encodeURIComponent(now)}&status=eq.active&select=id,username`,
      { headers: sbHeaders }
    );

    if (!userRes.ok) {
      console.error('reset-password: lookup error', userRes.status);
      return res.status(500).json({ success: false, error: 'Error del servidor' });
    }

    const users = await userRes.json();
    if (users.length === 0) {
      return res.status(400).json({ success: false, error: 'El enlace es invalido o ha expirado. Solicita uno nuevo.' });
    }

    const user = users[0];

    // Hash new password with bcrypt cost 12
    const passwordHash = await bcrypt.hash(newPassword, 12);

    // Update password + clear reset token + clear lockout + clear forced change flag
    const patchRes = await fetch(
      `${supabaseUrl}/rest/v1/restaurant_users?id=eq.${user.id}`,
      {
        method: 'PATCH',
        headers: { ...sbHeaders, 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          password_hash: passwordHash,
          reset_token_hash: null,
          reset_token_expires: null,
          failed_login_attempts: 0,
          locked_until: null,
          must_change_password: false,
        }),
      }
    );

    if (!patchRes.ok) {
      console.error('reset-password: patch error', patchRes.status);
      return res.status(500).json({ success: false, error: 'Error al actualizar la contrasena' });
    }

    // Invalidate all existing sessions (force re-login with new password)
    await fetch(
      `${supabaseUrl}/rest/v1/restaurant_sessions?user_id=eq.${user.id}`,
      { method: 'DELETE', headers: sbHeaders }
    );

    console.log('reset-password: password reset for', user.username);
    return res.status(200).json({ success: true, message: 'Contrasena actualizada. Ya puedes iniciar sesion.' });

  } catch (error) {
    console.error('reset-password error:', error);
    return res.status(500).json({ success: false, error: 'Error del servidor' });
  }
}
