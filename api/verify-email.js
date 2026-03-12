import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { rateLimit } from './rate-limit.js';
import { sendEmail } from './send-email.js';
import { generateQRPdf } from './generate-qr-pdf.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  // Only GET allowed (user clicks link from email)
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Rate limit: 10 attempts per minute per IP
  if (rateLimit(req, res, { max: 10, windowMs: 60000, prefix: 'verify-email' })) return;

  const token = (req.query.token || '').trim();

  if (!token || token.length !== 64) {
    return sendHTML(res, 400, 'Enlace invalido', 'El enlace de verificacion no es valido o ha expirado.');
  }

  const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseKey) {
    console.error('SUPABASE_SERVICE_ROLE_KEY not set');
    return sendHTML(res, 500, 'Error del servidor', 'Intenta de nuevo mas tarde.');
  }

  const sbHeaders = {
    'apikey': supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
  };

  try {
    // Find user by verification token
    const findRes = await fetch(
      `${supabaseUrl}/rest/v1/restaurant_users?email_verification_token=eq.${encodeURIComponent(token)}&select=id,email,email_verified,restaurant_slug,display_name,logo_url,trial_expires_at,welcome_email_sent&limit=1`,
      { headers: sbHeaders }
    );

    if (!findRes.ok) {
      console.error('verify-email: lookup error', findRes.status);
      return sendHTML(res, 500, 'Error del servidor', 'Intenta de nuevo mas tarde.');
    }

    const rows = await findRes.json();

    if (rows.length === 0) {
      return sendHTML(res, 400, 'Enlace invalido', 'El enlace de verificacion no es valido o ya fue utilizado.');
    }

    const user = rows[0];

    // Already verified
    if (user.email_verified) {
      return res.writeHead(302, { Location: '/email-confirmed' }).end();
    }

    // Set email_verified = true and clear the token
    const patchRes = await fetch(
      `${supabaseUrl}/rest/v1/restaurant_users?id=eq.${user.id}`,
      {
        method: 'PATCH',
        headers: { ...sbHeaders, 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          email_verified: true,
          email_verification_token: null,
        }),
      }
    );

    if (!patchRes.ok) {
      console.error('verify-email: patch error', patchRes.status, await patchRes.text());
      return sendHTML(res, 500, 'Error del servidor', 'No se pudo verificar el email. Intenta de nuevo.');
    }

    console.log('verify-email: verified', user.restaurant_slug);

    // ── Generate fresh temp password for welcome email ──
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const bytes = randomBytes(8);
    let temp_password = '';
    for (let i = 0; i < 8; i++) {
      temp_password += chars.charAt(bytes[i] % chars.length);
    }
    const password_hash = await bcrypt.hash(temp_password, 12);

    // Update password_hash in DB
    const pwPatchRes = await fetch(
      `${supabaseUrl}/rest/v1/restaurant_users?id=eq.${user.id}`,
      {
        method: 'PATCH',
        headers: { ...sbHeaders, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ password_hash }),
      }
    );
    if (!pwPatchRes.ok) {
      console.error('verify-email: password update error', pwPatchRes.status);
      // Continue — email is verified, user can request password reset later
    }

    // ── Send welcome email with credentials + QR (only if not already sent) ──
    if (!user.welcome_email_sent) {
      const slug = user.restaurant_slug;
      const dashboardUrl = `https://www.pincerweb.com/${slug}/dashboard`;
      const menuUrl = `https://www.pincerweb.com/${slug}`;
      const expiryDate = user.trial_expires_at
        ? new Date(user.trial_expires_at).toLocaleDateString('es-DO', { day: 'numeric', month: 'long', year: 'numeric' })
        : '';

      // Generate QR PDF
      let qrAttachments = [];
      try {
        const qrPdfBase64 = await generateQRPdf(slug, user.display_name, user.logo_url || null);
        qrAttachments = [{ filename: `QR-${slug}.pdf`, content: qrPdfBase64 }];
      } catch (e) {
        console.error('verify-email: QR PDF error:', e.message);
      }

      // Send welcome email
      await sendEmail(
        user.email,
        `Bienvenido a Pincer — ${user.display_name}`,
        `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;background:#fff;">
          <div style="text-align:center;margin-bottom:20px;">
            <img src="https://i.imgur.com/FaOdU4D.png" alt="Pincer" style="width:48px;height:48px;">
          </div>
          <h1 style="color:#E8191A;text-align:center;margin-bottom:8px;">Bienvenido a Pincer!</h1>
          <p style="text-align:center;color:#64748B;">Tu menu digital esta listo</p>
          <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
          <table style="width:100%;border-collapse:collapse;">
            <tr><td style="padding:8px 0;color:#64748B;">Restaurante</td><td style="padding:8px 0;font-weight:bold;">${user.display_name}</td></tr>
            <tr><td style="padding:8px 0;color:#64748B;">Usuario</td><td style="padding:8px 0;font-weight:bold;">${slug}</td></tr>
            <tr><td style="padding:8px 0;color:#64748B;">Contrasena temporal</td><td style="padding:8px 0;font-weight:bold;font-family:monospace;font-size:16px;letter-spacing:1px;">${temp_password}</td></tr>
            <tr><td style="padding:8px 0;color:#64748B;">Dashboard</td><td style="padding:8px 0;"><a href="${dashboardUrl}" style="color:#E8191A;font-weight:bold;">${dashboardUrl}</a></td></tr>
            <tr><td style="padding:8px 0;color:#64748B;">Tu menu</td><td style="padding:8px 0;"><a href="${menuUrl}" style="color:#E8191A;font-weight:bold;">${menuUrl}</a></td></tr>
          </table>
          <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
          ${expiryDate ? `<div style="background:#FFF3F3;padding:14px;border-radius:8px;text-align:center;">
            <p style="color:#E8191A;font-weight:bold;margin:0;">Prueba gratuita de 30 dias</p>
            <p style="color:#64748B;font-size:13px;margin:4px 0 0;">Vence el ${expiryDate}</p>
          </div>` : ''}
          <div style="background:#FFF7ED;padding:14px;border-radius:8px;text-align:center;margin-top:12px;">
            <p style="color:#9A3412;font-weight:bold;margin:0;">Cambia tu contrasena</p>
            <p style="color:#C2410C;font-size:13px;margin:4px 0 0;">Al iniciar sesion por primera vez, se te pedira crear una contrasena nueva.</p>
          </div>
          <p style="color:#94a3b8;font-size:12px;margin-top:24px;text-align:center;">— El equipo de Pincer</p>
        </div>`,
        qrAttachments
      );

      // Mark welcome email as sent
      fetch(
        `${supabaseUrl}/rest/v1/restaurant_users?id=eq.${user.id}`,
        {
          method: 'PATCH',
          headers: { ...sbHeaders, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ welcome_email_sent: true }),
        }
      ).catch(e => console.error('verify-email: welcome_email_sent patch error:', e.message));
    }

    // Redirect to login with success indicator
    return res.writeHead(302, { Location: '/email-confirmed' }).end();

  } catch (error) {
    console.error('verify-email error:', error);
    return sendHTML(res, 500, 'Error del servidor', 'Intenta de nuevo mas tarde.');
  }
}

function sendHTML(res, status, title, message) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(status).send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — Pincer</title>
  <link rel="icon" type="image/png" href="https://i.imgur.com/FaOdU4D.png">
  <style>
    * { margin:0; padding:0; box-sizing:border-box; font-family:'Plus Jakarta Sans',system-ui,sans-serif; }
    body { min-height:100vh; background:#F9FAFB; display:flex; align-items:center; justify-content:center; }
    .card { background:#fff; border-radius:16px; padding:40px; max-width:420px; width:90%; text-align:center;
      box-shadow:0 1px 3px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.04); border:1px solid #E2E8F0; }
    h1 { color:#0F172A; font-size:1.3em; margin-bottom:8px; }
    p { color:#64748B; font-size:0.95em; margin-bottom:20px; }
    a { display:inline-block; padding:12px 24px; background:#DC2626; color:#fff; border-radius:10px;
      text-decoration:none; font-weight:700; }
    a:hover { background:#991B1B; }
  </style>
</head>
<body>
  <div class="card">
    <div style="font-size:2.5em;margin-bottom:16px;">${status >= 400 ? '&#9888;' : '&#10003;'}</div>
    <h1>${title}</h1>
    <p>${message}</p>
    <a href="/login">Ir al login</a>
  </div>
</body>
</html>`);
}
