const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://www.pincerweb.com';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const sessionId = req.query.session;
  if (!sessionId) {
    return res.status(400).json({ error: 'Missing session' });
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL || 'https://tcwujslibopzfyufhjsr.supabase.co';
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    const r = await fetch(
      `${supabaseUrl}/rest/v1/sessions_3ds?session_id=eq.${encodeURIComponent(sessionId)}&select=status,method_notification_received,final_response`,
      {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
        },
      }
    );

    if (!r.ok) {
      console.error('3ds status supabase error:', r.status);
      return res.status(500).json({ error: 'DB error' });
    }

    const rows = await r.json();
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const session = rows[0];
    const fr = session.final_response;

    // Return only non-sensitive fields (no auth codes, tickets, RRN)
    const safeResponse = (session.status === 'approved' || session.status === 'declined' || session.status === 'error') && fr
      ? { isoCode: fr.IsoCode, message: fr.ResponseMessage, responseCode: fr.ResponseCode }
      : null;

    return res.status(200).json({
      status: session.status,
      methodReceived: session.method_notification_received,
      finalResponse: safeResponse,
    });

  } catch (error) {
    console.error('3ds status error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
