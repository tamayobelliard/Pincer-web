export default async function handler(req, res) {
  // This endpoint receives POST from the ACS after the 3DS Method iframe completes.
  // The bank posts here to confirm the device fingerprinting step is done.

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || 'https://www.pincerweb.com');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  const sessionId = req.query.session;
  if (!sessionId) {
    return res.status(400).send('Missing session');
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    await fetch(
      `${supabaseUrl}/rest/v1/sessions_3ds?session_id=eq.${encodeURIComponent(sessionId)}`,
      {
        method: 'PATCH',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          method_notification_received: true,
          updated_at: new Date().toISOString(),
        }),
      }
    );
  } catch (err) {
    console.error('method-notify supabase error:', err);
  }

  // Return minimal HTML — the ACS expects a 200 response
  res.setHeader('Content-Type', 'text/html');
  return res.status(200).send('<html><body>OK</body></html>');
}
