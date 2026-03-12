export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  const cronSecret = req.headers['authorization']?.replace('Bearer ', '');
  if (cronSecret !== process.env.CRON_SECRET && req.headers['x-vercel-cron'] !== '1') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseKey) return res.status(500).json({ error: 'Server misconfigured' });

  try {
    const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    // Delete rate_limits entries older than 5 minutes
    const delRes = await fetch(
      `${supabaseUrl}/rest/v1/rate_limits?created_at=lt.${cutoff}`,
      {
        method: 'DELETE',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
        },
      }
    );

    // Also delete expired sessions
    const now = new Date().toISOString();
    await fetch(
      `${supabaseUrl}/rest/v1/restaurant_sessions?expires_at=lt.${now}`,
      {
        method: 'DELETE',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
        },
      }
    );
    await fetch(
      `${supabaseUrl}/rest/v1/admin_sessions?expires_at=lt.${now}`,
      {
        method: 'DELETE',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
        },
      }
    );

    // Delete payment_audit entries older than 7 days
    const auditCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    await fetch(
      `${supabaseUrl}/rest/v1/payment_audit?created_at=lt.${auditCutoff}`,
      {
        method: 'DELETE',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
        },
      }
    );

    console.log('[cleanup] rate_limits + expired sessions + old audit logs cleaned');
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('[cleanup] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
