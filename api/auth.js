import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { rateLimit } from './rate-limit.js';
import { verifyRecaptcha } from './recaptcha.js';

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || 'https://www.pincerweb.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Rate limit: 10 login attempts per minute per IP
  if (rateLimit(req, res, { max: 10, windowMs: 60000, prefix: 'auth' })) return;

  const { username, password, recaptchaToken } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'Username and password required' });
  }

  // Verify reCAPTCHA v3 (skipped if secret key not configured)
  if (!await verifyRecaptcha(recaptchaToken, 'login')) {
    return res.status(403).json({ success: false, error: 'Verificación de seguridad fallida. Intenta de nuevo.' });
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    // Fetch user by username
    const userRes = await fetch(
      `${supabaseUrl}/rest/v1/restaurant_users?username=eq.${encodeURIComponent(username)}&status=eq.active&select=*`,
      {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
        },
      }
    );

    if (!userRes.ok) {
      console.error('Supabase error:', userRes.status);
      return res.status(500).json({ success: false, error: 'Error del servidor' });
    }

    const users = await userRes.json();

    if (users.length === 0) {
      return res.status(401).json({ success: false, error: 'Usuario o contraseña incorrectos' });
    }

    const user = users[0];

    // Verify password
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return res.status(401).json({ success: false, error: 'Usuario o contraseña incorrectos' });
    }

    // Block login if email is not verified (skip for admin users)
    if (user.role !== 'admin' && user.email_verified === false) {
      return res.status(403).json({ success: false, error: 'Debes confirmar tu email antes de iniciar sesion. Revisa tu bandeja de entrada.' });
    }

    const response = {
      success: true,
      role: user.role,
      restaurant_slug: user.restaurant_slug,
      display_name: user.display_name,
      username: user.username,
      plan: user.plan || 'free',
    };

    // Force password change on first login
    if (user.must_change_password) {
      response.mustChangePassword = true;
    }

    // For admin users, generate a unique session token (not the static API key)
    if (user.role === 'admin') {
      const sessionToken = randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24h

      // Store session in Supabase
      const sessRes = await fetch(
        `${supabaseUrl}/rest/v1/admin_sessions`,
        {
          method: 'POST',
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            token: sessionToken,
            user_id: user.id,
            expires_at: expiresAt,
          }),
        }
      );

      if (!sessRes.ok) {
        console.error('Failed to create admin session:', await sessRes.text());
        return res.status(500).json({ success: false, error: 'Error del servidor' });
      }

      response.adminToken = sessionToken;
    }

    return res.status(200).json(response);

  } catch (error) {
    console.error('auth error:', error);
    return res.status(500).json({ success: false, error: 'Error del servidor' });
  }
}
