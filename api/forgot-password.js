import { randomBytes } from 'crypto';
import { rateLimit } from './rate-limit.js';
import { verifyRecaptcha } from './recaptcha.js';
import { handleCors, requireJson } from './cors.js';
import { checkEnvSafety } from './env-check.js';
import { hashToken } from './verify-session.js';
import { sendEmail } from './send-email.js';
import { OPERATIONAL_STATUSES_FILTER } from './statuses.js';

export default async function handler(req, res) {
  checkEnvSafety();
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (requireJson(req, res)) return;

  // Strict rate limit: 3 requests per 15 minutes per IP
  if (rateLimit(req, res, { max: 3, windowMs: 15 * 60 * 1000, prefix: 'forgot-pw' })) return;

  const { email, recaptchaToken } = req.body;

  if (!email || typeof email !== 'string') {
    return res.status(400).json({ success: false, error: 'Email requerido' });
  }

  if (!await verifyRecaptcha(recaptchaToken, 'forgot_password')) {
    return res.status(403).json({ success: false, error: 'Verificacion de seguridad fallida. Intenta de nuevo.' });
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

  // Always return success to prevent email enumeration
  const safeResponse = { success: true, message: 'Si el email existe, recibiras un enlace para restablecer tu contrasena.' };

  try {
    // Look up active user by email
    const userRes = await fetch(
      `${supabaseUrl}/rest/v1/restaurant_users?email=eq.${encodeURIComponent(email.trim().toLowerCase())}&status=${OPERATIONAL_STATUSES_FILTER}&select=id,email,display_name`,
      { headers: sbHeaders }
    );

    if (!userRes.ok) {
      console.error('forgot-password: lookup error', userRes.status);
      return res.status(200).json(safeResponse);
    }

    const users = await userRes.json();
    if (users.length === 0) {
      // No user found — return same response to prevent enumeration
      return res.status(200).json(safeResponse);
    }

    const user = users[0];

    // Generate reset token (48 bytes = 96 hex chars)
    const resetToken = randomBytes(48).toString('hex');
    const resetTokenHash = hashToken(resetToken);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

    // Store hashed token + expiration
    const patchRes = await fetch(
      `${supabaseUrl}/rest/v1/restaurant_users?id=eq.${user.id}`,
      {
        method: 'PATCH',
        headers: { ...sbHeaders, 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          reset_token_hash: resetTokenHash,
          reset_token_expires: expiresAt,
        }),
      }
    );

    if (!patchRes.ok) {
      console.error('forgot-password: patch error', patchRes.status);
      return res.status(200).json(safeResponse);
    }

    // Build reset link
    const baseUrl = 'https://www.pincerweb.com';
    const resetLink = `${baseUrl}/reset-password?token=${resetToken}`;

    // Send email
    await sendEmail(
      user.email,
      'Restablecer contraseña — Pincer',
      `
      <div style="font-family: 'Helvetica Neue', Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 20px;">
        <div style="text-align: center; margin-bottom: 32px;">
          <img src="https://i.imgur.com/FaOdU4D.png" alt="Pincer" style="height: 36px;" />
        </div>
        <h2 style="color: #0F172A; font-size: 1.3em; margin-bottom: 8px;">Restablecer contraseña</h2>
        <p style="color: #64748B; font-size: 0.95em; line-height: 1.6;">
          Hola${user.display_name ? ` ${user.display_name}` : ''},<br><br>
          Recibimos una solicitud para restablecer la contraseña de tu cuenta en Pincer.
          Haz clic en el botón para crear una nueva contraseña:
        </p>
        <div style="text-align: center; margin: 28px 0;">
          <a href="${resetLink}" style="background: #E8191A; color: #FFFFFF; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 0.95em; display: inline-block;">
            Restablecer contraseña
          </a>
        </div>
        <p style="color: #94A3B8; font-size: 0.85em; line-height: 1.5;">
          Este enlace expira en 1 hora. Si no solicitaste este cambio, puedes ignorar este correo.
        </p>
      </div>
      `
    );

    console.log('forgot-password: reset email sent to', user.email);
    return res.status(200).json(safeResponse);

  } catch (error) {
    console.error('forgot-password error:', error);
    return res.status(200).json(safeResponse);
  }
}
