import { rateLimit } from './rate-limit.js';
import { sendEmail } from './send-email.js';
import { handleCors } from './cors.js';

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Rate limit: 3 per minute per IP
  if (rateLimit(req, res, { max: 3, windowMs: 60000, prefix: 'send-confirm' })) return;

  const { restaurant_slug, token } = req.body || {};

  if (!restaurant_slug || !token) {
    return res.status(400).json({ success: false, error: 'Datos requeridos' });
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
    // Look up user by restaurant_slug and validate token
    const userRes = await fetch(
      `${supabaseUrl}/rest/v1/restaurant_users?restaurant_slug=eq.${encodeURIComponent(restaurant_slug)}&select=email,display_name,email_verification_token&limit=1`,
      { headers: sbHeaders }
    );

    if (!userRes.ok) {
      console.error('send-confirmation-email: lookup error', userRes.status);
      return res.status(500).json({ success: false, error: 'Error del servidor' });
    }

    const users = await userRes.json();
    if (users.length === 0) {
      return res.status(404).json({ success: false, error: 'Restaurante no encontrado' });
    }

    const user = users[0];

    // Validate token matches stored token
    if (user.email_verification_token !== token) {
      return res.status(403).json({ success: false, error: 'Token invalido' });
    }

    const verifyUrl = `https://www.pincerweb.com/api/verify-email?token=${encodeURIComponent(token)}`;

    await sendEmail(
      user.email,
      `Confirma tu email — Pincer`,
      `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;background:#fff;">
        <div style="text-align:center;margin-bottom:20px;">
          <img src="https://i.imgur.com/FaOdU4D.png" alt="Pincer" style="width:48px;height:48px;">
        </div>
        <h1 style="color:#E8191A;text-align:center;margin-bottom:8px;">Confirma tu email</h1>
        <p style="text-align:center;color:#64748B;">Haz clic en el boton para activar tu cuenta de <strong>${user.display_name}</strong>.</p>
        <div style="text-align:center;margin:32px 0;">
          <a href="${verifyUrl}" style="display:inline-block;background:#E8191A;color:#fff;padding:16px 40px;border-radius:10px;font-weight:700;font-size:1.1em;text-decoration:none;">Confirmar email</a>
        </div>
        <p style="color:#94a3b8;font-size:12px;text-align:center;">Si no creaste esta cuenta, ignora este mensaje.</p>
        <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
        <p style="color:#94a3b8;font-size:11px;text-align:center;">O copia y pega este enlace en tu navegador:<br>${verifyUrl}</p>
      </div>`
    );

    console.log('send-confirmation-email: sent to', user.email, 'for', restaurant_slug);
    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('send-confirmation-email error:', error);
    return res.status(500).json({ success: false, error: 'Error del servidor' });
  }
}
