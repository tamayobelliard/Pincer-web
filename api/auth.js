import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { rateLimit } from './rate-limit.js';
import { verifyRecaptcha } from './recaptcha.js';
import { handleCors, requireJson } from './cors.js';
import { OPERATIONAL_STATUSES_FILTER } from './statuses.js';
import { checkEnvSafety } from './env-check.js';
import { hashToken } from './verify-session.js';

export default async function handler(req, res) {
  checkEnvSafety();
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (requireJson(req, res)) return;

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
      `${supabaseUrl}/rest/v1/restaurant_users?username=eq.${encodeURIComponent(username)}&status=${OPERATIONAL_STATUSES_FILTER}&select=*`,
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

    // Check account lockout
    if (user.locked_until) {
      const lockedUntil = new Date(user.locked_until);
      if (lockedUntil > new Date()) {
        return res.status(429).json({ success: false, error: 'Cuenta bloqueada. Intenta en 15 minutos.' });
      }
      // Lock expired — reset counter
      await fetch(
        `${supabaseUrl}/rest/v1/restaurant_users?id=eq.${user.id}`,
        {
          method: 'PATCH',
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ failed_login_attempts: 0, locked_until: null }),
        }
      );
    }

    // Verify password
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      const attempts = (user.failed_login_attempts || 0) + 1;
      const update = { failed_login_attempts: attempts };
      if (attempts >= 5) {
        update.locked_until = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      }
      await fetch(
        `${supabaseUrl}/rest/v1/restaurant_users?id=eq.${user.id}`,
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
      if (attempts >= 5) {
        return res.status(429).json({ success: false, error: 'Cuenta bloqueada. Intenta en 15 minutos.' });
      }
      return res.status(401).json({ success: false, error: 'Usuario o contraseña incorrectos' });
    }

    // Reset failed attempts on successful login
    if (user.failed_login_attempts > 0) {
      await fetch(
        `${supabaseUrl}/rest/v1/restaurant_users?id=eq.${user.id}`,
        {
          method: 'PATCH',
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ failed_login_attempts: 0, locked_until: null }),
        }
      );
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

    const sbHeaders = {
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
    };

    // For restaurant users, invalidate existing sessions then create new one
    if (user.role === 'restaurant') {
      try {
        // Invalidate all existing sessions for this user (#3 — session regeneration)
        await fetch(
          `${supabaseUrl}/rest/v1/restaurant_sessions?user_id=eq.${user.id}`,
          { method: 'DELETE', headers: sbHeaders }
        );

        const sessionToken = randomBytes(32).toString('hex');
        const tokenHash = hashToken(sessionToken);
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24h

        const sessRes = await fetch(
          `${supabaseUrl}/rest/v1/restaurant_sessions`,
          {
            method: 'POST',
            headers: sbHeaders,
            body: JSON.stringify({
              token_hash: tokenHash,
              user_id: user.id,
              restaurant_slug: user.restaurant_slug,
              expires_at: expiresAt,
            }),
          }
        );

        if (sessRes.ok) {
          response.sessionToken = sessionToken;
          // Set httpOnly cookie (#1 — move token out of sessionStorage)
          const maxAge = 24 * 60 * 60; // 24h in seconds
          res.setHeader('Set-Cookie', `pincer_session=${sessionToken}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`);
        } else {
          console.error('Failed to create restaurant session:', sessRes.status, await sessRes.text());
        }
      } catch (e) {
        console.error('Restaurant session creation error:', e.message);
      }
    }

    // For admin users, invalidate existing sessions then create new one
    if (user.role === 'admin') {
      // Invalidate all existing admin sessions for this user (#3)
      await fetch(
        `${supabaseUrl}/rest/v1/admin_sessions?user_id=eq.${user.id}`,
        { method: 'DELETE', headers: sbHeaders }
      );

      const sessionToken = randomBytes(32).toString('hex');
      const tokenHash = hashToken(sessionToken);
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24h

      const sessRes = await fetch(
        `${supabaseUrl}/rest/v1/admin_sessions`,
        {
          method: 'POST',
          headers: sbHeaders,
          body: JSON.stringify({
            token_hash: tokenHash,
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
      // Set httpOnly cookie for admin
      const maxAge = 24 * 60 * 60;
      res.setHeader('Set-Cookie', `pincer_admin=${sessionToken}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`);
    }

    return res.status(200).json(response);

  } catch (error) {
    console.error('auth error:', error);
    return res.status(500).json({ success: false, error: 'Error del servidor' });
  }
}
