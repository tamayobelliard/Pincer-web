import { rateLimit } from './rate-limit.js';

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
      `${supabaseUrl}/rest/v1/restaurant_users?email_verification_token=eq.${encodeURIComponent(token)}&select=id,email_verified,restaurant_slug,display_name&limit=1`,
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
      return res.writeHead(302, { Location: '/login?verified=1' }).end();
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

    // Redirect to login with success indicator
    return res.writeHead(302, { Location: '/login?verified=1' }).end();

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
