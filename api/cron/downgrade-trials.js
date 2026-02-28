export const config = { maxDuration: 30 };

async function sendEmail(to, subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('RESEND_API_KEY not set — skipping email to', to);
    return;
  }
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Pincer <info@pincerweb.com>',
        to: [to],
        subject,
        html,
      }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    console.error('Resend email error:', e.message);
  }
}

export default async function handler(req, res) {
  // Vercel cron sends GET requests with Authorization header
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify cron secret
  const authHeader = req.headers['authorization'];
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseKey) {
    console.error('SUPABASE_SERVICE_ROLE_KEY not set');
    return res.status(500).json({ error: 'Server config error' });
  }

  const sbHeaders = {
    'apikey': supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
  };

  try {
    const now = new Date().toISOString();

    // Find all premium restaurants with expired trials
    const queryRes = await fetch(
      `${supabaseUrl}/rest/v1/restaurant_users?plan=eq.premium&trial_expires_at=lt.${encodeURIComponent(now)}&status=eq.active&select=id,restaurant_slug,display_name,email,contact_name`,
      { headers: sbHeaders, signal: AbortSignal.timeout(10000) }
    );

    if (!queryRes.ok) {
      console.error('Query error:', queryRes.status, await queryRes.text());
      return res.status(500).json({ error: 'Failed to query expired trials' });
    }

    const expired = await queryRes.json();
    console.log(`Found ${expired.length} expired premium trial(s)`);

    const errors = [];
    let downgraded = 0;

    for (const restaurant of expired) {
      try {
        // Downgrade to free
        const patchRes = await fetch(
          `${supabaseUrl}/rest/v1/restaurant_users?id=eq.${encodeURIComponent(restaurant.id)}`,
          {
            method: 'PATCH',
            headers: sbHeaders,
            body: JSON.stringify({ plan: 'free' }),
          }
        );

        if (!patchRes.ok) {
          const errText = await patchRes.text();
          console.error(`Failed to downgrade ${restaurant.restaurant_slug}:`, errText);
          errors.push({ slug: restaurant.restaurant_slug, error: errText });
          continue;
        }

        downgraded++;

        // Send notification email
        if (restaurant.email) {
          const dashboardUrl = `https://www.pincerweb.com/${restaurant.restaurant_slug}/dashboard`;
          const name = restaurant.contact_name || restaurant.display_name;

          await sendEmail(
            restaurant.email,
            'Tu periodo de prueba en Pincer ha expirado',
            `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
              <h1 style="color:#E8191A">Periodo de prueba finalizado</h1>
              <p>Hola <strong>${name}</strong>,</p>
              <p>Tu periodo de prueba de 30 dias para <strong>${restaurant.display_name}</strong> ha expirado.</p>
              <p>Tu cuenta ha sido cambiada al plan gratuito. Sigue usando Pincer gratis o contactanos para continuar con Premium.</p>
              <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
              <p><strong>Dashboard:</strong> <a href="${dashboardUrl}">${dashboardUrl}</a></p>
              <p>Para continuar con Premium, responde a este correo o escríbenos por WhatsApp.</p>
              <p style="color:#888;font-size:12px;margin-top:20px">— El equipo de Pincer</p>
            </div>`
          );
        }
      } catch (e) {
        console.error(`Error processing ${restaurant.restaurant_slug}:`, e.message);
        errors.push({ slug: restaurant.restaurant_slug, error: e.message });
      }
    }

    return res.status(200).json({
      success: true,
      found: expired.length,
      downgraded,
      errors,
    });

  } catch (error) {
    console.error('downgrade-trials error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
